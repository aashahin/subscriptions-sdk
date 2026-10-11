import { describe, expect, test } from 'bun:test';
import { CouponsService } from '../src/services/coupons.service.ts';
import { memoryDatabaseAdapter } from '../src/testing/memory-database.ts';

describe('atomic purchase-bound coupon admission', () => {
  test('discounts respect purchase currency precision and reject cross-currency fixed coupons before reservation', async () => {
    const coupons = new CouponsService(memoryDatabaseAdapter());
    const percent = await coupons.create({ code: 'PRECISION', type: 'percent', value: 50 });
    expect(coupons.computeDiscount(percent, 101, 'JPY')).toBe(51);
    expect(coupons.computeDiscount(percent, 1.001, 'KWD')).toBe(0.501);
    const kwd = await coupons.apply('PRECISION', 1.001, { purchaseId: 'kwd-purchase', currency: 'KWD' });
    expect(kwd.total).toBe(0.5);
    await coupons.create({ code: 'SAR-ONLY', type: 'fixed', value: 10, currency: 'SAR' });
    await expect(coupons.apply('SAR-ONLY', 100, { purchaseId: 'usd-purchase', currency: 'USD' }))
      .rejects.toMatchObject({ code: 'COUPON_CURRENCY_MISMATCH' });
    expect((await coupons.getByCode('SAR-ONLY'))?.timesRedeemed).toBe(0);
  });

  test('concurrent consumers cannot redeem the last slot more than once', async () => {
    const db = memoryDatabaseAdapter();
    const coupons = new CouponsService(db);
    await coupons.create({ code: 'LAST', type: 'percent', value: 25, maxRedemptions: 1 });
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) =>
      coupons.apply('last', 100, { purchaseId: `purchase-${index}` })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await coupons.getByCode('LAST'))?.timesRedeemed).toBe(1);
  });

  test('retry is idempotent, release is idempotent, and a released purchase cannot consume again', async () => {
    const coupons = new CouponsService(memoryDatabaseAdapter());
    await coupons.create({ code: 'ONCE', type: 'percent', value: 25, maxRedemptions: 1 });
    const first = await coupons.apply('ONCE', 100, { purchaseId: 'same-purchase' });
    const retry = await coupons.apply('ONCE', 100, { purchaseId: 'same-purchase' });
    expect(first.total).toBe(75);
    expect(retry.coupon.timesRedeemed).toBe(1);
    await coupons.release('ONCE', 'same-purchase');
    await coupons.release('ONCE', 'same-purchase');
    expect((await coupons.getByCode('ONCE'))?.timesRedeemed).toBe(0);
    await expect(coupons.apply('ONCE', 100, { purchaseId: 'same-purchase' })).rejects.toMatchObject({ code: 'COUPON_REDEMPTION_CONFLICT' });
    expect((await coupons.apply('ONCE', 100, { purchaseId: 'new-purchase' })).coupon.timesRedeemed).toBe(1);
  });

  test('inactive and expired coupons cannot reserve capacity; purchase identities cannot cross coupons', async () => {
    const coupons = new CouponsService(memoryDatabaseAdapter());
    await coupons.create({ code: 'INACTIVE', type: 'percent', value: 25, isActive: false });
    await expect(coupons.apply('INACTIVE', 100, { purchaseId: 'purchase' })).rejects.toMatchObject({ code: 'COUPON_INVALID' });
    await coupons.create({ code: 'EXPIRED', type: 'percent', value: 25, expiresAt: new Date(0) });
    await expect(coupons.apply('EXPIRED', 100, { purchaseId: 'purchase' })).rejects.toMatchObject({ code: 'COUPON_INVALID' });
    await coupons.create({ code: 'FIRST', type: 'percent', value: 25 });
    await coupons.create({ code: 'SECOND', type: 'percent', value: 25 });
    await coupons.apply('FIRST', 100, { purchaseId: 'purchase' });
    await expect(coupons.apply('SECOND', 100, { purchaseId: 'purchase' })).rejects.toThrow();
    expect((await coupons.getByCode('SECOND'))?.timesRedeemed).toBe(0);
  });

  test('missing purchase IDs, invalid amounts and non-atomic adapters fail before redemption', async () => {
    const db = memoryDatabaseAdapter();
    const coupons = new CouponsService(db);
    await coupons.create({ code: 'SAFE', type: 'percent', value: 25 });
    for (const amount of [NaN, Infinity, -1]) {
      await expect(coupons.apply('SAFE', amount, { purchaseId: 'purchase' })).rejects.toMatchObject({ code: 'INVALID_COUPON_AMOUNT' });
    }
    await expect((coupons.apply as any)('SAFE', 100)).rejects.toMatchObject({ code: 'INVALID_COUPON_PURCHASE' });
    const { redeem, ...legacyCoupons } = db.coupons!;
    await expect(new CouponsService({ ...db, coupons: legacyCoupons }).apply('SAFE', 100, { purchaseId: 'purchase' }))
      .rejects.toMatchObject({ code: 'ATOMIC_COUPONS_NOT_SUPPORTED' });
    expect((await coupons.getByCode('SAFE'))?.timesRedeemed).toBe(0);
  });
});
