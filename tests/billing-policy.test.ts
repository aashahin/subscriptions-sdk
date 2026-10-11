import { describe, expect, it } from 'bun:test';
import {
    billingCalendarAnchor,
    calculateBillingPeriodEnd,
    currencyMinorUnits,
    majorToMinor,
    minorToMajor,
    quotePlanChange,
    snapshotBillingPrice,
} from '../src/core/billing-policy.ts';
import type { Plan, Subscription } from '../src/core/types.ts';

const now = new Date('2026-01-16T00:00:00.000Z');
const subscription: Pick<Subscription, 'id' | 'status' | 'currentPeriodStart' | 'currentPeriodEnd'> = {
    id: 'sub_1', status: 'active',
    currentPeriodStart: new Date('2026-01-01T00:00:00.000Z'),
    currentPeriodEnd: new Date('2026-01-31T00:00:00.000Z'),
};
function plan(id: string, price: number, extra: Partial<Plan> = {}): Plan {
    return {
        id, name: id, description: null, price, currency: 'USD',
        interval: 'monthly', intervalCount: 1, trialDays: 0,
        features: {}, isActive: true, sortOrder: 0, metadata: null,
        createdAt: now, updatedAt: now, ...extra,
    };
}
function quote(extra: Partial<Parameters<typeof quotePlanChange>[0]> = {}) {
    return quotePlanChange({
        subscription, currentPlan: plan('basic', 100), newPlan: plan('pro', 200), now, ...extra,
    });
}

describe('production plan-change quote policy', () => {
    it('preserves the billing anchor when charging the remaining paid difference', () => {
        const result = quote();
        expect(result.amountMinor).toBe(5000);
        expect(result.amountMajor).toBe(50);
        expect(result.periodStart).toEqual(subscription.currentPeriodStart);
        expect(result.periodEnd).toEqual(subscription.currentPeriodEnd);
        expect(result.preserveAnchor).toBe(true);
        expect(result.newPrice.amountMinor).toBe(20000);
        expect(result.newPrice.updatedAt).toBe(now.toISOString());
    });

    it('charges no money before a deferred upgrade becomes effective', () => {
        const result = quote({ immediately: false });
        expect(result.amountMinor).toBe(0);
        expect(result.timing).toBe('period_end');
        expect(result.effectiveDate).toEqual(subscription.currentPeriodEnd);
        expect(result.periodEnd).toEqual(subscription.currentPeriodEnd);
    });

    it('charges a full new period for a trial without manufacturing paid credit', () => {
        const result = quote({ subscription: { ...subscription, status: 'trialing' } });
        expect(result.amountMinor).toBe(20000);
        expect(result.periodStart).toEqual(now);
        expect(result.periodEnd).toEqual(new Date('2026-02-16T00:00:00.000Z'));
        expect(result.preserveAnchor).toBe(false);
    });

    it('grants no paid credit to explicitly complimentary access', () => {
        expect(quote({ hasPaidEntitlement: false }).amountMinor).toBe(20000);
    });

    it('uses the settled period price after the catalog price changes', () => {
        const result = quote({ currentPlan: plan('basic', 150), currentPaidPrice: snapshotBillingPrice(plan('basic', 100)) });
        expect(result.amountMinor).toBe(5000);
        expect(result.currentPrice.amountMajor).toBe(100);
    });

    it('quotes the full payable amount at and after period expiry', () => {
        for (const expiredNow of [subscription.currentPeriodEnd, new Date('2026-02-01T00:00:00.000Z')]) {
            const result = quote({ now: expiredNow });
            expect(result.amountMinor).toBe(20000);
            expect(result.periodStart).toEqual(expiredNow);
            expect(result.preserveAnchor).toBe(false);
        }
    });

    it('charges full price with a new period when proration is explicitly disabled', () => {
        const result = quote({ prorate: false });
        expect(result.amountMinor).toBe(20000);
        expect(result.periodStart).toEqual(now);
    });

    it('does not compare different currencies or billing durations as raw prices', () => {
        for (const newPlan of [
            plan('pro', 100, { currency: 'SAR' }),
            plan('pro', 1200, { interval: 'yearly' }),
            plan('pro', 200, { intervalCount: 2 }),
        ]) {
            expect(() => quote({ newPlan })).toThrow('explicit migration policy');
        }
    });

    it('quotes JPY and KWD in their actual minor-unit precision', () => {
        for (const [currency, current, target, minor, major] of [
            ['JPY', 100, 200, 50, 50],
            ['KWD', 1, 2.125, 563, 0.563],
        ] as const) {
            const result = quote({ currentPlan: plan('basic', current, { currency }), newPlan: plan('pro', target, { currency }) });
            expect(result.amountMinor).toBe(minor);
            expect(result.amountMajor).toBe(major);
        }
    });

    it('expires a prorated quote at its period boundary and carries price identity', () => {
        const beforeExpiry = new Date('2026-01-30T23:59:00.000Z');
        const result = quote({ now: beforeExpiry });
        expect(result.validUntil).toEqual(subscription.currentPeriodEnd);
        expect(result.currentPrice.planId).toBe('basic');
        expect(result.newPrice.planId).toBe('pro');
        expect(result.id).not.toBe(quote({ now: beforeExpiry, newPlan: plan('pro', 201) }).id);
    });

    it('bounds proration to a valid paid period, including malformed period order', () => {
        const result = quote({ subscription: { ...subscription, currentPeriodStart: subscription.currentPeriodEnd } });
        expect(result.amountMinor).toBe(20000);
        expect(Number.isFinite(result.prorationRatio)).toBe(true);
    });
});

