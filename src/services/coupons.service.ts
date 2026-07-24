// file: packages/subscriptions/src/services/coupons.service.ts
// Coupons service for creating, validating, and applying discount codes

import type { DatabaseAdapter } from '../adapters/database.adapter.js';
import type {
    AppliedCoupon,
    Coupon,
    CreateCouponInput,
    UpdateCouponInput,
} from '../core/coupons.js';
import {
    CouponInvalidError,
    CouponNotFoundError,
    SubscriptionError,
} from '../core/errors.js';
import type { FeatureRegistry } from '../core/types.js';

export interface CouponsServiceOptions {
    /**
     * Default currency for `fixed` coupons when none is provided
     * @default 'USD'
     */
    defaultCurrency?: string;
}

export class CouponsService<TFeatures extends FeatureRegistry = FeatureRegistry> {
    private readonly defaultCurrency: string;

    constructor(
        private readonly db: DatabaseAdapter<TFeatures>,
        options?: CouponsServiceOptions,
    ) {
        this.defaultCurrency = options?.defaultCurrency ?? 'USD';
    }

    /**
     * Create a new coupon
     */
    async create(data: CreateCouponInput): Promise<Coupon> {
        const coupons = this.couponsOrThrow();

        if (data.type === 'percent' && (data.value <= 0 || data.value > 100)) {
            throw new SubscriptionError(
                `Percent coupon value must be between 1 and 100, got ${data.value}`,
                'INVALID_COUPON',
                400,
            );
        }

        if (data.type === 'fixed' && data.value <= 0) {
            throw new SubscriptionError(
                `Fixed coupon value must be positive, got ${data.value}`,
                'INVALID_COUPON',
                400,
            );
        }

        if (data.duration === 'repeating' && !data.durationInMonths) {
            throw new SubscriptionError(
                'Repeating coupons require durationInMonths',
                'INVALID_COUPON',
                400,
            );
        }

        return coupons.create({
            ...data,
            code: normalizeCode(data.code),
            currency: data.type === 'fixed'
                ? (data.currency ?? this.defaultCurrency)
                : undefined,
        });
    }

    /**
     * Get a coupon by its redemption code (case-insensitive)
     */
    async getByCode(code: string): Promise<Coupon | null> {
        return this.couponsOrThrow().findByCode(normalizeCode(code));
    }

    /**
     * Update a coupon
     */
    async update(id: string, data: UpdateCouponInput): Promise<Coupon> {
        return this.couponsOrThrow().update(id, data);
    }

    /**
     * Deactivate a coupon (it can no longer be redeemed)
     */
    async deactivate(id: string): Promise<Coupon> {
        return this.couponsOrThrow().update(id, { isActive: false });
    }

    /**
     * Validate a coupon code without redeeming it.
     *
     * @throws CouponNotFoundError when the code does not exist
     * @throws CouponInvalidError when the coupon is inactive, expired, or exhausted
     */
    async validate(code: string): Promise<Coupon> {
        const normalized = normalizeCode(code);
        const coupon = await this.couponsOrThrow().findByCode(normalized);

        if (!coupon) {
            throw new CouponNotFoundError(normalized);
        }

        if (!coupon.isActive) {
            throw new CouponInvalidError(normalized, 'inactive');
        }

        if (coupon.expiresAt && coupon.expiresAt.getTime() <= Date.now()) {
            throw new CouponInvalidError(normalized, 'expired');
        }

        if (
            coupon.maxRedemptions !== null &&
            coupon.timesRedeemed >= coupon.maxRedemptions
        ) {
            throw new CouponInvalidError(normalized, 'exhausted');
        }

        return coupon;
    }

    /**
     * Compute the discount a coupon gives against an amount (e.g. a plan price)
     * without redeeming it. Pure calculation — no persistence side effects.
     *
     * @returns The discount amount (>= 0, never exceeding `amount`)
     */
    computeDiscount(coupon: Coupon, amount: number): number {
        if (amount <= 0) {
            return 0;
        }

        const discount = coupon.type === 'percent'
            ? (amount * coupon.value) / 100
            : coupon.value;

        return roundMoney(Math.min(discount, amount));
    }

    /**
     * Validate and redeem a coupon against an amount (e.g. a plan price).
     * Increments the coupon's redemption counter.
     *
     * @returns The coupon, the discount amount, and the final total
     */
    async apply(code: string, amount: number): Promise<AppliedCoupon> {
        const coupon = await this.validate(code);
        const discountAmount = this.computeDiscount(coupon, amount);

        const updated = await this.couponsOrThrow().incrementRedemptions(coupon.id);

        return {
            coupon: updated,
            discountAmount,
            total: roundMoney(Math.max(0, amount - discountAmount)),
        };
    }

    // ==================== Private Helpers ====================

    /**
     * Coupon persistence is optional on the database adapter. When the
     * adapter does not implement it, fail with a helpful setup error instead
     * of an obscure "cannot read property of undefined".
     */
    private couponsOrThrow(): NonNullable<DatabaseAdapter<TFeatures>['coupons']> {
        const coupons = this.db.coupons;
        if (!coupons) {
            throw new SubscriptionError(
                'Coupons are not supported by the configured database adapter. ' +
                'Implement the optional `coupons` section on your DatabaseAdapter ' +
                '(with the Prisma adapter, add the Coupon model — see docs/prisma-schema.md).',
                'COUPONS_NOT_SUPPORTED',
                501,
            );
        }
        return coupons;
    }
}

/**
 * Coupon codes are case-insensitive and stored uppercase
 */
function normalizeCode(code: string): string {
    return code.trim().toUpperCase();
}

/**
 * Round a money amount to 2 decimal places
 */
function roundMoney(amount: number): number {
    return Math.round(amount * 100) / 100;
}
