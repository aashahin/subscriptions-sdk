import type { CacheAdapter } from '../adapters/cache.adapter.js';
import { CacheKeys, noopCacheAdapter } from '../adapters/cache.adapter.js';
import type { BillingOperationRecord, DatabaseAdapter } from '../adapters/database.adapter.js';
import type { CancelOptions, ChargePaymentResult, PaymentGatewayAdapter, WebhookEvent } from '../adapters/payment.adapter.js';
import { DuplicateSubscriptionError, PaymentFailedError, PlanNotFoundError, SubscriptionError, SubscriptionInactiveError, SubscriptionNotCanceledError, SubscriptionNotFoundError } from '../core/errors.js';
import type { FeatureRegistry, Invoice, Plan, ProviderBinding, SubscriberType, Subscription, SubscriptionsLogger, SubscriptionStatus, SubscriptionWithPlan, UpdateSubscriptionInput } from '../core/types.js';
import { noopLogger } from '../core/types.js';
import { ProviderRegistry, scopedProviderReference } from '../core/providers.js';
import { billingCalendarAnchor, calculateBillingPeriodEnd, majorToMinor, minorToMajor, quotePlanChange, snapshotBillingPrice, type BillingPriceSnapshot, type PlanChangeQuote } from '../core/billing-policy.js';
import { InvoicesService } from './invoices.service.js';
export interface DunningOptions {
    retryScheduleDays?: number[];
    action?: 'pause' | 'cancel' | 'none';
}
export interface SubscriptionsServiceOptions {
    subscriberType?: SubscriberType;
    trialDays?: number;
    gracePeriodDays?: number;
    cacheTtlSeconds?: number;
    cacheNamespace?: string;
    dunning?: DunningOptions;
    logger?: SubscriptionsLogger;
    providers?: ProviderRegistry;
}
export interface ChangePlanResult<TFeatures extends FeatureRegistry = FeatureRegistry> {
    subscription: SubscriptionWithPlan<TFeatures>;
    charged: boolean;
    paymentId?: string;
    chargeAmount?: number;
    paymentPending?: boolean;
    verificationUrl?: string;
    invoice?: Invoice;
}
export interface DunningProcessResult {
    subscriberId: string;
    subscriptionId: string;
    attempts: number;
    exhausted: boolean;
    recovered: boolean;
    actionApplied: 'pause' | 'cancel' | 'none';
}
export interface PendingChangeResult {
    subscriberId: string;
    subscriptionId: string;
    previousPlanId: string;
    newPlanId: string;
}
export interface PlanChangePreview {
    currentPlan: {
        id: string;
        name: string;
        price: number;
        currency: string;
    };
    newPlan: {
        id: string;
        name: string;
        price: number;
        currency: string;
    };
    isUpgrade: boolean;
    isDowngrade: boolean;
    priceDifference: number;
    daysRemaining: number;
    totalDays: number;
    prorationRatio: number;
    amountDue: number;
    amountDueFormatted: number;
    currency: string;
    effectiveDate: Date;
    message: string;
    quoteId: string;
    validUntil: Date;
}
export interface CreateSubscriptionOptions {
    /** Server-only policies; purchase is the safe default. */
    policy?: 'purchase' | 'manual_invoice' | 'complimentary';
    trialDays?: number;
    billing?: ProviderBinding;
    gatewayCustomerId?: string;
    metadata?: Record<string, unknown>;
}
export interface ChangePlanOptions {
    immediately?: boolean;
    prorate?: boolean;
    quoteId?: string;
}
export interface RenewSubscriptionOptions {
    retryAttempt?: number;
}
interface Purchase {
    kind: 'renewal' | 'change';
    subscriberId: string;
    subscriptionId: string;
    binding: ProviderBinding;
    planId: string;
    amountMinor: number;
    currency: string;
    periodStart: string;
    periodEnd: string;
    previousPlanId: string;
    previousPeriodEnd: string;
    previousPeriodStart: string;
    previousCancelAt: string | null;
    previousStatus: SubscriptionStatus;
    previousBillingRevision?: string;
    price: ReturnType<typeof snapshotBillingPrice>;
    billingAnchor?: ReturnType<typeof billingCalendarAnchor>;
    quote?: PlanChangeQuote;
    invoiceId?: string;
    paymentId?: string;
    paymentAttemptKey?: string;
}
const DAY = 86400000;
function fail(message: string, code: string = 'BILLING_CONFLICT'): never { throw new SubscriptionError(message, code, 409); }
const cleanRecovery = (metadata: Record<string, unknown> | null): Record<string, unknown> => {
    const result = { ...metadata };
    for (const key of ['dunningCycle', 'dunningStartedAt', 'dunningAttempts', 'lastDunningAttemptAt', 'lastPaymentError', 'lastPaymentFailedAt', 'pendingDowngradePlanId', 'pendingPlanChange', 'pendingPaymentId', 'pendingVerificationUrl'])
        delete result[key];
    return result;
};
const hydrateQuote = (raw: PlanChangeQuote): PlanChangeQuote => ({ ...raw, quotedAt: new Date(raw.quotedAt), validUntil: new Date(raw.validUntil), effectiveDate: new Date(raw.effectiveDate), periodStart: new Date(raw.periodStart), periodEnd: new Date(raw.periodEnd) });
const billingRevision = (sub: Subscription): string => typeof sub.metadata?.billingRevision === 'string' ? sub.metadata.billingRevision : 'legacy';
function purchaseStillCurrent(sub: Subscription, purchase: Purchase): boolean {
    return sub.planId === purchase.previousPlanId && sub.currentPeriodStart.toISOString() === purchase.previousPeriodStart &&
        sub.currentPeriodEnd.toISOString() === purchase.previousPeriodEnd && (sub.cancelAt?.toISOString() ?? null) === purchase.previousCancelAt &&
        (purchase.previousBillingRevision === undefined || billingRevision(sub) === purchase.previousBillingRevision) &&
        ['active', 'trialing', 'past_due', 'incomplete'].includes(sub.status) &&
        (purchase.kind !== 'change' || sub.status === purchase.previousStatus);
}
export class SubscriptionsService<TFeatures extends FeatureRegistry> {
    private readonly cache: CacheAdapter;
    private readonly providers: ProviderRegistry;
    private readonly logger: SubscriptionsLogger;
    constructor(private readonly db: DatabaseAdapter<TFeatures>, cache?: CacheAdapter, _payment?: PaymentGatewayAdapter, private readonly options: SubscriptionsServiceOptions = {}) {
        this.cache = cache ?? noopCacheAdapter;
        if (cache && cache !== noopCacheAdapter && !options.cacheNamespace?.trim())
            throw new SubscriptionError('cacheNamespace is required when using a cache', 'CACHE_NAMESPACE_REQUIRED');
        this.providers = options.providers ?? new ProviderRegistry();
        this.logger = options.logger ?? noopLogger;
        this.validateTrial(options.trialDays ?? 0);
    }
    /** Always read durable state. Subscription caches cannot authorize a financial operation. */
    async get(subscriberId: string): Promise<SubscriptionWithPlan<TFeatures> | null> { return this.db.subscriptions.findBySubscriber(subscriberId); }
    private async getOrThrow(id: string): Promise<SubscriptionWithPlan<TFeatures>> { const sub = await this.get(id); if (!sub)
        throw new SubscriptionNotFoundError(id); return sub; }
    private async plan(id: string): Promise<Plan<TFeatures>> { const plan = await this.db.plans.findById(id); if (!plan)
        throw new PlanNotFoundError(id); if (!plan.isActive)
        fail('Inactive plans cannot be purchased', 'PLAN_INACTIVE'); return plan; }
    private validateTrial(days: number): void { if (!Number.isSafeInteger(days) || days < 0 || days > 365)
        throw new SubscriptionError('Trial days must be an integer between 0 and 365', 'INVALID_TRIAL'); }
    private requireAtomic(): void { if (!this.db.capabilities?.asyncTransactions || !this.db.billingOperations || !this.db.outbox || !this.db.providerResources)
        fail('Billing requires awaited transactions, billing operations, provider mappings and a transaction-owned outbox; migrate the adapter first', 'BILLING_STORAGE_UNSUPPORTED'); }
    private async local<T>(fn: (tx: DatabaseAdapter<TFeatures>) => Promise<T>): Promise<T> { if (this.db.capabilities?.asyncTransactions)
        return this.db.transaction(fn); if (this.db.outbox)
        fail('This driver cannot atomically persist mutations and outbox records', 'BILLING_STORAGE_UNSUPPORTED'); return fn(this.db); }
    private async emit(tx: DatabaseAdapter<TFeatures>, type: string, id: string, subscriberId: string, data: Record<string, unknown>): Promise<void> {
        if (tx.outbox)
            await tx.outbox.insert({ id, type, subscriberId, data, occurredAt: new Date() });
    }
    private async invalidate(id: string): Promise<void> {
        const prefix = this.options.cacheNamespace ? `${this.options.cacheNamespace}:` : '';
        for (const key of [CacheKeys.subscription(id), CacheKeys.features(id)])
            try {
                await this.cache.delete(prefix + key);
            }
            catch (error) {
                this.logger.warn?.('Cache invalidation failed', error);
            }
    }
    private binding(sub: Subscription): ProviderBinding {
        if (!sub.billing)
            fail('Subscription requires an explicit provider/account/environment ownership backfill', 'PROVIDER_BINDING_REQUIRED');
        this.providers.resolve(sub.billing);
        return sub.billing;
    }
    private assertLocalBilling(sub: Subscription): ProviderBinding {
        const binding = this.binding(sub);
        if (binding.billingOwner !== 'sdk_managed')
            fail('Local billing cannot collect for a provider-managed subscription', 'PROVIDER_OWNS_BILLING');
        return binding;
    }
    private async providerCommand(sub: Subscription, command: 'cancel' | 'pause' | 'resume' | 'reactivate', cancelOptions?: CancelOptions): Promise<void> {
        if (!sub.billing) {
            if (sub.gatewaySubscriptionId)
                fail('Legacy remote subscriptions require ownership backfill', 'PROVIDER_BINDING_REQUIRED');
            return;
        }
        const binding = this.binding(sub);
        if (binding.billingOwner === 'sdk_managed')
            return;
        const adapter = this.providers.resolve(binding).adapter;
        if (adapter.capabilities?.nativeSubscriptions !== true)
            fail('Provider has no native subscription capability', 'UNSUPPORTED_OPERATION');
        const id = binding.externalSubscriptionId;
        if (!id)
            fail('Provider-managed subscription has no mapped external subscription', 'PROVIDER_RESOURCE_REQUIRED');
        if (command === 'cancel') {
            if (!adapter.cancelSubscription)
                fail('Provider does not support cancellation', 'UNSUPPORTED_OPERATION');
            await adapter.cancelSubscription(id, cancelOptions);
        }
        if (command === 'pause') {
            if (!adapter.pauseSubscription)
                fail('Provider does not support pause', 'UNSUPPORTED_OPERATION');
            await adapter.pauseSubscription(id);
        }
        if (command === 'resume') {
            if (!adapter.resumeSubscription)
                fail('Provider does not support resume', 'UNSUPPORTED_OPERATION');
            await adapter.resumeSubscription(id);
        }
        if (command === 'reactivate') {
            if (!adapter.updateSubscription)
                fail('Provider does not support reactivation', 'UNSUPPORTED_OPERATION');
            await adapter.updateSubscription(id, { cancelAtPeriodEnd: false });
        }
    }
    private async bindResources(tx: DatabaseAdapter<TFeatures>, sub: Subscription, binding: ProviderBinding): Promise<void> {
        if (!tx.providerResources)
            fail('Provider resource mapping migration is required', 'BILLING_STORAGE_UNSUPPORTED');
        const scope = { providerId: binding.providerId, accountId: binding.accountId, environment: binding.environment };
        if (binding.externalCustomerId)
            await tx.providerResources.bind({ ...scope, kind: 'customer', localId: sub.subscriberId, externalId: binding.externalCustomerId });
        if (binding.externalPaymentMethodId)
            await tx.providerResources.bind({ ...scope, kind: 'payment_method', localId: `${sub.subscriberId}:${binding.externalPaymentMethodId}`, externalId: binding.externalPaymentMethodId });
        if (binding.externalSubscriptionId)
            await tx.providerResources.bind({ ...scope, kind: 'subscription', localId: sub.id, externalId: binding.externalSubscriptionId });
    }
    async createSelfService(subscriberId: string, planId: string): Promise<Subscription> {
        const plan = await this.plan(planId);
        return this.create(subscriberId, planId, { policy: 'purchase', trialDays: plan.trialDays || this.options.trialDays || 0 });
    }
    async create(subscriberId: string, planId: string, options: CreateSubscriptionOptions = {}): Promise<Subscription> {
        for (const key of ['paidExternally', 'gatewayInvoiceId', 'verifiedTokenId', 'skipPayment'])
            if (key in options)
                fail(`Removed unsafe payment option: ${key}`, 'UNVERIFIED_PAYMENT');
        const plan = await this.plan(planId);
        this.validateTrial(options.trialDays ?? this.options.trialDays ?? 0);
        const billing = options.billing ?? this.providers.defaultBinding();
        if (billing)
            this.providers.resolve(billing);
        if (options.gatewayCustomerId)
            fail('Use billing.externalPaymentMethodId and externalCustomerId separately', 'AMBIGUOUS_PAYMENT_ID');
        const policy = options.policy ?? 'purchase';
        if (!['purchase', 'manual_invoice', 'complimentary'].includes(policy))
            fail('An explicit supported billing policy is required', 'BILLING_POLICY_REQUIRED');
        if (policy === 'manual_invoice' && plan.price > 0)
            this.requireAtomic();
        const now = new Date();
        const sub = await this.local(async (tx) => {
            const existing = await tx.subscriptions.findBySubscriber(subscriberId);
            if (existing && ['active', 'trialing', 'past_due', 'paused', 'incomplete'].includes(existing.status))
                throw new DuplicateSubscriptionError(subscriberId);
            const days = existing ? 0 : (options.trialDays ?? this.options.trialDays ?? 0);
            const trialEnd = days ? new Date(now.getTime() + days * DAY) : null;
            const status: SubscriptionStatus = trialEnd ? 'trialing' : plan.price === 0 || policy !== 'purchase' ? 'active' : 'incomplete';
            const end = trialEnd ?? calculateBillingPeriodEnd(now, plan.interval, plan.intervalCount);
            const metadata = { ...options.metadata, billingPolicy: policy, billingRevision: crypto.randomUUID(), billingAnchor: billingCalendarAnchor(now), trialUsed: !!trialEnd || !!existing?.metadata?.trialUsed };
            if (existing?.billing && options.billing && JSON.stringify(existing.billing) !== JSON.stringify(options.billing))
                fail('Existing billing ownership requires an explicit provider migration', 'PROVIDER_MIGRATION_REQUIRED');
            const effectiveBinding = existing?.billing ?? (existing && !options.billing ? undefined : billing);
            const data = { planId, status, currentPeriodStart: now, currentPeriodEnd: end, cancelAt: null, canceledAt: null, trialStart: trialEnd ? now : null, trialEnd, metadata, ...(effectiveBinding ? { billing: effectiveBinding } : {}) };
            const result = existing ? await tx.subscriptions.update(existing.id, data) : await tx.subscriptions.create({ ...data, subscriberId, subscriberType: this.options.subscriberType ?? 'tenant' });
            if (effectiveBinding)
                await this.bindResources(tx, result, effectiveBinding);
            if (policy === 'manual_invoice' && plan.price > 0) {
                if (!tx.capabilities?.asyncTransactions)
                    fail('Manual invoicing requires an atomic database', 'BILLING_STORAGE_UNSUPPORTED');
                await new InvoicesService(tx).create({ subscriptionId: result.id, amount: plan.price, currency: plan.currency, status: 'open', dueDate: end, lineItems: [{ description: plan.name, quantity: 1, unitPrice: plan.price, amount: plan.price }] });
            }
            await this.emit(tx, 'subscription.created', `subscription.created:${result.id}:${now.toISOString()}`, subscriberId, { subscriptionId: result.id, planId, status });
            return result;
        });
        await this.invalidate(subscriberId);
        return sub;
    }
    private paidPrice(sub: SubscriptionWithPlan<TFeatures>, creditRequired = true): BillingPriceSnapshot | undefined {
        if (sub.currentPeriodEnd <= new Date() || sub.status !== 'active')
            return undefined;
        const paid = sub.metadata?.paidPrice as BillingPriceSnapshot | undefined;
        if (paid)
            return paid;
        if (creditRequired && sub.status === 'active' && sub.plan.price > 0 && sub.metadata?.billingPolicy !== 'complimentary' && sub.metadata?.billingPolicy !== 'manual_invoice')
            fail('Paid-period price snapshot is missing; backfill verified historical price before proration', 'BILLING_PRICE_BACKFILL_REQUIRED');
        return undefined;
    }
    async previewChangePlan(subscriberId: string, newPlanId: string, options: ChangePlanOptions = {}): Promise<PlanChangePreview> {
        this.requireAtomic();
        const sub = await this.getOrThrow(subscriberId);
        const next = await this.plan(newPlanId);
        if (!['active', 'trialing'].includes(sub.status))
            throw new SubscriptionInactiveError(sub.status);
        const quote = quotePlanChange({ subscription: sub, currentPlan: sub.plan, newPlan: next, now: new Date(), ...options, hasPaidEntitlement: !!this.paidPrice(sub, options.immediately !== false && options.prorate !== false), ...(this.paidPrice(sub, options.immediately !== false && options.prorate !== false) ? { currentPaidPrice: this.paidPrice(sub, options.immediately !== false && options.prorate !== false)! } : {}) });
        const quoteId = crypto.randomUUID();
        await this.db.billingOperations!.reserve(`quote:${quoteId}`, { subscriberId, subscriptionId: sub.id, quote, subscriptionVersion: sub.updatedAt.toISOString(), billingRevision: billingRevision(sub) });
        return { currentPlan: { id: sub.plan.id, name: sub.plan.name, price: sub.plan.price, currency: sub.plan.currency }, newPlan: { id: next.id, name: next.name, price: next.price, currency: next.currency }, isUpgrade: quote.kind === 'upgrade', isDowngrade: quote.kind === 'downgrade', priceDifference: quote.priceDifference, daysRemaining: quote.daysRemaining, totalDays: quote.totalDays, prorationRatio: quote.prorationRatio, amountDue: quote.amountMinor, amountDueFormatted: quote.amountMajor, currency: quote.currency, effectiveDate: quote.effectiveDate, message: quote.timing === 'period_end' ? 'Change scheduled for the next renewal.' : `Amount due: ${quote.amountMajor} ${quote.currency}`, quoteId, validUntil: quote.validUntil };
    }
    async changePlan(subscriberId: string, newPlanId: string, options: ChangePlanOptions = {}): Promise<ChangePlanResult<TFeatures>> {
        for (const key of ['skipPayment', 'verifiedTokenId', 'paymentId', 'gatewayInvoiceId', 'tokenId', 'paidExternally'])
            if (key in options)
                fail(`Removed unsafe payment option: ${key}`, 'UNVERIFIED_PAYMENT');
        this.requireAtomic();
        const sub = await this.getOrThrow(subscriberId);
        const next = await this.plan(newPlanId);
        if (sub.planId === next.id)
            return { subscription: sub, charged: false };
        if (!['active', 'trialing'].includes(sub.status))
            throw new SubscriptionInactiveError(sub.status);
        if (sub.billing?.billingOwner === 'provider_managed')
            fail('Provider-managed plan changes require the owning provider integration', 'UNSUPPORTED_OPERATION');
        let quote: PlanChangeQuote;
        if (options.quoteId) {
            const stored = await this.db.billingOperations!.find(`quote:${options.quoteId}`);
            if (!stored || stored.payload.subscriberId !== subscriberId || stored.payload.subscriptionId !== sub.id)
                fail('Quote does not belong to this purchase', 'INVALID_QUOTE');
            quote = hydrateQuote(stored.payload.quote as PlanChangeQuote);
            if (quote.newPrice.planId !== newPlanId || quote.currentPrice.planId !== sub.planId || stored.payload.subscriptionVersion !== sub.updatedAt.toISOString() || (stored.payload.billingRevision !== undefined && stored.payload.billingRevision !== billingRevision(sub)) || new Date() >= quote.validUntil || JSON.stringify(quote.newPrice) !== JSON.stringify(snapshotBillingPrice(next)))
                fail('Quote changed or expired; preview and confirm again', 'QUOTE_EXPIRED');
            const paidPrice = this.paidPrice(sub, quote.timing === 'immediate' && quote.prorate);
            if (sub.status === 'active' && sub.plan.price > 0 && paidPrice && JSON.stringify(quote.currentPrice) !== JSON.stringify(paidPrice))
                fail('Paid-period price changed; preview again', 'QUOTE_EXPIRED');
            if (options.prorate !== undefined && options.prorate !== quote.prorate)
                fail('Quote proration changed; preview again', 'INVALID_QUOTE');
            if (options.immediately !== undefined && (options.immediately === false) !== (quote.timing === 'period_end'))
                fail('Quote timing changed; preview again', 'INVALID_QUOTE');
        }
        else {
            quote = quotePlanChange({ subscription: sub, currentPlan: sub.plan, newPlan: next, now: new Date(), ...options, hasPaidEntitlement: !!this.paidPrice(sub, options.immediately !== false && options.prorate !== false), ...(this.paidPrice(sub, options.immediately !== false && options.prorate !== false) ? { currentPaidPrice: this.paidPrice(sub, options.immediately !== false && options.prorate !== false)! } : {}) });
            if (quote.amountMinor > 0)
                fail('Preview and confirm quoteId before a payable plan change', 'QUOTE_REQUIRED');
        }
        if (quote.timing === 'period_end') {
            const updated = await this.db.transaction(async (tx) => {
                const current = await tx.subscriptions.findById(sub.id);
                if (!current || current.updatedAt.getTime() !== sub.updatedAt.getTime() || billingRevision(current) !== billingRevision(sub))
                    fail('Subscription changed; preview again');
                const result = await tx.subscriptions.update(sub.id, { metadata: { ...current.metadata, pendingDowngradePlanId: next.id, billingRevision: crypto.randomUUID() } });
                await this.emit(tx, 'subscription.plan_changed', `scheduled:${sub.id}:${next.id}:${sub.currentPeriodEnd.toISOString()}`, subscriberId, { subscriptionId: sub.id, newPlanId: next.id, effectiveAt: sub.currentPeriodEnd });
                return result;
            });
            await this.invalidate(subscriberId);
            return { subscription: { ...updated, plan: sub.plan }, charged: false, chargeAmount: 0 };
        }
        const binding = quote.amountMinor > 0 ? this.assertLocalBilling(sub) : (sub.billing ?? { providerId: 'manual', accountId: 'manual', environment: 'test', billingOwner: 'sdk_managed' } as ProviderBinding);
        const purchase: Purchase = { kind: 'change', subscriberId, subscriptionId: sub.id, binding, planId: next.id, amountMinor: quote.amountMinor, currency: quote.currency, periodStart: quote.periodStart.toISOString(), periodEnd: quote.periodEnd.toISOString(), previousPlanId: sub.planId, previousPeriodEnd: sub.currentPeriodEnd.toISOString(), previousPeriodStart: sub.currentPeriodStart.toISOString(), previousCancelAt: sub.cancelAt?.toISOString() ?? null, previousStatus: sub.status, previousBillingRevision: billingRevision(sub), price: quote.newPrice, quote };
        const key = `change:${sub.id}:${billingRevision(sub)}:${sub.planId}:${sub.currentPeriodEnd.toISOString()}:${next.id}:${JSON.stringify(quote.newPrice)}`;
        const result = await this.runPurchase(key, purchase, 0);
        const appliedPlan = result.subscription.planId === next.id ? next : await this.plan(result.subscription.planId);
        return { subscription: { ...result.subscription, plan: appliedPlan }, charged: !!result.paymentId, chargeAmount: purchase.amountMinor, ...(result.paymentId ? { paymentId: result.paymentId } : {}), ...(result.invoice ? { invoice: result.invoice } : {}) };
    }
    async renew(subscriberId: string, options: RenewSubscriptionOptions = {}): Promise<Subscription> {
        for (const key of ['skipPayment', 'paidExternally', 'gatewayInvoiceId'])
            if (key in options)
                fail(`Removed unsafe renewal option: ${key}`, 'UNVERIFIED_PAYMENT');
        this.requireAtomic();
        const sub = await this.getOrThrow(subscriberId);
        if (sub.billing?.billingOwner === 'provider_managed')
            fail('Local billing cannot collect for a provider-managed subscription', 'PROVIDER_OWNS_BILLING');
        if (sub.cancelAt && sub.cancelAt <= new Date())
            throw new SubscriptionInactiveError('canceled');
        if (['paused', 'canceled', 'unpaid', 'incomplete_expired'].includes(sub.status))
            throw new SubscriptionInactiveError(sub.status);
        if (sub.status === 'active' && sub.currentPeriodEnd > new Date())
            return sub;
        const planId = typeof sub.metadata?.pendingDowngradePlanId === 'string' ? sub.metadata.pendingDowngradePlanId : sub.planId;
        const plan = await this.plan(planId);
        const binding = plan.price > 0 || sub.billing ? this.assertLocalBilling(sub) : { providerId: 'manual', accountId: 'manual', environment: 'test', billingOwner: 'sdk_managed' } as ProviderBinding;
        const key = `renewal:${sub.id}:${sub.currentPeriodEnd.toISOString()}`;
        const existing = await this.db.billingOperations!.find(key);
        const periodStart = sub.status === 'incomplete' || sub.status === 'trialing' ? new Date() : sub.currentPeriodEnd;
        const anchor = sub.status === 'incomplete' || sub.status === 'trialing' ? billingCalendarAnchor(periodStart) : sub.metadata?.billingAnchor as {
                day: number;
                endOfMonth: boolean;
            } | undefined;
        const purchase: Purchase = (existing?.payload.purchase as Purchase | undefined) ?? { kind: 'renewal', subscriberId, subscriptionId: sub.id, binding, planId: plan.id, amountMinor: majorToMinor(plan.price, plan.currency), currency: plan.currency, periodStart: periodStart.toISOString(), periodEnd: calculateBillingPeriodEnd(periodStart, plan.interval, plan.intervalCount, anchor).toISOString(), billingAnchor: anchor ?? billingCalendarAnchor(periodStart), previousPlanId: sub.planId, previousPeriodEnd: sub.currentPeriodEnd.toISOString(), previousPeriodStart: sub.currentPeriodStart.toISOString(), previousCancelAt: sub.cancelAt?.toISOString() ?? null, previousStatus: sub.status, previousBillingRevision: billingRevision(sub), price: snapshotBillingPrice(plan) };
        return (await this.runPurchase(key, purchase, options.retryAttempt ?? 0)).subscription;
    }
    /** Server-only renewal policy for deliberate manual invoices or complimentary access. */
    async renewAdministrative(subscriberId: string, options: {
        policy: 'manual_invoice' | 'complimentary';
    }): Promise<Subscription> {
        this.requireAtomic();
        const sub = await this.getOrThrow(subscriberId);
        if (sub.billing?.billingOwner === 'provider_managed')
            fail('Administrative renewal cannot override provider-owned billing', 'PROVIDER_OWNS_BILLING');
        if (!['manual_invoice', 'complimentary'].includes(options.policy))
            fail('An explicit administrative policy is required', 'BILLING_POLICY_REQUIRED');
        const plan = await this.plan(typeof sub.metadata?.pendingDowngradePlanId === 'string' ? sub.metadata.pendingDowngradePlanId : sub.planId);
        const now = new Date();
        const start = sub.currentPeriodEnd > now ? sub.currentPeriodEnd : now;
        const end = calculateBillingPeriodEnd(start, plan.interval, plan.intervalCount);
        const result = await this.db.transaction(async (tx) => {
            const unresolved = await tx.billingOperations!.find(`billing-lock:${sub.id}`);
            if (unresolved && !['applied', 'failed'].includes(unresolved.status))
                fail('An unresolved payment must be reconciled before a manual grant', 'PAYMENT_OUTCOME_UNKNOWN');
            const latest = await tx.subscriptions.findById(sub.id);
            if (!latest || latest.updatedAt.getTime() !== sub.updatedAt.getTime())
                fail('Subscription changed');
            const metadata: Record<string, unknown> = { ...cleanRecovery(latest.metadata), billingPolicy: options.policy, billingRevision: crypto.randomUUID(), billingAnchor: billingCalendarAnchor(start) };
            delete metadata.paidPrice;
            delete metadata.paidThrough;
            const updated = await tx.subscriptions.update(sub.id, { status: 'active', planId: plan.id, currentPeriodStart: start, currentPeriodEnd: end, trialStart: null, trialEnd: null, metadata });
            if (options.policy === 'manual_invoice' && plan.price > 0)
                await new InvoicesService(tx).create({ subscriptionId: sub.id, amount: plan.price, currency: plan.currency, status: 'open', dueDate: end, lineItems: [{ description: plan.name, quantity: 1, unitPrice: plan.price, amount: plan.price }] });
            await this.emit(tx, 'subscription.renewed', `administrative:${sub.id}:${start.toISOString()}:${options.policy}`, subscriberId, { subscriptionId: sub.id, policy: options.policy });
            return updated;
        });
        await this.invalidate(subscriberId);
        return result;
    }
    private async runPurchase(key: string, purchase: Purchase, retry: number): Promise<{
        subscription: Subscription;
        invoice?: Invoice;
        paymentId?: string;
    }> {
        const base = await this.db.transaction(async (tx) => {
            const current = await tx.subscriptions.findById(purchase.subscriptionId);
            if (!current)
                fail('Subscription missing');
            if (purchase.binding.providerId !== 'manual')
                await this.bindResources(tx, current, purchase.binding);
            const result = (await tx.billingOperations!.reserve(key, { purchase })).record;
            if (result.status === 'applied')
                return result;
            if (result.status !== 'succeeded' && !purchaseStillCurrent(current, result.payload.purchase as Purchase))
                fail('Subscription changed before collection; preview again', 'STALE_SETTLEMENT');
            const latest = result.payload.latestAttempt as number | undefined;
            if (result.status !== 'succeeded') {
                if (latest === undefined && retry !== 0)
                    fail('Initial collection must be attempt zero', 'INVALID_RETRY');
                if (latest !== undefined) {
                    const prior = await tx.billingOperations!.find(`${key}:attempt:${latest}`);
                    if (retry !== latest && (retry !== latest + 1 || prior?.status !== 'failed'))
                        fail('Only a confirmed failed attempt permits one next retry', 'PAYMENT_OUTCOME_UNKNOWN');
                    if (retry === latest && prior?.status === 'failed')
                        return result;
                }
            }
            const lockKey = `billing-lock:${purchase.subscriptionId}`;
            const lock = (await tx.billingOperations!.reserve(lockKey, { purchaseKey: key })).record;
            if (lock.payload.purchaseKey !== key) {
                if (!['applied', 'failed'].includes(lock.status) || !await tx.billingOperations!.compareAndSet(lockKey, lock.status, { status: 'collecting', payload: { purchaseKey: key } }))
                    fail('Another purchase for this subscription is unresolved', 'PAYMENT_IN_PROGRESS');
            }
            else if (['reserved', 'failed'].includes(lock.status))
                await tx.billingOperations!.compareAndSet(lockKey, lock.status, { status: 'collecting' });
            return result;
        });
        const persisted = base.payload.purchase as Purchase;
        purchase = persisted;
        if (base.status === 'applied')
            return this.purchaseResult(base, purchase);
        if (purchase.amountMinor === 0) {
            await this.db.billingOperations!.compareAndSet(key, 'reserved', { status: 'succeeded' });
            return this.applyPurchase(key);
        }
        if (base.status === 'succeeded')
            return this.applyPurchase(key);
        const binding = purchase.binding;
        const adapter = this.providers.resolve(binding).adapter;
        if (binding.billingOwner !== 'sdk_managed')
            fail('Provider owns billing', 'PROVIDER_OWNS_BILLING');
        if (!adapter.chargePayment || adapter.capabilities?.idempotentCharges !== true)
            fail('Provider must support idempotent direct payments', 'UNSUPPORTED_OPERATION');
        const current = await this.getOrThrow(purchase.subscriberId);
        const paymentMethodId = binding.externalPaymentMethodId;
        if (!paymentMethodId)
            throw new PaymentFailedError('No mapped reusable payment method');
        if (!Number.isSafeInteger(retry) || retry < 0)
            fail('Invalid retry attempt');
        const attemptKey = `${key}:attempt:${retry}`;
        const attempt = await this.db.transaction(async (tx) => {
            const parent = await tx.billingOperations!.find(key);
            if (!parent)
                fail('Purchase missing');
            const latest = parent.payload.latestAttempt as number | undefined;
            if (latest !== undefined && latest !== retry) {
                if (retry !== latest + 1)
                    fail('Retry must advance one confirmed failed attempt', 'INVALID_RETRY');
                const previous = await tx.billingOperations!.find(`${key}:attempt:${latest}`);
                if (previous?.status !== 'failed')
                    fail('Previous payment outcome is unresolved; reconcile before retrying', 'PAYMENT_OUTCOME_UNKNOWN');
            }
            else if (latest === undefined && retry !== 0)
                fail('Initial collection must be attempt zero', 'INVALID_RETRY');
            const result = (await tx.billingOperations!.reserve(attemptKey, { purchaseKey: key, subscriberId: purchase.subscriberId, subscriptionId: purchase.subscriptionId, binding, idempotencyKey: crypto.randomUUID() })).record;
            await tx.billingOperations!.update(key, { status: parent.status, payload: { ...parent.payload, latestAttempt: retry } });
            return result;
        });
        let result = attempt.payload.result as ChargePaymentResult | undefined;
        if (attempt.status === 'succeeded')
            return this.applyPurchase(key);
        if (attempt.status === 'failed')
            throw new PaymentFailedError(result?.errorMessage ?? 'Confirmed payment failure', result?.id);
        if (['unknown', 'collecting'].includes(attempt.status)) {
            if (!adapter.getPayment)
                fail('Payment outcome requires reconciliation; no further collection is allowed', 'PAYMENT_OUTCOME_UNKNOWN');
            const lookupId = result?.id || attempt.payload.idempotencyKey as string;
            const payment = await adapter.getPayment(lookupId);
            if (payment && payment.id !== lookupId)
                fail('Provider lookup returned another payment resource', 'SETTLEMENT_MISMATCH');
            if (!payment || !['paid', 'failed'].includes(payment.status))
                fail('Payment outcome is unresolved; do not retry collection', 'PAYMENT_OUTCOME_UNKNOWN');
            result = { id: payment.id, status: payment.status === 'paid' ? 'paid' : 'failed', amount: payment.amount, currency: payment.currency, ...(payment.errorMessage ? { errorMessage: payment.errorMessage } : {}) };
        }
        else {
            const acquired = await this.db.billingOperations!.compareAndSet(attemptKey, 'reserved', { status: 'collecting' });
            if (!acquired)
                fail('Another worker is collecting this purchase', 'PAYMENT_IN_PROGRESS');
            try {
                result = await adapter.chargePayment({ customerId: binding.externalCustomerId ?? paymentMethodId, paymentMethodId, amount: purchase.amountMinor, currency: purchase.currency, idempotencyKey: attempt.payload.idempotencyKey as string, description: `${purchase.kind} ${purchase.planId}`, metadata: { subscriberId: purchase.subscriberId, subscriptionId: purchase.subscriptionId, planId: purchase.planId, type: purchase.kind, paymentAttemptKey: attemptKey, purchaseKey: key, providerId: binding.providerId, accountId: binding.accountId, environment: binding.environment } });
            }
            catch (error) {
                await this.db.billingOperations!.compareAndSet(attemptKey, 'collecting', { status: 'unknown', payload: { ...attempt.payload, error: error instanceof Error ? error.message : 'Provider transport error' } });
                fail('Provider outcome is unknown; reconcile before another collection', 'PAYMENT_OUTCOME_UNKNOWN');
            }
        }
        if (['paid', 'failed'].includes(result.status) && ((result.status === 'paid' && !result.id) || (adapter.provider === 'moyasar' && !!result.id && result.id !== attempt.payload.idempotencyKey) || result.amount !== purchase.amountMinor || result.currency.toUpperCase() !== purchase.currency.toUpperCase())) {
            await this.db.billingOperations!.update(attemptKey, { status: 'unknown', payload: { ...attempt.payload, result } });
            fail('Provider settlement disagrees with the immutable quote', 'SETTLEMENT_MISMATCH');
        }
        await this.db.transaction(async (tx) => {
            const latest = await tx.billingOperations!.find(attemptKey);
            if (!latest)
                fail('Payment attempt missing');
            const committed = await tx.billingOperations!.find(key);
            if (committed?.status === 'applied' || (committed?.status === 'succeeded' && result!.status !== 'paid') || (latest.status === 'succeeded' && result!.status !== 'paid'))
                return;
            if (result!.status === 'failed') {
                if (latest.status !== 'failed')
                    await this.applyFailureToCurrentPurchase(tx, key, purchase, attemptKey, result!.errorMessage ?? 'Confirmed renewal failure');
            }
            await tx.billingOperations!.update(attemptKey, { status: result!.status === 'paid' ? 'succeeded' : result!.status === 'failed' ? 'failed' : 'unknown', payload: { ...latest.payload, result } });
            if (result!.status === 'paid') {
                const parent = await tx.billingOperations!.find(key);
                if (!parent)
                    fail('Purchase missing');
                if (parent.status !== 'applied')
                    await tx.billingOperations!.update(key, { status: 'succeeded', payload: { ...parent.payload, purchase: { ...purchase, paymentId: result!.id, paymentAttemptKey: attemptKey } } });
            }
        });
        const committed = await this.db.billingOperations!.find(key);
        if (committed?.status === 'applied')
            return this.purchaseResult(committed, committed.payload.purchase as Purchase);
        if (committed?.status === 'succeeded')
            return this.applyPurchase(key);
        if (result.status !== 'paid') {
            if (result.status === 'failed')
                await this.invalidate(purchase.subscriberId);
            throw new PaymentFailedError(result.status === 'failed' ? (result.errorMessage ?? 'Payment failed') : 'Payment is pending, authorized, or unknown; reconcile without another charge', result.id, result.errorCode, result.isRetryable, result.userAction);
        }
        return this.applyPurchase(key);
    }
    /** Server-only recovery. Never initiates collection or grants stale canceled/paused state. */
    async reconcilePayment(subscriberId: string, purchaseKey: string): Promise<{
        state: 'applied' | 'failed' | 'unknown' | 'requires_review';
        paymentId?: string;
        invoiceId?: string;
        reason?: string;
    }> {
        this.requireAtomic();
        const base = await this.db.billingOperations!.find(purchaseKey);
        const purchase = base?.payload.purchase as Purchase | undefined;
        if (!base || !purchase || purchase.subscriberId !== subscriberId)
            fail('Purchase does not belong to subscriber', 'UNVERIFIED_PAYMENT');
        const index = base.payload.latestAttempt as number | undefined;
        const attempt = index === undefined ? null : await this.db.billingOperations!.find(`${purchaseKey}:attempt:${index}`);
        if (base.status !== 'applied' && base.status !== 'succeeded' && (!attempt || attempt.status === 'reserved'))
            return { state: 'unknown', reason: 'No provider outcome is recorded; reconciliation does not initiate collection' };
        try {
            const result = await this.runPurchase(purchaseKey, purchase, index ?? 0);
            return { state: 'applied', ...(result.paymentId ? { paymentId: result.paymentId } : {}), ...(result.invoice ? { invoiceId: result.invoice.id } : {}) };
        }
        catch (error) {
            const latest = index === undefined ? null : await this.db.billingOperations!.find(`${purchaseKey}:attempt:${index}`);
            const state = latest?.status === 'failed' ? 'failed' : error instanceof SubscriptionError && ['STALE_SETTLEMENT', 'DUPLICATE_SETTLEMENT', 'SETTLEMENT_MISMATCH'].includes(error.code) ? 'requires_review' : 'unknown';
            const reason = error instanceof Error ? error.message : 'Reconciliation failed';
            await this.db.transaction(async (tx) => { const record = await tx.billingOperations!.find(purchaseKey); if (record && record.status !== 'applied')
                await tx.billingOperations!.update(purchaseKey, { status: record.status, payload: { ...record.payload, reconciliation: { state, reason, checkedAt: new Date().toISOString() } } }); });
            return { state, reason };
        }
    }
    private async purchaseResult(record: BillingOperationRecord, purchase: Purchase): Promise<{
        subscription: Subscription;
        invoice?: Invoice;
        paymentId?: string;
    }> {
        const sub = await this.db.subscriptions.findById(purchase.subscriptionId);
        if (!sub)
            throw new SubscriptionNotFoundError(purchase.subscriberId);
        const id = record.payload.invoiceId as string | undefined;
        const invoice = id ? await this.db.invoices.findById(id) : null;
        return { subscription: sub, ...(invoice ? { invoice } : {}), ...(purchase.paymentId ? { paymentId: purchase.paymentId } : {}) };
    }
    private async applyPurchase(key: string): Promise<{
        subscription: Subscription;
        invoice?: Invoice;
        paymentId?: string;
    }> {
        const result = await this.db.transaction(async (tx) => {
            const record = await tx.billingOperations!.find(key);
            if (!record)
                fail('Purchase not found');
            const purchase = record.payload.purchase as Purchase;
            if (record.status === 'applied') {
                const sub = await tx.subscriptions.findById(purchase.subscriptionId);
                if (!sub)
                    fail('Subscription missing');
                const invoice = record.payload.invoiceId ? await tx.invoices.findById(record.payload.invoiceId as string) : null;
                return { subscription: sub, ...(invoice ? { invoice } : {}), ...(purchase.paymentId ? { paymentId: purchase.paymentId } : {}) };
            }
            if (record.status !== 'succeeded')
                fail('Purchase has no verified settlement', 'UNVERIFIED_PAYMENT');
            const current = await tx.subscriptions.findById(purchase.subscriptionId);
            if (!current)
                fail('Subscription missing');
            const lock = await tx.billingOperations!.find(`billing-lock:${purchase.subscriptionId}`);
            if (lock?.payload.purchaseKey !== key || !purchaseStillCurrent(current, purchase))
                fail('Stale settlement requires reconciliation', 'STALE_SETTLEMENT');
            const plan = await tx.plans.findById(purchase.planId);
            if (!plan)
                throw new PlanNotFoundError(purchase.planId);
            if (!plan.isActive)
                fail('Target plan became inactive; settlement requires reconciliation', 'STALE_SETTLEMENT');
            if (!await tx.billingOperations!.compareAndSet(key, 'succeeded', { status: 'applied' }))
                fail('Purchase is being applied');
            let invoice: Invoice | undefined;
            if (purchase.amountMinor > 0) {
                if (!purchase.paymentId)
                    fail('Settlement has no payment resource', 'UNVERIFIED_PAYMENT');
                await tx.providerResources!.bind({ providerId: purchase.binding.providerId, accountId: purchase.binding.accountId, environment: purchase.binding.environment, kind: 'payment', localId: purchase.paymentAttemptKey ?? key, externalId: purchase.paymentId });
                const amount = minorToMajor(purchase.amountMinor, purchase.currency);
                invoice = await new InvoicesService(tx).create({ subscriptionId: current.id, amount, currency: purchase.currency, status: 'paid', paidAt: new Date(), gatewayInvoiceId: scopedProviderReference(purchase.binding, purchase.paymentId), lineItems: [{ description: `${purchase.kind}: ${plan.name}`, quantity: 1, unitPrice: amount, amount }], metadata: { purchaseKey: key, paymentId: purchase.paymentId, paymentAttemptKey: purchase.paymentAttemptKey } });
                await this.emit(tx, 'invoice.paid', `invoice.paid:${scopedProviderReference(purchase.binding, purchase.paymentId)}`, current.subscriberId, { invoiceId: invoice.id, amount, currency: purchase.currency });
            }
            const metadata = { ...cleanRecovery(current.metadata), paidThrough: purchase.periodEnd, paidPrice: purchase.price, billingPolicy: 'purchase', billingRevision: crypto.randomUUID(), ...(purchase.billingAnchor ? { billingAnchor: purchase.billingAnchor } : (purchase.kind === 'change' && !purchase.quote?.preserveAnchor) ? { billingAnchor: billingCalendarAnchor(new Date(purchase.periodStart)) } : {}) };
            const subscription = await tx.subscriptions.update(current.id, { planId: purchase.planId, status: 'active', currentPeriodStart: new Date(purchase.periodStart), currentPeriodEnd: new Date(purchase.periodEnd), trialStart: null, trialEnd: null, metadata });
            await tx.billingOperations!.update(`billing-lock:${purchase.subscriptionId}`, { status: 'applied' });
            await tx.billingOperations!.update(key, { status: 'applied', payload: { ...record.payload, ...(invoice ? { invoiceId: invoice.id } : {}) } });
            await this.emit(tx, purchase.kind === 'renewal' ? 'subscription.renewed' : 'subscription.plan_changed', `${purchase.kind}:${key}`, current.subscriberId, { subscriptionId: current.id, planId: purchase.planId, currentPeriodEnd: purchase.periodEnd });
            return { subscription, ...(invoice ? { invoice } : {}), ...(purchase.paymentId ? { paymentId: purchase.paymentId } : {}) };
        });
        await this.invalidate(result.subscription.subscriberId);
        return result;
    }
    /** Only known server-created attempts may turn provider payment events into entitlement. */
    async acceptPaymentEvent(registrationId: string, event: WebhookEvent): Promise<void> {
        const data = event.data;
        const metadata = data.metadata as Record<string, string> | undefined;
        if (!metadata?.paymentAttemptKey)
            return;
        this.requireAtomic();
        const attempt = await this.db.billingOperations!.find(metadata.paymentAttemptKey);
        if (!attempt)
            fail('Payment attempt not found', 'UNVERIFIED_PAYMENT');
        const binding = attempt.payload.binding as ProviderBinding;
        const registered = this.providers.get(registrationId);
        if (binding.providerId !== registrationId || binding.accountId !== registered.accountId || binding.environment !== registered.environment)
            fail('Webhook provider binding mismatch', 'PROVIDER_BINDING_MISMATCH');
        if (metadata.subscriberId !== attempt.payload.subscriberId || metadata.subscriptionId !== attempt.payload.subscriptionId || metadata.purchaseKey !== attempt.payload.purchaseKey || metadata.providerId !== binding.providerId || metadata.accountId !== binding.accountId || metadata.environment !== binding.environment)
            fail('Webhook purchase binding mismatch', 'UNVERIFIED_PAYMENT');
        const base = await this.db.billingOperations!.find(attempt.payload.purchaseKey as string);
        if (!base)
            fail('Purchase not found');
        const purchase = base.payload.purchase as Purchase;
        const paymentId = typeof data.paymentId === 'string' ? data.paymentId : data.id;
        if (registered.adapter.provider === 'moyasar' && paymentId !== attempt.payload.idempotencyKey)
            fail('Moyasar payment resource does not match persisted given_id', 'SETTLEMENT_MISMATCH');
        if (typeof paymentId !== 'string' || data.amount !== purchase.amountMinor || typeof data.currency !== 'string' || data.currency.toUpperCase() !== purchase.currency.toUpperCase())
            fail('Webhook settlement mismatch', 'SETTLEMENT_MISMATCH');
        const recorded = attempt.payload.result as ChargePaymentResult | undefined;
        if (recorded?.id && recorded.id !== paymentId)
            fail('Payment resource does not match attempt', 'SETTLEMENT_MISMATCH');
        if (base.status === 'applied') {
            if (purchase.paymentId !== paymentId)
                fail('Another settlement for an applied purchase requires reconciliation', 'DUPLICATE_SETTLEMENT');
            return;
        }
        if (event.type === 'payment.paid') {
            await this.db.transaction(async (tx) => {
                const live = await tx.billingOperations!.find(base.key);
                if (!live)
                    fail('Purchase missing');
                if (live.status === 'applied')
                    return;
                await tx.billingOperations!.update(attempt.key, { status: 'succeeded', payload: { ...attempt.payload, result: { id: paymentId, status: 'paid', amount: data.amount, currency: data.currency } } });
                await tx.billingOperations!.update(base.key, { status: 'succeeded', payload: { ...live.payload, purchase: { ...purchase, paymentId, paymentAttemptKey: attempt.key } } });
            });
            await this.applyPurchase(base.key);
        }
        else if (event.type === 'payment.failed') {
            await this.db.transaction(async (tx) => {
                const latest = await tx.billingOperations!.find(attempt.key);
                const parent = await tx.billingOperations!.find(base.key);
                if (!latest || !parent || ['succeeded', 'failed'].includes(latest.status) || ['applied', 'succeeded'].includes(parent.status))
                    return;
                const guard = await tx.billingOperations!.reserve(`failure-event:${scopedProviderReference(binding, paymentId as string)}`, {});
                if (!guard.created)
                    return;
                await tx.billingOperations!.update(attempt.key, { status: 'failed', payload: { ...latest.payload, result: { id: paymentId, status: 'failed', amount: data.amount, currency: data.currency } } });
                await this.applyFailureToCurrentPurchase(tx, base.key, purchase, attempt.key, typeof data.message === 'string' ? data.message : 'Verified renewal failure');
                await tx.billingOperations!.update(guard.record.key, { status: 'applied' });
            });
            await this.invalidate(purchase.subscriberId);
        }
    }
    private async applyFailureToCurrentPurchase(tx: DatabaseAdapter<TFeatures>, key: string, purchase: Purchase, attemptKey: string, message: string): Promise<void> {
        const lockKey = `billing-lock:${purchase.subscriptionId}`;
        const lock = await tx.billingOperations!.find(lockKey);
        const parent = await tx.billingOperations!.find(key);
        if (lock?.payload.purchaseKey !== key || attemptKey !== `${key}:attempt:${parent?.payload.latestAttempt}`)
            return;
        await tx.billingOperations!.update(lockKey, { status: 'failed' });
        const current = await tx.subscriptions.findById(purchase.subscriptionId);
        if (purchase.kind === 'renewal' && current && purchaseStillCurrent(current, purchase))
            await this.recordFailureInTransaction(tx, purchase.subscriberId, message, attemptKey);
    }
    /** Incoming snapshots never prove payment and never issue provider commands. */
    async acceptSubscriptionSnapshot(registrationId: string, event: WebhookEvent): Promise<void> {
        const metadata = event.data.metadata as Record<string, string> | undefined;
        if (!metadata?.subscriberId)
            return;
        const sub = await this.getOrThrow(metadata.subscriberId);
        const binding = this.binding(sub);
        if (binding.providerId !== registrationId || binding.externalSubscriptionId !== event.data.id)
            fail('Snapshot resource binding mismatch', 'PROVIDER_BINDING_MISMATCH');
        const last = typeof sub.metadata?.providerEventAt === 'string' ? new Date(sub.metadata.providerEventAt).getTime() : 0;
        if (event.createdAt.getTime() <= last)
            return;
        const deleted = ['customer.subscription.deleted', 'subscription.deleted'].includes(event.type);
        const status = event.data.status;
        const safeStatus: SubscriptionStatus | undefined = deleted ? 'canceled' : status === 'past_due' ? 'past_due' : status === 'paused' ? 'paused' : status === 'canceled' ? 'canceled' : undefined;
        if (!safeStatus)
            return;
        this.requireAtomic();
        await this.db.transaction(async (tx) => {
            const guard = await tx.billingOperations!.reserve(`snapshot:${registrationId}:${event.id}`, {});
            if (!guard.created)
                return;
            const live = await tx.subscriptions.findById(sub.id);
            if (!live)
                return;
            const appliedAt = typeof live.metadata?.providerEventAt === 'string' ? new Date(live.metadata.providerEventAt).getTime() : 0;
            if (event.createdAt.getTime() <= appliedAt)
                return;
            await tx.subscriptions.update(sub.id, { status: safeStatus, metadata: { ...live.metadata, providerEventAt: event.createdAt.toISOString() } });
            await tx.billingOperations!.update(guard.record.key, { status: 'applied' });
            await this.emit(tx, deleted ? 'subscription.canceled' : 'subscription.updated', guard.record.key, sub.subscriberId, { subscriptionId: sub.id, status: safeStatus });
        });
        await this.invalidate(sub.subscriberId);
    }
    async cancel(subscriberId: string, options?: CancelOptions): Promise<Subscription> {
        const sub = await this.getOrThrow(subscriberId);
        if (sub.status === 'canceled')
            throw new SubscriptionInactiveError('canceled');
        await this.providerCommand(sub, 'cancel', options);
        const now = new Date();
        const result = await this.local(async (tx) => { const updated = await tx.subscriptions.update(sub.id, { canceledAt: now, cancelAt: options?.immediately ? now : sub.currentPeriodEnd, ...(options?.immediately ? { status: 'canceled' as const } : {}), ...(options?.reason ? { metadata: { ...sub.metadata, cancelReason: options.reason } } : {}) }); await this.emit(tx, 'subscription.canceled', `cancel:${sub.id}:${now.toISOString()}`, subscriberId, { subscriptionId: sub.id, immediately: !!options?.immediately }); return updated; });
        await this.invalidate(subscriberId);
        return result;
    }
    async pause(subscriberId: string): Promise<Subscription> {
        const sub = await this.getOrThrow(subscriberId);
        if (!['active', 'trialing'].includes(sub.status))
            throw new SubscriptionInactiveError(sub.status);
        await this.providerCommand(sub, 'pause');
        const result = await this.local(async (tx) => { const updated = await tx.subscriptions.update(sub.id, { status: 'paused', metadata: { ...sub.metadata, pausedAt: new Date().toISOString(), prePauseStatus: sub.status, pauseReason: 'voluntary' } }); await this.emit(tx, 'subscription.paused', `pause:${sub.id}:${updated.updatedAt.toISOString()}`, subscriberId, { subscriptionId: sub.id }); return updated; });
        await this.invalidate(subscriberId);
        return result;
    }
    async resume(subscriberId: string): Promise<Subscription> {
        const sub = await this.getOrThrow(subscriberId);
        if (sub.status !== 'paused')
            throw new SubscriptionInactiveError(sub.status);
        if (sub.metadata?.pauseReason !== 'voluntary' || !['active', 'trialing'].includes(sub.metadata?.prePauseStatus as string))
            fail('Payment suspension requires settlement, not resume', 'PAYMENT_REQUIRED');
        await this.providerCommand(sub, 'resume');
        const pausedAt = new Date(sub.metadata.pausedAt as string);
        if (!Number.isFinite(pausedAt.getTime()))
            fail('Missing pause timestamp');
        const pauseMs = Math.max(0, Date.now() - pausedAt.getTime());
        const metadata = { ...sub.metadata };
        delete metadata.pausedAt;
        delete metadata.prePauseStatus;
        delete metadata.pauseReason;
        const providerOwned = sub.billing?.billingOwner === 'provider_managed';
        const result = await this.local(async (tx) => { const updated = await tx.subscriptions.update(sub.id, { status: sub.metadata!.prePauseStatus as SubscriptionStatus, metadata, ...(!providerOwned ? { currentPeriodEnd: new Date(sub.currentPeriodEnd.getTime() + pauseMs), ...(sub.trialEnd ? { trialEnd: new Date(sub.trialEnd.getTime() + pauseMs) } : {}) } : {}) }); await this.emit(tx, 'subscription.resumed', `resume:${sub.id}:${updated.updatedAt.toISOString()}`, subscriberId, { subscriptionId: sub.id }); return updated; });
        await this.invalidate(subscriberId);
        return result;
    }
    async reactivate(subscriberId: string): Promise<Subscription> {
        const sub = await this.getOrThrow(subscriberId);
        if (!['active', 'trialing'].includes(sub.status) || sub.currentPeriodEnd <= new Date())
            throw new SubscriptionInactiveError(sub.status);
        if (!sub.cancelAt && !sub.canceledAt)
            throw new SubscriptionNotCanceledError();
        await this.providerCommand(sub, 'reactivate');
        const result = await this.local(async (tx) => { const updated = await tx.subscriptions.update(sub.id, { cancelAt: null, canceledAt: null }); await this.emit(tx, 'subscription.reactivated', `reactivate:${sub.id}:${updated.updatedAt.toISOString()}`, subscriberId, { subscriptionId: sub.id }); return updated; });
        await this.invalidate(subscriberId);
        return result;
    }
    async startTrial(id: string, planId: string, days: number): Promise<Subscription> { this.validateTrial(days); return this.create(id, planId, { trialDays: days }); }
    async extendTrial(id: string, days: number): Promise<Subscription> { this.validateTrial(days); const sub = await this.getOrThrow(id); if (sub.status !== 'trialing' || !sub.trialEnd)
        throw new SubscriptionInactiveError(sub.status); const trialEnd = new Date(sub.trialEnd.getTime() + days * DAY); const result = await this.db.subscriptions.update(sub.id, { trialEnd, currentPeriodEnd: trialEnd }); await this.invalidate(id); return result; }
    async isActive(id: string): Promise<boolean> { const sub = await this.get(id); if (!sub || !['active', 'trialing', 'past_due'].includes(sub.status))
        return false; const now = Date.now(); return (!sub.cancelAt || sub.cancelAt.getTime() > now) && now < sub.currentPeriodEnd.getTime() + (sub.status === 'trialing' ? 0 : (this.options.gracePeriodDays ?? 0) * DAY); }
    async isTrialing(id: string): Promise<boolean> { const sub = await this.get(id); return sub?.status === 'trialing' && await this.isActive(id); }
    async daysRemaining(id: string): Promise<number> { const sub = await this.get(id); return sub ? Math.max(0, Math.ceil(((sub.trialEnd ?? sub.currentPeriodEnd).getTime() - Date.now()) / DAY)) : 0; }
    private async recordFailureInTransaction(tx: DatabaseAdapter<TFeatures>, id: string, message: string, failureIdentity: string = crypto.randomUUID()): Promise<Subscription | null> {
        const sub = await tx.subscriptions.findBySubscriber(id);
        if (!sub)
            return null;
        const cycle = sub.currentPeriodEnd.toISOString();
        const metadata = sub.metadata ?? {};
        const same = metadata.dunningCycle === cycle;
        const eligible = ['active', 'trialing', 'past_due', 'incomplete'].includes(sub.status) && (!sub.cancelAt || sub.cancelAt > new Date());
        const updated = await tx.subscriptions.update(sub.id, { ...(eligible ? { status: 'past_due' as const } : {}), metadata: { ...metadata, lastPaymentError: message, lastPaymentFailedAt: new Date().toISOString(), dunningCycle: cycle, dunningStartedAt: same ? metadata.dunningStartedAt : new Date().toISOString(), dunningAttempts: same ? metadata.dunningAttempts ?? 0 : 0 } });
        await this.emit(tx, 'subscription.payment_failed', `failure:${failureIdentity}`, id, { subscriptionId: sub.id, message, cycle });
        return updated;
    }
    async recordPaymentFailure(id: string, message: string): Promise<Subscription | null> {
        const result = await this.local(tx => this.recordFailureInTransaction(tx, id, message));
        await this.invalidate(id);
        return result;
    }
    private async reserveDunningSlot(sub: Subscription, due: number, retryCount: number): Promise<{ attempts: number; cycleKey: string; retry?: number } | null> {
        return this.db.transaction(async tx => {
            const live = await tx.subscriptions.findById(sub.id);
            const cycle = sub.currentPeriodEnd.toISOString();
            if (!live || live.status !== 'past_due' || live.currentPeriodEnd.toISOString() !== cycle)
                return null;
            const attempts = typeof live.metadata?.dunningAttempts === 'number' ? live.metadata.dunningAttempts : 0;
            const cycleKey = `renewal:${sub.id}:${cycle}`;
            if (attempts >= due || attempts >= retryCount)
                return { attempts, cycleKey };
            const purchase = await tx.billingOperations!.find(cycleKey);
            const latest = purchase?.payload.latestAttempt as number | undefined;
            const prior = latest === undefined ? null : await tx.billingOperations!.find(`${cycleKey}:attempt:${latest}`);
            const retry = latest === undefined ? 0 : prior?.status === 'failed' ? latest + 1 : latest;
            // Concurrent sweeps for one scheduled retry share the same durable provider attempt.
            const slot = await tx.billingOperations!.reserve(`dunning-slot:${sub.id}:${cycle}:${attempts}`, { retry });
            return { attempts, cycleKey, retry: slot.record.payload.retry as number };
        });
    }
    private async countDunningFailure(sub: Subscription, attemptKey: string, now: Date): Promise<number | null> {
        return this.db.transaction(async tx => {
            const live = await tx.subscriptions.findById(sub.id);
            const attempt = await tx.billingOperations!.find(attemptKey);
            const cycle = sub.currentPeriodEnd.toISOString();
            if (!live || live.status !== 'past_due' || live.currentPeriodEnd.toISOString() !== cycle || live.metadata?.dunningCycle !== cycle || attempt?.status !== 'failed')
                return null;
            const purchase = await tx.billingOperations!.find(attempt.payload.purchaseKey as string);
            if (!purchase || ['applied', 'succeeded'].includes(purchase.status) || !purchaseStillCurrent(live, purchase.payload.purchase as Purchase))
                return null;
            const count = typeof live.metadata.dunningAttempts === 'number' ? live.metadata.dunningAttempts : 0;
            if (attempt.payload.dunningCounted)
                return count;
            await tx.billingOperations!.update(attemptKey, { status: 'failed', payload: { ...attempt.payload, dunningCounted: true } });
            await tx.subscriptions.update(sub.id, { metadata: { ...live.metadata, dunningAttempts: count + 1, lastDunningAttemptAt: now.toISOString() } });
            return count + 1;
        });
    }
    private async suspendFailedCycle(sub: Subscription, action: 'pause' | 'cancel', retryCount: number): Promise<boolean> {
        return this.db.transaction(async tx => {
            const live = await tx.subscriptions.findById(sub.id);
            const cycle = sub.currentPeriodEnd.toISOString();
            if (!live || live.status !== 'past_due' || live.currentPeriodEnd.toISOString() !== cycle || live.metadata?.dunningCycle !== cycle || Number(live.metadata.dunningAttempts) < retryCount)
                return false;
            const key = `renewal:${sub.id}:${cycle}`;
            const purchase = await tx.billingOperations!.find(key);
            const lock = await tx.billingOperations!.find(`billing-lock:${sub.id}`);
            const attempt = purchase ? await tx.billingOperations!.find(`${key}:attempt:${purchase.payload.latestAttempt}`) : null;
            if (!purchase || ['succeeded', 'applied'].includes(purchase.status) || attempt?.status !== 'failed' || lock?.status !== 'failed' || lock.payload.purchaseKey !== key)
                return false;
            await tx.subscriptions.update(sub.id, { status: action === 'pause' ? 'paused' : 'canceled', metadata: { ...live.metadata, pauseReason: 'payment_failure' } });
            await this.emit(tx, 'subscription.suspended', `dunning:${sub.id}:${cycle}`, sub.subscriberId, { subscriptionId: sub.id, action });
            return true;
        });
    }
    async processDunning(now: Date = new Date()): Promise<DunningProcessResult[]> {
        const candidates = await this.db.subscriptions.findAll({ status: 'past_due' });
        const results: DunningProcessResult[] = [];
        const schedule = this.options.dunning?.retryScheduleDays ?? [1, 3, 5, 7];
        for (const row of candidates) {
            if (row.billing?.billingOwner !== 'sdk_managed')
                continue;
            const sub = await this.getOrThrow(row.subscriberId);
            if (sub.status !== 'past_due')
                continue;
            const metadata = sub.metadata ?? {};
            const started = new Date(metadata.dunningStartedAt as string);
            if (!Number.isFinite(started.getTime()))
                continue;
            let attempts = typeof metadata.dunningAttempts === 'number' ? metadata.dunningAttempts : 0;
            const due = schedule.filter(day => now.getTime() - started.getTime() >= day * DAY).length;
            let recovered = false;
            let actionApplied: 'pause' | 'cancel' | 'none' = 'none';
            if (attempts < schedule.length && due > attempts) {
                const slot = await this.reserveDunningSlot(sub, due, schedule.length);
                if (!slot)
                    continue;
                attempts = slot.attempts;
                if (slot.retry !== undefined) {
                    const retryKey = `${slot.cycleKey}:attempt:${slot.retry}`;
                    try {
                        await this.renew(sub.subscriberId, { retryAttempt: slot.retry });
                        recovered = true;
                    }
                    catch (error) {
                        const count = await this.countDunningFailure(sub, retryKey, now);
                        if (count !== null)
                            attempts = count;
                        else
                            this.logger.warn?.('Dunning payment unresolved; attempt is not advanced', error);
                    }
                }
            }
            const exhausted = !recovered && attempts >= schedule.length;
            const action = this.options.dunning?.action ?? 'none';
            if (exhausted && action !== 'none') {
                if (await this.suspendFailedCycle(sub, action, schedule.length))
                    actionApplied = action;
            }
            await this.invalidate(sub.subscriberId);
            results.push({ subscriberId: sub.subscriberId, subscriptionId: sub.id, attempts, exhausted, recovered, actionApplied });
        }
        return results;
    }
    /** Pending changes are applied only with the renewal quote and settlement. */
    async executePendingChanges(_now: Date = new Date()): Promise<PendingChangeResult[]> { return []; }
}
