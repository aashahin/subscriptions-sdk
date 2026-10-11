import { describe, expect, it, setSystemTime } from 'bun:test';
import { createSubscriptions, defineFeatures } from '../src/index.ts';
import type { ChargePaymentInput } from '../src/adapters/payment.adapter.ts';
import type { CreateSubscriptionInput } from '../src/core/types.ts';
import { snapshotBillingPrice } from '../src/core/billing-policy.ts';
import { fakePaymentGateway } from '../src/testing/fake-payment-gateway.ts';
import { memoryDatabaseAdapter } from '../src/testing/memory-database.ts';

const features = defineFeatures({ premium: { type: 'boolean', default: false } });
const DAY_MS = 24 * 60 * 60 * 1000;

async function setup(extra: Partial<CreateSubscriptionInput> = {}) {
    const database = memoryDatabaseAdapter<typeof features>();
    const payment = fakePaymentGateway();
    const current = await database.plans.create({ name: 'Basic', price: 100, currency: 'USD', interval: 'monthly' });
    const target = await database.plans.create({ name: 'Pro', price: 200, currency: 'USD', interval: 'monthly', features: { premium: true } });
    const now = new Date();
    const periodStart = new Date(now.getTime() - 15 * DAY_MS);
    const periodEnd = new Date(now.getTime() + 15 * DAY_MS);
    const subscription = await database.subscriptions.create({
        subscriberId: 'user_1', planId: current.id, status: 'active',
        currentPeriodStart: periodStart, currentPeriodEnd: periodEnd,
        gatewayCustomerId: 'tok_1',
        billing: { providerId: 'fake', accountId: 'default', environment: 'test', billingOwner: 'sdk_managed', externalPaymentMethodId: 'tok_1' },
        metadata: { billingPolicy: 'purchase', paidThrough: periodEnd.toISOString(), paidPrice: snapshotBillingPrice(current) },
        ...extra,
    });
    const sdk = createSubscriptions({
        database, features, payment,
        providers: [{ id: 'fake', accountId: 'default', environment: 'test', billingOwner: extra.billing?.billingOwner ?? 'sdk_managed', adapter: payment }],
        defaultProvider: 'fake',
        options: { dunning: { retryScheduleDays: [0, 1], action: 'none' } },
    });
    return { database, payment, current, target, subscription, sdk };
}

function charges(payment: ReturnType<typeof fakePaymentGateway>): ChargePaymentInput[] {
    return payment.calls.filter(call => call.method === 'chargePayment').map(call => call.args[0] as ChargePaymentInput);
}

