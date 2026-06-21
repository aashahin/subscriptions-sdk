// file: packages/subscriptions/src/index.ts
// Main entry point for @abshahin/subscriptions package

import type { CacheAdapter } from "./adapters/cache.adapter.js";
import { noopCacheAdapter } from "./adapters/cache.adapter.js";
import type { DatabaseAdapter } from "./adapters/database.adapter.js";
import type {
  PaymentGatewayAdapter,
  WebhookEvent,
} from "./adapters/payment.adapter.js";
import { noopPaymentAdapter } from "./adapters/payment.adapter.js";
import type { FeatureRegistry, SubscriptionsLogger, SubscriptionsOptions } from "./core/types.js";
import { noopLogger } from "./core/types.js";
import { InvoicesService } from "./services/invoices.service.js";
import { PermissionsService } from "./services/permissions.service.js";
import { PlansService } from "./services/plans.service.js";
import { SubscriptionsService } from "./services/subscriptions.service.js";

/**
 * Configuration for creating a subscriptions instance
 */
export interface SubscriptionsConfig<TFeatures extends FeatureRegistry> {
  /**
   * Database adapter (required)
   */
  database: DatabaseAdapter<TFeatures>;

  /**
   * Feature registry defining available features
   */
  features: TFeatures;

  /**
   * Cache adapter (optional, improves performance)
   */
  cache?: CacheAdapter;

  /**
   * Payment gateway adapter (optional, for Stripe/Paddle integration)
   */
  payment?: PaymentGatewayAdapter;

  /**
   * Additional options
   */
  options?: SubscriptionsOptions;
}

/**
 * Main subscriptions instance with all services
 */
export interface Subscriptions<TFeatures extends FeatureRegistry> {
  /**
   * Plans service for managing subscription plans
   */
  plans: PlansService<TFeatures>;

  /**
   * Subscriptions service for managing subscriber subscriptions
   */
  subscriptions: SubscriptionsService<TFeatures>;

  /**
   * Permissions service for feature gates and usage tracking
   */
  permissions: PermissionsService<TFeatures>;

  /**
   * Invoices service for invoice management
   */
  invoices: InvoicesService<TFeatures>;

  // ==================== Convenience Methods ====================

  /**
   * Check if subscriber has access to a boolean feature
   * Shorthand for `permissions.can()`
   */
  can<K extends keyof TFeatures>(
    subscriberId: string,
    feature: K,
  ): Promise<boolean>;

  /**
   * Get current usage vs limit for a feature
   * Shorthand for `permissions.remaining()`
   */
  remaining<K extends keyof TFeatures>(
    subscriberId: string,
    feature: K,
  ): Promise<import("./core/types.js").UsageStatus>;

  /**
   * Increment usage counter (throws if limit exceeded)
   * Shorthand for `permissions.use()`
   */
  use<K extends keyof TFeatures>(
    subscriberId: string,
    feature: K,
    count?: number,
  ): Promise<import("./core/types.js").UsageStatus>;

  /**
   * Decrement usage counter
   * Shorthand for `permissions.release()`
   */
  release<K extends keyof TFeatures>(
    subscriberId: string,
    feature: K,
    count?: number,
  ): Promise<import("./core/types.js").UsageStatus>;

  /**
   * Handle webhook event from payment gateway
   */
  handleWebhook(
    provider: string,
    payload: string | Uint8Array,
    signature: string,
  ): Promise<WebhookEvent>;
}

/**
 * Create a subscriptions instance with all services configured
 *
 * @example
 * ```typescript
 * import { createSubscriptions, defineFeatures } from '@abshahin/subscriptions';
 * import { prismaAdapter } from '@abshahin/subscriptions/adapters/prisma';
 *
 * const features = defineFeatures({
 *   analytics: { type: 'boolean', default: false },
 *   maxProducts: { type: 'limit', default: 100 },
 * });
 *
 * const subs = createSubscriptions({
 *   database: prismaAdapter(db),
 *   features,
 * });
 *
 * // Usage
 * if (await subs.can(tenantId, 'analytics')) {
 *   // Show analytics
 * }
 * ```
 */
