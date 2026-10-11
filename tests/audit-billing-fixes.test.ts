import { afterEach, describe, expect, it } from 'bun:test';
import { createSubscriptions, defineFeatures } from '../src/index.ts';
import { fakePaymentGateway, type FakeChargeOutcome } from '../src/testing/fake-payment-gateway.ts';
import { memoryCacheAdapter } from '../src/testing/memory-cache.ts';
import { sqliteDatabase } from './helpers/sqlite.ts';
import type { Database } from 'bun:sqlite';

const connections: Database[] = [];
afterEach(() => { for (const connection of connections.splice(0)) connection.close(); });
const features = defineFeatures({ premium: { type: 'boolean', default: false } });
function storage() {
  const fixture = sqliteDatabase();
  connections.push(fixture.connection);
  return fixture.database;
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function dunningFixture(outcomes: FakeChargeOutcome[], action: 'pause' | 'none') {
  const database = storage();
  const payment = fakePaymentGateway({ chargeOutcomes: outcomes });
  const cache = memoryCacheAdapter();
  const failed = gate();
  const continueFailure = gate();
  let blockNextInvalidation = false;
  const deleteCache = cache.delete.bind(cache);
  cache.delete = async key => {
    if (blockNextInvalidation) {
      blockNextInvalidation = false;
      failed.resolve();
      await continueFailure.promise;
    }
    await deleteCache(key);
  };
  const sdk = createSubscriptions({ database, features, cache, providers: [{ id: 'fake', accountId: 'merchant', environment: 'test', billingOwner: 'sdk_managed', adapter: payment }], options: { cacheNamespace: 'billing-regression', dunning: { retryScheduleDays: [0], action } } });
  const plan = await sdk.plans.create({ name: 'Paid', price: 10, interval: 'monthly' });
  const oldEnd = new Date(Date.now() - 86400000);
  const subscription = await database.subscriptions.create({ subscriberId: 'subscriber', planId: plan.id, status: 'past_due', currentPeriodStart: new Date(oldEnd.getTime() - 30 * 86400000), currentPeriodEnd: oldEnd, billing: { providerId: 'fake', accountId: 'merchant', environment: 'test', billingOwner: 'sdk_managed', externalPaymentMethodId: 'token' }, metadata: { dunningStartedAt: new Date(Date.now() - 86400000).toISOString(), dunningAttempts: 0 } });
  return { sdk, database, payment, subscription, failed: failed.promise, release: continueFailure.resolve, start: () => { blockNextInvalidation = true; return sdk.subscriptions.processDunning(); } };
}

describe('audited billing regressions', () => {
  it('grants a new free subscription after immediate cancellation', async () => {
    const sdk = createSubscriptions({ database: storage(), features });
    const plan = await sdk.plans.create({ name: 'Free', price: 0, interval: 'monthly', features: { premium: true } });
    await sdk.subscriptions.create('subscriber', plan.id);
    await sdk.subscriptions.cancel('subscriber', { immediately: true });
    const recreated = await sdk.subscriptions.create('subscriber', plan.id);
    expect(recreated.cancelAt).toBeNull();
    expect(recreated.canceledAt).toBeNull();
    expect(await sdk.subscriptions.isActive('subscriber')).toBe(true);
    expect(await sdk.can('subscriber', 'premium')).toBe(true);
  });

  it('applies every repeated equal-price transition within the same paid period', async () => {
    const database = storage();
    const payment = fakePaymentGateway();
    const sdk = createSubscriptions({ database, features, providers: [{ id: 'fake', accountId: 'merchant', environment: 'test', billingOwner: 'sdk_managed', adapter: payment }] });
    const a = await sdk.plans.create({ name: 'A', price: 10, interval: 'monthly' });
    const b = await sdk.plans.create({ name: 'B', price: 10, interval: 'monthly', features: { premium: true } });
    await sdk.subscriptions.create('subscriber', a.id, { billing: { providerId: 'fake', accountId: 'merchant', environment: 'test', billingOwner: 'sdk_managed', externalPaymentMethodId: 'token' } });
    const paid = await sdk.subscriptions.renew('subscriber');
    for (const plan of [b, a, b]) {
      const changed = await sdk.subscriptions.changePlan('subscriber', plan.id, { immediately: true });
      expect(changed.subscription.planId).toBe(plan.id);
      expect(changed.subscription.plan.id).toBe(plan.id);
      expect((await sdk.subscriptions.get('subscriber'))!.planId).toBe(plan.id);
    }
    expect(await sdk.can('subscriber', 'premium')).toBe(true);
    expect((await sdk.subscriptions.get('subscriber'))!.currentPeriodEnd).toEqual(paid.currentPeriodEnd);
    expect(payment.calls.filter(call => call.method === 'chargePayment')).toHaveLength(1);
  });

  it('does not suspend a paid recovery completed while an older dunning failure returns', async () => {
    const fixture = await dunningFixture(['failed', 'paid'], 'pause');
    const { sdk, database, subscription } = fixture;
    const sweep = fixture.start();
    await fixture.failed;
    let recovered;
    try { recovered = await sdk.subscriptions.renew('subscriber', { retryAttempt: 1 }); }
    finally { fixture.release(); }
    await sweep;
    const persisted = (await sdk.subscriptions.get('subscriber'))!;
    expect(persisted.status).toBe('active');
    expect(persisted.currentPeriodEnd).toEqual(recovered!.currentPeriodEnd);
    expect(persisted.metadata?.paidPrice).toEqual(recovered!.metadata?.paidPrice);
    expect(persisted.metadata?.dunningAttempts).toBeUndefined();
    expect(await database.invoices.findBySubscription(subscription.id)).toHaveLength(1);
  });

  it('shares one durable scheduled retry between overlapping dunning sweeps', async () => {
    const fixture = await dunningFixture(['failed', 'failed'], 'none');
    const first = fixture.start();
    await fixture.failed;
    try { await fixture.sdk.subscriptions.processDunning(); }
    finally { fixture.release(); }
    await first;
    expect(fixture.payment.calls.filter(call => call.method === 'chargePayment')).toHaveLength(1);
    expect((await fixture.sdk.subscriptions.get('subscriber'))!.metadata?.dunningAttempts).toBe(1);
    expect(await fixture.database.invoices.findBySubscription(fixture.subscription.id)).toHaveLength(0);
  });

  it.each([
    ['USD', 0.09, 20],
    ['USD', 0.01, 100],
    ['JPY', 9, 20],
    ['KWD', 0.009, 20],
  ] as const)('preserves tax-inclusive gross money in %s', async (currency, amount, taxRate) => {
    const sdk = createSubscriptions({ database: storage(), features });
    const totals = sdk.invoices.computeTotals([{ description: 'Inclusive', quantity: 1, unitPrice: amount, amount, taxRate, taxInclusive: true }], 0, currency);
    expect(totals.total).toBe(amount);
    expect(totals.subtotal + totals.taxAmount).toBeCloseTo(amount, 8);
  });
});
