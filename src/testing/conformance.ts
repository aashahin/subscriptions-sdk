// file: packages/subscriptions/src/testing/conformance.ts
// Conformance suites for DatabaseAdapter and CacheAdapter implementations.
//
// Each suite registers `bun:test` describe/it blocks verifying that an adapter
// satisfies the behavioral contract the package relies on. Run them against
// any implementation — the bundled memory adapters, the Prisma adapter, or a
// custom one — to catch contract drift.
//
// `bun:test` is imported lazily inside the registration functions so that
// importing this module never loads the test runner in production runtimes.

import type { CacheAdapter } from '../adapters/cache.adapter.js';
import type { DatabaseAdapter } from '../adapters/database.adapter.js';
import type {
    BillingInterval,
    FeatureRegistry,
} from '../core/types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

const inDays = (days: number): Date => new Date(Date.now() + days * DAY_MS);

/**
 * Register the DatabaseAdapter conformance suite.
 *
 * @param name - Display name for the describe block (e.g. the adapter name)
 * @param factory - Returns a fresh, empty adapter instance per test
 *
 * @example
 * ```typescript
 * // tests/conformance.prisma.test.ts
 * import { databaseAdapterConformance } from '@abshahin/subscriptions/testing';
 *
 * await databaseAdapterConformance('prismaAdapter', () => prismaAdapter(db));
 * ```
 */
export async function databaseAdapterConformance<
    TFeatures extends FeatureRegistry = FeatureRegistry,
