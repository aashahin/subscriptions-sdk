# Coupons

Coupons let you discount subscription amounts — launch promotions, referral credits, migration offers — without touching plan prices.

Coupon persistence is an optional section of the database adapter contract. It is implemented by the Prisma adapter; if the configured adapter does not implement it, every `CouponsService` method throws a `COUPONS_NOT_SUPPORTED` (501) setup error. See `adapters.md` for the adapter surface.

## Coupon Model

```ts
interface Coupon {
  id: string;
  /** Customer-facing code, e.g. "LAUNCH50" (unique, normalized to uppercase) */
  code: string;

  /** "percent" discounts by a percentage; "fixed" subtracts an amount */
  type: "percent" | "fixed";
  /** Percentage (1–100) for "percent"; amount in major units for "fixed" */
  value: number;
  /** Currency for "fixed" coupons; null for "percent" coupons */
  currency: string | null;

  /**
   * How long the discount applies:
   * - "once": a single invoice
   * - "repeating": `durationInMonths` billing periods
   * - "forever": the life of the subscription
   */
  duration: "once" | "repeating" | "forever";
  /** Required when duration is "repeating"; null otherwise */
  durationInMonths: number | null;

  /** Total redemptions allowed across all subscribers (null = unlimited) */
  maxRedemptions: number | null;
  /** Redemptions so far (incremented on every successful `apply`) */
  timesRedeemed: number;

  /** Coupon cannot be redeemed after this time (null = never expires) */
  expiresAt: Date | null;
  /** Inactive coupons can no longer be redeemed */
  isActive: boolean;

  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}
```

## CouponsService

The service is available as `subs.coupons` on the instance returned by `createSubscriptions`.

```ts
// Create a 50%-off-for-3-months launch coupon, capped at 500 redemptions.
const coupon = await subs.coupons.create({
  code: "LAUNCH50",
  type: "percent",
  value: 50,
  duration: "repeating",
  durationInMonths: 3,
  maxRedemptions: 500,
  expiresAt: new Date("2026-12-31T23:59:59Z"),
});

await subs.coupons.getByCode("launch50"); // case-insensitive
await subs.coupons.update(coupon.id, { maxRedemptions: 1000 });
await subs.coupons.deactivate(coupon.id); // keeps history, stops redemptions
```

Validation rules enforced on `create`: percent values must be 1–100, fixed values must be positive, and `repeating` coupons require `durationInMonths`.

### Validation

`validate(code)` checks a code without redeeming it — use it to show the discounted price at checkout. It returns the coupon or throws:

```ts
import { CouponInvalidError, CouponNotFoundError } from "@abshahin/subscriptions";

try {
  const coupon = await subs.coupons.validate("LAUNCH50");
  console.log(coupon.type, coupon.value); // "percent" 50
} catch (error) {
  if (error instanceof CouponNotFoundError) {
    // Unknown code
  } else if (error instanceof CouponInvalidError) {
    // error.reason: "inactive" | "expired" | "exhausted"
  }
}
```

### Discount Preview

`computeDiscount(coupon, amount)` is a pure calculation — no persistence side effects. It returns the discount amount (never exceeding the amount):

```ts
const coupon = await subs.coupons.validate("LAUNCH50");
const discount = subs.coupons.computeDiscount(coupon, plan.price);
const total = plan.price - discount;
```

### Redemption

`apply(code, amount)` validates the code, computes the discount, and increments `timesRedeemed`. It returns the updated coupon, the discount, and the final total:

```ts
const { coupon, discountAmount, total } = await subs.coupons.apply(
  "LAUNCH50",
  plan.price,
);
// → discountAmount: 24.5, total: 24.5 for a $49 plan at 50% off
```

Apply the result wherever you charge: pass `total` as the amount when creating an invoice or charging through your payment gateway, and record the `discountAmount` on the invoice so rendered invoices and credit-note math stay consistent. Tracking which billing periods a `repeating` or `forever` coupon still applies to is the host application's responsibility — the service enforces validity and counts redemptions, it does not attach coupons to subscriptions.

## Notes

- Codes are case-insensitive and stored uppercase.
- Redemption counting goes through the adapter's `incrementRedemptions`, which the Prisma adapter implements atomically, so `maxRedemptions` holds under concurrency.
- Coupons are stored through the database adapter's optional `coupons` section; with the Prisma adapter, add the `Coupon` model from `docs/prisma-schema.md`.
