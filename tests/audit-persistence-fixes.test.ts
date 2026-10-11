import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import type { DatabaseAdapter } from '../src/adapters/database.adapter.ts';
import { defineFeatures } from '../src/core/features.ts';
import type { FeatureRegistry } from '../src/core/types.ts';
import { PermissionsService } from '../src/services/permissions.service.ts';
import { PlansService } from '../src/services/plans.service.ts';
import { memoryCacheAdapter } from '../src/testing/memory-cache.ts';
import { memoryDatabaseAdapter } from '../src/testing/memory-database.ts';
import { sqliteDatabase } from './helpers/sqlite.ts';

const features = {
  requests: { type: 'limit', default: 3 },
  cycle: { type: 'limit', default: 3, usage: { kind: 'periodic', reset: 'subscription-cycle' } },
  metered: { type: 'metered', default: 3, usage: { kind: 'periodic', reset: 'subscription-cycle' } },
  inventory: { type: 'limit', default: 3, usage: { kind: 'persistent' } },
  rate: { type: 'rate', default: 2.5 },
} as const;
const connections: Database[] = [];
const drivers: ('memory' | 'sqlite')[] = ['memory', 'sqlite'];
const january = { periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-02-01') };
const december = { periodStart: new Date('2025-12-01'), periodEnd: new Date('2026-01-01') };
const february = { periodStart: new Date('2026-02-01'), periodEnd: new Date('2026-03-01') };

afterEach(() => {
  setSystemTime();
  for (const connection of connections.splice(0)) connection.close();
});

function sqlite<TFeatures extends FeatureRegistry = typeof features>() {
  const queries: { sql: string; parameters: unknown[] }[] = [];
  const { connection, database } = sqliteDatabase<TFeatures>({ logQuery: (sql, parameters) => queries.push({ sql, parameters }) });
  connections.push(connection);
  return { connection, database, queries };
}

async function fixture(driver: typeof drivers[number], period = { periodStart: new Date('2026-01-10'), periodEnd: new Date('2026-02-10') }) {
  setSystemTime(new Date('2026-01-20'));
  const database = driver === 'sqlite' ? sqlite().database : memoryDatabaseAdapter<typeof features>();
  const plan = await database.plans.create({ name: 'Paid', price: 10, interval: 'monthly' });
  const subscription = await database.subscriptions.create({ subscriberId: 'subscriber', planId: plan.id,
    currentPeriodStart: period.periodStart, currentPeriodEnd: period.periodEnd });
  return { database, plan, subscription, permissions: new PermissionsService(database, features) };
}

describe('audited period and tenant isolation', () => {
  test.each(drivers)('current-period reset preserves history, future periods and other tenants (%s)', async driver => {
    const { database, permissions } = await fixture(driver);
    await database.usage.set('subscriber', 'requests', 2, undefined, december);
    await database.usage.set('subscriber', 'requests', 1, undefined, january);
    await database.usage.set('subscriber', 'requests', 2, undefined, february);
    await database.usage.set('subscriber', 'requests', 3, 'other-tenant', january);

    await permissions.resetUsage('subscriber', 'requests');

    expect(await database.usage.get('subscriber', 'requests', january)).toBe(0);
    expect(await database.usage.get('subscriber', 'requests', december)).toBe(2);
    expect(await database.usage.get('subscriber', 'requests', february)).toBe(2);
    expect(await database.usage.get('subscriber', 'requests', { ...january, tenantId: 'other-tenant' })).toBe(3);
  });

  test.each(drivers)('legacy reset without boundaries still clears all periods and tenants (%s)', async driver => {
    const { database } = await fixture(driver);
    await database.usage.set('subscriber', 'requests', 2, undefined, december);
    await database.usage.set('subscriber', 'requests', 3, 'other-tenant', january);
    await database.usage.reset('subscriber', { feature: 'requests' });
    expect(await database.usage.get('subscriber', 'requests', december)).toBe(0);
    expect(await database.usage.get('subscriber', 'requests', { ...january, tenantId: 'other-tenant' })).toBe(0);
  });

  test.each(drivers)('grace and extended cycles retain authoritative counts and reject excess consumption (%s)', async driver => {
    const endedCycle = { periodStart: new Date('2026-01-10'), periodEnd: new Date('2026-01-19') };
    const { database, subscription } = await fixture(driver, endedCycle);
    await database.usage.set('subscriber', 'cycle', 2, undefined, endedCycle);
    await database.usage.set('subscriber', 'metered', 5, undefined, endedCycle);
    await database.usage.set('subscriber', 'cycle', 3, 'other-tenant', endedCycle);
    const permissions = new PermissionsService(database, features, undefined, { gracePeriodDays: 3 });

    expect(await permissions.remaining('subscriber', 'cycle')).toMatchObject({ used: 2, remaining: 1 });
    expect(await permissions.canUse('subscriber', 'cycle', 2)).toBe(false);
    await expect(permissions.use('subscriber', 'cycle', 2)).rejects.toMatchObject({ code: 'USAGE_LIMIT_EXCEEDED' });
    expect(await permissions.getAllUsage('subscriber')).toMatchObject({ cycle: { used: 2 }, metered: { used: 5 } });

    const extendedCycle = { ...endedCycle, periodEnd: new Date('2026-01-25') };
    await database.subscriptions.update(subscription.id, { currentPeriodEnd: extendedCycle.periodEnd });
    const extendedPermissions = new PermissionsService(database, features);
    expect(await extendedPermissions.getAllUsage('subscriber')).toMatchObject({ cycle: { used: 2 }, metered: { used: 5 } });
    expect(await extendedPermissions.use('subscriber', 'cycle')).toMatchObject({ used: 3, remaining: 0 });
    const stored = await database.usage.getForPeriods!('subscriber', [{ feature: 'cycle', ...extendedCycle }]);
    expect(stored[0]!.periodEnd).toEqual(extendedCycle.periodEnd);
    expect((await database.usage.getAll('subscriber')).find(record => record.feature === 'cycle')!.count).toBe(3);
  });

  test.each(drivers)('increment and absolute set update an extended period end (%s)', async driver => {
    const { database } = await fixture(driver);
    const endedCycle = { periodStart: new Date('2026-01-10'), periodEnd: new Date('2026-01-19') };
    const extendedCycle = { ...endedCycle, periodEnd: new Date('2026-01-25') };
    await database.usage.set('subscriber', 'incremented', 1, undefined, endedCycle);
    await database.usage.set('subscriber', 'replaced', 1, undefined, endedCycle);
    await database.usage.increment('subscriber', 'incremented', extendedCycle);
    await database.usage.set('subscriber', 'replaced', 2, undefined, extendedCycle);
    expect(await database.usage.getAll('subscriber')).toEqual(expect.arrayContaining([
      expect.objectContaining({ feature: 'incremented', count: 2, periodEnd: extendedCycle.periodEnd }),
      expect.objectContaining({ feature: 'replaced', count: 2, periodEnd: extendedCycle.periodEnd }),
    ]));
  });

  test('custom adapters without batching retain exact cycle reports', async () => {
    const endedCycle = { periodStart: new Date('2026-01-10'), periodEnd: new Date('2026-01-19') };
    const { database } = await fixture('memory', endedCycle);
    await database.usage.set('subscriber', 'cycle', 2, undefined, endedCycle);
    const { getForPeriods: _batch, ...usage } = database.usage;
    const permissions = new PermissionsService({ ...database, usage }, features, undefined, { gracePeriodDays: 3 });
    expect((await permissions.getAllUsage('subscriber')).cycle!.used).toBe(2);
  });
});

describe('audited usage admission receipts', () => {
  for (const replacement of ['reset', 'set'] as const) {
    test.each(drivers)(`${replacement} while admissions are pending cannot reverse or emit events for replacement usage (%s)`, async driver => {
      const { database, subscription, permissions } = await fixture(driver);
      const firstAdmission = await permissions.admitUsage('subscriber', 'cycle');
      const lastAdmission = await permissions.admitUsage('subscriber', 'cycle', 2);
      const period = { periodStart: subscription.currentPeriodStart, periodEnd: subscription.currentPeriodEnd };
      const oldRecord = (await database.usage.getForPeriods!('subscriber', [{ feature: 'cycle', ...period }]))[0]!;
      if (replacement === 'reset') await permissions.resetUsage('subscriber', 'cycle');
      else await permissions.setUsage('subscriber', 'cycle', 0);
      await permissions.use('subscriber', 'cycle', 3);
      const replacementRecord = (await database.usage.getForPeriods!('subscriber', [{ feature: 'cycle', ...period }]))[0]!;
      expect(await database.usage.decrement('subscriber', 'cycle', { ...period, expectedRecordId: oldRecord.id })).toBe(0);

      await Promise.all([firstAdmission.release(), firstAdmission.release()]);
      await lastAdmission.commit();

      expect(replacementRecord.id).not.toBe(oldRecord.id);
      expect((await permissions.remaining('subscriber', 'cycle')).used).toBe(3);
      expect((await database.outbox!.claimPending!()).map(event => event.type)).toEqual(['usage.limit_reached']);
    });
  }

  test('custom adapters without guarded reversal reject admission before mutating but retain ordinary use', async () => {
    const { database } = await fixture('memory');
    const legacyDatabase = { ...database, capabilities: { asyncTransactions: true } };
    const permissions = new PermissionsService(legacyDatabase, features);
    await expect(permissions.admitUsage('subscriber', 'cycle')).rejects.toMatchObject({ code: 'ATOMIC_USAGE_NOT_SUPPORTED' });
    expect((await permissions.remaining('subscriber', 'cycle')).used).toBe(0);
    expect(await permissions.use('subscriber', 'cycle')).toMatchObject({ used: 1 });
  });

  test('an adapter claiming guarded reversal without a record identity rolls admission back', async () => {
    const { database } = await fixture('sqlite');
    const brokenDatabase: DatabaseAdapter<typeof features> = { ...database,
      transaction: operation => database.transaction(tx => operation({ ...tx, usage: { ...tx.usage,
        reserve: async (subscriberId, feature, options) => {
          const reservation = await tx.usage.reserve!(subscriberId, feature, options);
          return { accepted: reservation.accepted, count: reservation.count };
        },
      } })),
    };
    const permissions = new PermissionsService(brokenDatabase, features);
    await expect(permissions.admitUsage('subscriber', 'cycle')).rejects.toMatchObject({ code: 'INVALID_USAGE_RESERVATION' });
    expect((await permissions.remaining('subscriber', 'cycle')).used).toBe(0);
  });

  test.each(drivers)('concurrent admissions reserve before effects and commit once per receipt (%s)', async driver => {
    const { database, permissions } = await fixture(driver);
    const attempts = await Promise.allSettled(Array.from({ length: 5 }, () => permissions.admitUsage('subscriber', 'cycle')));
    const admissions = attempts.flatMap(attempt => attempt.status === 'fulfilled' ? [attempt.value] : []);
    expect(admissions).toHaveLength(3);
    expect(attempts.filter(attempt => attempt.status === 'rejected')).toHaveLength(2);
    expect((await permissions.remaining('subscriber', 'cycle')).used).toBe(3);
    expect(await database.outbox!.claimPending!()).toEqual([]);

    await Promise.all(admissions.flatMap(admission => [admission.commit(), admission.commit()]));
    await Promise.all(admissions.map(admission => admission.release()));
    expect((await permissions.remaining('subscriber', 'cycle')).used).toBe(3);
    const events = await database.outbox!.claimPending!();
    expect(events.map(event => event.type)).toEqual(['usage.limit_reached']);
  });

  test.each(drivers)('release captures its period and stays idempotent after expiry and cancellation (%s)', async driver => {
    const { database, subscription, permissions } = await fixture(driver);
    const oldCycle = { periodStart: subscription.currentPeriodStart, periodEnd: subscription.currentPeriodEnd };
    await permissions.use('subscriber', 'cycle');
    const admission = await permissions.admitUsage('subscriber', 'cycle');
    const newCycle = { periodStart: new Date('2026-02-10'), periodEnd: new Date('2026-04-10') };
    setSystemTime(new Date('2026-03-11'));
    await database.subscriptions.update(subscription.id, { currentPeriodStart: newCycle.periodStart, currentPeriodEnd: newCycle.periodEnd });
    await permissions.use('subscriber', 'cycle', 2);
    await database.subscriptions.update(subscription.id, { status: 'canceled' });

    await Promise.all([admission.release(), admission.release()]);
    await admission.commit();
    expect(await database.usage.get('subscriber', 'cycle', oldCycle)).toBe(1);
    expect(await database.usage.get('subscriber', 'cycle', newCycle)).toBe(2);
    expect(await database.outbox!.claimPending!()).toEqual([]);
  });

  test('committed business usage keeps capacity through an outbox failure and retries its event once', async () => {
    setSystemTime(new Date('2026-01-20'));
    const { connection, database } = sqlite();
    const plan = await database.plans.create({ name: 'Paid', price: 10, interval: 'monthly' });
    await database.subscriptions.create({ subscriberId: 'subscriber', planId: plan.id });
    const permissions = new PermissionsService(database, features);
    const admission = await permissions.admitUsage('subscriber', 'requests', 3);
    connection.exec("CREATE TRIGGER failed_limit_event BEFORE INSERT ON billing_outbox BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END");
    await expect(admission.commit()).rejects.toThrow('outbox unavailable');
    await admission.release();
    expect((await permissions.remaining('subscriber', 'requests')).used).toBe(3);
    expect(await database.outbox!.claimPending!()).toEqual([]);

    connection.exec('DROP TRIGGER failed_limit_event');
    await Promise.all([admission.commit(), admission.commit()]);
    await admission.release();
    expect((await permissions.remaining('subscriber', 'requests')).used).toBe(3);
    expect((await database.outbox!.claimPending!()).map(event => event.type)).toEqual(['usage.limit_reached']);
  });

  test('ordinary use still rolls back quota when its transaction-owned limit event fails', async () => {
    setSystemTime(new Date('2026-01-20'));
    const { connection, database } = sqlite();
    const plan = await database.plans.create({ name: 'Paid', price: 10, interval: 'monthly' });
    await database.subscriptions.create({ subscriberId: 'subscriber', planId: plan.id });
    const permissions = new PermissionsService(database, features);
    connection.exec("CREATE TRIGGER failed_limit_event BEFORE INSERT ON billing_outbox BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END");
    await expect(permissions.use('subscriber', 'requests', 3)).rejects.toThrow('outbox unavailable');
    expect((await permissions.remaining('subscriber', 'requests')).used).toBe(0);
    expect(await database.outbox!.claimPending!()).toEqual([]);
  });
});

describe('audited bounded reporting and relay queries', () => {
  test('twenty-feature reports use one subscription query and one bounded usage query with a warm cache', async () => {
    setSystemTime(new Date('2026-01-20'));
    const registry = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`feature_${index}`,
      { type: 'limit' as const, default: 100, usage: { kind: 'persistent' as const } }]));
    const { database, queries } = sqlite<typeof registry>();
    const plan = await database.plans.create({ name: 'Report', price: 0, interval: 'monthly' });
    await database.subscriptions.create({ subscriberId: 'subscriber', planId: plan.id });
    const permissions = new PermissionsService(database, registry, memoryCacheAdapter(), { cacheNamespace: 'report' });
    await permissions.use('subscriber', 'feature_0', 7);
    await permissions.getFeatures('subscriber');
    queries.splice(0);

    const usage = await permissions.getAllUsage('subscriber');

    expect(Object.keys(usage)).toHaveLength(20);
    expect(usage.feature_0!.used).toBe(7);
    expect(usage.feature_19!.used).toBe(0);
    expect(queries.filter(query => query.sql.startsWith('select'))).toHaveLength(2);
  });

  test('outbox claims use the status/claim-time index instead of scanning delivered history', async () => {
    const { connection, database, queries } = sqlite();
    await database.outbox!.insert({ id: 'sent', type: 'test', data: {}, occurredAt: new Date() });
    await database.outbox!.markSent!('sent');
    await database.outbox!.insert({ id: 'pending', type: 'test', data: {}, occurredAt: new Date() });
    queries.splice(0);
    expect((await database.outbox!.claimPending!()).map(event => event.id)).toEqual(['pending']);
    const claimQuery = queries.find(query => query.sql.startsWith('select'))!;
    const plan = connection.query(`EXPLAIN QUERY PLAN ${claimQuery.sql}`).all(...claimQuery.parameters as (string | number | null)[]) as { detail: string }[];
    expect(plan.some(step => step.detail.includes('billing_outbox_status_claimed_at_idx'))).toBe(true);
    expect(plan.some(step => step.detail === 'SCAN billing_outbox')).toBe(false);
  });
});

