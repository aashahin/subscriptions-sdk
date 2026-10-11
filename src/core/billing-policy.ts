import { SubscriptionError } from './errors.js';
import type { BillingInterval, Plan, Subscription } from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const QUOTE_VALIDITY_MS = 5 * 60 * 1000;

/** ISO currency precision supplied by the runtime's CLDR data. */
export function currencyMinorUnits(currency: string): number {
    const normalized = normalizeCurrency(currency);
    const precision = new Intl.NumberFormat('en', {
        style: 'currency', currency: normalized,
    }).resolvedOptions().maximumFractionDigits;
    if (precision === undefined || !Number.isInteger(precision) || precision < 0) {
        throw new SubscriptionError(`Currency precision is unavailable: ${currency}`, 'INVALID_CURRENCY');
    }
    return precision;
}

export function normalizeCurrency(currency: string): string {
    if (typeof currency !== 'string' || !/^[a-z]{3}$/i.test(currency)) {
        throw new SubscriptionError('A supported ISO currency code is required', 'INVALID_CURRENCY');
    }
    const normalized = currency.toUpperCase();
    // NumberFormat accepts invented three-letter codes; supportedValuesOf
    // prevents silently assigning a guessed precision to such a currency.
    if (!Intl.supportedValuesOf('currency').includes(normalized)) {
        throw new SubscriptionError(`Unsupported currency: ${currency}`, 'INVALID_CURRENCY');
    }
    return normalized;
}

/** Convert display units to finite, safely representable currency minor units. */
export function majorToMinor(amount: number, currency: string): number {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
        throw new SubscriptionError('Money must be a finite number', 'INVALID_MONEY');
    }
    const scale = 10 ** currencyMinorUnits(currency);
    // Compensate only for floating-point representation at a half-unit
    // boundary (e.g. 1.005 USD), preserving normal nearest-unit rounding.
    const scaled = amount * scale;
    const absolute = Math.abs(scaled);
    const fractional = absolute - Math.floor(absolute);
    const halfUnitTolerance = Math.min(1e-7, Number.EPSILON * absolute);
    const roundedAbsolute = fractional < 0.5 && 0.5 - fractional <= halfUnitTolerance ?
        Math.floor(absolute) + 1 : Math.round(absolute);
    const rounded = Math.sign(scaled) * roundedAbsolute;
    if (!Number.isSafeInteger(rounded)) {
        throw new SubscriptionError('Money exceeds the safe minor-unit range', 'INVALID_MONEY');
    }
    return rounded === 0 ? 0 : rounded;
}

export function minorToMajor(amount: number, currency: string): number {
    if (!Number.isSafeInteger(amount)) {
        throw new SubscriptionError('Minor-unit money must be a safe integer', 'INVALID_MONEY');
    }
    return amount / (10 ** currencyMinorUnits(currency));
}

export interface BillingCalendarAnchor {
    day: number;
    endOfMonth: boolean;
}

function assertDate(date: Date): void {
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
        throw new SubscriptionError('Billing dates must be valid dates', 'INVALID_BILLING_PERIOD');
    }
}

function daysInUtcMonth(year: number, month: number): number {
    const date = new Date(0);
    date.setUTCFullYear(year, month + 1, 0);
    return date.getUTCDate();
}

export function billingCalendarAnchor(start: Date): BillingCalendarAnchor {
    assertDate(start);
    const day = start.getUTCDate();
    return { day, endOfMonth: day === daysInUtcMonth(start.getUTCFullYear(), start.getUTCMonth()) };
}

/**
 * UTC calendar periods clamp the anchor day to the destination month. An
 * end-of-month anchor remains at month end, including February/leap years.
 * Keep the original optional anchor across renewals when preserving a
 * non-month-end day such as January 30 through a short February.
 */