describe('subscription lifecycle through production services', () => {
    it('collects the persisted preview price while preserving a prorated paid anchor', async () => {
        const { sdk, database, payment, subscription, target } = await setup();
        const preview = await sdk.subscriptions.previewChangePlan('user_1', target.id);
        const result = await sdk.subscriptions.changePlan('user_1', target.id, { quoteId: preview.quoteId });
        expect(charges(payment)).toHaveLength(1);
        expect(charges(payment)[0]!.amount).toBe(preview.amountDue);
        expect(result.subscription.currentPeriodStart).toEqual(subscription.currentPeriodStart);
        expect(result.subscription.currentPeriodEnd).toEqual(subscription.currentPeriodEnd);
        const invoices = await database.invoices.findBySubscription(subscription.id);
        expect(invoices).toHaveLength(1);
        expect(invoices[0]!.amount).toBe(preview.amountDueFormatted);
        expect(invoices[0]!.status).toBe('paid');
    });

    it('quotes and collects full target price after an active-status period expires', async () => {
        const { sdk, payment, target } = await setup({
            currentPeriodStart: new Date(Date.now() - 31 * DAY_MS),
            currentPeriodEnd: new Date(Date.now() - DAY_MS),
        });
        const preview = await sdk.subscriptions.previewChangePlan('user_1', target.id);
        expect(preview.amountDue).toBe(20000);
        await sdk.subscriptions.changePlan('user_1', target.id, { quoteId: preview.quoteId });
        expect(charges(payment)[0]!.amount).toBe(preview.amountDue);
    });

    it('defers an upgrade without collecting or granting the target plan early', async () => {
        const { sdk, database, payment, subscription, current, target } = await setup();
        const preview = await sdk.subscriptions.previewChangePlan('user_1', target.id, { immediately: false });
        expect(preview.amountDue).toBe(0);
        const result = await sdk.subscriptions.changePlan('user_1', target.id, { quoteId: preview.quoteId, immediately: false });
        expect(charges(payment)).toHaveLength(0);
        expect(result.subscription.planId).toBe(current.id);
        expect(await database.invoices.findBySubscription(subscription.id)).toHaveLength(0);
        expect(await sdk.can('user_1', 'premium')).toBe(false);
    });

    it('rejects changed price identity and requires a fresh confirmation', async () => {
        const { sdk, database, payment, target, current } = await setup();
        const preview = await sdk.subscriptions.previewChangePlan('user_1', target.id);
        await database.plans.update(target.id, { price: 250 });
        await expect(sdk.subscriptions.changePlan('user_1', target.id, { quoteId: preview.quoteId })).rejects.toThrow();
        expect(charges(payment)).toHaveLength(0);
        expect((await database.subscriptions.findBySubscriber('user_1'))!.planId).toBe(current.id);
    });

    it('credits the settled period price after a catalog price edit', async () => {
        const { sdk, database, payment, current, target } = await setup();
        await database.plans.update(current.id, { price: 150 });
        const preview = await sdk.subscriptions.previewChangePlan('user_1', target.id);
        expect(preview.amountDue).toBe(5000);
        await sdk.subscriptions.changePlan('user_1', target.id, { quoteId: preview.quoteId });
        expect(charges(payment)[0]!.amount).toBe(5000);
    });

    it('fails closed when legacy paid-period price evidence has not been backfilled', async () => {
        const { sdk, payment, target } = await setup({ metadata: { billingPolicy: 'purchase' } });
        await expect(sdk.subscriptions.previewChangePlan('user_1', target.id)).rejects.toThrow('backfill');
        expect(charges(payment)).toHaveLength(0);
    });

    it('requires confirmation again at the exact quote expiry boundary', async () => {
        setSystemTime(new Date('2026-04-01T00:00:00.000Z'));
        try {
            const { sdk, payment, target } = await setup();
            const preview = await sdk.subscriptions.previewChangePlan('user_1', target.id);
            setSystemTime(preview.validUntil);
            await expect(sdk.subscriptions.changePlan('user_1', target.id, { quoteId: preview.quoteId })).rejects.toThrow('expired');
            expect(charges(payment)).toHaveLength(0);
        } finally {
            setSystemTime();
        }
    });

    it('rejects currency and interval transitions before any collection', async () => {
        for (const change of [{ currency: 'SAR' }, { interval: 'yearly' as const }]) {
            const { sdk, database, payment, target } = await setup();
            await database.plans.update(target.id, change);
            await expect(sdk.subscriptions.previewChangePlan('user_1', target.id)).rejects.toThrow();
            await expect(sdk.subscriptions.changePlan('user_1', target.id)).rejects.toThrow();
            expect(charges(payment)).toHaveLength(0);
        }
    });

    it('keeps JPY and KWD precision consistent across quote, collection, and invoice', async () => {
        setSystemTime(new Date('2026-04-01T00:00:00.000Z'));
        try {
            for (const [currency, currentPrice, targetPrice, minor, major] of [
                ['JPY', 100, 200, 50, 50],
                ['KWD', 1, 2.125, 563, 0.563],
            ] as const) {
                const { sdk, database, payment, subscription, current, target } = await setup();
                const paidPlan = await database.plans.update(current.id, { currency, price: currentPrice });
                await database.plans.update(target.id, { currency, price: targetPrice });
                await database.subscriptions.update(subscription.id, { metadata: { ...subscription.metadata, paidPrice: snapshotBillingPrice(paidPlan) } });
                const preview = await sdk.subscriptions.previewChangePlan('user_1', target.id);
                expect(preview.amountDue).toBe(minor);
                expect(preview.amountDueFormatted).toBe(major);
                const result = await sdk.subscriptions.changePlan('user_1', target.id, { quoteId: preview.quoteId });
                expect(charges(payment)[0]!.amount).toBe(minor);
                expect(charges(payment)[0]!.currency).toBe(currency);
                expect(result.invoice!.amount).toBe(major);
                expect(result.invoice!.currency).toBe(currency);
            }
        } finally {
            setSystemTime();
        }
    });

    it('enrolls a confirmed renewal failure in dunning and clears it after recovery', async () => {
        const { sdk, database, payment, subscription } = await setup({
            currentPeriodStart: new Date(Date.now() - 31 * DAY_MS),
            currentPeriodEnd: new Date(Date.now() - DAY_MS),
        });
        payment.queueChargeOutcome('failed');
        await expect(sdk.subscriptions.renew('user_1')).rejects.toThrow();
        const failed = await database.subscriptions.findById(subscription.id);
        expect(failed!.status).toBe('past_due');
        expect(failed!.metadata?.dunningStartedAt).toBeString();
        const results = await sdk.subscriptions.processDunning(new Date(Date.now() + 2 * DAY_MS));
        expect(results[0]!.recovered).toBe(true);
        const recovered = await database.subscriptions.findById(subscription.id);
        expect(recovered!.status).toBe('active');
        expect(recovered!.metadata?.dunningStartedAt).toBeUndefined();
        expect(recovered!.metadata?.dunningAttempts).toBeUndefined();
    });

    it('uses one pending-downgrade renewal quote for dunning charge, plan, and invoice', async () => {
        const { sdk, database, payment, subscription } = await setup({
            status: 'past_due',
            currentPeriodStart: new Date(Date.now() - 31 * DAY_MS),
            currentPeriodEnd: new Date(Date.now() - DAY_MS),
        });
        const downgrade = await database.plans.create({ name: 'Starter', price: 25, currency: 'USD', interval: 'monthly' });
        await database.subscriptions.update(subscription.id, {
            metadata: { pendingDowngradePlanId: downgrade.id, dunningStartedAt: new Date(Date.now() - DAY_MS).toISOString(), dunningAttempts: 0 },
        });
        const results = await sdk.subscriptions.processDunning();
        expect(results[0]!.recovered).toBe(true);
        expect(charges(payment)).toHaveLength(1);
        expect(charges(payment)[0]!.amount).toBe(2500);
        const renewed = await database.subscriptions.findById(subscription.id);
        expect(renewed!.planId).toBe(downgrade.id);
        const invoices = await database.invoices.findBySubscription(subscription.id);
        expect(invoices).toHaveLength(1);
        expect(invoices[0]!.amount).toBe(25);
        expect(invoices[0]!.currency).toBe(charges(payment)[0]!.currency);
        expect(invoices[0]!.status).toBe('paid');
    });

    it('restores a paused trial and charges its full conversion price', async () => {
        const trialEnd = new Date(Date.now() + 15 * DAY_MS);
        const { sdk, payment, target } = await setup({ status: 'trialing', trialStart: new Date(), trialEnd, currentPeriodEnd: trialEnd });
        await sdk.subscriptions.pause('user_1');
        const resumed = await sdk.subscriptions.resume('user_1');
        expect(resumed.status).toBe('trialing');
        expect(resumed.trialEnd!.getTime()).toBeGreaterThanOrEqual(trialEnd.getTime());
        const preview = await sdk.subscriptions.previewChangePlan('user_1', target.id);
        expect(preview.amountDue).toBe(20000);
        await sdk.subscriptions.changePlan('user_1', target.id, { quoteId: preview.quoteId });
        expect(charges(payment)[0]!.amount).toBe(20000);
    });

    it('failed optional upgrades preserve the existing paid period and status', async () => {
        const { sdk, database, payment, subscription, current, target } = await setup();
        const preview = await sdk.subscriptions.previewChangePlan('user_1', target.id);
        payment.queueChargeOutcome('failed');
        await expect(sdk.subscriptions.changePlan('user_1', target.id, { quoteId: preview.quoteId })).rejects.toThrow();
        const unchanged = await database.subscriptions.findById(subscription.id);
        expect(unchanged!.status).toBe('active');
        expect(unchanged!.planId).toBe(current.id);
        expect(unchanged!.currentPeriodEnd).toEqual(subscription.currentPeriodEnd);
        expect(unchanged!.metadata?.dunningStartedAt).toBeUndefined();
    });

    it('reactivates scheduled cancellation through the subscription owning provider', async () => {
        const { sdk, database, payment, subscription } = await setup({
            billing: { providerId: 'fake', accountId: 'default', environment: 'test', billingOwner: 'provider_managed' },
        });
        const remote = await payment.createSubscription!({ customerId: 'cus_1', priceId: 'price_1' });
        await database.subscriptions.update(subscription.id, { gatewaySubscriptionId: remote.id, billing: { ...subscription.billing!, externalSubscriptionId: remote.id } });
        await sdk.subscriptions.cancel('user_1');
        expect((await payment.getSubscription!(remote.id))!.cancelAt).not.toBeNull();
        const reactivated = await sdk.subscriptions.reactivate('user_1');
        expect(reactivated.cancelAt).toBeNull();
        expect((await payment.getSubscription!(remote.id))!.cancelAt).toBeNull();
        expect(payment.calls.some(call => call.method === 'updateSubscription' && call.args[0] === remote.id)).toBe(true);
    });

    it('fails unsupported provider reactivation before clearing local cancellation', async () => {
        const { sdk, database, payment, subscription } = await setup({
            billing: { providerId: 'fake', accountId: 'default', environment: 'test', billingOwner: 'provider_managed' },
        });
        const remote = await payment.createSubscription!({ customerId: 'cus_1', priceId: 'price_1' });
        await database.subscriptions.update(subscription.id, { gatewaySubscriptionId: remote.id, billing: { ...subscription.billing!, externalSubscriptionId: remote.id } });
        await sdk.subscriptions.cancel('user_1');
        delete payment.updateSubscription;
        await expect(sdk.subscriptions.reactivate('user_1')).rejects.toThrow('reactivation');
        expect((await database.subscriptions.findById(subscription.id))!.cancelAt).not.toBeNull();
    });

    it('does not issue provider commands when accepting an incoming cancellation snapshot', async () => {
        const { sdk, database, payment, subscription } = await setup({
            billing: { providerId: 'fake', accountId: 'default', environment: 'test', billingOwner: 'provider_managed', externalSubscriptionId: 'native_1' },
        });
        await sdk.subscriptions.acceptSubscriptionSnapshot('fake', {
            id: 'evt_cancel', type: 'customer.subscription.deleted', createdAt: new Date(),
            data: { id: 'native_1', metadata: { subscriberId: 'user_1' } },
        });
        expect((await database.subscriptions.findById(subscription.id))!.status).toBe('canceled');
        expect(payment.calls).toHaveLength(0);
    });

    it('cannot collect SDK renewal or dunning for provider-owned billing', async () => {
        const { sdk, payment } = await setup({
            status: 'past_due',
            currentPeriodEnd: new Date(Date.now() - DAY_MS),
            billing: { providerId: 'fake', accountId: 'default', environment: 'test', billingOwner: 'provider_managed', externalSubscriptionId: 'native_1' },
            metadata: { dunningStartedAt: new Date(Date.now() - 2 * DAY_MS).toISOString(), dunningAttempts: 0 },
        });
        await expect(sdk.subscriptions.renew('user_1')).rejects.toThrow('provider-managed');
        expect(await sdk.subscriptions.processDunning()).toHaveLength(0);
        expect(charges(payment)).toHaveLength(0);
    });

    it('preserves the original calendar anchor when a renewal follows clamped February', async () => {
        setSystemTime(new Date('2026-02-28T00:00:00.000Z'));
        try {
            const { sdk } = await setup({
                currentPeriodStart: new Date('2026-01-30T00:00:00.000Z'),
                currentPeriodEnd: new Date('2026-02-28T00:00:00.000Z'),
                metadata: { billingPolicy: 'purchase', billingAnchor: { day: 30, endOfMonth: false } },
            });
            const renewed = await sdk.subscriptions.renew('user_1');
            expect(renewed.currentPeriodStart).toEqual(new Date('2026-02-28T00:00:00.000Z'));
            expect(renewed.currentPeriodEnd).toEqual(new Date('2026-03-30T00:00:00.000Z'));
        } finally {
            setSystemTime();
        }
    });

    for (const status of ['trialing', 'incomplete'] as const) {
        it(`starts and retains a full paid period when renewing ${status} after the original anchor day`, async () => {
            setSystemTime(new Date('2026-10-25T00:00:00.000Z'));
            try {
                const { sdk, database, payment, subscription } = await setup({
                    status,
                    currentPeriodStart: new Date('2026-10-11T00:00:00.000Z'),
                    currentPeriodEnd: new Date(status === 'trialing' ? '2026-10-25T00:00:00.000Z' : '2026-11-11T00:00:00.000Z'),
                    trialStart: status === 'trialing' ? new Date('2026-10-11T00:00:00.000Z') : null,
                    trialEnd: status === 'trialing' ? new Date('2026-10-25T00:00:00.000Z') : null,
                    metadata: { billingPolicy: 'purchase', billingAnchor: { day: 11, endOfMonth: false } },
                });
                const converted = await sdk.subscriptions.renew('user_1');
                expect(charges(payment)[0]!.amount).toBe(10000);
                expect(converted.currentPeriodStart).toEqual(new Date('2026-10-25T00:00:00.000Z'));
                expect(converted.currentPeriodEnd).toEqual(new Date('2026-11-25T00:00:00.000Z'));
                expect(converted.metadata?.billingAnchor).toEqual({ day: 25, endOfMonth: false });
                setSystemTime(new Date('2026-11-25T00:00:00.000Z'));
                const renewed = await sdk.subscriptions.renew('user_1');
                expect(renewed.currentPeriodEnd).toEqual(new Date('2026-12-25T00:00:00.000Z'));
                expect(await database.invoices.findBySubscription(subscription.id)).toHaveLength(2);
            } finally {
                setSystemTime();
            }
        });
    }

    for (const source of ['trial', 'free'] as const) {
        it(`accepts the same explicit proration policy when ${source} conversion requires full price`, async () => {
            const { sdk, database, payment, subscription, current, target } = await setup(source === 'trial' ? {
                status: 'trialing', trialStart: new Date(), trialEnd: new Date(Date.now() + 15 * DAY_MS),
            } : {});
            if (source === 'free') {
                const freePlan = await database.plans.update(current.id, { price: 0 });
                await database.subscriptions.update(subscription.id, { metadata: { ...subscription.metadata, paidPrice: snapshotBillingPrice(freePlan) } });
            }
            const preview = await sdk.subscriptions.previewChangePlan('user_1', target.id, { prorate: true });
            expect(preview.amountDue).toBe(20000);
            const converted = await sdk.subscriptions.changePlan('user_1', target.id, { quoteId: preview.quoteId, prorate: true });
            expect(converted.subscription.status).toBe('active');
            expect(charges(payment)[0]!.amount).toBe(20000);
        });
    }

    it('accepts the same explicit no-proration policy for a deferred change', async () => {
        const { sdk, payment, current, target } = await setup();
        const preview = await sdk.subscriptions.previewChangePlan('user_1', target.id, { immediately: false, prorate: false });
        expect(preview.amountDue).toBe(0);
        const deferred = await sdk.subscriptions.changePlan('user_1', target.id, { quoteId: preview.quoteId, immediately: false, prorate: false });
        expect(deferred.subscription.planId).toBe(current.id);
        expect(charges(payment)).toHaveLength(0);
    });

    it('executes a confirmed legacy full-price quote by ID without requiring unused credit evidence', async () => {
        const { sdk, payment, target } = await setup({ metadata: { billingPolicy: 'purchase' } });
        const preview = await sdk.subscriptions.previewChangePlan('user_1', target.id, { prorate: false });
        expect(preview.amountDue).toBe(20000);
        const converted = await sdk.subscriptions.changePlan('user_1', target.id, { quoteId: preview.quoteId });
        expect(converted.subscription.status).toBe('active');
        expect(charges(payment)[0]!.amount).toBe(20000);
    });
});
