// file: packages/subscriptions/src/adapters/drizzle.adapter.ts
// Drizzle ORM adapter implementation for @abshahin/subscriptions

import type {
    BillingInterval,
    CreateInvoiceInput,
    CreatePlanInput,
    CreateSubscriptionInput,
    FeatureRegistry,
    Invoice,
    InvoiceWithDetails,
    Plan,
    PlanPrice,
    Subscription,
    SubscriptionStatus,
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
} from './database.adapter.js';
import {
    billingSequences as billingSequencesTable,
    invoices as invoicesTable,
    subscriptionPlans as plansTable,
    subscriptions as subscriptionsTable,
    usageRecords as usageRecordsTable,
} from './drizzle-schema.js';

export * from './drizzle-schema.js';

/**
 * The drizzle-orm query helper module. Loaded lazily (see `loadOps`) so that
 * importing this adapter never eagerly pulls drizzle-orm into bundles that do
 * not use the Drizzle adapter.
 */
type DrizzleOps = typeof import('drizzle-orm');

let opsPromise: Promise<DrizzleOps> | undefined;

/**
 * Lazily load the drizzle-orm query helpers (eq, and, desc, sql, ...).
 * drizzle-orm is an optional peer dependency and is only required when the
 * Drizzle adapter is actually used.
 */
function loadOps(): Promise<DrizzleOps> {
    opsPromise ??= import('drizzle-orm');
    return opsPromise;
}

const bundledSchema = {
    subscriptionPlans: plansTable,
    subscriptions: subscriptionsTable,
    invoices: invoicesTable,
    usageRecords: usageRecordsTable,
    billingSequences: billingSequencesTable,
};

/**
 * Tables used by the Drizzle adapter. Defaults to the bundled SQLite schema
 * from `drizzle-schema.ts`; override to plug in tables with custom names or
 * columns (same shape).
 */
export type DrizzleAdapterSchema = typeof bundledSchema;

/**
 * Any Drizzle database instance whose schema includes the subscriptions
 * tables — Cloudflare D1, Turso/libSQL, bun:sqlite, better-sqlite3, or a
 * PostgreSQL driver with an equivalent schema.
 */
export interface DrizzleDatabase {
    select: (...args: any[]) => any;
    insert: (table: any) => any;
    update: (table: any) => any;
    delete: (table: any) => any;
    transaction: (fn: (tx: any) => any) => any;
}

/**
 * Options for the Drizzle adapter
 */
export interface DrizzleAdapterOptions {
    /**
     * Custom table objects if you maintain your own Drizzle schema
     * (e.g. different column names). Must match the bundled table shapes.
     */
    schema?: DrizzleAdapterSchema;
}

/**
 * Create a Drizzle ORM adapter for the subscriptions package.
 *
 * Works with any Drizzle driver whose database contains the subscriptions
 * tables (see `drizzle-schema.ts` and `docs/drizzle-schema.md`).
 *
 * @example
 * ```typescript
 * import { drizzle } from 'drizzle-orm/d1';
 * import { drizzleAdapter, subscriptionsSchema } from '@abshahin/subscriptions/adapters/drizzle';
 *
 * const db = drizzle(env.DB, { schema: subscriptionsSchema });
 * const subs = createSubscriptions({
 *   database: drizzleAdapter(db),
 *   features,
 * });
 * ```
 */