describe('currency money invariants', () => {
    it('uses ISO currency precision and normalized currency names', () => {
        expect(currencyMinorUnits('jpy')).toBe(0);
        expect(currencyMinorUnits('KWD')).toBe(3);
        expect(majorToMinor(1.005, 'USD')).toBe(101);
        expect(majorToMinor(-1.005, 'USD')).toBe(-101);
        expect(minorToMajor(1234, 'KWD')).toBe(1.234);
    });

    it('rejects invented currencies and nonfinite or unsafe money', () => {
        expect(() => currencyMinorUnits('ABC')).toThrow('Unsupported currency');
        for (const amount of [NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER]) {
            expect(() => majorToMinor(amount, 'USD')).toThrow();
        }
        expect(() => minorToMajor(1.1, 'USD')).toThrow('safe integer');
        expect(() => quote({ newPlan: plan('pro', -1) })).toThrow('negative');
    });
});

describe('UTC calendar billing periods', () => {
    it('keeps January 31 at February month end and preserves the end-of-month anchor', () => {
        const january = new Date('2026-01-31T18:23:45.123Z');
        const february = calculateBillingPeriodEnd(january, 'monthly', 1);
        expect(february).toEqual(new Date('2026-02-28T18:23:45.123Z'));
        expect(calculateBillingPeriodEnd(february, 'monthly', 1)).toEqual(new Date('2026-03-31T18:23:45.123Z'));
    });

    it('handles leap February and leap-year yearly periods', () => {
        expect(calculateBillingPeriodEnd(new Date('2024-01-31T00:00:00.000Z'), 'monthly', 1))
            .toEqual(new Date('2024-02-29T00:00:00.000Z'));
        expect(calculateBillingPeriodEnd(new Date('2024-02-29T00:00:00.000Z'), 'yearly', 1))
            .toEqual(new Date('2025-02-28T00:00:00.000Z'));
    });

    it('can preserve an original non-month-end day through a clamped short month', () => {
        const january = new Date('2026-01-30T00:00:00.000Z');
        const anchor = billingCalendarAnchor(january);
        const february = calculateBillingPeriodEnd(january, 'monthly', 1, anchor);
        expect(february).toEqual(new Date('2026-02-28T00:00:00.000Z'));
        expect(calculateBillingPeriodEnd(february, 'monthly', 1, anchor)).toEqual(new Date('2026-03-30T00:00:00.000Z'));
    });

    it('rejects invalid dates or interval counts instead of generating invalid periods', () => {
        expect(() => calculateBillingPeriodEnd(new Date(NaN), 'monthly', 1)).toThrow();
        for (const count of [0, -1, 1.5, Infinity]) {
            expect(() => calculateBillingPeriodEnd(now, 'monthly', count)).toThrow();
        }
    });
});
