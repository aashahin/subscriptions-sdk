// file: packages/subscriptions/src/testing/memory-database.ts
// In-memory DatabaseAdapter for tests, examples, and local development

import type {
    CreateInvoiceInput,
    CreatePlanInput,
    CreateSubscriptionInput,
    FeatureRegistry,
    Invoice,
    InvoiceWithDetails,
    Plan,
    Subscription,
    SubscriptionWithPlan,
    UpdateInvoiceInput,
    UpdatePlanInput,
    UpdateSubscriptionInput,
    UsageRecord,
} from '../core/types.js';
import { explicitUsagePeriod, queue, serialAdapter, usagePeriod, validateUsageCount, validateUsageLimit, validateProviderResource, providerResourceScope, providerResourceKey } from '../adapters/persistence-utils.js';
import type { Coupon } from '../core/coupons.js';
import type { OutboxRecord } from '../adapters/outbox.adapter.js';
import type {
    BillingOperationRecord, ProviderResourceMapping, UsageMutationOptions, UsagePeriodOptions, UsageReadOptions, UsageReservationOptions, UsageResetOptions,
    DatabaseAdapter,
    PlanQueryOptions,
    SubscriptionQueryOptions,
} from '../adapters/database.adapter.js';

/**
 * Stored usage record. Extends the public UsageRecord with the tenantId used
 * for tenant-scoped lookups (mirrors the Prisma adapter's internal column).
 */
interface StoredUsageRecord extends UsageRecord {
    tenantId: string;
}

/**
 * Internal mutable state. Maps are replaced (not mutated) on transaction
 * rollback, so every adapter closure reads them through this object.
 */
interface MemoryState<TFeatures extends FeatureRegistry> {
    plans: Map<string, Plan<TFeatures>>;
    subscriptions: Map<string, Subscription>;
    invoices: Map<string, Invoice>;
    usage: Map<string, StoredUsageRecord>;
    operations: Map<string,BillingOperationRecord>;
    outbox: Map<string,{event:OutboxRecord;status:string;claimedAt:number}>;
    coupons: Map<string,Coupon>;
    redemptions: Map<string,{couponId:string;status:string;couponSnapshot:Coupon}>;
    sequences: Map<string,number>;
    resources:Map<string,ProviderResourceMapping>;
}

/** Statuses considered "live" for subscriber/downgrade checks */
const LIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

/** Statuses eligible for expiry reminders */
const EXPIRING_STATUSES = new Set(['active', 'trialing']);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Create a fully in-memory {@link DatabaseAdapter}.
 *
 * Implements the complete adapter contract — plans (including admin filtering,
 * `hasActiveSubscribers` and `hasPendingDowngrades`), subscriptions (including
 * `findExpiring`), invoices (including `findByGatewayInvoiceId` for idempotent
 * webhook handling), usage tracking (increment/decrement/set/reset with
 * never-below-zero decrement semantics), and transactions via a deep
 * snapshot that is restored when the transaction function throws.
 *
 * Useful for unit tests, demos, and as a reference implementation when
 * building a custom adapter.
 *
 * @example
 * ```typescript
 * import { memoryDatabaseAdapter } from '@abshahin/subscriptions/testing';
 *
 * const subs = createSubscriptions({
 *   database: memoryDatabaseAdapter(),
 *   features,
 * });
 * ```
 */
export function memoryDatabaseAdapter<
    TFeatures extends FeatureRegistry = FeatureRegistry,