export function drizzleAdapter<TFeatures extends FeatureRegistry = FeatureRegistry>(
    db: DrizzleDatabase,
    options?: DrizzleAdapterOptions,
): DatabaseAdapter<TFeatures> {
    const schema: DrizzleAdapterSchema = { ...bundledSchema, ...options?.schema };

    const createAdapter = (client: DrizzleDatabase): DatabaseAdapter<TFeatures> => ({
        // ==================== Plans ====================
        plans: {
            async findById(id: string): Promise<Plan<TFeatures> | null> {
                const { eq } = await loadOps();
                const rows = await client
                    .select()
                    .from(schema.subscriptionPlans)
                    .where(eq(schema.subscriptionPlans.id, id))
                    .limit(1);
                const plan = rows[0];
                return plan ? mapPlanFromDrizzle<TFeatures>(plan) : null;
            },

            async findAll(options?: { activeOnly?: boolean }): Promise<Plan<TFeatures>[]> {
                const { asc, eq } = await loadOps();
                let query = client.select().from(schema.subscriptionPlans).$dynamic();
                if (options?.activeOnly) {
                    query = query.where(eq(schema.subscriptionPlans.isActive, true));
                }
                const plans = await query.orderBy(asc(schema.subscriptionPlans.sortOrder));
                return plans.map(mapPlanFromDrizzle<TFeatures>);
            },

            async findAllForAdmin(
                options?: PlanQueryOptions,
            ): Promise<{ plans: Plan<TFeatures>[]; total: number }> {
                const { and, asc, eq, sql } = await loadOps();

                const conditions: any[] = [];
                if (options?.isActive !== undefined) {
                    conditions.push(eq(schema.subscriptionPlans.isActive, options.isActive));
                }
                if (options?.interval) {
                    conditions.push(
                        eq(schema.subscriptionPlans.interval, options.interval as BillingInterval),
                    );
                }
                const where = conditions.length > 0 ? and(...conditions) : undefined;

                let query = client.select().from(schema.subscriptionPlans).$dynamic();
                if (where) {
                    query = query.where(where);
                }
                query = query.orderBy(asc(schema.subscriptionPlans.sortOrder));
                if (options?.limit !== undefined) {
                    query = query.limit(options.limit);
                }
                if (options?.offset !== undefined) {
                    query = query.offset(options.offset);
                }

                let countQuery = client
                    .select({ count: sql<number>`count(*)` })
                    .from(schema.subscriptionPlans)
                    .$dynamic();
                if (where) {
                    countQuery = countQuery.where(where);
                }

                const [plans, countRows] = await Promise.all([query, countQuery]);
                return {
                    plans: plans.map(mapPlanFromDrizzle<TFeatures>),
                    total: Number(countRows[0]?.count ?? 0),
                };
            },

            async create(data: CreatePlanInput<TFeatures>): Promise<Plan<TFeatures>> {
                const now = new Date();
                const row = {
                    id: crypto.randomUUID(),
                    name: data.name,
                    description: data.description ?? null,
                    price: data.price,
                    currency: data.currency ?? 'USD',
                    // Additional price points have no dedicated column in the
                    // base schema; they are persisted inside the metadata JSON
                    // column (same convention as the Prisma adapter).
                    metadata: mergeBillingExtras(data.metadata ?? null, {
                        prices: data.prices,
                    }),
                    interval: data.interval,
                    intervalCount: data.intervalCount ?? 1,
                    trialDays: data.trialDays ?? 0,
                    features: (data.features ?? {}) as Record<string, unknown>,
                    isActive: data.isActive ?? true,
                    sortOrder: data.sortOrder ?? 0,
                    createdAt: now,
                    updatedAt: now,
                };
                await client.insert(schema.subscriptionPlans).values(row);
                return mapPlanFromDrizzle<TFeatures>(row);
            },

            async update(id: string, data: UpdatePlanInput<TFeatures>): Promise<Plan<TFeatures>> {
                const { eq } = await loadOps();
                const metadata = await metadataForUpdate(
                    client,
                    schema.subscriptionPlans,
                    schema.subscriptionPlans.id,
                    id,
                    data.metadata,
                    { prices: data.prices },
                );

                const set: Record<string, unknown> = { updatedAt: new Date() };

                if (data.name !== undefined) set.name = data.name;
                if (data.description !== undefined) set.description = data.description;
                if (data.price !== undefined) set.price = data.price;
                if (data.currency !== undefined) set.currency = data.currency;
                if (data.interval !== undefined) set.interval = data.interval;
                if (data.intervalCount !== undefined) set.intervalCount = data.intervalCount;
                if (data.trialDays !== undefined) set.trialDays = data.trialDays;
                if (data.features !== undefined) set.features = data.features;
                if (data.isActive !== undefined) set.isActive = data.isActive;
                if (data.sortOrder !== undefined) set.sortOrder = data.sortOrder;
                if (metadata !== undefined) set.metadata = metadata;

                await client
                    .update(schema.subscriptionPlans)
                    .set(set)
                    .where(eq(schema.subscriptionPlans.id, id));

                const rows = await client
                    .select()
                    .from(schema.subscriptionPlans)
                    .where(eq(schema.subscriptionPlans.id, id))
                    .limit(1);
                const plan = rows[0];
                if (!plan) {
                    throw new Error(`Plan not found: ${id}`);
                }
                return mapPlanFromDrizzle<TFeatures>(plan);
            },

            async delete(id: string): Promise<void> {
                const { eq } = await loadOps();
                await client.delete(schema.subscriptionPlans).where(eq(schema.subscriptionPlans.id, id));
            },

            async hasActiveSubscribers(id: string): Promise<boolean> {
                const { and, eq, inArray, sql } = await loadOps();
                const rows = await client
                    .select({ count: sql<number>`count(*)` })
                    .from(schema.subscriptions)
                    .where(
                        and(
                            eq(schema.subscriptions.planId, id),
                            inArray(schema.subscriptions.status, ['active', 'trialing', 'past_due']),
                        ),
                    );
                return Number(rows[0]?.count ?? 0) > 0;
            },

            async hasPendingDowngrades(id: string): Promise<boolean> {
                const { inArray } = await loadOps();
                // Pending downgrades live in subscription metadata
                // (`pendingDowngradePlanId`), exactly like the Prisma adapter.
                // The JSON filter is applied in JS instead of a dialect-specific
                // `json_extract` so the adapter stays portable across SQLite and
                // PostgreSQL drivers.
                const rows = await client
                    .select({ metadata: schema.subscriptions.metadata })
                    .from(schema.subscriptions)
                    .where(inArray(schema.subscriptions.status, ['active', 'trialing', 'past_due']));
                return rows.some(
                    (row: any) =>
                        parseJsonField<Record<string, any> | null>(row.metadata, null)
                            ?.pendingDowngradePlanId === id,
                );
            },
        },

        // ==================== Subscriptions ====================
        subscriptions: {
            async findById(id: string): Promise<SubscriptionWithPlan<TFeatures> | null> {
                const { eq } = await loadOps();
                const rows = await client
                    .select({ subscription: schema.subscriptions, plan: schema.subscriptionPlans })
                    .from(schema.subscriptions)
                    .innerJoin(
                        schema.subscriptionPlans,
                        eq(schema.subscriptions.planId, schema.subscriptionPlans.id),
                    )
                    .where(eq(schema.subscriptions.id, id))
                    .limit(1);
                const row = rows[0];
                return row ? mapSubscriptionWithPlanFromDrizzle<TFeatures>(row) : null;
            },

            async findBySubscriber(
                subscriberId: string,
            ): Promise<SubscriptionWithPlan<TFeatures> | null> {
                const { desc, eq } = await loadOps();
                const rows = await client
                    .select({ subscription: schema.subscriptions, plan: schema.subscriptionPlans })
                    .from(schema.subscriptions)
                    .innerJoin(
                        schema.subscriptionPlans,
                        eq(schema.subscriptions.planId, schema.subscriptionPlans.id),
                    )
                    .where(eq(schema.subscriptions.tenantId, subscriberId))
                    .orderBy(desc(schema.subscriptions.createdAt))
                    .limit(1);
                const row = rows[0];
                return row ? mapSubscriptionWithPlanFromDrizzle<TFeatures>(row) : null;
            },

            async findAll(options?: SubscriptionQueryOptions): Promise<Subscription[]> {
                const { and, desc, eq, inArray } = await loadOps();

                const conditions: any[] = [];
                if (options?.status) {
                    conditions.push(
                        Array.isArray(options.status)
                            ? inArray(schema.subscriptions.status, options.status)
                            : eq(schema.subscriptions.status, options.status),
                    );
                }
                if (options?.planId) {
                    conditions.push(eq(schema.subscriptions.planId, options.planId));
                }

                let query = client.select().from(schema.subscriptions).$dynamic();
                if (conditions.length > 0) {
                    query = query.where(and(...conditions));
                }
                query = query.orderBy(desc(schema.subscriptions.createdAt));
                if (options?.limit !== undefined) {
                    query = query.limit(options.limit);
                }
                if (options?.offset !== undefined) {
                    query = query.offset(options.offset);
                }

                const subscriptions = await query;
                return subscriptions.map(mapSubscriptionFromDrizzle);
            },

            async create(data: CreateSubscriptionInput): Promise<Subscription> {
                const now = new Date();
                const row = {
                    id: crypto.randomUUID(),
                    tenantId: data.subscriberId,
                    subscriberType: data.subscriberType ?? 'tenant',
                    planId: data.planId,
                    status: data.status ?? 'active',
                    currentPeriodStart: data.currentPeriodStart ?? now,
                    currentPeriodEnd:
                        data.currentPeriodEnd ?? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
                    trialStart: data.trialStart ?? null,
                    trialEnd: data.trialEnd ?? null,
                    gatewaySubscriptionId: data.gatewaySubscriptionId ?? null,
                    gatewayCustomerId: data.gatewayCustomerId ?? null,
                    // quantity/addOns have no dedicated columns in the base
                    // schema; they are persisted inside the metadata JSON
                    // column (same convention as the Prisma adapter).
                    metadata: mergeBillingExtras(data.metadata ?? null, {
                        quantity: data.quantity,
                        addOns: data.addOns,
                    }),
                    createdAt: now,
                    updatedAt: now,
                };
                await client.insert(schema.subscriptions).values(row);
                return mapSubscriptionFromDrizzle(row);
            },

            async update(id: string, data: UpdateSubscriptionInput): Promise<Subscription> {
                const { eq } = await loadOps();
                const metadata = await metadataForUpdate(
                    client,
                    schema.subscriptions,
                    schema.subscriptions.id,
                    id,
                    data.metadata,
                    { quantity: data.quantity, addOns: data.addOns },
                );

                const set: Record<string, unknown> = { updatedAt: new Date() };

                if (data.planId !== undefined) set.planId = data.planId;
                if (data.status !== undefined) set.status = data.status;
                if (data.currentPeriodStart !== undefined) set.currentPeriodStart = data.currentPeriodStart;
                if (data.currentPeriodEnd !== undefined) set.currentPeriodEnd = data.currentPeriodEnd;
                if (data.cancelAt !== undefined) set.cancelAt = data.cancelAt;
                if (data.canceledAt !== undefined) set.canceledAt = data.canceledAt;
                if (data.trialStart !== undefined) set.trialStart = data.trialStart;
                if (data.trialEnd !== undefined) set.trialEnd = data.trialEnd;
                if (data.gatewaySubscriptionId !== undefined) set.gatewaySubscriptionId = data.gatewaySubscriptionId;
                if (data.gatewayCustomerId !== undefined) set.gatewayCustomerId = data.gatewayCustomerId;
                if (metadata !== undefined) set.metadata = metadata;

                await client
                    .update(schema.subscriptions)
                    .set(set)
                    .where(eq(schema.subscriptions.id, id));

                const rows = await client
                    .select()
                    .from(schema.subscriptions)
                    .where(eq(schema.subscriptions.id, id))
                    .limit(1);
                const subscription = rows[0];
                if (!subscription) {
                    throw new Error(`Subscription not found: ${id}`);
                }
                return mapSubscriptionFromDrizzle(subscription);
            },

            async delete(id: string): Promise<void> {
                const { eq } = await loadOps();
                await client.delete(schema.subscriptions).where(eq(schema.subscriptions.id, id));
            },

            async findExpiring(withinDays: number): Promise<Subscription[]> {
                const { and, gte, inArray, lte } = await loadOps();
                const now = new Date();
                const endDate = new Date(now.getTime() + withinDays * 24 * 60 * 60 * 1000);

                const subscriptions = await client
                    .select()
                    .from(schema.subscriptions)
                    .where(
                        and(
                            inArray(schema.subscriptions.status, ['active', 'trialing']),
                            gte(schema.subscriptions.currentPeriodEnd, now),
                            lte(schema.subscriptions.currentPeriodEnd, endDate),
                        ),
                    );

                return subscriptions.map(mapSubscriptionFromDrizzle);
            },
        },

        // ==================== Invoices ====================
        invoices: {
            async findById(id: string): Promise<Invoice | null> {
                const { eq } = await loadOps();
                const rows = await client
                    .select()
                    .from(schema.invoices)
                    .where(eq(schema.invoices.id, id))
                    .limit(1);
                const invoice = rows[0];
                return invoice ? mapInvoiceFromDrizzle(invoice) : null;
            },

            async findByIdWithDetails(id: string): Promise<InvoiceWithDetails<TFeatures> | null> {
                const { eq } = await loadOps();
                const rows = await client
                    .select({
                        invoice: schema.invoices,
                        subscription: schema.subscriptions,
                        plan: schema.subscriptionPlans,
                    })
                    .from(schema.invoices)
                    .innerJoin(
                        schema.subscriptions,
                        eq(schema.invoices.subscriptionId, schema.subscriptions.id),
                    )
                    .innerJoin(
                        schema.subscriptionPlans,
                        eq(schema.subscriptions.planId, schema.subscriptionPlans.id),
                    )
                    .where(eq(schema.invoices.id, id))
                    .limit(1);

                const row = rows[0];
                if (!row) {
                    return null;
                }

                return {
                    ...mapInvoiceFromDrizzle(row.invoice),
                    subscription: mapSubscriptionFromDrizzle(row.subscription),
                    plan: mapPlanFromDrizzle<TFeatures>(row.plan),
                };
            },

            async findByGatewayInvoiceId(gatewayInvoiceId: string): Promise<Invoice | null> {
                const { desc, eq } = await loadOps();
                const rows = await client
                    .select()
                    .from(schema.invoices)
                    .where(eq(schema.invoices.gatewayInvoiceId, gatewayInvoiceId))
                    .orderBy(desc(schema.invoices.createdAt))
                    .limit(1);
                const invoice = rows[0];
                return invoice ? mapInvoiceFromDrizzle(invoice) : null;
            },

            async findBySubscription(subscriptionId: string): Promise<Invoice[]> {
                const { desc, eq } = await loadOps();
                const invoices = await client
                    .select()
                    .from(schema.invoices)
                    .where(eq(schema.invoices.subscriptionId, subscriptionId))
                    .orderBy(desc(schema.invoices.createdAt));
                return invoices.map(mapInvoiceFromDrizzle);
            },

            async findBySubscriber(subscriberId: string): Promise<Invoice[]> {
                const { desc, eq } = await loadOps();
                const invoices = await client
                    .select()
                    .from(schema.invoices)
                    .where(eq(schema.invoices.tenantId, subscriberId))
                    .orderBy(desc(schema.invoices.createdAt));
                return invoices.map(mapInvoiceFromDrizzle);
            },

            async create(data: CreateInvoiceInput): Promise<Invoice> {
                const { eq } = await loadOps();

                // First, get the subscription to extract tenantId
                const subRows = await client
                    .select({ tenantId: schema.subscriptions.tenantId })
                    .from(schema.subscriptions)
                    .where(eq(schema.subscriptions.id, data.subscriptionId))
                    .limit(1);
                const subscription = subRows[0];

                if (!subscription) {
                    throw new Error(`Subscription not found: ${data.subscriptionId}`);
                }

                const now = new Date();
                const row = {
                    id: crypto.randomUUID(),
                    subscriptionId: data.subscriptionId,
                    tenantId: subscription.tenantId,
                    amount: data.amount,
                    currency: data.currency,
                    status: data.status ?? 'draft',
                    gatewayInvoiceId: data.gatewayInvoiceId ?? null,
                    paidAt: data.paidAt ?? (data.status === 'paid' ? new Date() : null),
                    dueDate: data.dueDate ?? null,
                    lineItems: data.lineItems ?? [],
                    // Extended billing fields (invoiceNumber, tax breakdown,
                    // credit note linkage) have no dedicated columns in the
                    // base schema; they are persisted inside the metadata JSON
                    // column (same convention as the Prisma adapter).
                    metadata: mergeBillingExtras(data.metadata ?? null, {
                        invoiceNumber: data.invoiceNumber,
                        subtotal: data.subtotal,
                        taxRate: data.taxRate,
                        taxAmount: data.taxAmount,
                        discountAmount: data.discountAmount,
                        total: data.total,
                        creditNoteOfId: data.creditNoteOfId,
                    }),
                    createdAt: now,
                    updatedAt: now,
                };
                await client.insert(schema.invoices).values(row);
                return mapInvoiceFromDrizzle(row);
            },

            async update(id: string, data: UpdateInvoiceInput): Promise<Invoice> {
                const { eq } = await loadOps();
                const metadata = await metadataForUpdate(
                    client,
                    schema.invoices,
                    schema.invoices.id,
                    id,
                    data.metadata,
                    {
                        invoiceNumber: data.invoiceNumber,
                        subtotal: data.subtotal,
                        taxRate: data.taxRate,
                        taxAmount: data.taxAmount,
                        discountAmount: data.discountAmount,
                        total: data.total,
                        creditNoteOfId: data.creditNoteOfId,
                    },
                );

                const set: Record<string, unknown> = { updatedAt: new Date() };

                if (data.amount !== undefined) set.amount = data.amount;
                if (data.status !== undefined) set.status = data.status;
                if (data.gatewayInvoiceId !== undefined) set.gatewayInvoiceId = data.gatewayInvoiceId;
                if (data.paidAt !== undefined) set.paidAt = data.paidAt;
                if (data.dueDate !== undefined) set.dueDate = data.dueDate;
                if (data.lineItems !== undefined) set.lineItems = data.lineItems;
                if (metadata !== undefined) set.metadata = metadata;

                await client
                    .update(schema.invoices)
                    .set(set)
                    .where(eq(schema.invoices.id, id));

                const rows = await client
                    .select()
                    .from(schema.invoices)
                    .where(eq(schema.invoices.id, id))
                    .limit(1);
                const invoice = rows[0];
                if (!invoice) {
                    throw new Error(`Invoice not found: ${id}`);
                }
                return mapInvoiceFromDrizzle(invoice);
            },

            async nextInvoiceNumber(prefix: string): Promise<string> {
                const { eq, sql } = await loadOps();

                // Atomic upsert+increment against the billing_sequences table.
                // RETURNING makes the whole operation a single statement, so
                // concurrent invoice creation never yields duplicate numbers.
                const returned = await client
                    .insert(schema.billingSequences)
                    .values({ prefix, value: 1 })
                    .onConflictDoUpdate({
                        target: schema.billingSequences.prefix,
                        set: { value: sql`${schema.billingSequences.value} + 1` },
                    })
                    .returning({ value: schema.billingSequences.value });

                let value = Number(returned[0]?.value ?? 0);
                if (!value) {
                    // Fallback for drivers without RETURNING support.
                    const rows = await client
                        .select({ value: schema.billingSequences.value })
                        .from(schema.billingSequences)
                        .where(eq(schema.billingSequences.prefix, prefix))
                        .limit(1);
                    value = Number(rows[0]?.value ?? 1);
                }

                return `${prefix}${String(value).padStart(6, '0')}`;
            },
        },

        // ==================== Usage Tracking ====================
        usage: {
            async get(
                subscriberId: string,
                feature: string,
                options?: { period?: Date; tenantId?: string | null },
            ): Promise<number> {
                const { and, eq, gte, lte } = await loadOps();
                const now = options?.period ?? new Date();
                const tenantId = options?.tenantId ?? subscriberId;

                const rows = await client
                    .select({ count: schema.usageRecords.count })
                    .from(schema.usageRecords)
                    .where(
                        and(
                            eq(schema.usageRecords.subscriberId, subscriberId),
                            eq(schema.usageRecords.tenantId, tenantId),
                            eq(schema.usageRecords.feature, feature),
                            lte(schema.usageRecords.periodStart, now),
                            gte(schema.usageRecords.periodEnd, now),
                        ),
                    )
                    .limit(1);
                return rows[0]?.count ?? 0;
            },

            async increment(
                subscriberId: string,
                feature: string,
                options?: { count?: number; tenantId?: string | null },
            ): Promise<number> {
                const { sql } = await loadOps();
                const count = options?.count ?? 1;
                const tenantId = options?.tenantId ?? subscriberId;
                const now = new Date();
                const periodStart = getMonthStart(now);
                const periodEnd = getMonthEnd(now);

                // Atomic upsert: a single INSERT ... ON CONFLICT DO UPDATE, so
                // concurrent increments never lose updates. The conflict target
                // matches the unique index on
                // (subscriberId, tenantId, feature, periodStart).
                await client
                    .insert(schema.usageRecords)
                    .values({
                        id: crypto.randomUUID(),
                        subscriberId,
                        tenantId,
                        feature,
                        count,
                        periodStart,
                        periodEnd,
                        createdAt: now,
                        updatedAt: now,
                    })
                    .onConflictDoUpdate({
                        target: [
                            schema.usageRecords.subscriberId,
                            schema.usageRecords.tenantId,
                            schema.usageRecords.feature,
                            schema.usageRecords.periodStart,
                        ],
                        set: {
                            count: sql`${schema.usageRecords.count} + ${count}`,
                            updatedAt: now,
                        },
                    });

                return readUsageCount(client, schema, subscriberId, tenantId, feature, periodStart);
            },

            async decrement(
                subscriberId: string,
                feature: string,
                options?: { count?: number; tenantId?: string | null },
            ): Promise<number> {
                const { and, eq, sql } = await loadOps();
                const count = options?.count ?? 1;
                const tenantId = options?.tenantId ?? subscriberId;
                const now = new Date();
                const periodStart = getMonthStart(now);

                // Atomic decrement that never drops below zero: a single guarded
                // UPDATE floors the counter at 0, so concurrent decrements can
                // neither lose updates nor go negative. The CASE expression is
                // portable across SQLite and PostgreSQL (unlike scalar `max()`,
                // which PostgreSQL does not provide).
                await client
                    .update(schema.usageRecords)
                    .set({
                        count: sql`case when ${schema.usageRecords.count} >= ${count} then ${schema.usageRecords.count} - ${count} else 0 end`,
                        updatedAt: now,
                    })
                    .where(
                        and(
                            eq(schema.usageRecords.subscriberId, subscriberId),
                            eq(schema.usageRecords.tenantId, tenantId),
                            eq(schema.usageRecords.feature, feature),
                            eq(schema.usageRecords.periodStart, periodStart),
                        ),
                    );

                return readUsageCount(client, schema, subscriberId, tenantId, feature, periodStart);
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
                const periodEnd = getMonthEnd(now);

                await client
                    .insert(schema.usageRecords)
                    .values({
                        id: crypto.randomUUID(),
                        subscriberId,
                        tenantId: tid,
                        feature,
                        count,
                        periodStart,
                        periodEnd,
                        createdAt: now,
                        updatedAt: now,
                    })
                    .onConflictDoUpdate({
                        target: [
                            schema.usageRecords.subscriberId,
                            schema.usageRecords.tenantId,
                            schema.usageRecords.feature,
                            schema.usageRecords.periodStart,
                        ],
                        set: { count, updatedAt: now },
                    });
            },

            async reset(
                subscriberId: string,
                options?: { feature?: string; tenantId?: string | null },
            ): Promise<void> {
                const { and, eq, isNull } = await loadOps();

                const conditions: any[] = [eq(schema.usageRecords.subscriberId, subscriberId)];
                if (options?.feature) {
                    conditions.push(eq(schema.usageRecords.feature, options.feature));
                }
                if (options?.tenantId !== undefined) {
                    conditions.push(
                        options.tenantId === null
                            ? isNull(schema.usageRecords.tenantId)
                            : eq(schema.usageRecords.tenantId, options.tenantId),
                    );
                }

                await client.delete(schema.usageRecords).where(and(...conditions));
            },

            async getAll(subscriberId: string, tenantId?: string | null): Promise<UsageRecord[]> {
                const { and, eq, gte, isNull, lte } = await loadOps();
                const now = new Date();

                const conditions: any[] = [
                    eq(schema.usageRecords.subscriberId, subscriberId),
                    lte(schema.usageRecords.periodStart, now),
                    gte(schema.usageRecords.periodEnd, now),
                ];
                if (tenantId !== undefined) {
                    conditions.push(
                        tenantId === null
                            ? isNull(schema.usageRecords.tenantId)
                            : eq(schema.usageRecords.tenantId, tenantId),
                    );
                }

                const records = await client
                    .select()
                    .from(schema.usageRecords)
                    .where(and(...conditions));
                return records.map(mapUsageRecordFromDrizzle);
            },
        },

        // ==================== Transactions ====================
        transaction<T>(fn: (tx: DatabaseAdapter<TFeatures>) => Promise<T>): Promise<T> {
            // Async drivers (D1, libSQL/Turso, PG drivers) support async
            // transaction callbacks and give a real transactional boundary.
            // Synchronous drivers (bun:sqlite, better-sqlite3) execute
            // statements serially on a single connection: the operations still
            // run, but the commit boundary is best-effort because the async
            // callback cannot be awaited by the driver. Use an async driver
            // when strict transactional guarantees matter.
            return client.transaction((tx: DrizzleDatabase) =>
                fn(createAdapter(tx)),
            ) as Promise<T>;
        },
    });

    return createAdapter(db);
}

