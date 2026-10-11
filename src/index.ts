// file: packages/subscriptions/src/index.ts
// Main entry point for @abshahin/subscriptions package
import type { CacheAdapter } from "./adapters/cache.adapter.js";
import { noopCacheAdapter } from "./adapters/cache.adapter.js";
import type { DatabaseAdapter, ProviderResourceMapping } from "./adapters/database.adapter.js";
import type { PaymentGatewayAdapter, WebhookEvent, } from "./adapters/payment.adapter.js";
import { noopPaymentAdapter } from "./adapters/payment.adapter.js";
import type { FeatureRegistry, SubscriptionsLogger, SubscriptionsOptions } from "./core/types.js";
import { noopLogger } from "./core/types.js";
import { ProviderRegistry, type ProviderRegistration } from "./core/providers.js";
import type { OutboxStore } from "./adapters/outbox.adapter.js";
import { webhookFailureStatus } from "./integrations/http.js";
import { InvoicesService } from "./services/invoices.service.js";
import { CouponsService } from "./services/coupons.service.js";
import { PermissionsService } from "./services/permissions.service.js";
import { PlansService } from "./services/plans.service.js";
import { SubscriptionsService, type DunningOptions } from "./services/subscriptions.service.js";
/**
 * Webhook-related options accepted in addition to {@link SubscriptionsOptions}.
 * These configure how {@link Subscriptions.handleWebhookRequest} translates
 * web-standard webhook Requests into provider webhook handling.
 */
export interface SubscriptionsWebhookOptions {
    /**
     * Header carrying the webhook signature.
     * Falls back to common gateway headers (`x-moyasar-signature`,
     * `stripe-signature`, `x-webhook-signature`) when the configured header
     * is absent.
     * @default 'x-signature'
     */
    webhookSignatureHeader?: string;
    /**
     * Payment provider name to handle webhooks for
     * @default the configured payment adapter's provider
     */
    webhookProvider?: string;
}
/**
 * Dunning (failed-payment retry) options accepted in addition to
 * {@link SubscriptionsOptions}. Driven externally via
 * `subscriptions.processDunning()` (e.g. from a cron / scheduled handler).
 */
export interface SubscriptionsDunningOptions {
    /**
     * Dunning configuration for failed subscription payments.
     * @default { retryScheduleDays: [1, 3, 5, 7], action: 'none' }
     */
    dunning?: DunningOptions;
}
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
    /** Stable account identities; a default affects new purchases only. */
    providers?: ProviderRegistration[];
    defaultProvider?: string;
    /** Required to route the legacy single payment adapter for new purchases. */
    paymentIdentity?: {
        accountId: string;
        environment: "test" | "live";
        billingOwner: "sdk_managed" | "provider_managed";
    };
    /**
     * Additional options
     */
    options?: SubscriptionsOptions & SubscriptionsWebhookOptions & SubscriptionsDunningOptions;
}
/**
 * Main subscriptions instance with all services
 */
