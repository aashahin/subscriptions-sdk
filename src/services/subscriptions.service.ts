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

/**
 * Dunning (failed payment recovery) configuration
 */
export interface DunningOptions {
  /**
   * Days after the first payment failure at which a retry is attempted.
   * Each entry represents one retry attempt; when all are exhausted the
   * configured `action` is applied.
   * @default [1, 3, 5, 7]
   */
  retryScheduleDays?: number[];

  /**
   * Action to apply to the subscription once the retry schedule is exhausted.
   * - 'pause': set status to 'paused' (access revoked, can be resumed later)
   * - 'cancel': cancel the subscription immediately
   * - 'none': only track attempts, leave the subscription in 'past_due'
   * @default 'none'
   */
  action?: "pause" | "cancel" | "none";
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
   * Dunning (failed payment recovery) configuration.
   * Used by `processDunning` to retry past-due subscriptions and apply a
   * terminal action when retries are exhausted.
   */
  dunning?: DunningOptions;

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

/**
 * Per-subscription outcome of a `processDunning` run
 */
export interface DunningProcessResult {
  /** Subscriber that was processed */
  subscriberId: string;
  /** Subscription that was processed */
  subscriptionId: string;
  /** Total retry attempts recorded after this run */
  attempts: number;
  /** Whether the configured retry schedule has been exhausted */
  exhausted: boolean;
  /** Whether the subscription recovered (a retry charge succeeded) */
  recovered: boolean;
  /** Terminal action applied when exhausted ('none' when nothing was applied) */
  actionApplied: "pause" | "cancel" | "none";
}

/**
 * Per-subscription outcome of an `executePendingChanges` run
 */
export interface PendingChangeResult {
  /** Subscriber whose plan change was applied */
  subscriberId: string;
  /** Subscription that was updated */
  subscriptionId: string;
  /** Plan the subscription was on before the change */
  previousPlanId: string;
  /** Plan that is now in effect */
  newPlanId: string;
}

interface RenewSubscriptionOptions {
  /** Do not charge the saved payment token (payment handled elsewhere). */
  skipPayment?: boolean;
  /**
   * Treat the renewal as already paid by an external flow (e.g. a `payment.paid`
   * webhook fired after the gateway charged the customer). When set, the renewal
   * invoice is created with `paid` status instead of `open`. Implies the caller
   * is responsible for the actual charge, so it is typically used together with
   * `skipPayment`.
   */
  paidExternally?: boolean;
  /** Gateway payment/invoice ID to record on the renewal invoice. */
  gatewayInvoiceId?: string;
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
  private readonly dunningRetryScheduleDays: number[];
  private readonly dunningAction: "pause" | "cancel" | "none";
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
    this.dunningRetryScheduleDays =
      options?.dunning?.retryScheduleDays ?? [1, 3, 5, 7];
    this.dunningAction = options?.dunning?.action ?? "none";
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
      /**
       * Mark the initial invoice as already paid (payment was collected by an
       * external flow, e.g. a verified token charged on the frontend). Defaults
       * to `false`, in which case the initial invoice is created as `open`.
       */
      paidExternally?: boolean;
      /** Gateway payment/invoice ID to record on the initial invoice. */
      gatewayInvoiceId?: string;
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

