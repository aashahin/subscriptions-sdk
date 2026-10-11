// file: packages/subscriptions/src/services/coupons.service.ts
// Coupons service for creating, validating, and applying discount codes

import type { DatabaseAdapter } from '../adapters/database.adapter.js';
import { majorToMinor, minorToMajor, normalizeCurrency } from '../core/billing-policy.js';
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
        this.defaultCurrency = normalizeCurrency(options?.defaultCurrency ?? 'USD');
    }

    /**
     * Create a new coupon
     */
    async create(data: CreateCouponInput): Promise<Coupon> {
        const coupons = this.couponsOrThrow();

        if (!Number.isFinite(data.value)) {
            throw new SubscriptionError('Coupon value must be finite', 'INVALID_COUPON', 400);
        }
        if (data.maxRedemptions !== undefined &&
            (!Number.isSafeInteger(data.maxRedemptions) || data.maxRedemptions < 1)) {
            throw new SubscriptionError('maxRedemptions must be a positive safe integer', 'INVALID_COUPON', 400);
        }

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
                ? normalizeCurrency(data.currency ?? this.defaultCurrency)
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
    computeDiscount(coupon: Coupon, amount: number, currency?: string): number {
        this.validateAmount(amount);
        const normalized = this.couponCurrency(coupon, currency);
        if (!Number.isFinite(coupon.value) || coupon.value <= 0 ||
            (coupon.type === 'percent' && coupon.value > 100)) {
            throw new SubscriptionError('Coupon discount value is invalid', 'INVALID_COUPON', 400);
        }
        const amountMinor = majorToMinor(amount, normalized);
        if (amount <= 0) {
            return 0;
        }

        const discountMinor = coupon.type === 'percent'
            ? Math.round((amountMinor * coupon.value) / 100)
            : majorToMinor(coupon.value, normalized);

        return minorToMajor(Math.min(discountMinor, amountMinor), normalized);
    }

    /**
     * Atomically redeem a coupon for one server-controlled purchase identity.
     * Retrying the same purchase does not consume another redemption.
     *
     * @returns The coupon, the discount amount, and the final total
     */
    async apply(code: string, amount: number, options: { purchaseId: string; currency?: string }): Promise<AppliedCoupon> {
        this.validateAmount(amount);
        this.validatePurchaseId(options?.purchaseId);
        const coupons = this.couponsOrThrow();
        if (!coupons.redeem) {
            throw new SubscriptionError('Coupon redemption requires atomic coupons.redeem support', 'ATOMIC_COUPONS_NOT_SUPPORTED', 501);
        }
        const normalized = normalizeCode(code);
        const coupon = await coupons.findByCode(normalized);
        if (!coupon) throw new CouponNotFoundError(normalized);
        // Validate the purchase currency and monetary range before reserving capacity.
        this.computeDiscount(coupon, amount, options.currency);
        // Eligibility and the remaining cap are enforced by the same durable
        // operation. Preview validation is deliberately not an admission lock.
        const updated = await coupons.redeem(coupon.id, options.purchaseId);
        if (!updated) {
            await this.validate(normalized);
            throw new SubscriptionError('Coupon could not be redeemed for this purchase', 'COUPON_REDEMPTION_CONFLICT', 409);
        }
        const currency = this.couponCurrency(updated, options.currency);
        const discountAmount = this.computeDiscount(updated, amount, currency);

        return {
            coupon: updated,
            discountAmount,
            total: minorToMajor(Math.max(0, majorToMinor(amount, currency) - majorToMinor(discountAmount, currency)), currency),
        };
    }

    /** Release an abandoned purchase exactly once; settled purchases must not be released. */
    async release(code: string, purchaseId: string): Promise<void> {
        this.validatePurchaseId(purchaseId);
        const coupons = this.couponsOrThrow();
        if (!coupons.releaseRedemption) {
            throw new SubscriptionError('Coupon release requires atomic coupons.releaseRedemption support', 'ATOMIC_COUPONS_NOT_SUPPORTED', 501);
        }
        const normalized = normalizeCode(code);
        const coupon = await coupons.findByCode(normalized);
        if (!coupon) throw new CouponNotFoundError(normalized);
        await coupons.releaseRedemption(coupon.id, purchaseId);
    }

    // ==================== Private Helpers ====================

    private couponCurrency(coupon: Coupon, currency?: string): string {
        const normalized = normalizeCurrency(currency ?? coupon.currency ?? this.defaultCurrency);
        if (coupon.type === 'fixed' && (!coupon.currency || normalizeCurrency(coupon.currency) !== normalized)) {
            throw new SubscriptionError('Fixed coupon currency must match the purchase currency', 'COUPON_CURRENCY_MISMATCH', 400);
        }
        return normalized;
    }

    private validateAmount(amount: number): void {
        if (!Number.isFinite(amount) || amount < 0) {
            throw new SubscriptionError('Coupon amount must be finite and nonnegative', 'INVALID_COUPON_AMOUNT', 400);
        }
    }

    private validatePurchaseId(purchaseId: string | undefined): void {
        if (typeof purchaseId !== 'string' || !purchaseId.trim() || purchaseId.length > 255) {
            throw new SubscriptionError('A server-controlled purchaseId is required for coupon redemption', 'INVALID_COUPON_PURCHASE', 400);
        }
    }

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
