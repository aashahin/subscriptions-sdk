import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { PermissionsService } from '../src/services/permissions.service.ts';
import { PlansService } from '../src/services/plans.service.ts';
import { memoryDatabaseAdapter } from '../src/testing/memory-database.ts';
import { memoryCacheAdapter } from '../src/testing/memory-cache.ts';
import type { CacheAdapter } from '../src/adapters/cache.adapter.ts';
import type { DatabaseAdapter } from '../src/adapters/database.adapter.ts';

const features = {
  products: { type: 'limit', default: 10, usage: { kind: 'persistent' } },
  requests: { type: 'limit', default: 10, usage: { kind: 'periodic', reset: 'calendar-month' } },
  cycle: { type: 'limit', default: 10, usage: { kind: 'periodic', reset: 'subscription-cycle' } },
  metered: { type: 'metered', default: 1 },
  enabled: { type: 'boolean', default: false },
  rate: { type: 'rate', default: 2 },
} as const;

afterEach(() => setSystemTime());

async function fixture(cache?: CacheAdapter, cacheNamespace = 'test:db:development') {
  setSystemTime(new Date('2026-01-15T00:00:00Z'));
  const db = memoryDatabaseAdapter<typeof features>();
  const plan = await db.plans.create({ name: 'Free', price: 0, interval: 'monthly',
    features: { enabled: true }, isActive: true });
  const subscription = await db.subscriptions.create({ subscriberId: 'subscriber', planId: plan.id,
    status: 'active', currentPeriodStart: new Date('2026-01-10T00:00:00Z'),
    currentPeriodEnd: new Date('2026-02-10T00:00:00Z') });
  return { db, plan, subscription, permissions: new PermissionsService(db, features, cache, { cacheNamespace }) };
}

describe('usage policies and admission', () => {
  test('persistent gauges survive monthly boundaries and bulk resets; calendar consumption resets', async () => {
    const { permissions } = await fixture();
    await permissions.use('subscriber', 'products', 3);
    await permissions.use('subscriber', 'requests', 4);
    setSystemTime(new Date('2026-02-01T00:00:00Z'));
    expect((await permissions.remaining('subscriber', 'products')).used).toBe(3);
    expect((await permissions.remaining('subscriber', 'requests')).used).toBe(0);
    await permissions.resetUsage('subscriber');
    expect((await permissions.remaining('subscriber', 'products')).used).toBe(3);
    expect((await permissions.release('subscriber', 'products', 1)).used).toBe(2);
    await permissions.resetUsage('subscriber', 'products');
    expect((await permissions.remaining('subscriber', 'products')).used).toBe(0);
  });

  test('subscription-cycle usage spans calendar months and resets with the authoritative cycle', async () => {
    const { permissions, db, subscription } = await fixture();
    await permissions.use('subscriber', 'cycle', 5);
    setSystemTime(new Date('2026-02-01T00:00:00Z'));
    expect((await permissions.remaining('subscriber', 'cycle')).used).toBe(5);
    await db.subscriptions.update(subscription.id, {
      currentPeriodStart: new Date('2026-02-10T00:00:00Z'), currentPeriodEnd: new Date('2026-03-10T00:00:00Z'),
    });
    setSystemTime(new Date('2026-02-10T00:00:00Z'));
    expect((await permissions.remaining('subscriber', 'cycle')).used).toBe(0);
    await permissions.use('subscriber', 'cycle', 2);
    expect((await permissions.remaining('subscriber', 'cycle')).used).toBe(2);
  });

  test('invalid quantities and non-usage feature types never mutate accounting', async () => {
    const { permissions } = await fixture();
    await permissions.setUsage('subscriber', 'products', 5);
    for (const count of [-5, 0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1' as any]) {
      await expect(permissions.use('subscriber', 'products', count)).rejects.toMatchObject({ code: 'INVALID_USAGE_VALUE' });
      await expect(permissions.release('subscriber', 'products', count)).rejects.toMatchObject({ code: 'INVALID_USAGE_VALUE' });
      await expect(permissions.canUse('subscriber', 'products', count)).rejects.toMatchObject({ code: 'INVALID_USAGE_VALUE' });
      if (count !== 0) await expect(permissions.setUsage('subscriber', 'products', count)).rejects.toMatchObject({ code: 'INVALID_USAGE_VALUE' });
    }
    for (const feature of ['enabled', 'rate', 'unknown'] as any[]) {
      await expect(permissions.use('subscriber', feature)).rejects.toMatchObject({ code: 'INVALID_USAGE_FEATURE' });
    }
    expect((await permissions.remaining('subscriber', 'products')).used).toBe(5);
    await permissions.setUsage('subscriber', 'products', 0);
    expect((await permissions.remaining('subscriber', 'products')).used).toBe(0);
  });

  test('conditional admission admits exactly one last-slot consumer', async () => {
    const { permissions, db } = await fixture();
    await permissions.setUsage('subscriber', 'products', 9);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => permissions.use('subscriber', 'products')));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await permissions.remaining('subscriber', 'products')).used).toBe(10);
    const events = await db.outbox!.claimPending!();
    expect(events.filter(event => event.type === 'usage.limit_reached')).toHaveLength(1);
  });

  test('capped usage fails closed for legacy adapters without conditional admission', async () => {
    const { db } = await fixture();
    const { reserve, ...legacyUsage } = db.usage;
    const permissions = new PermissionsService({ ...db, usage: legacyUsage }, features);
    await expect(permissions.use('subscriber', 'products')).rejects.toMatchObject({ code: 'ATOMIC_USAGE_NOT_SUPPORTED' });
    expect((await permissions.remaining('subscriber', 'products')).used).toBe(0);
  });

  test('a last-slot outbox persistence failure rolls usage back with the event', async () => {
    const { db, permissions } = await fixture();
    await permissions.setUsage('subscriber', 'products', 9);
    const failingDb: DatabaseAdapter<typeof features> = { ...db,
      transaction: operation => db.transaction(tx => operation({ ...tx,
        outbox: { ...tx.outbox!, insert: async () => { throw new Error('outbox unavailable'); } },
      })),
    };
    const failingPermissions = new PermissionsService(failingDb, features);
    await expect(failingPermissions.use('subscriber', 'products')).rejects.toThrow('outbox unavailable');
    expect((await permissions.remaining('subscriber', 'products')).used).toBe(9);
    expect(await db.outbox!.claimPending!()).toEqual([]);
  });
});