>(
    name: string,
    factory: () => DatabaseAdapter<TFeatures> | Promise<DatabaseAdapter<TFeatures>>,
): Promise<void> {
    const { describe, it, expect } = await import('bun:test');

    const createPlanInput = (
        overrides: Partial<{
            name: string;
            price: number;
            interval: BillingInterval;
            isActive: boolean;
            sortOrder: number;
        }> = {},
    ) => ({
        name: overrides.name ?? 'Pro',
        price: overrides.price ?? 1000,
        interval: overrides.interval ?? ('monthly' as BillingInterval),
        ...(overrides.isActive !== undefined && { isActive: overrides.isActive }),
        ...(overrides.sortOrder !== undefined && { sortOrder: overrides.sortOrder }),
    });

    describe(`DatabaseAdapter conformance: ${name}`, () => {
        // ==================== Plans ====================
        it('creates, reads, updates and deletes a plan', async () => {
            const db = await factory();

            const plan = await db.plans.create(createPlanInput());
            expect(plan.id).toBeTruthy();
            expect(plan.currency).toBe('USD');
            expect(plan.intervalCount).toBe(1);
            expect(plan.isActive).toBe(true);

            const found = await db.plans.findById(plan.id);
            expect(found?.name).toBe('Pro');

            const updated = await db.plans.update(plan.id, {
                price: 2000,
                isActive: false,
            });
            expect(updated.price).toBe(2000);
            expect(updated.isActive).toBe(false);

            await db.plans.delete(plan.id);
            expect(await db.plans.findById(plan.id)).toBeNull();
        });

        it('lists plans with findAll and the activeOnly filter', async () => {
            const db = await factory();
            await db.plans.create(createPlanInput({ name: 'Active', sortOrder: 2 }));
            await db.plans.create(
                createPlanInput({ name: 'Inactive', isActive: false, sortOrder: 1 }),
            );

            expect(await db.plans.findAll()).toHaveLength(2);

            const active = await db.plans.findAll({ activeOnly: true });
            expect(active).toHaveLength(1);
            expect(active[0]?.name).toBe('Active');
        });

        it('filters plans in findAllForAdmin with totals and pagination', async () => {
            const db = await factory();
            await db.plans.create(createPlanInput({ name: 'M1', sortOrder: 1 }));
            await db.plans.create(
                createPlanInput({ name: 'M2', sortOrder: 2, isActive: false }),
            );
            await db.plans.create(
                createPlanInput({ name: 'Y1', interval: 'yearly', sortOrder: 3 }),
            );

            const all = await db.plans.findAllForAdmin();
            expect(all.total).toBe(3);
            expect(all.plans).toHaveLength(3);
            // sorted by sortOrder ascending
            expect(all.plans[0]?.name).toBe('M1');

            const inactive = await db.plans.findAllForAdmin({ isActive: false });
            expect(inactive.total).toBe(1);
            expect(inactive.plans[0]?.name).toBe('M2');

            const yearly = await db.plans.findAllForAdmin({ interval: 'yearly' });
            expect(yearly.total).toBe(1);
            expect(yearly.plans[0]?.name).toBe('Y1');

            const page = await db.plans.findAllForAdmin({ limit: 2, offset: 1 });
            expect(page.total).toBe(3);
            expect(page.plans).toHaveLength(2);
            expect(page.plans[0]?.name).toBe('M2');
        });

        it('reports active subscribers and pending downgrades', async () => {
            const db = await factory();
            const plan = await db.plans.create(createPlanInput({ name: 'From' }));
            const target = await db.plans.create(createPlanInput({ name: 'To' }));

            expect(await db.plans.hasActiveSubscribers(plan.id)).toBe(false);
            expect(await db.plans.hasPendingDowngrades(target.id)).toBe(false);

            const sub = await db.subscriptions.create({
                subscriberId: 'tenant_1',
                planId: plan.id,
                metadata: { pendingDowngradePlanId: target.id },
            });

            expect(await db.plans.hasActiveSubscribers(plan.id)).toBe(true);
            expect(await db.plans.hasPendingDowngrades(target.id)).toBe(true);

            await db.subscriptions.update(sub.id, { status: 'canceled' });
            expect(await db.plans.hasActiveSubscribers(plan.id)).toBe(false);
            expect(await db.plans.hasPendingDowngrades(target.id)).toBe(false);
        });

        // ==================== Subscriptions ====================
        it('creates, reads, updates and deletes a subscription', async () => {
            const db = await factory();
            const plan = await db.plans.create(createPlanInput());

            const sub = await db.subscriptions.create({
                subscriberId: 'tenant_1',
                planId: plan.id,
            });
            expect(sub.status).toBe('active');
            expect(sub.subscriberType).toBe('tenant');

            const found = await db.subscriptions.findById(sub.id);
            expect(found?.id).toBe(sub.id);
            expect(found?.plan.id).toBe(plan.id);

            const updated = await db.subscriptions.update(sub.id, {
                status: 'past_due',
            });
            expect(updated.status).toBe('past_due');

            await db.subscriptions.delete(sub.id);
            expect(await db.subscriptions.findById(sub.id)).toBeNull();
        });

        it('finds a subscription by subscriber', async () => {
            const db = await factory();
            const plan = await db.plans.create(createPlanInput());
            await db.subscriptions.create({
                subscriberId: 'tenant_1',
                planId: plan.id,
            });

            const found = await db.subscriptions.findBySubscriber('tenant_1');
            expect(found?.subscriberId).toBe('tenant_1');
            expect(found?.plan.id).toBe(plan.id);

            expect(await db.subscriptions.findBySubscriber('tenant_unknown')).toBeNull();
        });

        it('filters subscriptions in findAll by status and plan', async () => {
            const db = await factory();
            const plan = await db.plans.create(createPlanInput());
            await db.subscriptions.create({
                subscriberId: 'tenant_1',
                planId: plan.id,
                status: 'active',
            });
            await db.subscriptions.create({
                subscriberId: 'tenant_2',
                planId: plan.id,
                status: 'canceled',
            });

            expect(await db.subscriptions.findAll()).toHaveLength(2);
            expect(
                await db.subscriptions.findAll({ status: 'active' }),
            ).toHaveLength(1);
            expect(
                await db.subscriptions.findAll({ status: ['active', 'canceled'] }),
            ).toHaveLength(2);
            expect(
                await db.subscriptions.findAll({ planId: plan.id, limit: 1 }),
            ).toHaveLength(1);
        });

        it('finds subscriptions expiring within a window', async () => {
            const db = await factory();
            const plan = await db.plans.create(createPlanInput());

            const expiringSoon = await db.subscriptions.create({
                subscriberId: 'tenant_1',
                planId: plan.id,
                currentPeriodEnd: inDays(5),
            });
            await db.subscriptions.create({
                subscriberId: 'tenant_2',
                planId: plan.id,
                currentPeriodEnd: inDays(30),
            });
            await db.subscriptions.create({
                subscriberId: 'tenant_3',
                planId: plan.id,
                status: 'canceled',
                currentPeriodEnd: inDays(3),
            });

            const within7 = await db.subscriptions.findExpiring(7);
            expect(within7).toHaveLength(1);
            expect(within7[0]?.id).toBe(expiringSoon.id);

            expect(await db.subscriptions.findExpiring(2)).toHaveLength(0);
        });

        // ==================== Invoices ====================
        it('creates, reads and updates an invoice', async () => {
            const db = await factory();
            const plan = await db.plans.create(createPlanInput());
            const sub = await db.subscriptions.create({
                subscriberId: 'tenant_1',
                planId: plan.id,
            });

            const invoice = await db.invoices.create({
                subscriptionId: sub.id,
                amount: 1000,
                currency: 'USD',
                lineItems: [
                    { description: 'Pro plan', quantity: 1, unitPrice: 1000, amount: 1000 },
                ],
            });
            expect(invoice.status).toBe('draft');
            expect(invoice.subscriberId).toBe('tenant_1');

            const found = await db.invoices.findById(invoice.id);
            expect(found?.amount).toBe(1000);
            expect(found?.lineItems).toHaveLength(1);

            const paidAt = new Date();
            const updated = await db.invoices.update(invoice.id, {
                status: 'paid',
                paidAt,
            });
            expect(updated.status).toBe('paid');
            expect(updated.paidAt?.getTime()).toBe(paidAt.getTime());
        });

        it('finds invoices by subscription and subscriber', async () => {
            const db = await factory();
            const plan = await db.plans.create(createPlanInput());
            const sub = await db.subscriptions.create({
                subscriberId: 'tenant_1',
                planId: plan.id,
            });
            await db.invoices.create({
                subscriptionId: sub.id,
                amount: 100,
                currency: 'USD',
            });
            await db.invoices.create({
                subscriptionId: sub.id,
                amount: 200,
                currency: 'USD',
            });

            expect(await db.invoices.findBySubscription(sub.id)).toHaveLength(2);
            expect(await db.invoices.findBySubscriber('tenant_1')).toHaveLength(2);
            expect(await db.invoices.findBySubscriber('tenant_other')).toHaveLength(0);
        });

        it('finds an invoice with full subscription and plan details', async () => {
            const db = await factory();
            const plan = await db.plans.create(createPlanInput());
            const sub = await db.subscriptions.create({
                subscriberId: 'tenant_1',
                planId: plan.id,
            });
            const invoice = await db.invoices.create({
                subscriptionId: sub.id,
                amount: 1000,
                currency: 'USD',
            });

            const detailed = await db.invoices.findByIdWithDetails(invoice.id);
            expect(detailed?.id).toBe(invoice.id);
            expect(detailed?.subscription.id).toBe(sub.id);
            expect(detailed?.plan.id).toBe(plan.id);
        });

        it('supports idempotent webhook handling via findByGatewayInvoiceId', async () => {
            const db = await factory();
            if (!db.invoices.findByGatewayInvoiceId) {
                // Optional capability — adapters may omit it (the package
                // degrades gracefully without idempotency).
                return;
            }

            const plan = await db.plans.create(createPlanInput());
            const sub = await db.subscriptions.create({
                subscriberId: 'tenant_1',
                planId: plan.id,
            });
            const invoice = await db.invoices.create({
                subscriptionId: sub.id,
                amount: 1000,
                currency: 'USD',
                gatewayInvoiceId: 'gw_inv_123',
            });

            const found = await db.invoices.findByGatewayInvoiceId('gw_inv_123');
            expect(found?.id).toBe(invoice.id);

            expect(
                await db.invoices.findByGatewayInvoiceId('gw_inv_missing'),
            ).toBeNull();
        });

        // ==================== Usage Tracking ====================
        it('increments usage and returns the running count', async () => {
            const db = await factory();

            expect(await db.usage.get('tenant_1', 'api_calls')).toBe(0);
            expect(await db.usage.increment('tenant_1', 'api_calls')).toBe(1);
            expect(await db.usage.increment('tenant_1', 'api_calls', { count: 4 })).toBe(5);
            expect(await db.usage.get('tenant_1', 'api_calls')).toBe(5);
        });

        it('decrements usage but never below zero', async () => {
            const db = await factory();

            await db.usage.increment('tenant_1', 'api_calls', { count: 3 });
            expect(await db.usage.decrement('tenant_1', 'api_calls')).toBe(2);
            expect(
                await db.usage.decrement('tenant_1', 'api_calls', { count: 10 }),
            ).toBe(0);
            expect(await db.usage.get('tenant_1', 'api_calls')).toBe(0);
            // decrementing a feature that was never used stays at zero
            expect(await db.usage.decrement('tenant_1', 'never_used')).toBe(0);
        });

        it('sets usage to an absolute value', async () => {
            const db = await factory();

            await db.usage.set('tenant_1', 'api_calls', 7);
            expect(await db.usage.get('tenant_1', 'api_calls')).toBe(7);

            await db.usage.set('tenant_1', 'api_calls', 2);
            expect(await db.usage.get('tenant_1', 'api_calls')).toBe(2);
        });

        it('resets usage per feature and entirely', async () => {
            const db = await factory();

            await db.usage.increment('tenant_1', 'api_calls');
            await db.usage.increment('tenant_1', 'emails');

            await db.usage.reset('tenant_1', { feature: 'api_calls' });
            expect(await db.usage.get('tenant_1', 'api_calls')).toBe(0);
            expect(await db.usage.get('tenant_1', 'emails')).toBe(1);

            await db.usage.reset('tenant_1');
            expect(await db.usage.get('tenant_1', 'emails')).toBe(0);
        });

        it('returns all usage records for a subscriber', async () => {
            const db = await factory();

            await db.usage.increment('tenant_1', 'api_calls', { count: 3 });
            await db.usage.increment('tenant_1', 'emails');
            await db.usage.increment('tenant_2', 'api_calls');

            const records = await db.usage.getAll('tenant_1');
            expect(records).toHaveLength(2);

            const apiCalls = records.find((record) => record.feature === 'api_calls');
            expect(apiCalls?.count).toBe(3);
            expect(apiCalls?.subscriberId).toBe('tenant_1');
        });

        // ==================== Transactions ====================
        it('commits changes made inside a transaction', async () => {
            const db = await factory();

            const planId = await db.transaction(async (tx) => {
                const plan = await tx.plans.create(createPlanInput());
                await tx.subscriptions.create({
                    subscriberId: 'tenant_1',
                    planId: plan.id,
                });
                return plan.id;
            });

            expect(await db.plans.findById(planId)).not.toBeNull();
            expect(
                await db.subscriptions.findBySubscriber('tenant_1'),
            ).not.toBeNull();
        });

        it('rolls back changes when the transaction throws', async () => {
            const db = await factory();
            const plan = await db.plans.create(createPlanInput());

            let caught: unknown;
            try {
                await db.transaction(async (tx) => {
                    await tx.plans.create(createPlanInput({ name: 'Temp' }));
                    await tx.plans.delete(plan.id);
                    throw new Error('boom');
                });
            } catch (error) {
                caught = error;
            }

            expect(caught).toBeDefined();
            expect((caught as Error).message).toBe('boom');
            expect(await db.plans.findById(plan.id)).not.toBeNull();
            const { plans } = await db.plans.findAllForAdmin();
            expect(plans).toHaveLength(1);
        });
    });
}

