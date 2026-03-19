// file: packages/subscriptions/src/services/permissions.service.ts
// Permissions service for feature gates and usage limits

import type { CacheAdapter } from "../adapters/cache.adapter";
import { CacheKeys, noopCacheAdapter } from "../adapters/cache.adapter";
import type { DatabaseAdapter } from "../adapters/database.adapter";
import {
  FeatureNotAllowedError,
  SubscriptionInactiveError,
  UsageLimitExceededError,
} from "../core/errors";
import {
  isBooleanFeature,
  isLimitFeature,
  resolveFeatures,
} from "../core/features";
import type {
  FeatureRegistry,
  FeatureValues,
  SubscriptionWithPlan,
  UsageStatus,
} from "../core/types";

const UNLIMITED = -1;

export interface PermissionsServiceOptions {
  /**
   * Cache TTL in seconds
   * @default 300
   */
  cacheTtlSeconds?: number;

  /**
   * Grace period in days for expired subscriptions
   * @default 0
   */
  gracePeriodDays?: number;
}

export class PermissionsService<TFeatures extends FeatureRegistry> {
  private readonly cache: CacheAdapter;
  private readonly cacheTtl: number;
  private readonly gracePeriodDays: number;

  constructor(
    private readonly db: DatabaseAdapter<TFeatures>,
    private readonly features: TFeatures,
    cache?: CacheAdapter,
    options?: PermissionsServiceOptions,
  ) {
    this.cache = cache ?? noopCacheAdapter;
    this.cacheTtl = options?.cacheTtlSeconds ?? 300;
    this.gracePeriodDays = options?.gracePeriodDays ?? 0;
  }

  /**
   * Check if subscriber has access to a boolean feature
   */
  async can<K extends keyof TFeatures>(
    subscriberId: string,
    feature: K,
  ): Promise<boolean> {
    const definition = this.features[feature];
    if (!definition) {
      return false;
    }

    if (!isBooleanFeature(definition)) {
      // For limit/rate features, check if they have any remaining
      const status = await this.remaining(subscriberId, feature);
      return status.remaining > 0 || status.unlimited;
    }

    const featureValues = await this.getFeatures(subscriberId);
    return featureValues[feature] as boolean;
  }

  /**
   * Get current usage vs limit for a feature
   */
  async remaining<K extends keyof TFeatures>(
    subscriberId: string,
    feature: K,
  ): Promise<UsageStatus> {
    const definition = this.features[feature];
    if (!definition) {
      return {
        feature: feature as string,
        used: 0,
        limit: 0,
        remaining: 0,
        percentage: 100,
        unlimited: false,
      };
    }

    const featureValues = await this.getFeatures(subscriberId);
    const limit = featureValues[feature] as number;
    const used = await this.db.usage.get(subscriberId, feature as string);
    const unlimited = limit === UNLIMITED;
    const remaining = unlimited ? Infinity : Math.max(0, limit - used);
    const percentage = unlimited
      ? 0
      : limit > 0
        ? Math.round((used / limit) * 100)
        : 100;

    return {
      feature: feature as string,
      used,
      limit: unlimited ? Infinity : limit,
      remaining,
      percentage,
      unlimited,
    };
  }

  /**
   * Check if subscriber can use more of a limited feature
   */
  async canUse<K extends keyof TFeatures>(
    subscriberId: string,
    feature: K,
    count: number = 1,
  ): Promise<boolean> {
    const status = await this.remaining(subscriberId, feature);
    return status.unlimited || status.remaining >= count;
  }

  /**
   * Increment usage counter (throws if limit exceeded)
   */
  async use<K extends keyof TFeatures>(
    subscriberId: string,
    feature: K,
    count: number = 1,
  ): Promise<UsageStatus> {
    const canUseMore = await this.canUse(subscriberId, feature, count);
    if (!canUseMore) {
      const status = await this.remaining(subscriberId, feature);
      throw new UsageLimitExceededError(
        feature as string,
        status.limit as number,
        status.used,
      );
    }

    await this.db.usage.increment(subscriberId, feature as string, { count });

    // Invalidate cached usage
    await this.cache.delete(CacheKeys.usage(subscriberId, feature as string));

    return this.remaining(subscriberId, feature);
  }

  /**
   * Decrement usage counter (e.g., when deleting a product)
   */
  async release<K extends keyof TFeatures>(
    subscriberId: string,
    feature: K,
    count: number = 1,
  ): Promise<UsageStatus> {
    await this.db.usage.decrement(subscriberId, feature as string, { count });

    // Invalidate cached usage
    await this.cache.delete(CacheKeys.usage(subscriberId, feature as string));

    return this.remaining(subscriberId, feature);
  }