// ==================== Internal helpers ====================

/**
 * Read the current usage count for an exact usage-record key.
 * Used to return the post-mutation count after atomic upserts/updates.
 */
async function readUsageCount(
    client: DrizzleDatabase,
    schema: DrizzleAdapterSchema,
    subscriberId: string,
    tenantId: string,
    feature: string,
    periodStart: Date,
): Promise<number> {
    const { and, eq } = await loadOps();
    const rows = await client
        .select({ count: schema.usageRecords.count })
        .from(schema.usageRecords)
        .where(
            and(
                eq(schema.usageRecords.subscriberId, subscriberId),
                eq(schema.usageRecords.tenantId, tenantId),
                eq(schema.usageRecords.feature, feature),
                eq(schema.usageRecords.periodStart, periodStart),
            ),
        )
        .limit(1);
    return rows[0]?.count ?? 0;
}

// ==================== Mappers ====================

/**
 * Reserved metadata key used to persist SDK-managed billing fields when
 * the schema has no dedicated columns for them (plan price points,
 * subscription quantity/addOns, invoice tax breakdown, etc.).
 *
 * The key is stripped from `metadata` when records are mapped back, so
 * consumers never see the internal storage detail. This matches the Prisma
 * adapter so both adapters can share the same rows.
 */
const BILLING_METADATA_KEY = '_billing';