export interface Subscriptions<TFeatures extends FeatureRegistry> {
    /**
     * Plans service for managing subscription plans
     */
    plans: PlansService<TFeatures>;
    /** Durable events persisted with business effects; relay is at least once. */
    eventOutbox?: OutboxStore;
    /** Server-only immutable customer/payment/subscription/product/price mappings. */
    bindProviderResource(mapping: ProviderResourceMapping): Promise<ProviderResourceMapping>;
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
    /**
     * Coupons service for discount codes
     */
    coupons: CouponsService<TFeatures>;
    // ==================== Convenience Methods ====================
    /**
     * Check if subscriber has access to a boolean feature
     * Shorthand for `permissions.can()`
     */
    can<K extends keyof TFeatures>(subscriberId: string, feature: K): Promise<boolean>;
    /**
     * Get current usage vs limit for a feature
     * Shorthand for `permissions.remaining()`
     */
    remaining<K extends keyof TFeatures>(subscriberId: string, feature: K): Promise<import("./core/types.js").UsageStatus>;
    /**
     * Increment usage counter (throws if limit exceeded)
     * Shorthand for `permissions.use()`
     */
    use<K extends keyof TFeatures>(subscriberId: string, feature: K, count?: number): Promise<import("./core/types.js").UsageStatus>;
    /**
     * Decrement usage counter
     * Shorthand for `permissions.release()`
     */
    release<K extends keyof TFeatures>(subscriberId: string, feature: K, count?: number): Promise<import("./core/types.js").UsageStatus>;
    /**
     * Handle webhook event from payment gateway
     */
    handleWebhook(provider: string, payload: string | Uint8Array, signature?: string, context?: {
        headers: Record<string, string>;
    }): Promise<WebhookEvent>;
    /**
     * Handle an incoming webhook as a web-standard `Request` and produce a
     * web-standard `Response`. Reads the raw body, extracts the signature from
     * the configured header (falling back to common gateway headers), and
     * delegates to {@link Subscriptions.handleWebhook}.
     *
     * Returns 200 JSON on success, 400/401 for provider authentication or
     * malformed input, and 500 for processing/provider outages.
     */
    handleWebhookRequest(request: Request): Promise<Response>;
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
export function createSubscriptions<TFeatures extends FeatureRegistry>(config: SubscriptionsConfig<TFeatures>): Subscriptions<TFeatures> {
    const { database, features, cache, payment, options } = config;
    if (cache && !options?.cacheNamespace?.trim())
        throw new Error("cacheNamespace is required when configuring a cache");
    const cacheAdapter = cache ?? noopCacheAdapter;
    const logger: SubscriptionsLogger = options?.logger ?? noopLogger;
    const registrations = [...(config.providers ?? [])];
    if (payment && config.paymentIdentity)
        registrations.push({ id: payment.provider, adapter: payment, ...config.paymentIdentity });
    const defaultProvider = config.defaultProvider ?? (payment && config.paymentIdentity ? payment.provider : undefined);
    const providers = new ProviderRegistry(registrations, defaultProvider);
    const shared = { ...(options?.cacheNamespace ? { cacheNamespace: options.cacheNamespace } : {}),
        ...(options?.cacheTtlSeconds !== undefined ? { cacheTtlSeconds: options.cacheTtlSeconds } : {}) };
    const plans = new PlansService(database, features, cacheAdapter, { ...shared,
        ...(options?.defaultCurrency ? { defaultCurrency: options.defaultCurrency } : {}) });
    const subscriptions = new SubscriptionsService(database, cacheAdapter, payment, { ...shared, providers, logger,
        ...(options?.subscriberType ? { subscriberType: options.subscriberType } : {}),
        ...(options?.trialDays !== undefined ? { trialDays: options.trialDays } : {}),
        ...(options?.gracePeriodDays !== undefined ? { gracePeriodDays: options.gracePeriodDays } : {}),
        ...(options?.dunning ? { dunning: options.dunning } : {}) });
    const permissions = new PermissionsService(database, features, cacheAdapter, { ...shared,
        ...(options?.gracePeriodDays !== undefined ? { gracePeriodDays: options.gracePeriodDays } : {}) });
    const invoices = new InvoicesService(database);
    const coupons = new CouponsService(database, options?.defaultCurrency ? { defaultCurrency: options.defaultCurrency } : {});
    const webhookProvider = options?.webhookProvider ?? defaultProvider ?? payment?.provider ?? "manual";
    const handleWebhook = async (provider: string, payload: string | Uint8Array, signature: string = "", context?: {
        headers: Record<string, string>;
    }): Promise<WebhookEvent> => {
        const registration = providers.get(provider);
        const event = await registration.adapter.constructWebhookEvent(payload, signature, context);
        if (event.environment && event.environment !== registration.environment)
            throw new Error("Webhook verification environment mismatch");
        if (["payment.paid", "payment.failed"].includes(event.type))
            await subscriptions.acceptPaymentEvent(provider, event);
        else if (["customer.subscription.updated", "customer.subscription.deleted", "subscription.updated", "subscription.deleted"].includes(event.type))
            await subscriptions.acceptSubscriptionSnapshot(provider, event);
        return event;
    };
    return { plans, subscriptions, permissions, invoices, coupons, bindProviderResource: async (mapping) => {
            const registration = providers.get(mapping.providerId);
            if (registration.accountId !== mapping.accountId || registration.environment !== mapping.environment)
                throw new Error("Provider resource scope mismatch");
            if (!database.providerResources || !database.capabilities?.asyncTransactions)
                throw new Error("Provider resource migration and atomic database required");
            return database.transaction(tx => tx.providerResources!.bind(mapping));
        }, ...(database.capabilities?.asyncTransactions && database.outbox ? { eventOutbox: database.outbox } : {}),
        can: (id, feature) => permissions.can(id, feature), remaining: (id, feature) => permissions.remaining(id, feature),
        use: (id, feature, count) => permissions.use(id, feature, count), release: (id, feature, count) => permissions.release(id, feature, count),
        handleWebhook,
        handleWebhookRequest: async (request) => {
            const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
            const signature = request.headers.get(options?.webhookSignatureHeader ?? "x-signature") ?? request.headers.get("stripe-signature") ?? request.headers.get("paddle-signature") ?? request.headers.get("x-signature") ?? request.headers.get("x-webhook-signature") ?? "";
            try {
                const event = await handleWebhook(webhookProvider, await request.text(), signature, { headers: Object.fromEntries(request.headers) });
                return json({ received: true, eventId: event.id }, 200);
            }
            catch (error) {
                const status = webhookFailureStatus(error) ?? 500;
                if (status === 500)
                    logger.error?.("Webhook handling failed", error);
                return json({ error: error instanceof Error ? error.message : "Webhook handling failed" }, status);
            }
        }
    };
}
// ==================== Re-exports ====================
// Core
export * from "./core/errors.js";
export { defineFeatures, resolveFeatures, validatePlanFeatures } from "./core/features.js";
export * from "./core/types.js";
// Adapters
export { CacheKeys, noopCacheAdapter } from "./adapters/cache.adapter.js";
export type { CacheAdapter } from "./adapters/cache.adapter.js";
export type { DatabaseAdapter, BillingOperationRecord, BillingOperationStore, ProviderResourceMapping, ProviderResourceScope, ProviderResourceStore, UsagePeriodOptions, UsageMutationOptions, UsageReservationOptions, PlanQueryOptions, SubscriptionQueryOptions } from "./adapters/database.adapter.js";
export { noopPaymentAdapter } from "./adapters/payment.adapter.js";
export type { ChargePaymentInput, GatewayPayment, GatewayPaymentMethod, PaymentGatewayCapabilities, WebhookVerificationContext, EmbeddedCheckoutInput, EmbeddedCheckoutConfiguration, ChargePaymentResult, CheckoutSession, GatewayCustomer, GatewaySubscription, PaymentGatewayAdapter, PortalSession, WebhookEvent } from "./adapters/payment.adapter.js";
// Services
export { InvoicesService, type InvoicesServiceOptions } from "./services/invoices.service.js";
export { CouponsService, type CouponsServiceOptions } from "./services/coupons.service.js";
export { PermissionsService } from "./services/permissions.service.js";
export { PlansService } from "./services/plans.service.js";
export { SubscriptionsService, type CreateSubscriptionOptions, type ChangePlanOptions, type RenewSubscriptionOptions, type ChangePlanResult, type DunningOptions, type DunningProcessResult, type PendingChangeResult, type PlanChangePreview } from "./services/subscriptions.service.js";
// Events & Outbox
export { noopEventsAdapter, withEvents, type EventsAdapter, type SubscriptionEvent, type SubscriptionEventType, type WithEventsOptions } from "./core/events.js";
export { createOutboxEventsAdapter, relayOutbox, type OutboxRecord, type OutboxStore, type RelayOutboxOptions, type RelayOutboxResult } from "./adapters/outbox.adapter.js";
// Invoice Templates
export { formatCurrency, formatDate, generatePdfWith, generateSubscriptionInvoicePdf, getCurrencyInfo, renderSubscriptionInvoice, wrapInvoiceForPrint, type PrintWrapOptions, type SubscriptionInvoiceData } from "./templates/invoice-utils.js";
export { subscriptionInvoiceTemplate } from "./templates/invoice-template.js";
export { noopPdfRenderer, type PdfRenderer } from "./templates/pdf-renderer.js";
// Integrations (web-standard HTTP)
export { createSubscriptionsHttpHandler, type SubscriptionsHttpHandler, type SubscriptionsHttpOptions, type SubscriptionOperation } from "./integrations/http.js";
export { ProviderRegistry, type ProviderRegistration } from "./core/providers.js";
export { calculateBillingPeriodEnd, currencyMinorUnits, majorToMinor, minorToMajor } from "./core/billing-policy.js";