  /**
   * Set usage to a specific value
   */
  async setUsage<K extends keyof TFeatures>(
    subscriberId: string,
    feature: K,
    count: number,
  ): Promise<void> {
    await this.db.usage.set(subscriberId, feature as string, count);
    await this.cache.delete(CacheKeys.usage(subscriberId, feature as string));
  }

  /**
   * Reset all usage for a subscriber (e.g., at period start)
   */
  async resetUsage(
    subscriberId: string,
    feature?: keyof TFeatures,
  ): Promise<void> {
    await this.db.usage.reset(subscriberId, {
      ...(feature !== undefined && { feature: feature as string }),
    });

    if (feature) {
      await this.cache.delete(CacheKeys.usage(subscriberId, feature as string));
    } else if (this.cache.deletePattern) {
      await this.cache.deletePattern(CacheKeys.usageAll(subscriberId));
    }
  }

  /**
   * Get all feature values for subscriber's current plan
   */
  async getFeatures(subscriberId: string): Promise<FeatureValues<TFeatures>> {
    const cacheKey = CacheKeys.features(subscriberId);

    // Try cache first
    const cached = await this.cache.get<FeatureValues<TFeatures>>(cacheKey);
    if (cached) {
      return cached;
    }

    const subscription =
      await this.db.subscriptions.findBySubscriber(subscriberId);
    if (!subscription) {
      // Return defaults for non-subscribers
      return resolveFeatures(this.features, null);
    }

    // Check if subscription is still valid
    this.validateSubscriptionActive(subscription);

    const resolved = resolveFeatures(this.features, subscription.plan.features);

    // Cache the result
    await this.cache.set(cacheKey, resolved, this.cacheTtl);

    return resolved;
  }

  /**
   * Get the limit value for a specific feature
   */
  async getLimit<K extends keyof TFeatures>(
    subscriberId: string,
    feature: K,
  ): Promise<number> {
    const featureValues = await this.getFeatures(subscriberId);
    return featureValues[feature] as number;
  }

  /**
   * Get the rate value for a specific feature (e.g., transaction fee percentage)
   */
  async getRate<K extends keyof TFeatures>(
    subscriberId: string,
    feature: K,
  ): Promise<number> {
    const featureValues = await this.getFeatures(subscriberId);
    return featureValues[feature] as number;
  }

  /**
   * Assert a boolean feature is enabled (throws if not)
   */
  async assertCan<K extends keyof TFeatures>(
    subscriberId: string,
    feature: K,
    planName?: string,
  ): Promise<void> {
    const allowed = await this.can(subscriberId, feature);
    if (!allowed) {
      throw new FeatureNotAllowedError(feature as string, planName);
    }
  }

  /**
   * Assert usage is within limits (throws if exceeded)
   */
  async assertCanUse<K extends keyof TFeatures>(
    subscriberId: string,
    feature: K,
    count: number = 1,
  ): Promise<void> {
    const canUseMore = await this.canUse(subscriberId, feature, count);
    if (!canUseMore) {
      const status = await this.remaining(subscriberId, feature);
      throw new UsageLimitExceededError(
        feature as string,
        status.limit as number,
        status.used,
      );
    }
  }

  /**
   * Get all usage stats for a subscriber
   */
  async getAllUsage(
    subscriberId: string,
  ): Promise<Record<string, UsageStatus>> {
    const result: Record<string, UsageStatus> = {};

    for (const feature of Object.keys(this.features)) {
      const definition = this.features[feature];
      if (definition && isLimitFeature(definition)) {
        result[feature] = await this.remaining(
          subscriberId,
          feature as keyof TFeatures,
        );
      }
    }

    return result;
  }

  // ==================== Private Helpers ====================

  private validateSubscriptionActive(
    subscription: SubscriptionWithPlan<TFeatures>,
  ): void {
    const now = new Date();

    if (subscription.status === "trialing") {
      const trialEnd = subscription.trialEnd ?? subscription.currentPeriodEnd;
      if (now >= trialEnd) {
        throw new SubscriptionInactiveError("expired");
      }
    }

    if (subscription.cancelAt && now >= subscription.cancelAt) {
      throw new SubscriptionInactiveError("canceled");
    }

    const validStatuses = ["active", "trialing", "past_due"];
    if (!validStatuses.includes(subscription.status)) {
      throw new SubscriptionInactiveError(subscription.status);
    }

    const endDate = subscription.currentPeriodEnd;
    const graceEnd = new Date(
      endDate.getTime() + this.gracePeriodDays * 24 * 60 * 60 * 1000,
    );

    if (now > graceEnd) {
      throw new SubscriptionInactiveError("expired");
    }
  }
}