/**
 * Merge SDK-managed extra fields into a JSON metadata column under the
 * reserved `_billing` key. Entries with `undefined` values are ignored.
 */
function mergeBillingExtras(
    metadata: Record<string, unknown> | null,
    extras: Record<string, unknown>,
): Record<string, unknown> | null {
    const definedExtras = Object.fromEntries(
        Object.entries(extras).filter(([, value]) => value !== undefined),
    );

    if (Object.keys(definedExtras).length === 0) {
        return metadata;
    }

    const base = metadata ?? {};
    const existing = parseJsonField<Record<string, unknown>>(base[BILLING_METADATA_KEY], {});

    return {
        ...base,
        [BILLING_METADATA_KEY]: { ...existing, ...definedExtras },
    };
}

/**
 * Split SDK-managed extra fields out of a stored metadata value.
 * Returns the cleaned metadata (without the reserved key) and the extras.
 */
function extractBillingExtras<T extends Record<string, unknown>>(
    metadata: unknown,
): { metadata: Record<string, unknown> | null; extras: Partial<T> } {
    const parsed = parseJsonField<Record<string, unknown> | null>(metadata, null);

    if (!parsed || !(BILLING_METADATA_KEY in parsed)) {
        return { metadata: parsed, extras: {} };
    }

    const { [BILLING_METADATA_KEY]: extras, ...rest } = parsed;
    return {
        metadata: Object.keys(rest).length > 0 ? rest : null,
        extras: parseJsonField<Partial<T>>(extras, {}),
    };
}

