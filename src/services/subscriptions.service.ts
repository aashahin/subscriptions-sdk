// file: packages/subscriptions/src/services/subscriptions.service.ts
// Subscriptions service for lifecycle management

import type { CacheAdapter } from "../adapters/cache.adapter.js";
import { CacheKeys, noopCacheAdapter } from "../adapters/cache.adapter.js";
import type { DatabaseAdapter } from "../adapters/database.adapter.js";
import type {
  CancelOptions,
  ChargePaymentResult,
  PaymentGatewayAdapter,
} from "../adapters/payment.adapter.js";
import { noopPaymentAdapter } from "../adapters/payment.adapter.js";
import {
  DuplicateSubscriptionError,
  PaymentFailedError,
  PlanNotFoundError,
  SubscriptionInactiveError,
  SubscriptionNotCanceledError,
  SubscriptionNotFoundError,
} from "../core/errors.js";
import type {
  FeatureRegistry,
  SubscriberType,
  Subscription,
  SubscriptionsLogger,
  SubscriptionStatus,
  SubscriptionWithPlan,
  UpdateSubscriptionInput,
} from "../core/types.js";
import { noopLogger } from "../core/types.js";

/**
 * Date fields that must be rehydrated after JSON deserialization from cache.
 * When objects are cached (e.g. in Redis), Date instances become ISO strings.
 */
const SUBSCRIPTION_DATE_FIELDS = [
  "currentPeriodStart",
  "currentPeriodEnd",
  "cancelAt",
  "canceledAt",
  "trialStart",
  "trialEnd",
  "createdAt",
  "updatedAt",
] as const;

const PLAN_DATE_FIELDS = ["createdAt", "updatedAt"] as const;

/** Rehydrate Date fields that were serialized to strings by the cache layer */
function rehydrateDates<T extends Record<string, unknown>>(
  obj: T,
  fields: readonly string[],
): T {
  for (const field of fields) {
    const val = obj[field];
    if (typeof val === "string") {
      (obj as Record<string, unknown>)[field] = new Date(val);
    }
  }
  return obj;
}

/** Rehydrate a SubscriptionWithPlan from cache (dates may be ISO strings) */
function rehydrateSubscription<TFeatures extends FeatureRegistry>(
  sub: SubscriptionWithPlan<TFeatures>,
): SubscriptionWithPlan<TFeatures> {
  rehydrateDates(sub as unknown as Record<string, unknown>, SUBSCRIPTION_DATE_FIELDS);
  if (sub.plan) {
    rehydrateDates(sub.plan as unknown as Record<string, unknown>, PLAN_DATE_FIELDS);
  }
  return sub;
}

export interface SubscriptionsServiceOptions {
  /**
   * Default subscriber type
   * @default 'tenant'
   */
  subscriberType?: SubscriberType;

  /**
   * Default trial period in days
   * @default 0
   */
  trialDays?: number;

  /**
   * Grace period in days after expiration
   * @default 0
   */
  gracePeriodDays?: number;

  /**
   * Cache TTL in seconds
   * @default 300
   */
  cacheTtlSeconds?: number;

  /**
   * Optional logger
   */
  logger?: SubscriptionsLogger;
}

/**
 * Result of a plan change operation
 */
export interface ChangePlanResult<
  TFeatures extends FeatureRegistry = FeatureRegistry,
> {
  /** Updated subscription with new plan */
  subscription: SubscriptionWithPlan<TFeatures>;
  /** Whether payment was charged */
  charged: boolean;
  /** Payment ID if charged */
  paymentId?: string;
  /** Amount actually charged in smallest currency unit (e.g. halalas/cents). Only set when charged or skipPayment with a known amount. */
  chargeAmount?: number;
  /** Whether payment is pending 3DS verification */
  paymentPending?: boolean;
  /** 3DS verification URL if payment is pending */
  verificationUrl?: string;
}

interface RenewSubscriptionOptions {
  skipPayment?: boolean;
}

/**
 * Preview of a plan change - shows what user will pay
 */
export interface PlanChangePreview {
  /** Current plan details */
  currentPlan: {
    id: string;
    name: string;
    price: number;
    currency: string;
  };
  /** New plan details */
  newPlan: {
    id: string;
    name: string;
    price: number;
    currency: string;
  };
  /** Whether this is an upgrade (new plan is more expensive) */
  isUpgrade: boolean;
  /** Whether this is a downgrade (new plan is cheaper) */
  isDowngrade: boolean;
  /** Price difference (positive = upgrade, negative = downgrade) */
  priceDifference: number;
  /** Days remaining in current period */
  daysRemaining: number;
  /** Total days in current period */
  totalDays: number;
  /** Proration ratio (0-1) */
  prorationRatio: number;
  /** Amount to charge now (in smallest currency unit, e.g., halalas) */
  amountDue: number;
  /** Amount in regular units (e.g., SAR) */
  amountDueFormatted: number;
  /** Currency code */
  currency: string;
  /** When the new plan will take effect */
  effectiveDate: Date;
  /** Message describing the change */
  message: string;
}

