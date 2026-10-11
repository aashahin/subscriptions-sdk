import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { drizzleAdapter, subscriptionsSchema } from '../src/adapters/drizzle.adapter';
import { createSubscriptions, defineFeatures, type ProviderRegistration } from '../src/index';
import { fakePaymentGateway } from '../src/testing/fake-payment-gateway';

const connections: Database[] = [];
afterEach(() => { for (const db of connections.splice(0)) db.close(); });
const features = defineFeatures({ premium: { type: 'boolean', default: false } });
function database() {
  const connection = new Database(':memory:');
  connections.push(connection);
  connection.exec('PRAGMA foreign_keys = ON');
  // Construct the actual shipped schema, including its foreign keys and unique indexes.
  for (const table of Object.values(subscriptionsSchema)) {
    const config = getTableConfig(table);
    const columns = config.columns.map(column => `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}${column.notNull ? ' NOT NULL' : ''}${column.isUnique ? ' UNIQUE' : ''}`);
    for (const fk of config.foreignKeys) {
      const ref = fk.reference();
      columns.push(`FOREIGN KEY (${ref.columns.map(column => `"${column.name}"`).join(',')}) REFERENCES "${getTableConfig(ref.foreignTable).name}" (${ref.foreignColumns.map(column => `"${column.name}"`).join(',')})`);
    }
    connection.exec(`CREATE TABLE "${config.name}" (${columns.join(',')})`);
    for (const index of config.indexes) {
      const item = index.config;
      connection.exec(`CREATE ${item.unique ? 'UNIQUE ' : ''}INDEX "${item.name}" ON "${config.name}" (${item.columns.map(column => `"${(column as { name: string }).name}"`).join(',')})`);
    }
  }
  return drizzleAdapter(drizzle(connection, { schema: subscriptionsSchema }));
}
function registration(id: string, adapter = fakePaymentGateway(), billingOwner: 'sdk_managed' | 'provider_managed' = 'sdk_managed'): ProviderRegistration {
  return { id, accountId: `${id}-account`, environment: 'test', billingOwner, adapter };
}
async function fixture(input: { gateway?: ReturnType<typeof fakePaymentGateway>; providerManaged?: boolean } = {}) {
  const db = database();
  const gateway = input.gateway ?? fakePaymentGateway();
  const provider = registration('original', gateway, input.providerManaged ? 'provider_managed' : 'sdk_managed');
  const subs = createSubscriptions({ database: db, features, providers: [provider], defaultProvider: provider.id });
  const plan = await subs.plans.create({ name: 'Paid', price: 100, currency: 'SAR', interval: 'monthly', features: { premium: true } });
  const created = await subs.subscriptions.create('subscriber', plan.id, { policy: 'complimentary', billing: { providerId: provider.id, accountId: provider.accountId, environment: 'test', billingOwner: provider.billingOwner, externalCustomerId: 'customer_original', externalPaymentMethodId: 'token_original', ...(input.providerManaged ? { externalSubscriptionId: 'subscription_remote' } : {}) } });
  const previousEnd = new Date(Date.now() - 86400000);
  await db.subscriptions.update(created.id, { status: 'active', currentPeriodStart: new Date(previousEnd.getTime() - 30 * 86400000), currentPeriodEnd: previousEnd, metadata: { billingPolicy: 'purchase', paidThrough: previousEnd.toISOString() } });
  gateway.clearCalls();
  return { db, gateway, provider, subs, plan, subscriptionId: created.id, previousEnd };
}
const charges = (gateway: ReturnType<typeof fakePaymentGateway>) => gateway.calls.filter(call => call.method === 'chargePayment');