/**
 * Resolve the metadata column value for an update that may carry SDK-managed
 * extra fields. Returns `undefined` when the column should be left untouched.
 *
 * When extras are present but no explicit metadata was provided, the existing
 * row's metadata is loaded first so unrelated keys are not wiped out.
 */
async function metadataForUpdate(
    client: DrizzleDatabase,
    table: any,
    idColumn: any,
    id: string,
    provided: Record<string, unknown> | undefined,
    extras: Record<string, unknown>,
): Promise<Record<string, unknown> | null | undefined> {
    const hasExtras = Object.values(extras).some((value) => value !== undefined);

    if (provided === undefined && !hasExtras) {
        return undefined;
    }

    let base = provided;
    if (base === undefined) {
        const { eq } = await loadOps();
        const rows = await client
            .select({ metadata: table.metadata })
            .from(table)
            .where(eq(idColumn, id))
            .limit(1);
        base =
            parseJsonField<Record<string, unknown> | null>(rows[0]?.metadata, null) ?? undefined;
    }

    return mergeBillingExtras(base ?? null, extras);
}

/**
 * Safely parse JSON that might be a string or already an object.
 * Some database drivers return JSON columns as strings.
 */
function parseJsonField<T>(value: unknown, fallback: T): T {
    if (value === null || value === undefined) {
        return fallback;
    }
    if (typeof value === 'string') {
        try {
            return JSON.parse(value) as T;
        } catch {
            return fallback;
        }
    }
    return value as T;
}

