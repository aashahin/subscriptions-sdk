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

      // Handle payment events
      switch (event.type) {
        case "payment.paid":
        case "customer.subscription.updated": {
          // Payment successful - process subscription renewal
          const paymentData = event.data as Record<string, unknown>;
          const metadata = paymentData.metadata as
            | Record<string, string>
            | undefined;

          if (metadata?.type === "subscription_renewal" && metadata?.tenantId) {
            const subscriberId = metadata.tenantId;

            // Renew the subscription
            await subscriptions.renew(subscriberId);

            // Create invoice if subscription exists
            const subscription = await subscriptions.get(subscriberId);
            if (subscription) {
              // Moyasar returns amount in smallest currency unit (halalas/cents)
              // Store as-is — the invoice download endpoint converts to display units
              const amount =
                typeof paymentData.amount === "number"
                  ? paymentData.amount
                  : 0;
              const currency =
                typeof paymentData.currency === "string"
                  ? paymentData.currency
                  : "SAR";

              const gatewayInvoiceId =
                typeof paymentData.id === "string" ? paymentData.id : null;

              await invoices.create({
                subscriptionId: subscription.id,
                amount,
                currency,
                status: "paid",
                ...(gatewayInvoiceId && { gatewayInvoiceId }),
                metadata: {
                  paymentId: paymentData.id,
                  provider,
                  webhookEventId: event.id,
                },
              });
            }
          }
          break;
        }

        case "payment.failed":
        case "invoice.payment_failed": {
          // Payment failed - update subscription status
          const paymentData = event.data as Record<string, unknown>;
          const metadata = paymentData.metadata as
            | Record<string, string>
            | undefined;

          if (metadata?.tenantId) {
            const subscriberId = metadata.tenantId;
            const subscription = await subscriptions.get(subscriberId);

            if (subscription) {
              // Update subscription metadata with failure info
              await database.subscriptions.update(subscription.id, {
                metadata: {
                  ...(subscription.metadata ?? {}),
                  lastPaymentError:
                    typeof paymentData.message === "string"
                      ? paymentData.message
                      : "Payment failed",
                  lastPaymentFailedAt: new Date().toISOString(),
                },
              });
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

          if (metadata?.tenantId) {
            await subscriptions.cancel(metadata.tenantId, {
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