describe('audited plan configuration', () => {
  test.each(drivers)('duplicates retain billing fields and comparisons order unlimited limits correctly (%s)', async driver => {
    const { database } = await fixture(driver);
    const plans = new PlansService(database, features);
    const original = await plans.create({ name: 'Localized', price: 10, interval: 'monthly', trialDays: 7,
      prices: [{ currency: 'EUR', amount: 9 }], metadata: { campaign: 'launch' }, features: { cycle: 3 } });
    const copy = await plans.duplicate(original.id, { features: { cycle: -1 } });
    expect(copy).toMatchObject({ trialDays: 7, prices: [{ currency: 'EUR', amount: 9 }], metadata: { campaign: 'launch' }, isActive: false });
    expect(plans.compareFeatures(original, copy).cycle.diff).toBe('upgrade');
    expect(plans.compareFeatures(copy, original).cycle.diff).toBe('downgrade');
  });

  test.each([
    ['cycle', Number.MAX_SAFE_INTEGER + 1], ['cycle', -2], ['cycle', NaN],
    ['metered', -1], ['metered', 0.5], ['metered', Infinity],
    ['rate', NaN], ['rate', Infinity], ['rate', 101],
  ] as const)('invalid %s=%s is rejected before plan creation or replacement', async (feature, invalidValue) => {
    const database = memoryDatabaseAdapter<typeof features>();
    const plans = new PlansService(database, features);
    const original = await plans.create({ name: 'Valid', price: 10, interval: 'monthly' });
    const overrides = { [feature]: invalidValue };
    await expect(plans.create({ name: 'Invalid', price: 10, interval: 'monthly', features: overrides })).rejects.toMatchObject({ code: 'INVALID_PLAN' });
    await expect(plans.update(original.id, { features: overrides })).rejects.toMatchObject({ code: 'INVALID_PLAN' });
    expect(await database.plans.findAll()).toHaveLength(1);
    expect((await database.plans.findById(original.id))!.features).toEqual({});
  });

  test('invalid numeric defaults fail during registry or service setup', () => {
    const invalidDefaults = [
      { type: 'limit', default: Number.MAX_SAFE_INTEGER + 1 },
      { type: 'metered', default: -1 },
      { type: 'rate', default: NaN },
    ] as const;
    for (const definition of invalidDefaults) {
      expect(() => defineFeatures({ feature: definition })).toThrow();
      expect(() => new PermissionsService(memoryDatabaseAdapter(), { feature: definition })).toThrow();
      expect(() => new PlansService(memoryDatabaseAdapter(), { feature: definition })).toThrow();
    }
  });
});