export class SubscriptionsService<TFeatures extends FeatureRegistry> {
  private readonly cache: CacheAdapter;
  private readonly payment: PaymentGatewayAdapter;
  private readonly subscriberType: SubscriberType;
  private readonly trialDays: number;
  private readonly gracePeriodDays: number;
  private readonly cacheTtl: number;
  private readonly logger: SubscriptionsLogger;

  constructor(
    private readonly db: DatabaseAdapter<TFeatures>,
    cache?: CacheAdapter,
    payment?: PaymentGatewayAdapter,
    options?: SubscriptionsServiceOptions,
  ) {
    this.cache = cache ?? noopCacheAdapter;
    this.payment = payment ?? noopPaymentAdapter;
    this.subscriberType = options?.subscriberType ?? "tenant";
    this.trialDays = options?.trialDays ?? 0;
    this.gracePeriodDays = options?.gracePeriodDays ?? 0;
    this.cacheTtl = options?.cacheTtlSeconds ?? 300;
    this.logger = options?.logger ?? noopLogger;
  }

  /**
   * Get subscription for a subscriber
   */
  async get(
    subscriberId: string,
  ): Promise<SubscriptionWithPlan<TFeatures> | null> {
    const cacheKey = CacheKeys.subscription(subscriberId);

    // Try cache first
    const cached =
      await this.cache.get<SubscriptionWithPlan<TFeatures>>(cacheKey);
    if (cached) {
      // Rehydrate Date fields that were serialized to strings by the cache
      rehydrateSubscription(cached);
      return this.finalizeEndedSubscriptionIfNeeded(subscriberId, cached);
    }

    const subscription =
      await this.db.subscriptions.findBySubscriber(subscriberId);
    if (!subscription) {
      return null;
    }

    const normalized = await this.finalizeEndedSubscriptionIfNeeded(
      subscriberId,
      subscription,
    );

    // Cache the result
    await this.cache.set(cacheKey, normalized, this.cacheTtl);

    return normalized;
  }