/**
 * Normalize a timestamp column into a Date. The bundled schema uses
 * `timestamp_ms` columns (already mapped to Date by Drizzle), but custom
 * schemas may surface raw numbers or ISO strings.
 */
function toDate(value: unknown): Date {
    return value instanceof Date ? value : new Date(value as string | number);
}

function toDateOrNull(value: unknown): Date | null {
    if (value === null || value === undefined) {
        return null;
    }
    return toDate(value);
}

function mapPlanFromDrizzle<TFeatures extends FeatureRegistry>(row: any): Plan<TFeatures> {
    const { metadata, extras } = extractBillingExtras<{ prices?: PlanPrice[] }>(row.metadata);
    // Prefer a dedicated `prices` JSON column when the schema provides one;
    // otherwise fall back to the value stored inside metadata.
    const prices = parseJsonField<PlanPrice[] | undefined>(row.prices, undefined) ?? extras.prices;

    return {
        id: row.id,
        name: row.name,
        description: row.description ?? null,
        price: Number(row.price),
        currency: row.currency,
        ...(prices ? { prices } : {}),
        interval: row.interval,
        intervalCount: row.intervalCount ?? 1,
        trialDays: row.trialDays ?? 0,
        features: parseJsonField(row.features, {}),
        isActive: Boolean(row.isActive),
        sortOrder: row.sortOrder ?? 0,
        metadata,
        createdAt: toDate(row.createdAt),
        updatedAt: toDate(row.updatedAt),
    };
}