export function calculateBillingPeriodEnd(
    start: Date,
    interval: BillingInterval,
    intervalCount: number,
    anchor: BillingCalendarAnchor = billingCalendarAnchor(start),
): Date {
    assertDate(start);
    if (!Number.isSafeInteger(intervalCount) || intervalCount <= 0 ||
        !Number.isInteger(anchor.day) || anchor.day < 1 || anchor.day > 31 ||
        typeof anchor.endOfMonth !== 'boolean') {
        throw new SubscriptionError('Billing interval and anchor must be valid', 'INVALID_BILLING_PERIOD');
    }
    if (!['monthly', 'yearly', 'one_time', 'custom'].includes(interval)) {
        throw new SubscriptionError('Unsupported billing interval', 'INVALID_BILLING_PERIOD');
    }
    const end = new Date(start);
    const monthDelta = interval === 'one_time' ? 120 : interval === 'yearly' ? intervalCount * 12 : intervalCount;
    if (!Number.isSafeInteger(monthDelta)) {
        throw new SubscriptionError('Billing interval exceeds the safe range', 'INVALID_BILLING_PERIOD');
    }
    // Move to the first before changing months to avoid Date's day overflow.
    end.setUTCDate(1);
    end.setUTCMonth(end.getUTCMonth() + monthDelta);
    assertDate(end);
    const lastDay = daysInUtcMonth(end.getUTCFullYear(), end.getUTCMonth());
    end.setUTCDate(anchor.endOfMonth ? lastDay : Math.min(anchor.day, lastDay));
    assertDate(end);
    return end;
}

export interface BillingPriceSnapshot {
    planId: string;
    amountMajor: number;
    amountMinor: number;
    currency: string;
    interval: BillingInterval;
    intervalCount: number;
    updatedAt: string;
}

type PricePlan = Pick<Plan, 'id' | 'price' | 'currency' | 'interval' | 'intervalCount' | 'updatedAt'>;

export function snapshotBillingPrice(plan: PricePlan): BillingPriceSnapshot {
    assertDate(plan.updatedAt);
    if (plan.price < 0) {
        throw new SubscriptionError('Plan prices cannot be negative', 'INVALID_MONEY');
    }
    const currency = normalizeCurrency(plan.currency);
    const amountMinor = majorToMinor(plan.price, currency);
    if (!Number.isSafeInteger(plan.intervalCount) || plan.intervalCount <= 0 ||
        !['monthly', 'yearly', 'one_time', 'custom'].includes(plan.interval)) {
        throw new SubscriptionError('Billing interval count must be a positive integer', 'INVALID_BILLING_PERIOD');
    }
    return {
        planId: plan.id,
        amountMajor: minorToMajor(amountMinor, currency),
        amountMinor,
        currency,
        interval: plan.interval,
        intervalCount: plan.intervalCount,
        updatedAt: plan.updatedAt.toISOString(),
    };
}

export interface PlanChangeQuote {
    /** Canonical calculation identity; a persisted quote uses its own opaque ID. */
    id: string;
    subscriptionId: string;
    currentPrice: BillingPriceSnapshot;
    newPrice: BillingPriceSnapshot;
    quotedAt: Date;
    validUntil: Date;
    effectiveDate: Date;
    periodStart: Date;
    periodEnd: Date;
    timing: 'immediate' | 'period_end' | 'unchanged';
    kind: 'upgrade' | 'downgrade' | 'lateral' | 'unchanged';
    amountMajor: number;
    amountMinor: number;
    currency: string;
    priceDifference: number;
    prorationRatio: number;
    daysRemaining: number;
    totalDays: number;
    preserveAnchor: boolean;
    /** Requested calculation policy, independent of the resulting anchor. */
    prorate: boolean;
}

export interface QuotePlanChangeInput {
    subscription: Pick<Subscription, 'id' | 'status' | 'currentPeriodStart' | 'currentPeriodEnd'>;
    currentPlan: PricePlan;
    newPlan: PricePlan;
    now: Date;
    immediately?: boolean;
    prorate?: boolean;
    /** False for trial/complimentary access which has no paid-period credit. */
    hasPaidEntitlement?: boolean;
    /** Actual settled price for the current period, independent of catalog edits. */
    currentPaidPrice?: BillingPriceSnapshot;
}