  /**
   * Create a new subscription
   */
  async create(
    subscriberId: string,
    planId: string,
    options?: {
      trialDays?: number;
      gatewayCustomerId?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<Subscription> {
    // Pre-emptively invalidate cache before checking for existing subscription
    // This ensures we always get fresh data from DB for the duplicate check
    await this.cache.delete(CacheKeys.subscription(subscriberId));
    await this.cache.delete(CacheKeys.features(subscriberId));

    // Check for existing subscription (now from fresh DB query)
    const existing = await this.get(subscriberId);
    if (existing && this.isActiveStatus(existing.status)) {
      throw new DuplicateSubscriptionError(subscriberId);
    }

    // Verify plan exists
    const plan = await this.db.plans.findById(planId);
    if (!plan) {
      throw new PlanNotFoundError(planId);
    }

    const now = new Date();
    // If re-subscribing after cancellation, don't grant another trial.
    // Trials are one-time only — returning subscribers must pay.
    const trialDays = existing ? 0 : (options?.trialDays ?? this.trialDays);
    const hasTrialDays = trialDays > 0;

    // Calculate period dates
    let currentPeriodStart = now;
    let currentPeriodEnd = this.calculatePeriodEnd(
      now,
      plan.interval,
      plan.intervalCount,
    );
    let trialStart: Date | null = null;
    let trialEnd: Date | null = null;
    let status: SubscriptionStatus = "active";

    if (hasTrialDays) {
      trialStart = now;
      trialEnd = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000);
      currentPeriodEnd = trialEnd;
      status = "trialing";
    }

    // If there's an existing inactive subscription, update it instead of
    // creating a new row (tenantId is unique, so INSERT would fail).
    let subscription: Subscription;
    if (existing && !this.isActiveStatus(existing.status)) {
      subscription = await this.db.subscriptions.update(existing.id, {
        planId,
        status,
        currentPeriodStart,
        currentPeriodEnd,
        trialStart,
        trialEnd,
        cancelAt: null,
        canceledAt: null,
        ...(options?.gatewayCustomerId && {
          gatewayCustomerId: options.gatewayCustomerId,
        }),
        ...(options?.metadata && { metadata: options.metadata }),
      });
    } else {
      subscription = await this.db.subscriptions.create({
        subscriberId,
        subscriberType: this.subscriberType,
        planId,
        status,
        currentPeriodStart,
        currentPeriodEnd,
        trialStart,
        trialEnd,
        gatewayCustomerId: options?.gatewayCustomerId,
        metadata: options?.metadata,
      });
    }

    // Invalidate cache
    await this.cache.delete(CacheKeys.subscription(subscriberId));
    await this.cache.delete(CacheKeys.features(subscriberId));

    // Create initial invoice (draft for trial, open for immediate start)
    if (!hasTrialDays && plan.price > 0) {
      try {
        await this.db.invoices.create({
          subscriptionId: subscription.id,
          amount: plan.price,
          currency: plan.currency,
          status: "open",
          dueDate: currentPeriodEnd,
          lineItems: [{
            description: `${plan.name} subscription`,
            quantity: 1,
            unitPrice: plan.price,
            amount: plan.price,
          }],
          metadata: { type: "subscription_start" },
        });
      } catch {
        this.logger.error?.(`Failed to create initial invoice for ${subscriberId}`);
      }
    }

    return subscription;
  }

  /**
   * Change subscription plan
   *
   * For upgrades (new plan is more expensive):
   * - If payment adapter supports chargePayment and there's a saved token, charges immediately
   * - Proration can be enabled to charge only the difference for remaining period
   * - Plan changes immediately on successful payment
   *
   * For downgrades (new plan is cheaper):
   * - Plan change is scheduled for end of current period
   * - No immediate payment required
   *
   * @param subscriberId - The subscriber ID
   * @param newPlanId - The new plan to switch to
   * @param options - Change options
   * @returns Updated subscription
   */
  async changePlan(
    subscriberId: string,
    newPlanId: string,
    options?: {
      /** Apply change immediately (default: true for upgrades, false for downgrades) */
      immediately?: boolean;
      /** Prorate the charge based on remaining period (default: true) */
      prorate?: boolean;
      /** Custom token ID to charge (overrides saved token) */
      tokenId?: string;
      /** Callback URL for 3DS verification */
      callbackUrl?: string;
      /** Skip payment even for upgrades (use with caution) */
      skipPayment?: boolean;
      /** Verified token ID from frontend 3DS - save for future renewals */
      verifiedTokenId?: string;
    },
  ): Promise<ChangePlanResult<TFeatures>> {
    const subscription = await this.getOrThrow(subscriberId);
    const currentPlan = subscription.plan;

    if (subscription.planId === newPlanId) {
      return { subscription, charged: false };
    }

    // Verify new plan exists
    const newPlan = await this.db.plans.findById(newPlanId);
    if (!newPlan) {
      throw new PlanNotFoundError(newPlanId);
    }

    const now = new Date();

    // CRITICAL: Check if user is in trial period
    // If trialing, they haven't paid anything, so:
    // 1. No proration credit (they didn't pay for the time)
    // 2. Treat current plan price as $0 for upgrade calculation
    const isTrialing = subscription.status === "trialing";

    // For upgrade detection: trial users upgrading to ANY paid plan should be charged
    // For proration: trial users get no credit (effective price = 0)
    const effectiveCurrentPrice = isTrialing ? 0 : currentPlan.price;
    const isUpgrade = newPlan.price > effectiveCurrentPrice;

    const shouldApplyImmediately = options?.immediately ?? isUpgrade;
    const shouldProrate = options?.prorate ?? true;

    let paymentResult: ChargePaymentResult | undefined;
    let chargeAmount: number | undefined;

    // Handle payment for upgrades
    if (isUpgrade && !options?.skipPayment && this.payment.chargePayment) {
      const tokenId = options?.tokenId ?? subscription.gatewayCustomerId;

      if (!tokenId) {
        throw new PaymentFailedError("No payment token available for upgrade");
      }

      // Calculate charge amount

      if (isTrialing || effectiveCurrentPrice === 0) {
        // TRIAL or FREE PLAN USER: Charge full price of new plan
        // No credit to subtract from a $0 plan
        chargeAmount = Math.round(newPlan.price * 100);
      } else if (shouldProrate && subscription.currentPeriodEnd > now) {
        // ACTIVE PAID USER: Prorate - charge difference for remaining period
        const totalPeriodMs =
          subscription.currentPeriodEnd.getTime() -
          subscription.currentPeriodStart.getTime();
        const remainingMs =
          subscription.currentPeriodEnd.getTime() - now.getTime();
        const remainingRatio = remainingMs / totalPeriodMs;

        const priceDifference = newPlan.price - currentPlan.price;
        chargeAmount = Math.round(priceDifference * remainingRatio * 100); // Convert to smallest unit
      } else {
        // Full price charge
        chargeAmount = Math.round(newPlan.price * 100);
      }

      // Charge the payment
      paymentResult = await this.payment.chargePayment({
        customerId: tokenId,
        amount: chargeAmount,
        currency: newPlan.currency,
        description: `Upgrade from ${currentPlan.name} to ${newPlan.name}`,
        ...(options?.callbackUrl && { callbackUrl: options.callbackUrl }),
        metadata: {
          subscriberId,
          oldPlanId: currentPlan.id,
          newPlanId: newPlan.id,
          type: "plan_upgrade",
        },
      });

      if (paymentResult.status === "failed") {
        throw new PaymentFailedError(
          paymentResult.errorMessage ?? "Payment failed for plan upgrade",
          paymentResult.id || undefined,
          paymentResult.errorCode,
          paymentResult.isRetryable,
          paymentResult.userAction,
        );
      }

      if (paymentResult.status === "pending") {
        // 3DS verification required - return pending status
        const updateData: UpdateSubscriptionInput = {
          metadata: {
            ...this.clearPendingSubscriptionMetadata(subscription.metadata),
            pendingPlanChange: newPlanId,
            pendingPaymentId: paymentResult.id,
            pendingVerificationUrl: paymentResult.verificationUrl,
          },
        };

        const updated = await this.db.subscriptions.update(
          subscription.id,
          updateData,
        );
        await this.cache.delete(CacheKeys.subscription(subscriberId));

        return {
          subscription: { ...updated, plan: currentPlan },
          charged: false,
          paymentPending: true,
          ...(paymentResult.verificationUrl && {
            verificationUrl: paymentResult.verificationUrl,
          }),
        };
      }
    }

    // Apply plan change
    const updateData: UpdateSubscriptionInput = {};
    const baseMetadata = this.clearPendingSubscriptionMetadata(
      subscription.metadata,
    );

    if (shouldApplyImmediately) {
      updateData.planId = newPlanId;
      updateData.currentPeriodStart = now;
      updateData.currentPeriodEnd = this.calculatePeriodEnd(
        now,
        newPlan.interval,
        newPlan.intervalCount,
      );
      updateData.metadata = baseMetadata;
    } else {
      // Downgrade: schedule for end of current period via metadata
      updateData.metadata = {
        ...baseMetadata,
        pendingDowngradePlanId: newPlanId,
      };
    }

    // If user was trialing and they're upgrading (paid or have verified token), end the trial
    // This covers both:
    // 1. Direct payment success (paymentResult.status === 'paid')
    // 2. 3DS flow completion (verifiedTokenId provided from frontend)
    const paymentCompleted =
      paymentResult?.status === "paid" || options?.verifiedTokenId;
    if (isTrialing && isUpgrade && paymentCompleted) {
      updateData.status = "active";
      updateData.trialStart = null;
      updateData.trialEnd = null;
      this.logger.info?.(
        `Trial ended for ${subscriberId} - upgraded to ${newPlan.name}`,
      );
    }

    // If a verified token ID was provided, save it for future renewals
    // Token is already verified from frontend 3DS flow
    if (options?.verifiedTokenId) {
      updateData.gatewayCustomerId = options.verifiedTokenId;
      this.logger.info?.(
        `Saved verified token ${options.verifiedTokenId} for subscriber ${subscriberId}`,
      );
    }

    const updated = await this.db.subscriptions.update(
      subscription.id,
      updateData,
    );

    // Invalidate cache
    await this.cache.delete(CacheKeys.subscription(subscriberId));
    await this.cache.delete(CacheKeys.features(subscriberId));

    // Determine charge amount:
    // 1. If payment was charged by this service, chargeAmount is already set
    // 2. If skipPayment but it's an upgrade, compute what WOULD have been charged
    //    (the frontend already collected this amount via its own payment flow)
    let resolvedChargeAmount: number | undefined;
    if (isUpgrade) {
      if (paymentResult) {
        // chargeAmount was computed above
        resolvedChargeAmount = chargeAmount;
      } else if (options?.skipPayment) {
        // Frontend handled payment; recompute the same amount for the invoice
        if (isTrialing || effectiveCurrentPrice === 0) {
          resolvedChargeAmount = Math.round(newPlan.price * 100);
        } else if (shouldProrate && subscription.currentPeriodEnd > now) {
          const totalPeriodMs =
            subscription.currentPeriodEnd.getTime() -
            subscription.currentPeriodStart.getTime();
          const remainingMs =
            subscription.currentPeriodEnd.getTime() - now.getTime();
          const remainingRatio = remainingMs / totalPeriodMs;
          const priceDifference = newPlan.price - currentPlan.price;
          resolvedChargeAmount = Math.round(
            priceDifference * remainingRatio * 100,
          );
        } else {
          resolvedChargeAmount = Math.round(newPlan.price * 100);
        }
      }
    }

    // Create invoice for upgrades that were charged or paid externally
    if (isUpgrade && resolvedChargeAmount && resolvedChargeAmount > 0) {
      try {
        const isPaid = paymentResult?.status === "paid" || !!options?.verifiedTokenId;
        await this.db.invoices.create({
          subscriptionId: subscription.id,
          amount: resolvedChargeAmount / 100,
          currency: newPlan.currency,
          status: isPaid ? "paid" : "open",
          ...(isPaid && { paidAt: now }),
          ...(paymentResult?.id && { gatewayInvoiceId: paymentResult.id }),
          lineItems: [{
            description: `Upgrade from ${currentPlan.name} to ${newPlan.name}`,
            quantity: 1,
            unitPrice: resolvedChargeAmount / 100,
            amount: resolvedChargeAmount / 100,
          }],
          metadata: { type: "plan_upgrade", oldPlanId: currentPlan.id, newPlanId: newPlan.id },
        });
      } catch {
        // Non-critical: log but don't fail the plan change
        this.logger.error?.(`Failed to create upgrade invoice for ${subscriberId}`);
      }
    }

    return {
      subscription: {
        ...updated,
        plan: shouldApplyImmediately ? newPlan : currentPlan,
      },
      charged: !!paymentResult && paymentResult.status === "paid",
      ...(paymentResult?.id && { paymentId: paymentResult.id }),
      ...(resolvedChargeAmount !== undefined && {
        chargeAmount: resolvedChargeAmount,
      }),
    };
  }

  /**
   * Preview a plan change - calculates what user will pay without making any changes.
   * Use this to show the user the cost before they confirm the plan change.
   *
   * @param subscriberId - The subscriber ID
   * @param newPlanId - The new plan to preview
   * @returns Preview with proration details
   */
  async previewChangePlan(
    subscriberId: string,
    newPlanId: string,
  ): Promise<PlanChangePreview> {
    const subscription = await this.getOrThrow(subscriberId);
    const currentPlan = subscription.plan;

    // Verify new plan exists
    const newPlan = await this.db.plans.findById(newPlanId);
    if (!newPlan) {
      throw new PlanNotFoundError(newPlanId);
    }

    // Early return if already on the same plan
    if (subscription.planId === newPlanId) {
      return {
        currentPlan: {
          id: currentPlan.id,
          name: currentPlan.name,
          price: currentPlan.price,
          currency: currentPlan.currency,
        },
        newPlan: {
          id: newPlan.id,
          name: newPlan.name,
          price: newPlan.price,
          currency: newPlan.currency,
        },
        isUpgrade: false,
        isDowngrade: false,
        priceDifference: 0,
        daysRemaining: 0,
        totalDays: 0,
        prorationRatio: 0,
        amountDue: 0,
        amountDueFormatted: 0,
        currency: currentPlan.currency,
        effectiveDate: new Date(),
        message: "You are already on this plan.",
      };
    }

    const now = new Date();

    // CRITICAL: Check if user is trialing - they haven't paid anything yet
    const isTrialing = subscription.status === "trialing";

    // For trial users, their effective "paid" price is $0
    const effectiveCurrentPrice = isTrialing ? 0 : currentPlan.price;

    const isUpgrade = newPlan.price > effectiveCurrentPrice;
    const isDowngrade = newPlan.price < effectiveCurrentPrice;
    const priceDifference = newPlan.price - effectiveCurrentPrice;

    // Calculate period details (only relevant for active, not trialing users)
    const totalPeriodMs =
      subscription.currentPeriodEnd.getTime() -
      subscription.currentPeriodStart.getTime();
    const remainingMs = Math.max(
      0,
      subscription.currentPeriodEnd.getTime() - now.getTime(),
    );
    const prorationRatio = totalPeriodMs > 0 ? remainingMs / totalPeriodMs : 0;

    const totalDays = Math.ceil(totalPeriodMs / (24 * 60 * 60 * 1000));
    const daysRemaining = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));