function mapSubscriptionFromDrizzle(row: any): Subscription {
    const { metadata, extras } = extractBillingExtras<{
        quantity?: number;
        addOns?: string[];
    }>(row.metadata);
    const quantity = row.quantity ?? extras.quantity;
    const addOns = row.addOns ?? extras.addOns;

    return {
        id: row.id,
        subscriberId: row.tenantId,
        subscriberType: row.subscriberType ?? 'tenant',
        planId: row.planId,
        status: row.status as SubscriptionStatus,
        currentPeriodStart: toDate(row.currentPeriodStart),
        currentPeriodEnd: toDate(row.currentPeriodEnd),
        cancelAt: toDateOrNull(row.cancelAt),
        canceledAt: toDateOrNull(row.canceledAt),
        trialStart: toDateOrNull(row.trialStart),
        trialEnd: toDateOrNull(row.trialEnd),
        gatewaySubscriptionId: row.gatewaySubscriptionId ?? null,
        gatewayCustomerId: row.gatewayCustomerId ?? null,
        ...(quantity !== undefined && quantity !== null ? { quantity } : {}),
        ...(addOns ? { addOns } : {}),
        metadata,
        createdAt: toDate(row.createdAt),
        updatedAt: toDate(row.updatedAt),
    };
}

function mapSubscriptionWithPlanFromDrizzle<TFeatures extends FeatureRegistry>(
    row: any,
): SubscriptionWithPlan<TFeatures> {
    return {
        ...mapSubscriptionFromDrizzle(row.subscription),
        plan: mapPlanFromDrizzle<TFeatures>(row.plan),
    };
}