describe('collection and persistent routing on real bun:sqlite', () => {
  test('concurrent renewals collect once and persist one actual settlement invoice', async () => {
    const gateway = fakePaymentGateway();
    const originalCharge = gateway.chargePayment!.bind(gateway);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const canComplete = new Promise<void>(resolve => { release = resolve; });
    gateway.chargePayment = async input => { enter(); await canComplete; return originalCharge(input); };
    const { db, subs, previousEnd } = await fixture({ gateway });
    const renewals = Array.from({ length: 8 }, () => subs.subscriptions.renew('subscriber'));
    const all = Promise.allSettled(renewals);
    await entered;
    release();
    const results = await all;
    expect(results.some(result => result.status === 'fulfilled')).toBe(true);
    expect(charges(gateway)).toHaveLength(1);
    const collected = charges(gateway)[0]!.args[0] as { idempotencyKey: string; amount: number };
    expect(collected.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(collected.amount).toBe(10000);
    const invoices = await db.invoices.findBySubscriber('subscriber');
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.amount).toBe(100);
    expect(invoices[0]!.status).toBe('paid');
    expect((await subs.subscriptions.get('subscriber'))!.currentPeriodEnd.getTime()).toBeGreaterThan(previousEnd.getTime());
  });

  test('transport failure after provider acceptance blocks another charge until authoritative reconciliation', async () => {
    const gateway = fakePaymentGateway({ chargeOutcomes: [input => ({ id: input.idempotencyKey!, status: 'paid' })] });
    const originalCharge = gateway.chargePayment!.bind(gateway);
    const originalLookup = gateway.getPayment!.bind(gateway);
    let reconcilable = false;
    gateway.chargePayment = async input => { await originalCharge(input); throw new Error('Connection dropped after provider accepted'); };
    gateway.getPayment = async id => reconcilable ? originalLookup(id) : null;
    const { db, subs } = await fixture({ gateway });
    await expect(subs.subscriptions.renew('subscriber')).rejects.toThrow('unknown');
    await expect(subs.subscriptions.renew('subscriber')).rejects.toThrow();
    await expect(subs.subscriptions.renew('subscriber', { retryAttempt: 1 })).rejects.toThrow();
    expect(charges(gateway)).toHaveLength(1);
    expect(await db.invoices.findBySubscriber('subscriber')).toHaveLength(0);
    reconcilable = true;
    expect((await subs.subscriptions.renew('subscriber')).status).toBe('active');
    expect(charges(gateway)).toHaveLength(1);
    expect(await db.invoices.findBySubscriber('subscriber')).toHaveLength(1);
  });

  for (const status of ['pending', 'authorized'] as const) {
    test(`${status} outcomes cannot be retried using a new logical attempt`, async () => {
      const { db, gateway, subs } = await fixture({ gateway: fakePaymentGateway({ chargeOutcomes: [status] }) });
      await expect(subs.subscriptions.renew('subscriber')).rejects.toThrow();
      await expect(subs.subscriptions.renew('subscriber')).rejects.toThrow();
      await expect(subs.subscriptions.renew('subscriber', { retryAttempt: 1 })).rejects.toThrow();
      await expect(subs.subscriptions.renew('subscriber', { retryAttempt: 100 })).rejects.toThrow();
      expect(charges(gateway)).toHaveLength(1);
      expect(await db.invoices.findBySubscriber('subscriber')).toHaveLength(0);
      await expect(subs.can('subscriber', 'premium')).rejects.toThrow('expired');
    });
  }

  test('changing the default provider preserves existing provider/account/payment-method routing', async () => {
    const { db, gateway, provider } = await fixture();
    const otherGateway = fakePaymentGateway({ provider: 'other' });
    const other = registration('new-default', otherGateway);
    const freshSdk = createSubscriptions({ database: db, features, providers: [provider, other], defaultProvider: other.id });
    await freshSdk.subscriptions.renew('subscriber');
    expect(charges(gateway)).toHaveLength(1);
    expect(charges(otherGateway)).toHaveLength(0);
    const input = charges(gateway)[0]!.args[0] as { customerId: string; paymentMethodId: string };
    expect(input.customerId).toBe('customer_original');
    expect(input.paymentMethodId).toBe('token_original');
    expect((await freshSdk.subscriptions.get('subscriber'))!.billing!.providerId).toBe('original');
  });

  test('provider-managed subscriptions cannot enter local renewal or dunning collection', async () => {
    const { db, gateway, subs, subscriptionId } = await fixture({ providerManaged: true });
    await expect(subs.subscriptions.renew('subscriber')).rejects.toThrow('provider-managed');
    await db.subscriptions.update(subscriptionId, { status: 'past_due', metadata: { dunningStartedAt: new Date(Date.now() - 10 * 86400000).toISOString(), dunningAttempts: 0 } });
    expect(await subs.subscriptions.processDunning()).toEqual([]);
    expect(charges(gateway)).toHaveLength(0);
    expect(await db.invoices.findBySubscriber('subscriber')).toHaveLength(0);
  });

  test('confirmed failure permits one next attempt with the immutable pending-plan quote', async () => {
    const { db, gateway, subs, plan, subscriptionId } = await fixture({ gateway: fakePaymentGateway({ chargeOutcomes: ['failed', 'paid'] }) });
    const pending = await subs.plans.create({ name: 'Downgrade', price: 25, currency: 'SAR', interval: 'monthly' });
    await db.subscriptions.update(subscriptionId, { metadata: { billingPolicy: 'purchase', pendingDowngradePlanId: pending.id } });
    await expect(subs.subscriptions.renew('subscriber')).rejects.toThrow();
    expect((await subs.subscriptions.get('subscriber'))!.status).toBe('past_due');
    await db.plans.update(pending.id, { price: 50 });
    await subs.subscriptions.renew('subscriber', { retryAttempt: 1 });
    const inputs = charges(gateway).map(call => call.args[0] as { amount: number; idempotencyKey: string });
    expect(inputs.map(input => input.amount)).toEqual([2500, 2500]);
    expect(inputs[0]!.idempotencyKey).not.toBe(inputs[1]!.idempotencyKey);
    const latest = (await subs.subscriptions.get('subscriber'))!;
    expect(latest.planId).toBe(pending.id);
    expect(latest.planId).not.toBe(plan.id);
    expect(latest.metadata?.dunningAttempts).toBeUndefined();
    const invoices = await db.invoices.findBySubscriber('subscriber');
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.amount).toBe(25);
  });
});