describe('cache and eligibility invariants', () => {
  test('all cache failures leave rejected consumption untouched and successful mutations committed once', async () => {
    const unavailable: CacheAdapter = {
      get: async () => { throw new Error('get unavailable'); },
      set: async () => { throw new Error('set unavailable'); },
      delete: async () => { throw new Error('delete unavailable'); },
    };
    const { permissions } = await fixture(unavailable);
    await permissions.setUsage('subscriber', 'products', 9);
    await expect(permissions.use('subscriber', 'products', 2)).rejects.toMatchObject({ code: 'USAGE_LIMIT_EXCEEDED' });
    expect((await permissions.remaining('subscriber', 'products')).used).toBe(9);
    expect((await permissions.use('subscriber', 'products')).used).toBe(10);
    expect((await permissions.release('subscriber', 'products', 2)).used).toBe(8);
    expect((await permissions.remaining('subscriber', 'products')).used).toBe(8);
  });

  test('cached values cannot outlive expiration even if cache ignores TTL', async () => {
    const entries = new Map<string, unknown>();
    const timeless: CacheAdapter = { get: async key => entries.get(key) as any ?? null,
      set: async (key, value) => { entries.set(key, value); }, delete: async key => { entries.delete(key); } };
    const { permissions } = await fixture(timeless);
    expect(await permissions.can('subscriber', 'enabled')).toBe(true);
    expect(entries.size).toBe(1);
    setSystemTime(new Date('2026-02-10T00:00:00Z'));
    await expect(permissions.getFeatures('subscriber')).rejects.toMatchObject({ code: 'SUBSCRIPTION_INACTIVE' });
    await expect(permissions.can('subscriber', 'metered')).rejects.toMatchObject({ code: 'SUBSCRIPTION_INACTIVE' });
    await expect(permissions.canUse('subscriber', 'metered')).rejects.toMatchObject({ code: 'SUBSCRIPTION_INACTIVE' });
    await expect(permissions.use('subscriber', 'metered')).rejects.toMatchObject({ code: 'SUBSCRIPTION_INACTIVE' });
  });

  test('plan changes invalidate the eligibility envelope even within one timestamp', async () => {
    const { db, plan, permissions } = await fixture(memoryCacheAdapter());
    expect(await permissions.can('subscriber', 'enabled')).toBe(true);
    await db.plans.update(plan.id, { features: { enabled: false, products: 1 } });
    expect(await permissions.can('subscriber', 'enabled')).toBe(false);
    await expect(permissions.use('subscriber', 'products', 2)).rejects.toMatchObject({ code: 'USAGE_LIMIT_EXCEEDED' });
  });

  test('trial, cancellation and ineligible statuses are checked before cached or metered access', async () => {
    const { db, subscription, permissions } = await fixture(memoryCacheAdapter());
    expect(await permissions.canUse('subscriber', 'metered', 100)).toBe(true);
    await db.subscriptions.update(subscription.id, { status: 'trialing', trialEnd: new Date('2026-01-15T00:00:00Z') });
    await expect(permissions.canUse('subscriber', 'metered')).rejects.toMatchObject({ code: 'SUBSCRIPTION_INACTIVE' });
    await db.subscriptions.update(subscription.id, { status: 'active', cancelAt: new Date('2026-01-15T00:00:00Z') });
    await expect(permissions.getFeatures('subscriber')).rejects.toMatchObject({ code: 'SUBSCRIPTION_INACTIVE' });
    await db.subscriptions.update(subscription.id, { status: 'paused', cancelAt: null });
    await expect(permissions.can('subscriber', 'metered')).rejects.toMatchObject({ code: 'SUBSCRIPTION_INACTIVE' });
    expect(await permissions.can('absent', 'metered')).toBe(false);
    expect(await permissions.canUse('absent', 'metered')).toBe(false);
    await expect(permissions.use('absent', 'metered')).rejects.toMatchObject({ code: 'SUBSCRIPTION_INACTIVE' });
  });

  test('cache namespaces are required and isolate otherwise matching subscriber identities', async () => {
    const cache = memoryCacheAdapter();
    const { db } = await fixture();
    expect(() => new PermissionsService(db, features, cache)).toThrow('cacheNamespace');
    expect(() => new PlansService(db, features, cache)).toThrow('cacheNamespace');
    const first = await fixture(cache, 'project-one:db:production');
    const second = await fixture(cache, 'project-two:db:production');
    await second.db.plans.update(second.plan.id, { features: { enabled: false } });
    expect(await first.permissions.can('subscriber', 'enabled')).toBe(true);
    expect(await second.permissions.can('subscriber', 'enabled')).toBe(false);
    expect(await cache.exists!('project-one:db:production:features:subscriber')).toBe(true);
    expect(await cache.exists!('project-two:db:production:features:subscriber')).toBe(true);
  });

  test('plan mutation succeeds through cache failure and reads never return stale activation or price', async () => {
    const cache = memoryCacheAdapter();
    const { db, plan } = await fixture(cache);
    await cache.set('test:plan:' + plan.id, { ...plan, isActive: true, price: 100 });
    cache.delete = async () => { throw new Error('cache unavailable'); };
    const plans = new PlansService(db, features, cache, { cacheNamespace: 'test' });
    await expect(plans.update(plan.id, { isActive: false, price: 20 })).resolves.toMatchObject({ isActive: false, price: 20 });
    expect(await plans.get(plan.id)).toMatchObject({ isActive: false, price: 20 });
    expect(await plans.list({ activeOnly: true })).toEqual([]);
  });

  test('plan mutations persist their events in the same transaction', async () => {
    const db = memoryDatabaseAdapter<typeof features>();
    const plans = new PlansService(db, features);
    const created = await plans.create({ name: 'Plan', price: 0, interval: 'monthly' });
    await plans.update(created.id, { name: 'Updated' });
    await plans.delete(created.id);
    const events = await db.outbox!.claimPending!();
    expect(events.map(event => event.type)).toEqual(['plan.created', 'plan.updated', 'plan.deleted']);
    expect(new Set(events.map(event => event.id)).size).toBe(3);
  });

  test('outbox failures roll back plan creation, updates and deletion', async () => {
    const db = memoryDatabaseAdapter<typeof features>();
    const failingDb: DatabaseAdapter<typeof features> = { ...db,
      transaction: operation => db.transaction(tx => operation({ ...tx,
        outbox: { ...tx.outbox!, insert: async () => { throw new Error('outbox unavailable'); } },
      })),
    };
    const plans = new PlansService(failingDb, features);
    await expect(plans.create({ name: 'Plan', price: 0, interval: 'monthly' })).rejects.toThrow('outbox unavailable');
    expect(await db.plans.findAll()).toEqual([]);
    const created = await db.plans.create({ name: 'Plan', price: 0, interval: 'monthly' });
    await expect(plans.update(created.id, { price: 20 })).rejects.toThrow('outbox unavailable');
    expect((await db.plans.findById(created.id))?.price).toBe(0);
    await expect(plans.delete(created.id)).rejects.toThrow('outbox unavailable');
    expect(await db.plans.findById(created.id)).not.toBeNull();
    expect(await db.outbox!.claimPending!()).toEqual([]);
  });
});