    // Create initial invoice. `paid` when payment was already collected
    // externally, otherwise `open` (amount due) for an immediate paid start.
    if (!hasTrialDays && plan.price > 0) {
      try {
        const invoicePaid = !!options?.paidExternally;
        await this.db.invoices.create({
          subscriptionId: subscription.id,
          amount: plan.price,
          currency: plan.currency,
          status: invoicePaid ? "paid" : "open",
          ...(invoicePaid && { paidAt: now }),
          ...(options?.gatewayInvoiceId && {
            gatewayInvoiceId: options.gatewayInvoiceId,
          }),
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
      /**
       * Gateway payment/invoice ID for a payment already collected by an
       * external flow (e.g. frontend 3DS). Recorded on the upgrade invoice so
       * the service stays the single source of truth for invoicing.
       */
      gatewayInvoiceId?: string;
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

      // Calculate charge amount (in smallest currency unit)
      chargeAmount = this.computeUpgradeChargeMinorUnits({
        newPrice: newPlan.price,
        currentPrice: currentPlan.price,
        effectiveCurrentPrice,
        isTrialing,
        shouldProrate,
        periodStart: subscription.currentPeriodStart,
        periodEnd: subscription.currentPeriodEnd,
        now,
      });

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
        resolvedChargeAmount = this.computeUpgradeChargeMinorUnits({
          newPrice: newPlan.price,
          currentPrice: currentPlan.price,
          effectiveCurrentPrice,
          isTrialing,
          shouldProrate,
          periodStart: subscription.currentPeriodStart,
          periodEnd: subscription.currentPeriodEnd,
          now,
        });
      }
    }

    // Create invoice for upgrades that were charged or paid externally
    if (isUpgrade && resolvedChargeAmount && resolvedChargeAmount > 0) {
      try {
        const isPaid = paymentResult?.status === "paid" || !!options?.verifiedTokenId;
        const gatewayInvoiceId = paymentResult?.id ?? options?.gatewayInvoiceId;
        await this.db.invoices.create({
          subscriptionId: subscription.id,
          amount: resolvedChargeAmount / 100,
          currency: newPlan.currency,
          status: isPaid ? "paid" : "open",
          ...(isPaid && { paidAt: now }),
          ...(gatewayInvoiceId && { gatewayInvoiceId }),
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

    // Persist the cancellation reason for reporting/audit
    if (options?.reason) {
      updateData.metadata = {
        ...(subscription.metadata ?? {}),
        cancelReason: options.reason,
      };
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
   * Pause subscription (if supported by payment gateway).
   *
   * Records `pausedAt` in metadata so `resume()` can extend the current
   * period by the time spent paused (paid time is not lost).
   */
  async pause(subscriberId: string): Promise<Subscription> {
    const subscription = await this.getOrThrow(subscriberId);

    if (subscription.gatewaySubscriptionId && this.payment.pauseSubscription) {
      await this.payment.pauseSubscription(subscription.gatewaySubscriptionId);
    }

    const updated = await this.db.subscriptions.update(subscription.id, {
      status: "paused",
      metadata: {
        ...(subscription.metadata ?? {}),
        pausedAt: new Date().toISOString(),
      },
    });

    await this.cache.delete(CacheKeys.subscription(subscriberId));
    await this.cache.delete(CacheKeys.features(subscriberId));

    return updated;
  }

  /**
   * Resume paused subscription.
   *
   * Restores the 'active' status and extends `currentPeriodEnd` by the time
   * the subscription spent paused (recorded as `pausedAt` by `pause()`), so
   * subscribers keep the paid time they missed. When no pause timestamp is
   * available (e.g. paused externally) and the period already expired, a
   * fresh period is started instead.
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

    const metadata = (subscription.metadata ?? {}) as Record<string, unknown>;
    const pausedAtRaw = metadata.pausedAt;
    const pausedAt =
      typeof pausedAtRaw === "string" ? new Date(pausedAtRaw) : null;

    if (pausedAt && !Number.isNaN(pausedAt.getTime())) {
      // Extend the current period by the paused duration and clear pausedAt
      const pausedMs = Math.max(0, now.getTime() - pausedAt.getTime());
      updateData.currentPeriodEnd = new Date(
        subscription.currentPeriodEnd.getTime() + pausedMs,
      );
      const { pausedAt: _pausedAt, ...restMeta } = metadata;
      updateData.metadata = restMeta;
    } else if (now > subscription.currentPeriodEnd) {
      // No pause timestamp recorded: if the subscription period expired
      // during pause, start a new period
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
        const invoicePaid =
          paymentResult?.status === "paid" || !!options?.paidExternally;
        const gatewayInvoiceId =
          paymentResult?.id ?? options?.gatewayInvoiceId;
        await this.db.invoices.create({
          subscriptionId: subscription.id,
          amount: activePlan.price,
          currency: activePlan.currency,
          status: invoicePaid ? "paid" : "open",
          ...(invoicePaid && { paidAt: now }),
          ...(gatewayInvoiceId && { gatewayInvoiceId }),
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

  /**
   * Record a payment failure against the subscriber's subscription.
   *
   * Stores the failure reason/timestamp in metadata and invalidates the cache
   * so subsequent reads are consistent. Also initializes the dunning tracking
   * fields (`dunningStartedAt`, `dunningAttempts`) used by `processDunning` —
   * existing dunning state is preserved so repeated failures within the same
   * dunning cycle don't reset the retry clock. Returns the updated
   * subscription, or `null` when the subscriber has no subscription.
   */
  async recordPaymentFailure(
    subscriberId: string,
    message: string,
  ): Promise<Subscription | null> {
    const subscription = await this.get(subscriberId);
    if (!subscription) {
      return null;
    }

    const metadata = (subscription.metadata ?? {}) as Record<string, unknown>;
    const nowIso = new Date().toISOString();

    const updated = await this.db.subscriptions.update(subscription.id, {
      metadata: {
        ...metadata,
        lastPaymentError: message,
        lastPaymentFailedAt: nowIso,
        dunningStartedAt:
          typeof metadata.dunningStartedAt === "string"
            ? metadata.dunningStartedAt
            : nowIso,
        dunningAttempts:
          typeof metadata.dunningAttempts === "number"
            ? metadata.dunningAttempts
            : 0,
      },
    });

    await this.cache.delete(CacheKeys.subscription(subscriberId));
    await this.cache.delete(CacheKeys.features(subscriberId));

    return updated;
  }

  /**
   * Process dunning for all past-due subscriptions.
   *
   * Intended to be called on a schedule (e.g. daily cron). For each
   * `past_due` subscription it:
   * 1. Computes how many retries from `dunning.retryScheduleDays` are due,
   *    based on when the failure was first recorded (`dunningStartedAt`,
   *    initialized by `recordPaymentFailure`).
   * 2. When a retry is due and the gateway supports direct charges, attempts
   *    to charge the saved payment method; a successful charge renews the
   *    subscription and clears the dunning state.
   * 3. Otherwise increments `metadata.dunningAttempts`.
   * 4. Once the schedule is exhausted, applies the configured
   *    `dunning.action` ('pause' or 'cancel') via the regular pause()/cancel()
   *    paths so caches stay consistent.
   *
   * @param now - Reference time (defaults to the current time; injectable for testing)
   * @returns One result per past-due subscription processed
   */
  async processDunning(now: Date = new Date()): Promise<DunningProcessResult[]> {
    const pastDueSubscriptions = await this.db.subscriptions.findAll({
      status: "past_due",
    });

    const schedule = this.dunningRetryScheduleDays;
    const results: DunningProcessResult[] = [];

    for (const subscription of pastDueSubscriptions) {
      const metadata = (subscription.metadata ?? {}) as Record<string, unknown>;
      const startedAtRaw =
        metadata.dunningStartedAt ?? metadata.lastPaymentFailedAt;
      const startedAt =
        typeof startedAtRaw === "string" ? new Date(startedAtRaw) : null;

      // No failure timestamp recorded: nothing to base the schedule on
      if (!startedAt || Number.isNaN(startedAt.getTime())) {
        continue;
      }

      const daysSinceFailure = Math.floor(
        (now.getTime() - startedAt.getTime()) / (24 * 60 * 60 * 1000),
      );
      const dueRetries = schedule.filter((d) => daysSinceFailure >= d).length;
      let attempts =
        typeof metadata.dunningAttempts === "number"
          ? metadata.dunningAttempts
          : 0;

      // Schedule already exhausted: apply the terminal action
      if (attempts >= schedule.length) {
        const actionApplied = await this.applyDunningAction(
          subscription.subscriberId,
        );
        results.push({
          subscriberId: subscription.subscriberId,
          subscriptionId: subscription.id,
          attempts,
          exhausted: true,
          recovered: false,
          actionApplied,
        });
        continue;
      }

      // No new retry due yet
      if (dueRetries <= attempts) {
        results.push({
          subscriberId: subscription.subscriberId,
          subscriptionId: subscription.id,
          attempts,
          exhausted: false,
          recovered: false,
          actionApplied: "none",
        });
        continue;
      }

      // A retry is due: attempt to charge the saved payment method (at most
      // one charge per run, even if multiple schedule points are overdue)
      const recovered = await this.attemptDunningCharge(subscription);
      if (recovered) {
        results.push({
          subscriberId: subscription.subscriberId,
          subscriptionId: subscription.id,
          attempts,
          exhausted: false,
          recovered: true,
          actionApplied: "none",
        });
        continue;
      }

      // Retry failed (or no charge capability): record the attempt
      attempts += 1;
      const exhausted = attempts >= schedule.length;
      await this.db.subscriptions.update(subscription.id, {
        metadata: {
          ...metadata,
          dunningAttempts: attempts,
          lastDunningAttemptAt: now.toISOString(),
        },
      });
      await this.cache.delete(CacheKeys.subscription(subscription.subscriberId));

      const actionApplied = exhausted
        ? await this.applyDunningAction(subscription.subscriberId)
        : "none";

      results.push({
        subscriberId: subscription.subscriberId,
        subscriptionId: subscription.id,
        attempts,
        exhausted,
        recovered: false,
        actionApplied,
      });
    }

    return results;
  }

  /**
   * Apply pending plan changes (scheduled downgrades) that have reached their
   * effective date.
   *
   * Downgrades requested via `changePlan` are stored as
   * `metadata.pendingDowngradePlanId` and take effect at the end of the
   * current period. This entry point finds subscriptions whose period has
   * ended and applies the pending plan change without charging (the next
   * `renew` call bills the new plan).
   *
   * @param now - Reference time (defaults to the current time; injectable for testing)
   * @returns One result per plan change applied
   */
  async executePendingChanges(
    now: Date = new Date(),
  ): Promise<PendingChangeResult[]> {
    const candidates = await this.db.subscriptions.findAll({
      status: ["active", "trialing"],
    });

    const applied: PendingChangeResult[] = [];

    for (const subscription of candidates) {
      const metadata = (subscription.metadata ?? {}) as Record<string, unknown>;
      const pendingPlanId = metadata.pendingDowngradePlanId as
        | string
        | undefined;
      if (!pendingPlanId) {
        continue;
      }

      // Not due yet: the change takes effect at period end
      if (subscription.currentPeriodEnd > now) {
        continue;
      }

      const newPlan = await this.db.plans.findById(pendingPlanId);
      if (!newPlan) {
        this.logger.warn?.(
          `Pending downgrade target plan ${pendingPlanId} not found for subscriber ${subscription.subscriberId} - skipping`,
        );
        continue;
      }

      const updated = await this.db.subscriptions.update(subscription.id, {
        planId: pendingPlanId,
        metadata: this.clearPendingSubscriptionMetadata(metadata),
      });

      // Invalidate both caches: features change together with the plan
      await this.cache.delete(CacheKeys.subscription(subscription.subscriberId));
      await this.cache.delete(CacheKeys.features(subscription.subscriberId));

      this.logger.info?.(
        `Applied pending downgrade for ${subscription.subscriberId}: ${subscription.planId} -> ${pendingPlanId}`,
      );

      applied.push({
        subscriberId: subscription.subscriberId,
        subscriptionId: updated.id,
        previousPlanId: subscription.planId,
        newPlanId: pendingPlanId,
      });
    }

    return applied;
  }

  // ==================== Private Helpers ====================

  /**
   * Compute the amount to charge for an upgrade, in the smallest currency unit.
   *
   * Centralizes the proration math so the charge, the skip-payment recompute,
   * and any future caller stay in sync. Guards against a zero-length period
   * (which would otherwise produce NaN/Infinity from a divide-by-zero).
   */
  private computeUpgradeChargeMinorUnits(args: {
    newPrice: number;
    currentPrice: number;
    effectiveCurrentPrice: number;
    isTrialing: boolean;
    shouldProrate: boolean;
    periodStart: Date;
    periodEnd: Date;
    now: Date;
  }): number {
    const {
      newPrice,
      currentPrice,
      effectiveCurrentPrice,
      isTrialing,
      shouldProrate,
      periodStart,
      periodEnd,
      now,
    } = args;

    const totalPeriodMs = periodEnd.getTime() - periodStart.getTime();
    const remainingMs = periodEnd.getTime() - now.getTime();

    if (isTrialing || effectiveCurrentPrice === 0) {
      // Trial or free-plan user: no credit to subtract, charge full new price.
      return Math.round(newPrice * 100);
    }

    if (shouldProrate && remainingMs > 0 && totalPeriodMs > 0) {
      // Active paid user: charge the prorated price difference for the time left.
      const remainingRatio = remainingMs / totalPeriodMs;
      const priceDifference = newPrice - currentPrice;
      return Math.round(priceDifference * remainingRatio * 100);
    }

    return Math.round(newPrice * 100);
  }

  /**
   * Apply the configured terminal dunning action to a subscriber whose retry
   * schedule is exhausted. Reuses the regular pause()/cancel() paths so
   * status, metadata, and caches stay consistent. Failures are logged and
   * reported as 'none' so one bad subscription doesn't abort the whole run.
   */
  private async applyDunningAction(
    subscriberId: string,
  ): Promise<"pause" | "cancel" | "none"> {
    if (this.dunningAction === "none") {
      return "none";
    }

    try {
      if (this.dunningAction === "pause") {
        await this.pause(subscriberId);
      } else {
        await this.cancel(subscriberId, {
          immediately: true,
          reason: "Dunning: payment retry schedule exhausted",
        });
      }
      this.logger.info?.(
        `Dunning action '${this.dunningAction}' applied for ${subscriberId}`,
      );
      return this.dunningAction;
    } catch (err) {
      this.logger.error?.(
        `Failed to apply dunning action '${this.dunningAction}' for ${subscriberId}: ${err}`,
      );
      return "none";
    }
  }

  /**
   * Attempt a single dunning retry charge against the subscriber's saved
   * payment method. On success the subscription is renewed (payment already
   * collected) and the dunning metadata is cleared. Returns whether the
   * subscription recovered. Degrades gracefully to `false` when the gateway
   * cannot charge directly or no payment method is stored.
   */
  private async attemptDunningCharge(
    subscription: Subscription,
  ): Promise<boolean> {
    if (!this.payment.chargePayment || !subscription.gatewayCustomerId) {
      return false;
    }

    try {
      const plan = await this.db.plans.findById(subscription.planId);
      if (!plan || plan.price <= 0) {
        return false;
      }

      const paymentResult = await this.payment.chargePayment({
        customerId: subscription.gatewayCustomerId,
        amount: Math.round(plan.price * 100),
        currency: plan.currency,
        description: `${plan.name} subscription renewal (dunning retry)`,
        metadata: {
          subscriberId: subscription.subscriberId,
          planId: plan.id,
          subscriptionId: subscription.id,
          type: "dunning_retry",
        },
      });

      if (paymentResult.status !== "paid") {
        this.logger.info?.(
          `Dunning retry for ${subscription.subscriberId} not paid (status: ${paymentResult.status})`,
        );
        return false;
      }

      // Payment recovered: renew for a fresh period without charging again
      const renewed = await this.renew(subscription.subscriberId, {
        skipPayment: true,
        paidExternally: true,
        ...(paymentResult.id && { gatewayInvoiceId: paymentResult.id }),
      });

      // Clear the dunning tracking fields left behind by renew()
      const metadata = (renewed.metadata ?? {}) as Record<string, unknown>;
      const {
        dunningStartedAt,
        dunningAttempts,
        lastDunningAttemptAt,
        lastPaymentError,
        lastPaymentFailedAt,
        ...restMeta
      } = metadata;
      await this.db.subscriptions.update(renewed.id, { metadata: restMeta });
      await this.cache.delete(CacheKeys.subscription(subscription.subscriberId));
      await this.cache.delete(CacheKeys.features(subscription.subscriberId));

      this.logger.info?.(
        `Dunning retry succeeded for ${subscription.subscriberId} - subscription renewed`,
      );
      return true;
    } catch (err) {
      this.logger.error?.(
        `Dunning retry charge failed for ${subscription.subscriberId}: ${err}`,
      );
      return false;
    }
  }

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
