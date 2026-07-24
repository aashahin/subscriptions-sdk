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
import type {
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
 * never-below-zero decrement semantics), and transactions via a shallow
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

    const createAdapter = (): DatabaseAdapter<TFeatures> => ({
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

                const now = new Date();
                const invoice: Invoice = {
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

            async update(id: string, data: UpdateInvoiceInput): Promise<Invoice> {
                const existing = state.invoices.get(id);
                if (!existing) {
                    throw new Error(`Invoice not found: ${id}`);
                }
                const updated: Invoice = {
                    ...existing,
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
                options?: { period?: Date; tenantId?: string | null },
            ): Promise<number> {
                const period = options?.period ?? new Date();
                const tenantId = options?.tenantId ?? subscriberId;

                for (const record of state.usage.values()) {
                    if (
                        record.subscriberId === subscriberId &&
                        record.tenantId === tenantId &&
                        record.feature === feature &&
                        record.periodStart <= period &&
                        record.periodEnd >= period
                    ) {
                        return record.count;
                    }
                }
                return 0;
            },

            async increment(
                subscriberId: string,
                feature: string,
                options?: { count?: number; tenantId?: string | null },
            ): Promise<number> {
                const count = options?.count ?? 1;
                const tenantId = options?.tenantId ?? subscriberId;
                const now = new Date();
                const periodStart = getMonthStart(now);
                const key = usageKey(subscriberId, tenantId, feature, periodStart);

                const existing = state.usage.get(key);
                if (existing) {
                    existing.count += count;
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
                    periodEnd: getMonthEnd(now),
                    createdAt: now,
                    updatedAt: now,
                };
                state.usage.set(key, record);
                return record.count;
            },

            async decrement(
                subscriberId: string,
                feature: string,
                options?: { count?: number; tenantId?: string | null },
            ): Promise<number> {
                const count = options?.count ?? 1;
                const tenantId = options?.tenantId ?? subscriberId;
                const now = new Date();
                const periodStart = getMonthStart(now);
                const key = usageKey(subscriberId, tenantId, feature, periodStart);

                // Never below zero: clamp the stored count when the release
                // amount exceeds what has been consumed.
                const existing = state.usage.get(key);
                if (existing) {
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
            ): Promise<void> {
                const tid = tenantId ?? subscriberId;
                const now = new Date();
                const periodStart = getMonthStart(now);
                const key = usageKey(subscriberId, tid, feature, periodStart);

                const existing = state.usage.get(key);
                if (existing) {
                    existing.count = count;
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
                    periodEnd: getMonthEnd(now),
                    createdAt: now,
                    updatedAt: now,
                });
            },

            async reset(
                subscriberId: string,
                options?: { feature?: string; tenantId?: string | null },
            ): Promise<void> {
                for (const [key, record] of state.usage) {
                    if (record.subscriberId !== subscriberId) {
                        continue;
                    }
                    if (options?.feature !== undefined && record.feature !== options.feature) {
                        continue;
                    }
                    if (options?.tenantId !== undefined && record.tenantId !== options.tenantId) {
                        continue;
                    }
                    state.usage.delete(key);
                }
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
            // Shallow snapshot: the maps themselves are copied (records are
            // shared by reference). On failure the copies are restored, which
            // undoes any create/update/delete applied through map references.
            const snapshot: MemoryState<TFeatures> = {
                plans: new Map(state.plans),
                subscriptions: new Map(state.subscriptions),
                invoices: new Map(state.invoices),
                usage: new Map(state.usage),
            };

            try {
                return await fn(createAdapter());
            } catch (error) {
                state.plans = snapshot.plans;
                state.subscriptions = snapshot.subscriptions;
                state.invoices = snapshot.invoices;
                state.usage = snapshot.usage;
                throw error;
            }
        },
    });

    return createAdapter();
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