export function createSubscriptions<TFeatures extends FeatureRegistry>(
  config: SubscriptionsConfig<TFeatures>,
): Subscriptions<TFeatures> {
  const { database, features, cache, payment, options } = config;

  const cacheAdapter = cache ?? noopCacheAdapter;
  const paymentAdapter = payment ?? noopPaymentAdapter;
  const logger: SubscriptionsLogger = options?.logger ?? noopLogger;

  const plans = new PlansService(database, features, cacheAdapter, {
    ...(options?.defaultCurrency && {
      defaultCurrency: options.defaultCurrency,
    }),
    ...(options?.cacheTtlSeconds && {
      cacheTtlSeconds: options.cacheTtlSeconds,
    }),
  });

  const subscriptions = new SubscriptionsService(
    database,
    cacheAdapter,
    paymentAdapter,
    {
      ...(options?.subscriberType && {
        subscriberType: options.subscriberType,
      }),
      ...(options?.trialDays !== undefined && { trialDays: options.trialDays }),
      ...(options?.gracePeriodDays !== undefined && {
        gracePeriodDays: options.gracePeriodDays,
      }),
      ...(options?.cacheTtlSeconds && {
        cacheTtlSeconds: options.cacheTtlSeconds,
      }),
      logger,
    },
  );

  const permissions = new PermissionsService(database, features, cacheAdapter, {
    ...(options?.cacheTtlSeconds && {
      cacheTtlSeconds: options.cacheTtlSeconds,
    }),
    ...(options?.gracePeriodDays !== undefined && {
      gracePeriodDays: options.gracePeriodDays,
    }),
  });

  const invoices = new InvoicesService(database);

  return {
    plans,
    subscriptions,
    permissions,
    invoices,

    // Convenience methods
    can: (subscriberId, feature) => permissions.can(subscriberId, feature),
    remaining: (subscriberId, feature) =>
      permissions.remaining(subscriberId, feature),
    use: (subscriberId, feature, count) =>
      permissions.use(subscriberId, feature, count),
    release: (subscriberId, feature, count) =>
      permissions.release(subscriberId, feature, count),

    // Webhook handler
    handleWebhook: async (provider, payload, signature) => {
      if (paymentAdapter.provider !== provider) {
        throw new Error(`Unknown payment provider: ${provider}`);
      }

      const event = await paymentAdapter.constructWebhookEvent(
        payload,
        signature,
      );

      // Resolve the subscriber from event metadata. Charges issued by this SDK
      // attach `subscriberId`; some external/legacy flows attach `tenantId`.
      const resolveSubscriberId = (
        metadata: Record<string, string> | undefined,
      ): string | undefined => metadata?.subscriberId ?? metadata?.tenantId;

      // Renewal-style payment types whose success should extend the period.
      const RENEWAL_TYPES = new Set([
        "subscription_renewal",
        "renewal",
        "subscription_payment",
      ]);

      // Handle payment events
      switch (event.type) {
        case "payment.paid":
        case "customer.subscription.updated": {
          // Payment already succeeded at the gateway — do NOT charge again.
          const paymentData = event.data as Record<string, unknown>;
          const metadata = paymentData.metadata as
            | Record<string, string>
            | undefined;
          const subscriberId = resolveSubscriberId(metadata);

          if (subscriberId && metadata?.type && RENEWAL_TYPES.has(metadata.type)) {
            const gatewayInvoiceId =
              typeof paymentData.id === "string" ? paymentData.id : undefined;

            // Idempotency: if we've already recorded an invoice for this gateway
            // payment (e.g. a cron renewal already processed it), skip entirely
            // so we never double-renew or double-invoice the same payment.
            if (gatewayInvoiceId && database.invoices.findByGatewayInvoiceId) {
              const existing =
                await database.invoices.findByGatewayInvoiceId(gatewayInvoiceId);
              if (existing) {
                break;
              }
            }

            // Renew without charging (the gateway already collected payment) and
            // let renew() create the paid invoice so there is exactly one.
            await subscriptions.renew(subscriberId, {
              skipPayment: true,
              paidExternally: true,
              ...(gatewayInvoiceId && { gatewayInvoiceId }),
            });
          }
          break;
        }

        case "payment.failed":
        case "invoice.payment_failed": {
          // Payment failed - record failure info on the subscription.
          const paymentData = event.data as Record<string, unknown>;
          const metadata = paymentData.metadata as
            | Record<string, string>
            | undefined;
          const subscriberId = resolveSubscriberId(metadata);

          if (subscriberId) {
            const subscription = await subscriptions.get(subscriberId);

            if (subscription) {
              const failureMessage =
                typeof paymentData.message === "string"
                  ? paymentData.message
                  : "Payment failed";

              // Route through the service so caches stay consistent.
              await subscriptions.recordPaymentFailure(
                subscriberId,
                failureMessage,
              );
            }
          }
          break;
        }

        case "customer.subscription.deleted": {
          // Subscription cancelled from gateway
          const subscriptionData = event.data as Record<string, unknown>;
          const metadata = subscriptionData.metadata as
            | Record<string, string>
            | undefined;
          const subscriberId = resolveSubscriberId(metadata);

          if (subscriberId) {
            await subscriptions.cancel(subscriberId, {
              immediately: true,
            });
          }
          break;
        }
      }

      return event;
    },
  };
}

// ==================== Re-exports ====================

// Core
export * from "./core/errors.js";
export {
  defineFeatures,
  resolveFeatures,
  validatePlanFeatures
} from "./core/features.js";
export * from "./core/types.js";

// Adapters
export { CacheKeys, noopCacheAdapter } from "./adapters/cache.adapter.js";
export type { CacheAdapter } from "./adapters/cache.adapter.js";
export type {
  DatabaseAdapter,
  PlanQueryOptions,
  SubscriptionQueryOptions
} from "./adapters/database.adapter.js";
export { noopPaymentAdapter } from "./adapters/payment.adapter.js";
export type {
  ChargePaymentInput,
  ChargePaymentResult,
  CheckoutSession,
  GatewayCustomer,
  GatewaySubscription,
  PaymentGatewayAdapter,
  PortalSession,
  WebhookEvent
} from "./adapters/payment.adapter.js";

// Services
export { InvoicesService } from "./services/invoices.service.js";
export { PermissionsService } from "./services/permissions.service.js";
export { PlansService } from "./services/plans.service.js";
export {
  SubscriptionsService,
  type ChangePlanResult,
  type PlanChangePreview
} from "./services/subscriptions.service.js";

// Invoice Templates
export {
  formatCurrency,
  formatDate,
  generateSubscriptionInvoicePdf,
  getCurrencyInfo,
  renderSubscriptionInvoice,
  type SubscriptionInvoiceData
} from "./templates/invoice-utils.js";