function mapInvoiceFromDrizzle(row: any): Invoice {
    const { metadata, extras } = extractBillingExtras<{
        invoiceNumber?: string | null;
        subtotal?: number;
        taxRate?: number;
        taxAmount?: number;
        discountAmount?: number;
        total?: number;
        creditNoteOfId?: string | null;
    }>(row.metadata);

    // Prefer dedicated columns when the schema provides them; otherwise fall
    // back to the values stored inside metadata.
    const subtotal = row.subtotal ?? extras.subtotal;
    const taxRate = row.taxRate ?? extras.taxRate;
    const taxAmount = row.taxAmount ?? extras.taxAmount;
    const discountAmount = row.discountAmount ?? extras.discountAmount;
    const total = row.total ?? extras.total;

    return {
        id: row.id,
        subscriptionId: row.subscriptionId,
        subscriberId: row.tenantId ?? row.subscriberId,
        amount: Number(row.amount),
        currency: row.currency,
        status: row.status,
        invoiceNumber: row.invoiceNumber ?? extras.invoiceNumber ?? null,
        ...(subtotal !== undefined && subtotal !== null ? { subtotal: Number(subtotal) } : {}),
        ...(taxRate !== undefined && taxRate !== null ? { taxRate: Number(taxRate) } : {}),
        ...(taxAmount !== undefined && taxAmount !== null ? { taxAmount: Number(taxAmount) } : {}),
        ...(discountAmount !== undefined && discountAmount !== null
            ? { discountAmount: Number(discountAmount) }
            : {}),
        ...(total !== undefined && total !== null ? { total: Number(total) } : {}),
        creditNoteOfId: row.creditNoteOfId ?? extras.creditNoteOfId ?? null,
        gatewayInvoiceId: row.gatewayInvoiceId ?? null,
        paidAt: toDateOrNull(row.paidAt),
        dueDate: toDateOrNull(row.dueDate),
        lineItems: parseJsonField(row.lineItems, []),
        metadata,
        createdAt: toDate(row.createdAt),
        updatedAt: toDate(row.updatedAt),
    };
}

function mapUsageRecordFromDrizzle(row: any): UsageRecord {
    return {
        id: row.id,
        subscriberId: row.subscriberId,
        feature: row.feature,
        count: row.count,
        periodStart: toDate(row.periodStart),
        periodEnd: toDate(row.periodEnd),
        createdAt: toDate(row.createdAt),
        updatedAt: toDate(row.updatedAt),
    };
}

// ==================== Helpers ====================

// Usage periods are computed in UTC so that period boundaries are deterministic
// and independent of the server's local timezone or DST transitions. Using
// local time would shift the billing window per region and could split a single
// calendar month into two usage buckets across a deploy region change.
function getMonthStart(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function getMonthEnd(date: Date): Date {
    return new Date(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0, 23, 59, 59, 999),
    );
}
