// file: packages/subscriptions/src/core/coupons.ts
// Coupon (discount code) type definitions

/**
 * How the coupon discount is computed
 *
 * - `percent`: percentage off (value is 1-100)
 * - `fixed`: fixed amount off in the coupon's currency
 */
export type CouponType = 'percent' | 'fixed';

/**
 * How long a coupon discount applies to a subscription
 *
 * - `once`: applies to a single invoice only
 * - `repeating`: applies for `durationInMonths` billing periods
 * - `forever`: applies for the lifetime of the subscription
 */
export type CouponDuration = 'once' | 'repeating' | 'forever';

/**
 * A discount coupon that can be applied to plans and invoices
 */
export interface Coupon {
    id: string;
    /**
     * Unique redemption code. Stored uppercase (normalized on create).
     */
    code: string;
    type: CouponType;
    /**
     * Discount value: percentage (1-100) for `percent` coupons,
     * amount in `currency` units for `fixed` coupons.
     */
    value: number;
    /**
     * Currency for `fixed` coupons. Null for `percent` coupons.
     */
    currency: string | null;
    duration: CouponDuration;
    /**
     * Number of billing periods the discount applies for.
     * Only meaningful when `duration` is `repeating`.
     */
    durationInMonths: number | null;
    /**
     * Maximum number of times the coupon can be redeemed.
     * Null means unlimited redemptions.
     */
    maxRedemptions: number | null;
    /**
     * Expiration date. Null means the coupon never expires.
     */
    expiresAt: Date | null;
    isActive: boolean;
    /**
     * Number of times the coupon has been redeemed so far.
     */
    timesRedeemed: number;
    metadata: Record<string, unknown> | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface CreateCouponInput {
    /**
     * Redemption code. Normalized to uppercase.
     */
    code: string;
    type: CouponType;
    /**
     * Percentage (1-100) for `percent`, amount in currency units for `fixed`.
     */
    value: number;
    /**
     * Currency for `fixed` coupons. Defaults to the service default currency.
     */
    currency?: string | undefined;
    /**
     * @default 'once'
     */
    duration?: CouponDuration | undefined;
    /**
     * Required when `duration` is `repeating`.
     */
    durationInMonths?: number | undefined;
    maxRedemptions?: number | undefined;
    expiresAt?: Date | undefined;
    /**
     * @default true
     */
    isActive?: boolean | undefined;
    metadata?: Record<string, unknown> | undefined;
}

export interface UpdateCouponInput {
    type?: CouponType;
    value?: number;
    currency?: string | null;
    duration?: CouponDuration;
    durationInMonths?: number | null;
    maxRedemptions?: number | null;
    expiresAt?: Date | null;
    isActive?: boolean;
    metadata?: Record<string, unknown>;
}

/**
 * Result of applying a coupon to an amount
 */
export interface AppliedCoupon {
    coupon: Coupon;
    /**
     * Discount amount (always >= 0, never exceeds the original amount).
     */
    discountAmount: number;
    /**
     * Final amount after the discount.
     */
    total: number;
}