>(): DatabaseAdapter<TFeatures> {
    const state: MemoryState<TFeatures> = {
        plans: new Map(),
        subscriptions: new Map(),
        invoices: new Map(),
        usage: new Map(),
        operations:new Map(),outbox:new Map(),coupons:new Map(),redemptions:new Map(),sequences:new Map(),resources:new Map(),
    };

    const usageKey = (
        subscriberId: string,
        tenantId: string,
        feature: string,
        periodStart: Date,
    ): string => `${subscriberId}|${tenantId}|${feature}|${periodStart.toISOString()}`;

    const toUsageRecord = (stored: StoredUsageRecord): UsageRecord => ({
        id: stored.id,
        subscriberId: stored.subscriberId,
        feature: stored.feature,
        count: stored.count,
        periodStart: stored.periodStart,
        periodEnd: stored.periodEnd,
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
    });

    const withPlan = (
        subscription: Subscription,
    ): SubscriptionWithPlan<TFeatures> | null => {
        const plan = state.plans.get(subscription.planId);
        return plan ? { ...subscription, plan } : null;
    };

    const run = queue();
    const createAdapter = (inTransaction = false): DatabaseAdapter<TFeatures> => ({
        capabilities: {asyncTransactions:true,guardedUsageRelease:true},
        providerResources: {
            async bind(mapping) {
                const scope=providerResourceScope(mapping);validateProviderResource(scope,mapping.localId);validateProviderResource(scope,mapping.externalId);
                const external=state.resources.get(providerResourceKey(scope,mapping.externalId));
                const local=await this.findByLocal(scope,mapping.localId);
                if(external&&external.localId!==mapping.localId||local&&local.externalId!==mapping.externalId)throw new Error('Provider resource is already bound to another local or external identity');
                if(!external)state.resources.set(providerResourceKey(scope,mapping.externalId),structuredClone(mapping));
                return structuredClone(external??mapping);
            },
            async findByExternal(scope,externalId) {validateProviderResource(scope,externalId);return structuredClone(state.resources.get(providerResourceKey(scope,externalId))??null);},
            async findByLocal(scope,localId) {validateProviderResource(scope,localId);const key=providerResourceKey(scope,localId);return structuredClone([...state.resources.values()].find(r=>providerResourceKey(providerResourceScope(r),r.localId)===key)??null);},
        },
        billingOperations: {
            async reserve(key,payload) {const existing=state.operations.get(key);if(existing)return {created:false,record:structuredClone(existing)};
                const record:BillingOperationRecord={key,payload:structuredClone(payload),status:'reserved',createdAt:new Date(),updatedAt:new Date()};state.operations.set(key,record);return {created:true,record:structuredClone(record)};},
            async find(key) {return structuredClone(state.operations.get(key)??null);},
            async update(key,data) {const record=state.operations.get(key);if(!record)throw new Error('Billing operation not found');const updated={...record,...structuredClone(data),updatedAt:new Date()};state.operations.set(key,updated);return structuredClone(updated);},
            async compareAndSet(key,expectedStatus,data) {const record=state.operations.get(key);if(!record||record.status!==expectedStatus)return false;state.operations.set(key,{...record,...structuredClone(data),updatedAt:new Date()});return true;},
        },
        outbox: {
            async insert(event) {if(!state.outbox.has(event.id))state.outbox.set(event.id,{event:structuredClone(event),status:'pending',claimedAt:0});},
            async claimPending(limit=100) {const result:OutboxRecord[]=[];for(const row of state.outbox.values())if(row.status==='pending'||row.status==='claimed'&&row.claimedAt<Date.now()-300000){row.status='claimed';row.claimedAt=Date.now();result.push(structuredClone(row.event));if(result.length>=limit)break;}return result;},
            async releaseClaim(id) {const row=state.outbox.get(id);if(row?.status==='claimed'){row.status='pending';row.claimedAt=0;}},
            async markSent(id) {const row=state.outbox.get(id);if(row)row.status='sent';},
        },
        coupons: {
            async findByCode(code) {return structuredClone([...state.coupons.values()].find(c=>c.code===code)??null);},
            async findById(id) {return structuredClone(state.coupons.get(id)??null);},
            async create(data) {if([...state.coupons.values()].some(c=>c.code===data.code))throw new Error('Unique coupon code');const now=new Date();const coupon:Coupon={id:crypto.randomUUID(),code:data.code,type:data.type,value:data.value,currency:data.currency??null,duration:data.duration??'once',durationInMonths:data.durationInMonths??null,maxRedemptions:data.maxRedemptions??null,expiresAt:data.expiresAt??null,isActive:data.isActive??true,timesRedeemed:0,metadata:data.metadata??null,createdAt:now,updatedAt:now};state.coupons.set(coupon.id,coupon);return structuredClone(coupon);},
            async update(id,data) {const coupon=state.coupons.get(id);if(!coupon)throw new Error('Coupon not found');const updated={...coupon,...data,updatedAt:new Date()};state.coupons.set(id,updated);return structuredClone(updated);},
            async incrementRedemptions() {throw new Error('Coupon redemption requires a purchaseId; use redeem()');},
            async reserveRedemption(id,purchaseId,options) {return this.redeem!(id,purchaseId,options);},
            async redeem(id,purchaseId,options) {if(!purchaseId)throw new Error('Coupon redemption requires a purchaseId');const existing=state.redemptions.get(purchaseId);if(existing){if(existing.couponId!==id)throw new Error('Purchase already bound to another coupon');return existing.status==='reserved'?structuredClone(existing.couponSnapshot):null;}
                const coupon=state.coupons.get(id);const now=options?.now??new Date();if(!coupon||!coupon.isActive||coupon.expiresAt&&coupon.expiresAt<=now||coupon.maxRedemptions!==null&&coupon.timesRedeemed>=coupon.maxRedemptions)return null;
                coupon.timesRedeemed++;state.redemptions.set(purchaseId,{couponId:id,status:'reserved',couponSnapshot:structuredClone(coupon)});return structuredClone(coupon);},
            async releaseRedemption(id,purchaseId) {const row=state.redemptions.get(purchaseId);if(row?.couponId===id&&row.status==='reserved'){row.status='released';const coupon=state.coupons.get(id);if(coupon)coupon.timesRedeemed--;}},
        },
        // ==================== Plans ====================
        plans: {
            async findById(id: string): Promise<Plan<TFeatures> | null> {
                return state.plans.get(id) ?? null;
            },

            async findAll(options?: {
                activeOnly?: boolean;
            }): Promise<Plan<TFeatures>[]> {
                let plans = [...state.plans.values()];
                if (options?.activeOnly) {
                    plans = plans.filter((plan) => plan.isActive);
                }
                return plans.sort((a, b) => a.sortOrder - b.sortOrder);
            },

            async findAllForAdmin(
                options?: PlanQueryOptions,
            ): Promise<{ plans: Plan<TFeatures>[]; total: number }> {
                let plans = [...state.plans.values()];

                if (options?.isActive !== undefined) {
                    plans = plans.filter((plan) => plan.isActive === options.isActive);
                }

                if (options?.interval) {
                    plans = plans.filter((plan) => plan.interval === options.interval);
                }

                const total = plans.length;
                plans.sort((a, b) => a.sortOrder - b.sortOrder);

                const offset = options?.offset ?? 0;
                const limit = options?.limit ?? plans.length;
                return { plans: plans.slice(offset, offset + limit), total };
            },

            async create(data: CreatePlanInput<TFeatures>): Promise<Plan<TFeatures>> {
                const now = new Date();
                const plan: Plan<TFeatures> = {
                    id: crypto.randomUUID(),
                    name: data.name,
                    description: data.description ?? null,
                    price: data.price,
                    ...(data.prices && {prices:structuredClone(data.prices)}),
                    currency: data.currency ?? 'USD',
                    interval: data.interval,
                    intervalCount: data.intervalCount ?? 1,
                    trialDays: data.trialDays ?? 0,
                    features: data.features ?? {},
                    isActive: data.isActive ?? true,
                    sortOrder: data.sortOrder ?? 0,
                    metadata: data.metadata ?? null,
                    createdAt: now,
                    updatedAt: now,
                };
                state.plans.set(plan.id, plan);
                return plan;
            },

            async update(
                id: string,
                data: UpdatePlanInput<TFeatures>,
            ): Promise<Plan<TFeatures>> {
                const existing = state.plans.get(id);
                if (!existing) {
                    throw new Error(`Plan not found: ${id}`);
                }
                const updated: Plan<TFeatures> = {
                    ...existing,
                    ...(data.name !== undefined && { name: data.name }),
                    ...(data.description !== undefined && { description: data.description }),
                    ...(data.price !== undefined && { price: data.price }),
                    ...(data.prices !== undefined && {prices:structuredClone(data.prices)}),
                    ...(data.currency !== undefined && { currency: data.currency }),
                    ...(data.interval !== undefined && { interval: data.interval }),
                    ...(data.intervalCount !== undefined && { intervalCount: data.intervalCount }),
                    ...(data.trialDays !== undefined && { trialDays: data.trialDays }),
                    ...(data.features !== undefined && { features: data.features }),
                    ...(data.isActive !== undefined && { isActive: data.isActive }),
                    ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
                    ...(data.metadata !== undefined && { metadata: data.metadata }),
                    updatedAt: new Date(),
                };
                state.plans.set(id, updated);
                return updated;
            },

            async delete(id: string): Promise<void> {
                state.plans.delete(id);
            },

            async hasActiveSubscribers(id: string): Promise<boolean> {
                return [...state.subscriptions.values()].some(
                    (sub) => sub.planId === id && LIVE_STATUSES.has(sub.status),
                );
            },

            async hasPendingDowngrades(id: string): Promise<boolean> {
                return [...state.subscriptions.values()].some(
                    (sub) =>
                        LIVE_STATUSES.has(sub.status) &&
                        sub.metadata?.pendingDowngradePlanId === id,
                );
            },
        },

        // ==================== Subscriptions ====================
        subscriptions: {
            async findById(
                id: string,
            ): Promise<SubscriptionWithPlan<TFeatures> | null> {
                const subscription = state.subscriptions.get(id);
                return subscription ? withPlan(subscription) : null;
            },

            async findBySubscriber(
                subscriberId: string,
            ): Promise<SubscriptionWithPlan<TFeatures> | null> {
                const matches = [...state.subscriptions.values()]
                    .filter((sub) => sub.subscriberId === subscriberId)
                    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
                const latest = matches[0];
                return latest ? withPlan(latest) : null;
            },

            async findAll(
                options?: SubscriptionQueryOptions,
            ): Promise<Subscription[]> {
                let subscriptions = [...state.subscriptions.values()];

                if (options?.status) {
                    const statuses = Array.isArray(options.status)
                        ? options.status
                        : [options.status];
                    subscriptions = subscriptions.filter((sub) =>
                        statuses.includes(sub.status),
                    );
                }

                if (options?.planId) {
                    subscriptions = subscriptions.filter(
                        (sub) => sub.planId === options.planId,
                    );
                }

                subscriptions.sort(
                    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
                );

                const offset = options?.offset ?? 0;
                const limit = options?.limit ?? subscriptions.length;
                return subscriptions.slice(offset, offset + limit);
            },

            async create(data: CreateSubscriptionInput): Promise<Subscription> {
                const now = new Date();
                const subscription: Subscription = {
                    id: crypto.randomUUID(),
                    quantity: data.quantity ?? 1,
                    addOns: data.addOns ?? [],
                    ...(data.billing && {billing:data.billing}),
                    subscriberId: data.subscriberId,
                    subscriberType: data.subscriberType ?? 'tenant',
                    planId: data.planId,
                    status: data.status ?? 'active',
                    currentPeriodStart: data.currentPeriodStart ?? now,
                    currentPeriodEnd:
                        data.currentPeriodEnd ?? new Date(now.getTime() + 30 * DAY_MS),
                    cancelAt: null,
                    canceledAt: null,
                    trialStart: data.trialStart ?? null,
                    trialEnd: data.trialEnd ?? null,
                    gatewaySubscriptionId: data.gatewaySubscriptionId ?? null,
                    gatewayCustomerId: data.gatewayCustomerId ?? null,
                    metadata: data.metadata ?? null,
                    createdAt: now,
                    updatedAt: now,
                };
                state.subscriptions.set(subscription.id, subscription);
                return subscription;
            },

            async update(
                id: string,
                data: UpdateSubscriptionInput,
            ): Promise<Subscription> {
                const existing = state.subscriptions.get(id);
                if (!existing) {
                    throw new Error(`Subscription not found: ${id}`);
                }
                const updated: Subscription = {
                    ...existing,
                    ...data,
                    ...(data.planId !== undefined && { planId: data.planId }),
                    ...(data.status !== undefined && { status: data.status }),
                    ...(data.currentPeriodStart !== undefined && {
                        currentPeriodStart: data.currentPeriodStart,
                    }),
                    ...(data.currentPeriodEnd !== undefined && {
                        currentPeriodEnd: data.currentPeriodEnd,
                    }),
                    ...(data.cancelAt !== undefined && { cancelAt: data.cancelAt }),
                    ...(data.canceledAt !== undefined && { canceledAt: data.canceledAt }),
                    ...(data.trialStart !== undefined && { trialStart: data.trialStart }),
                    ...(data.trialEnd !== undefined && { trialEnd: data.trialEnd }),
                    ...(data.gatewaySubscriptionId !== undefined && {
                        gatewaySubscriptionId: data.gatewaySubscriptionId,
                    }),
                    ...(data.gatewayCustomerId !== undefined && {
                        gatewayCustomerId: data.gatewayCustomerId,
                    }),
                    ...(data.metadata !== undefined && { metadata: data.metadata }),
                    updatedAt: new Date(),
                };
                state.subscriptions.set(id, updated);
                return updated;
            },

            async delete(id: string): Promise<void> {
                state.subscriptions.delete(id);
            },

            async findExpiring(withinDays: number): Promise<Subscription[]> {
                const now = new Date();
                const endDate = new Date(now.getTime() + withinDays * DAY_MS);

                return [...state.subscriptions.values()].filter(
                    (sub) =>
                        EXPIRING_STATUSES.has(sub.status) &&
                        sub.currentPeriodEnd >= now &&
                        sub.currentPeriodEnd <= endDate,
                );
            },
        },

        // ==================== Invoices ====================
        invoices: {
            async findById(id: string): Promise<Invoice | null> {
                return state.invoices.get(id) ?? null;
            },

            async findByIdWithDetails(
                id: string,
            ): Promise<InvoiceWithDetails<TFeatures> | null> {
                const invoice = state.invoices.get(id);
                if (!invoice) {
                    return null;
                }
                const subscription = state.subscriptions.get(invoice.subscriptionId);
                const plan = subscription
                    ? state.plans.get(subscription.planId)
                    : undefined;
                if (!subscription || !plan) {
                    return null;
                }
                return { ...invoice, subscription, plan };
            },

            async findByGatewayInvoiceId(
                gatewayInvoiceId: string,
            ): Promise<Invoice | null> {
                const matches = [...state.invoices.values()]
                    .filter((invoice) => invoice.gatewayInvoiceId === gatewayInvoiceId)
                    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
                return matches[0] ?? null;
            },

            async findBySubscription(subscriptionId: string): Promise<Invoice[]> {
                return [...state.invoices.values()]
                    .filter((invoice) => invoice.subscriptionId === subscriptionId)
                    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
            },

            async findBySubscriber(subscriberId: string): Promise<Invoice[]> {
                return [...state.invoices.values()]
                    .filter((invoice) => invoice.subscriberId === subscriberId)
                    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
            },

            async create(data: CreateInvoiceInput): Promise<Invoice> {
                const subscription = state.subscriptions.get(data.subscriptionId);
                if (!subscription) {
                    throw new Error(`Subscription not found: ${data.subscriptionId}`);
                }

                if(data.gatewayInvoiceId && [...state.invoices.values()].some(row=>row.gatewayInvoiceId===data.gatewayInvoiceId))throw new Error('Unique gateway invoice id');
                const now = new Date();
                const invoice: Invoice = {
                    ...data,
                    id: crypto.randomUUID(),
                    subscriptionId: data.subscriptionId,
                    subscriberId: subscription.subscriberId,
                    amount: data.amount,
                    currency: data.currency,
                    status: data.status ?? 'draft',
                    gatewayInvoiceId: data.gatewayInvoiceId ?? null,
                    paidAt: data.paidAt ?? (data.status === 'paid' ? now : null),
                    dueDate: data.dueDate ?? null,
                    lineItems: data.lineItems ?? [],
                    metadata: data.metadata ?? null,
                    createdAt: now,
                    updatedAt: now,
                };
                state.invoices.set(invoice.id, invoice);
                return invoice;
            },

            async nextInvoiceNumber(prefix: string) {const value=(state.sequences.get(prefix)??0)+1;state.sequences.set(prefix,value);return `${prefix}${String(value).padStart(6,'0')}`;},

            async update(id: string, data: UpdateInvoiceInput): Promise<Invoice> {
                const existing = state.invoices.get(id);
                if (!existing) {
                    throw new Error(`Invoice not found: ${id}`);
                }
                const updated: Invoice = {
                    ...existing,
                    ...data,
                    ...(data.amount !== undefined && { amount: data.amount }),
                    ...(data.status !== undefined && { status: data.status }),
                    ...(data.gatewayInvoiceId !== undefined && {
                        gatewayInvoiceId: data.gatewayInvoiceId,
                    }),
                    ...(data.paidAt !== undefined && { paidAt: data.paidAt }),
                    ...(data.dueDate !== undefined && { dueDate: data.dueDate }),
                    ...(data.lineItems !== undefined && { lineItems: data.lineItems }),
                    ...(data.metadata !== undefined && { metadata: data.metadata }),
                    updatedAt: new Date(),
                };
                state.invoices.set(id, updated);
                return updated;
            },
        },

        // ==================== Usage Tracking ====================
        usage: {
            async get(
                subscriberId: string,
                feature: string,
                options?: UsageReadOptions,
            ): Promise<number> {
                const period = options?.period ?? new Date();
                const tenantId = options?.tenantId ?? subscriberId;
                const explicitPeriod = explicitUsagePeriod(options);

                for (const record of state.usage.values()) {
                    if (
                        record.subscriberId === subscriberId &&
                        record.tenantId === tenantId &&
                        record.feature === feature &&
                        (options?.expectedRecordId === undefined || record.id === options.expectedRecordId) &&
                        (explicitPeriod ? record.periodStart.getTime() === explicitPeriod.periodStart.getTime()
                            : record.periodStart <= period && record.periodEnd >= period)
                    ) {
                        return record.count;
                    }
                }
                return 0;
            },

            async increment(
                subscriberId: string,
                feature: string,
                options?: UsageMutationOptions,
            ): Promise<number> {
                const count = options?.count ?? 1;
                validateUsageCount(count);
                const tenantId = options?.tenantId ?? subscriberId;
                const now = new Date();
                const {periodStart,periodEnd} = usagePeriod(options);
                const key = usageKey(subscriberId, tenantId, feature, periodStart);

                const existing = state.usage.get(key);
                if (existing) {
                    existing.count += count;
                    existing.periodEnd = periodEnd;
                    existing.updatedAt = now;
                    return existing.count;
                }

                const record: StoredUsageRecord = {
                    id: crypto.randomUUID(),
                    subscriberId,
                    tenantId,
                    feature,
                    count,
                    periodStart,
                    periodEnd,
                    createdAt: now,
                    updatedAt: now,
                };
                state.usage.set(key, record);
                return record.count;
            },

            async reserve(subscriberId: string,feature: string,options?:UsageReservationOptions) {
                const count=options?.count??1;validateUsageCount(count);validateUsageLimit(options?.limit);
                const tenantId=options?.tenantId??subscriberId;const {periodStart,periodEnd}=usagePeriod(options);
                const key=usageKey(subscriberId,tenantId,feature,periodStart);const existing=state.usage.get(key);
                const current=existing?.count??0;const limit=options?.limit??Number.MAX_SAFE_INTEGER;
                if(current>limit-count)return {accepted:false,count:current};
                const recordId=existing?.id??crypto.randomUUID();
                const now=new Date();if(existing){existing.count+=count;existing.periodEnd=periodEnd;existing.updatedAt=now;}else state.usage.set(key,{id:recordId,subscriberId,tenantId,feature,count,periodStart,periodEnd,createdAt:now,updatedAt:now});
                return {accepted:true,count:current+count,recordId};
            },

            async decrement(
                subscriberId: string,
                feature: string,
                options?: UsageMutationOptions,
            ): Promise<number> {
                const count = options?.count ?? 1;
                validateUsageCount(count);
                const tenantId = options?.tenantId ?? subscriberId;
                const now = new Date();
                const {periodStart,periodEnd} = usagePeriod(options);
                const key = usageKey(subscriberId, tenantId, feature, periodStart);

                // Never below zero: clamp the stored count when the release
                // amount exceeds what has been consumed.
                const existing = state.usage.get(key);
                if (existing && (options?.expectedRecordId === undefined || existing.id === options.expectedRecordId)) {
                    existing.count = Math.max(0, existing.count - count);
                    existing.updatedAt = now;
                    return existing.count;
                }
                return 0;
            },

            async set(
                subscriberId: string,
                feature: string,
                count: number,
                tenantId?: string | null,
                options?: UsagePeriodOptions,
            ): Promise<void> {
                validateUsageCount(count,true);
                const tid = tenantId ?? subscriberId;
                const now = new Date();
                const {periodStart,periodEnd} = usagePeriod(options);
                const key = usageKey(subscriberId, tid, feature, periodStart);

                const existing = state.usage.get(key);
                if (existing) {
                    existing.id = crypto.randomUUID();
                    existing.count = count;
                    existing.periodEnd = periodEnd;
                    existing.updatedAt = now;
                    return;
                }

                state.usage.set(key, {
                    id: crypto.randomUUID(),
                    subscriberId,
                    tenantId: tid,
                    feature,
                    count,
                    periodStart,
                    periodEnd,
                    createdAt: now,
                    updatedAt: now,
                });
            },

            async reset(
                subscriberId: string,
                options?: UsageResetOptions,
            ): Promise<void> {
                const explicitPeriod = explicitUsagePeriod(options);
                const tenantId = explicitPeriod ? options?.tenantId ?? subscriberId : options?.tenantId;
                for (const [key, record] of state.usage) {
                    if (record.subscriberId !== subscriberId) {
                        continue;
                    }
                    if (options?.feature !== undefined && record.feature !== options.feature) {
                        continue;
                    }
                    if (tenantId !== undefined && record.tenantId !== tenantId) {
                        continue;
                    }
                    if (explicitPeriod && record.periodStart.getTime() !== explicitPeriod.periodStart.getTime()) {
                        continue;
                    }
                    state.usage.delete(key);
                }
            },

            async getForPeriods(subscriberId, periods, tenantId) {
                const records: UsageRecord[] = [];
                for (const period of periods) {
                    const key = usageKey(subscriberId, tenantId ?? subscriberId, period.feature, usagePeriod(period).periodStart);
                    const record = state.usage.get(key);
                    if (record) records.push(toUsageRecord(record));
                }
                return records;
            },

            async getAll(
                subscriberId: string,
                tenantId?: string | null,
            ): Promise<UsageRecord[]> {
                const now = new Date();
                return [...state.usage.values()]
                    .filter(
                        (record) =>
                            record.subscriberId === subscriberId &&
                            record.periodStart <= now &&
                            record.periodEnd >= now &&
                            (tenantId === undefined || record.tenantId === tenantId),
                    )
                    .map(toUsageRecord);
            },
        },

        // ==================== Transactions ====================
        async transaction<T>(
            fn: (tx: DatabaseAdapter<TFeatures>) => Promise<T>,
        ): Promise<T> {
            if(inTransaction)return fn(createAdapter(true));
            const snapshot = structuredClone(state);
            try { return await fn(createAdapter(true)); }
            catch(error) {Object.assign(state,snapshot);throw error;}
        },
    });

    return serialAdapter(createAdapter(),run);
}

// ==================== Helpers ====================

// Usage periods are computed in UTC so that period boundaries are deterministic
// and independent of the server's local timezone or DST transitions (mirrors
// the Prisma adapter).
function getMonthStart(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function getMonthEnd(date: Date): Date {
    return new Date(
        Date.UTC(
            date.getUTCFullYear(),
            date.getUTCMonth() + 1,
            0,
            23,
            59,
            59,
            999,
        ),
    );
}