    // Calculate amount due
    let amountDue = 0;
    let effectiveDate = now;

    if (isUpgrade) {
      if (isTrialing || effectiveCurrentPrice === 0) {
        // TRIAL or FREE PLAN USER: Pay full price of new plan
        // No credit to subtract from a $0 plan
        amountDue = Math.round(newPlan.price * 100);
      } else {
        // ACTIVE PAID USER: Prorated difference
        amountDue = Math.round(priceDifference * prorationRatio * 100);
      }
      effectiveDate = now; // Takes effect immediately
    } else if (isDowngrade) {
      // Downgrades: no charge, applies at period end
      amountDue = 0;
      effectiveDate = subscription.currentPeriodEnd;
    }

    // Generate message
    let message: string;
    if (isTrialing && isUpgrade) {
      // Special message for trial users
      const formattedAmount = (amountDue / 100).toFixed(2);
      message = `Upgrade to ${newPlan.name}: Your trial will end and you will be charged ${formattedAmount} ${newPlan.currency} for the full plan price. Your subscription takes effect immediately.`;
    } else if (isUpgrade) {
      const formattedAmount = (amountDue / 100).toFixed(2);
      message = `Upgrade to ${newPlan.name}: You will be charged ${formattedAmount} ${newPlan.currency} now (prorated for ${daysRemaining} remaining days). Your new plan takes effect immediately.`;
    } else if (isDowngrade) {
      message = `Downgrade to ${newPlan.name}: Your current plan will remain active until ${subscription.currentPeriodEnd.toLocaleDateString()}. The new plan will take effect at your next billing cycle.`;
    } else {
      message = `Switch to ${newPlan.name}: No charge required as the plans are the same price.`;
    }

