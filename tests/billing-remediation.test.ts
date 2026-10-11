import { describe, test, expect } from 'bun:test';
import { createSubscriptions, defineFeatures } from '../src/index.ts';
import { memoryDatabaseAdapter } from '../src/testing/memory-database.ts';
const features = defineFeatures({ premium: { type: 'boolean', default: false } });
describe('billing trust and lifecycle', () => {
    test('unpaid paid-plan creation cannot grant paid features', async () => {
        const subs = createSubscriptions({ database: memoryDatabaseAdapter(), features });
        const plan = await subs.plans.create({ name: 'paid', price: 100, interval: 'monthly', features: { premium: true } });
        const sub = await subs.subscriptions.create('u', plan.id);
        expect(sub.status).toBe('incomplete');
        await expect(subs.can('u', 'premium')).rejects.toMatchObject({ code: 'SUBSCRIPTION_INACTIVE' });
    });
    test('inactive plans are rejected at the service boundary', async () => {
        const subs = createSubscriptions({ database: memoryDatabaseAdapter(), features });
        const plan = await subs.plans.create({ name: 'inactive', price: 0, interval: 'monthly', isActive: false });
        await expect(subs.subscriptions.create('u', plan.id)).rejects.toThrow();
    });
    test('pausing and resuming preserves unpaid trial state', async () => {
        const subs = createSubscriptions({ database: memoryDatabaseAdapter(), features });
        const plan = await subs.plans.create({ name: 'paid', price: 100, interval: 'monthly' });
        await subs.subscriptions.create('u', plan.id, { trialDays: 14 });
        await subs.subscriptions.pause('u');
        expect((await subs.subscriptions.resume('u')).status).toBe('trialing');
    });
});
test('zero-cost renewals work without a payment provider', async () => {
    const database = memoryDatabaseAdapter();
    const sdk = createSubscriptions({ database, features });
    const plan = await sdk.plans.create({ name: 'Free', price: 0, interval: 'monthly' });
    const subscription = await sdk.subscriptions.create('free', plan.id);
    await database.subscriptions.update(subscription.id, { currentPeriodStart: new Date(Date.now() - 31 * 86400000), currentPeriodEnd: new Date(Date.now() - 86400000) });
    expect((await sdk.subscriptions.renew('free')).status).toBe('active');
    expect(await sdk.invoices.listBySubscriber('free')).toHaveLength(0);
});
test('administrative policies preserve deliberate invoicing and complimentary grants', async () => {
    const database = memoryDatabaseAdapter();
    const sdk = createSubscriptions({ database, features });
    const plan = await sdk.plans.create({ name: 'Paid', price: 100, interval: 'monthly', features: { premium: true } });
    await expect(sdk.subscriptions.create('bad', plan.id, { policy: 'unexpected' as any })).rejects.toThrow();
    expect(await sdk.subscriptions.get('bad')).toBeNull();
    await sdk.subscriptions.create('manual', plan.id, { policy: 'manual_invoice' });
    expect(await sdk.can('manual', 'premium')).toBe(true);
    const invoices = await sdk.invoices.listBySubscriber('manual');
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.status).toBe('open');
    expect(invoices[0]!.invoiceNumber).toBe('INV-000001');
    await sdk.subscriptions.renewAdministrative('manual', { policy: 'complimentary' });
    expect(await sdk.invoices.listBySubscriber('manual')).toHaveLength(1);
    expect(await sdk.can('manual', 'premium')).toBe(true);
});