/**
 * Register the CacheAdapter conformance suite.
 *
 * Optional capabilities (`deletePattern`, `incrBy`/`decrBy`, `exists`) are
 * verified only when the adapter implements them.
 *
 * @param name - Display name for the describe block (e.g. the adapter name)
 * @param factory - Returns a fresh, empty cache instance per test
 */
export async function cacheAdapterConformance(
    name: string,
    factory: () => CacheAdapter | Promise<CacheAdapter>,
): Promise<void> {
    const { describe, it, expect } = await import('bun:test');

    describe(`CacheAdapter conformance: ${name}`, () => {
        it('returns null for missing keys', async () => {
            const cache = await factory();
            expect(await cache.get('missing')).toBeNull();
        });

        it('sets and gets values, including objects', async () => {
            const cache = await factory();

            await cache.set('key', 'value');
            expect(await cache.get('key')).toBe('value');

            const payload = { subscriberId: 'tenant_1', features: ['a', 'b'] };
            await cache.set('obj', payload);
            expect(await cache.get('obj')).toEqual(payload);
        });

        it('overwrites existing values', async () => {
            const cache = await factory();

            await cache.set('key', 'first');
            await cache.set('key', 'second');
            expect(await cache.get('key')).toBe('second');
        });

        it('expires values after their TTL', async () => {
            const cache = await factory();

            await cache.set('short-lived', 'value', 0.05);
            expect(await cache.get('short-lived')).toBe('value');

            await sleep(100);
            expect(await cache.get('short-lived')).toBeNull();
        });

        it('deletes values', async () => {
            const cache = await factory();

            await cache.set('key', 'value');
            await cache.delete('key');
            expect(await cache.get('key')).toBeNull();
        });

        it('deletes values matching a glob pattern', async () => {
            const cache = await factory();
            if (!cache.deletePattern) {
                return;
            }

            await cache.set('sub:tenant:1', 'a');
            await cache.set('sub:tenant:2', 'b');
            await cache.set('plan:1', 'c');

            await cache.deletePattern('sub:tenant:*');

            expect(await cache.get('sub:tenant:1')).toBeNull();
            expect(await cache.get('sub:tenant:2')).toBeNull();
            expect(await cache.get('plan:1')).toBe('c');
        });

        it('increments and decrements numeric values', async () => {
            const cache = await factory();
            if (!cache.incrBy || !cache.decrBy) {
                return;
            }

            expect(await cache.incrBy('counter', 2)).toBe(2);
            expect(await cache.incrBy('counter', 3)).toBe(5);
            expect(await cache.decrBy('counter', 4)).toBe(1);
        });

        it('reports whether keys exist', async () => {
            const cache = await factory();
            if (!cache.exists) {
                return;
            }

            expect(await cache.exists('key')).toBe(false);
            await cache.set('key', 'value');
            expect(await cache.exists('key')).toBe(true);
            await cache.delete('key');
            expect(await cache.exists('key')).toBe(false);
        });
    });
}