    return {
      currentPlan: {
        id: currentPlan.id,
        name: currentPlan.name,
        price: currentPlan.price,
        currency: currentPlan.currency,
      },
      newPlan: {
        id: newPlan.id,
        name: newPlan.name,
        price: newPlan.price,
        currency: newPlan.currency,
      },
      isUpgrade,
      isDowngrade,
      priceDifference,
      daysRemaining,
      totalDays,
      prorationRatio,
      amountDue,
      amountDueFormatted: amountDue / 100,
      currency: newPlan.currency,
      effectiveDate,
      message,
    };
  }

  /**
   * Cancel subscription
   */
  async cancel(
    subscriberId: string,
    options?: CancelOptions,
  ): Promise<Subscription> {
    const subscription = await this.getOrThrow(subscriberId);

    // Don't allow canceling an already-canceled subscription
    if (subscription.status === "canceled") {
      throw new SubscriptionInactiveError("canceled");
    }

    const now = new Date();
    const updateData: UpdateSubscriptionInput = {
      canceledAt: now,
    };

    if (options?.immediately) {
      updateData.status = "canceled";
      updateData.cancelAt = now;
    } else {
      updateData.cancelAt = subscription.currentPeriodEnd;
    }

    // Cancel in payment gateway if connected
    if (subscription.gatewaySubscriptionId) {
      await this.payment.cancelSubscription(
        subscription.gatewaySubscriptionId,
        options,
      );
    }

    const updated = await this.db.subscriptions.update(
      subscription.id,
      updateData,
    );

    // Invalidate cache
    await this.cache.delete(CacheKeys.subscription(subscriberId));
    await this.cache.delete(CacheKeys.features(subscriberId));

    return updated;
  }

  /**
   * Pause subscription (if supported by payment gateway)
   */
  async pause(subscriberId: string): Promise<Subscription> {
    const subscription = await this.getOrThrow(subscriberId);

    if (subscription.gatewaySubscriptionId && this.payment.pauseSubscription) {
      await this.payment.pauseSubscription(subscription.gatewaySubscriptionId);
    }

    const updated = await this.db.subscriptions.update(subscription.id, {
      status: "paused",
    });

    await this.cache.delete(CacheKeys.subscription(subscriberId));
    await this.cache.delete(CacheKeys.features(subscriberId));

    return updated;
  }

  /**
   * Resume paused subscription
   */
  async resume(subscriberId: string): Promise<Subscription> {
    const subscription = await this.getOrThrow(subscriberId);

    if (subscription.status !== "paused") {
      throw new SubscriptionInactiveError(subscription.status);
    }

    if (subscription.gatewaySubscriptionId && this.payment.resumeSubscription) {
      await this.payment.resumeSubscription(subscription.gatewaySubscriptionId);
    }

    const now = new Date();
    const updateData: UpdateSubscriptionInput = { status: "active" };

    // If the subscription period expired during pause, start a new period
    if (now > subscription.currentPeriodEnd) {
      updateData.currentPeriodStart = now;
      updateData.currentPeriodEnd = this.calculatePeriodEnd(
        now,
        subscription.plan.interval,
        subscription.plan.intervalCount,
      );
    }

    const updated = await this.db.subscriptions.update(
      subscription.id,
      updateData,
    );

    await this.cache.delete(CacheKeys.subscription(subscriberId));
    await this.cache.delete(CacheKeys.features(subscriberId));

    return updated;
  }

  /**
   * Reactivate a subscription that was scheduled for cancellation.
   * This clears cancelAt/canceledAt without changing the subscription period.
   */
  async reactivate(subscriberId: string): Promise<Subscription> {
    const subscription = await this.getOrThrow(subscriberId);

    // Only allow reactivation if subscription is still active/trialing but scheduled to cancel
    if (!this.isActiveStatus(subscription.status)) {
      throw new SubscriptionInactiveError(subscription.status);
    }

    if (!subscription.cancelAt && !subscription.canceledAt) {
      throw new SubscriptionNotCanceledError();
    }

    const updated = await this.db.subscriptions.update(subscription.id, {
      cancelAt: null,
      canceledAt: null,
    });

    await this.cache.delete(CacheKeys.subscription(subscriberId));
    await this.cache.delete(CacheKeys.features(subscriberId));

    return updated;
  }

  /**
   * Start a trial subscription
   */
  async startTrial(
    subscriberId: string,
    planId: string,
    trialDays: number,
  ): Promise<Subscription> {
    return this.create(subscriberId, planId, { trialDays });
  }

  /**
   * Extend trial period
   */
  async extendTrial(
    subscriberId: string,
    additionalDays: number,
  ): Promise<Subscription> {
    const subscription = await this.getOrThrow(subscriberId);

    if (subscription.status !== "trialing" || !subscription.trialEnd) {
      throw new SubscriptionInactiveError(
        "Cannot extend trial - subscription is not in trial",
      );
    }

    const newTrialEnd = new Date(
      subscription.trialEnd.getTime() + additionalDays * 24 * 60 * 60 * 1000,
    );

    const updated = await this.db.subscriptions.update(subscription.id, {
      trialEnd: newTrialEnd,
      currentPeriodEnd: newTrialEnd,
    });

    await this.cache.delete(CacheKeys.subscription(subscriberId));

    return updated;
  }

  /**
   * Check if subscription is active (including trial and grace period)
   */
  async isActive(subscriberId: string): Promise<boolean> {
    const subscription = await this.get(subscriberId);
    if (!subscription) return false;

    return this.isSubscriptionActive(subscription);
  }

  /**
   * Check if subscription is in trial
   */
  async isTrialing(subscriberId: string): Promise<boolean> {
    const subscription = await this.get(subscriberId);
    if (!subscription) return false;

    return subscription.status === "trialing";
  }

  /**
   * Get days remaining in current period
   */
  async daysRemaining(subscriberId: string): Promise<number> {
    const subscription = await this.get(subscriberId);
    if (!subscription) return 0;

    const now = new Date();
    const endDate = subscription.trialEnd ?? subscription.currentPeriodEnd;
    const diff = endDate.getTime() - now.getTime();

    return Math.max(0, Math.ceil(diff / (24 * 60 * 60 * 1000)));
  }

  /**
   * Renew subscription for a new period
   */
  async renew(
    subscriberId: string,
    options?: RenewSubscriptionOptions,
  ): Promise<Subscription> {
    const subscription = await this.getOrThrow(subscriberId);
    const pendingDowngradePlanId = (subscription.metadata as Record<string, unknown> | null)?.pendingDowngradePlanId as string | undefined;
    let activePlan = subscription.plan;

    if (pendingDowngradePlanId) {
      const downgradePlan = await this.db.plans.findById(pendingDowngradePlanId);
      if (downgradePlan) {
        activePlan = downgradePlan;
      }
    }

    const now = new Date();
    let paymentResult: ChargePaymentResult | undefined;

    if (activePlan.price > 0 && !options?.skipPayment) {
      if (!this.payment.chargePayment) {
        throw new PaymentFailedError(
          "Payment gateway does not support renewal charges",
        );
      }

      if (!subscription.gatewayCustomerId) {
        throw new PaymentFailedError("No payment token available for renewal");
      }

      paymentResult = await this.payment.chargePayment({
        customerId: subscription.gatewayCustomerId,
        amount: Math.round(activePlan.price * 100),
        currency: activePlan.currency,
        description: `${activePlan.name} subscription renewal`,
        metadata: {
          subscriberId,
          planId: activePlan.id,
          subscriptionId: subscription.id,
          type: "renewal",
        },
      });

      if (paymentResult.status !== "paid") {
        throw new PaymentFailedError(
          paymentResult.errorMessage ??
            (paymentResult.status === "pending"
              ? "Renewal payment requires additional verification"
              : "Payment failed for subscription renewal"),
          paymentResult.id || undefined,
          paymentResult.errorCode,
          paymentResult.isRetryable,
          paymentResult.userAction,
        );
      }
    }

    const newPeriodEnd = this.calculatePeriodEnd(
      now,
      activePlan.interval,
      activePlan.intervalCount,
    );

    const cleanedMetadata = this.clearPendingSubscriptionMetadata(
      subscription.metadata,
    );
    const updateData: UpdateSubscriptionInput = {
      status: "active",
      currentPeriodStart: now,
      currentPeriodEnd: newPeriodEnd,
      trialStart: null,
      trialEnd: null,
      cancelAt: null,
      canceledAt: null,
      metadata: cleanedMetadata,
    };

    if (pendingDowngradePlanId && activePlan.id === pendingDowngradePlanId) {
        updateData.planId = pendingDowngradePlanId;
    }

    const updated = await this.db.subscriptions.update(subscription.id, updateData);

    // Create renewal invoice
    if (activePlan.price > 0) {
      try {
        const invoicePaid = paymentResult?.status === "paid";
        await this.db.invoices.create({
          subscriptionId: subscription.id,
          amount: activePlan.price,
          currency: activePlan.currency,
          status: invoicePaid ? "paid" : "open",
          ...(invoicePaid && { paidAt: now }),
          ...(paymentResult?.id && { gatewayInvoiceId: paymentResult.id }),
          dueDate: newPeriodEnd,
          lineItems: [{
            description: `${activePlan.name} subscription renewal`,
            quantity: 1,
            unitPrice: activePlan.price,
            amount: activePlan.price,
          }],
          metadata: { type: "renewal" },
        });
      } catch {
        this.logger.error?.(`Failed to create renewal invoice for ${subscriberId}`);
      }
    }

    await this.cache.delete(CacheKeys.subscription(subscriberId));
    await this.cache.delete(CacheKeys.features(subscriberId));

    return updated;
  }

  // ==================== Private Helpers ====================

  private clearPendingSubscriptionMetadata(
    metadata: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> {
    const {
      pendingPlanChange,
      pendingPaymentId,
      pendingVerificationUrl,
      pendingDowngradePlanId,
      ...restMeta
    } = (metadata ?? {}) as Record<string, unknown>;

    return restMeta;
  }

  private async getOrThrow(
    subscriberId: string,
  ): Promise<SubscriptionWithPlan<TFeatures>> {
    const subscription = await this.get(subscriberId);
    if (!subscription) {
      throw new SubscriptionNotFoundError(subscriberId);
    }
    return subscription;
  }

  private isActiveStatus(status: SubscriptionStatus): boolean {
    return ["active", "trialing", "past_due"].includes(status);
  }

  private async finalizeEndedSubscriptionIfNeeded(
    subscriberId: string,
    subscription: SubscriptionWithPlan<TFeatures>,
  ): Promise<SubscriptionWithPlan<TFeatures>> {
    const now = new Date();
    const endedByScheduledCancel =
      this.isActiveStatus(subscription.status) &&
      !!subscription.cancelAt &&
      now >= subscription.cancelAt;

    const trialBoundary =
      subscription.trialEnd ?? subscription.currentPeriodEnd;
    // Only auto-cancel expired trials if the user has NO saved payment method.
    // If they have a gatewayCustomerId, the scheduler should charge them and
    // convert to active — premature cancellation here would race with the cron.
    const endedTrial =
      subscription.status === "trialing" &&
      now >= trialBoundary &&
      !subscription.gatewayCustomerId;

    if (!endedByScheduledCancel && !endedTrial) {
      return subscription;
    }

    const canceledAt =
      subscription.canceledAt ?? subscription.cancelAt ?? trialBoundary;

    await this.db.subscriptions.update(subscription.id, {
      status: "canceled",
      canceledAt,
      cancelAt: subscription.cancelAt,
    });

    await this.cache.delete(CacheKeys.subscription(subscriberId));
    await this.cache.delete(CacheKeys.features(subscriberId));

    return {
      ...subscription,
      status: "canceled",
      canceledAt,
    };
  }

  private isSubscriptionActive(subscription: Subscription): boolean {
    if (!this.isActiveStatus(subscription.status)) {
      return false;
    }

    const now = new Date();
    const endDate = subscription.currentPeriodEnd;
    const graceEnd = new Date(
      endDate.getTime() + this.gracePeriodDays * 24 * 60 * 60 * 1000,
    );

    return now <= graceEnd;
  }

  private calculatePeriodEnd(
    start: Date,
    interval: string,
    intervalCount: number,
  ): Date {
    const end = new Date(start);

    switch (interval) {
      case "monthly":
        end.setMonth(end.getMonth() + intervalCount);
        break;
      case "yearly":
        end.setFullYear(end.getFullYear() + intervalCount);
        break;
      case "one_time":
        // One-time subscriptions: set period end to 10 years
        end.setFullYear(end.getFullYear() + 10);
        break;
      default:
        // Custom interval: use calendar months (consistent with 'monthly')
        end.setMonth(end.getMonth() + intervalCount);
    }

    return end;
  }
}