/** One policy shared by preview, persisted purchase quotes, and execution. */
export function quotePlanChange(input: QuotePlanChangeInput): PlanChangeQuote {
    const { subscription, now } = input;
    assertDate(now);
    assertDate(subscription.currentPeriodStart);
    assertDate(subscription.currentPeriodEnd);
    const currentPrice = input.currentPaidPrice ? { ...input.currentPaidPrice } : snapshotBillingPrice(input.currentPlan);
    if (currentPrice.planId !== input.currentPlan.id ||
        currentPrice.currency !== normalizeCurrency(currentPrice.currency) ||
        currentPrice.amountMinor < 0 ||
        majorToMinor(currentPrice.amountMajor, currentPrice.currency) !== currentPrice.amountMinor ||
        !Number.isSafeInteger(currentPrice.intervalCount) || currentPrice.intervalCount <= 0 ||
        !['monthly', 'yearly', 'one_time', 'custom'].includes(currentPrice.interval) ||
        !Number.isFinite(new Date(currentPrice.updatedAt).getTime())) {
        throw new SubscriptionError('Current paid price snapshot is invalid', 'INVALID_BILLING_PRICE');
    }
    const newPrice = snapshotBillingPrice(input.newPlan);
    if (currentPrice.currency !== newPrice.currency ||
        currentPrice.interval !== newPrice.interval ||
        currentPrice.intervalCount !== newPrice.intervalCount) {
        throw new SubscriptionError(
            'Cross-currency and billing-interval plan changes require an explicit migration policy',
            'UNSUPPORTED_PLAN_CHANGE',
        );
    }
    const totalMs = subscription.currentPeriodEnd.getTime() - subscription.currentPeriodStart.getTime();
    const remainingMs = Math.max(0, subscription.currentPeriodEnd.getTime() - now.getTime());
    const ratio = totalMs > 0 ? Math.min(1, remainingMs / totalMs) : 0;
    const paidEntitlement = subscription.status !== 'trialing' && currentPrice.amountMinor > 0 &&
        (input.hasPaidEntitlement ?? true);
    const validPaidPeriod = paidEntitlement && totalMs > 0 &&
        subscription.currentPeriodStart <= now && now < subscription.currentPeriodEnd;
    const unchanged = currentPrice.planId === newPrice.planId;
    const effectiveCurrentMinor = validPaidPeriod ? currentPrice.amountMinor : 0;
    const difference = newPrice.amountMinor - effectiveCurrentMinor;
    const kind = unchanged ? 'unchanged' : difference > 0 ? 'upgrade' : difference < 0 ? 'downgrade' : 'lateral';
    const immediate = !unchanged && (input.immediately ?? kind === 'upgrade');
    const timing = unchanged ? 'unchanged' : immediate ? 'immediate' : 'period_end';
    const preserveAnchor = unchanged || !immediate || (validPaidPeriod && (input.prorate ?? true));
    const periodStart = preserveAnchor ? new Date(subscription.currentPeriodStart) : new Date(now);
    const periodEnd = preserveAnchor ? new Date(subscription.currentPeriodEnd) :
        calculateBillingPeriodEnd(now, newPrice.interval, newPrice.intervalCount);
    let amountMinor = 0;
    if (immediate && newPrice.amountMinor > 0) {
        if (!validPaidPeriod || !(input.prorate ?? true)) {
            amountMinor = newPrice.amountMinor;
        } else if (difference > 0) {
            amountMinor = Math.round(difference * ratio);
        }
    }
    if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
        throw new SubscriptionError('Computed quote is not safe minor-unit money', 'INVALID_MONEY');
    }
    const validUntil = new Date(Math.min(
        now.getTime() + QUOTE_VALIDITY_MS,
        preserveAnchor && remainingMs > 0 ? subscription.currentPeriodEnd.getTime() : Infinity,
    ));
    const quote: PlanChangeQuote = {
        id: '', subscriptionId: subscription.id, currentPrice, newPrice,
        quotedAt: new Date(now), validUntil,
        effectiveDate: immediate || unchanged ? new Date(now) : new Date(subscription.currentPeriodEnd),
        periodStart, periodEnd, timing, kind, amountMinor,
        amountMajor: minorToMajor(amountMinor, newPrice.currency),
        currency: newPrice.currency,
        priceDifference: minorToMajor(difference, newPrice.currency),
        prorationRatio: ratio,
        daysRemaining: Math.ceil(remainingMs / DAY_MS),
        totalDays: Math.max(0, Math.ceil(totalMs / DAY_MS)),
        preserveAnchor,
        prorate: input.prorate ?? true,
    };
    quote.id = JSON.stringify({ ...quote, id: undefined });
    return quote;
}
