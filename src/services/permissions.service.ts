// Permissions service for feature gates and durable usage limits.
import type { CacheAdapter } from "../adapters/cache.adapter.js";
import { CacheKeys, noopCacheAdapter } from "../adapters/cache.adapter.js";
import type { DatabaseAdapter } from "../adapters/database.adapter.js";
import { FeatureNotAllowedError, SubscriptionError, SubscriptionInactiveError, UsageLimitExceededError } from "../core/errors.js";
import { resolveFeatures } from "../core/features.js";
import type { FeatureDefinition, FeatureRegistry, FeatureValues, SubscriptionWithPlan, UsageStatus } from "../core/types.js";

const UNLIMITED = -1;
interface UsagePeriod { periodStart: Date; periodEnd: Date }
interface EntitlementEnvelope<TFeatures extends FeatureRegistry> {
  version: string;
  validUntil: number;
  values: FeatureValues<TFeatures>;
}
interface EntitlementContext<TFeatures extends FeatureRegistry> {
  subscription: SubscriptionWithPlan<TFeatures> | null;
  values: FeatureValues<TFeatures>;
}

export interface PermissionsServiceOptions {
  cacheTtlSeconds?: number;
  /** Required with a real cache; identify the application, database and environment. */
  cacheNamespace?: string;
  gracePeriodDays?: number;
}

export class PermissionsService<TFeatures extends FeatureRegistry> {
  private readonly cache: CacheAdapter;
  private readonly cacheTtl: number;
  private readonly gracePeriodDays: number;
  private readonly cacheNamespace: string;

  constructor(private readonly db: DatabaseAdapter<TFeatures>, private readonly features: TFeatures,
    cache?: CacheAdapter, options?: PermissionsServiceOptions) {
    if (cache && cache !== noopCacheAdapter && !options?.cacheNamespace?.trim()) {
      throw new SubscriptionError("A cacheNamespace is required when caching is enabled", "CACHE_NAMESPACE_REQUIRED");
    }
    this.cache = cache ?? noopCacheAdapter;
    this.cacheNamespace = options?.cacheNamespace?.trim() ?? "uncached";
    this.cacheTtl = options?.cacheTtlSeconds ?? 300;
    this.gracePeriodDays = options?.gracePeriodDays ?? 0;
    if (!Number.isFinite(this.gracePeriodDays) || this.gracePeriodDays < 0) {
      throw new SubscriptionError("gracePeriodDays must be finite and nonnegative", "INVALID_GRACE_PERIOD");
    }
  }

  async can<K extends keyof TFeatures>(subscriberId: string, feature: K): Promise<boolean> {
    const definition = this.features[feature];
    if (!definition) return false;
    const context = await this.entitlements(subscriberId);
    if (definition.type === "boolean") return context.values[feature] as boolean;
    if (definition.type === "rate") return (context.values[feature] as number) > 0;
    if (definition.type === "metered") return context.subscription !== null;
    const status = await this.status(subscriberId, feature, definition, context);
    return status.unlimited || status.remaining > 0;
  }

  async remaining<K extends keyof TFeatures>(subscriberId: string, feature: K): Promise<UsageStatus> {
    const definition = this.usageFeature(feature);
    return this.status(subscriberId, feature, definition, await this.entitlements(subscriberId));
  }

  async canUse<K extends keyof TFeatures>(subscriberId: string, feature: K, count = 1): Promise<boolean> {
    this.validateQuantity(count);
    const definition = this.usageFeature(feature);
    const context = await this.entitlements(subscriberId);
    if (definition.type === "metered") return context.subscription !== null;
    const status = await this.status(subscriberId, feature, definition, context);
    return status.unlimited || status.remaining >= count;
  }

  /** Admit consumption in one durable conditional mutation. Cache errors cannot undo it. */
  async use<K extends keyof TFeatures>(subscriberId: string, feature: K, count = 1): Promise<UsageStatus> {
    this.validateQuantity(count);
    const definition = this.usageFeature(feature);
    const context = await this.entitlements(subscriberId);
    if (definition.type === "metered" && !context.subscription) throw new SubscriptionInactiveError("missing");
    const limit = this.usageLimit(context.values[feature] as number, definition);
    const period = this.period(definition, context.subscription);
    const capped = definition.type !== "metered" && limit !== UNLIMITED;
    let used: number;
    if (this.db.usage.reserve) {
      const eventId = `usage.limit_reached:${crypto.randomUUID()}`;
      const reserve = async (tx: DatabaseAdapter<TFeatures>): Promise<number> => {
        const reservation = await tx.usage.reserve!(subscriberId, feature as string, {
          count, limit: capped ? limit : null, ...period,
        });
        if (!reservation.accepted) {
          throw new UsageLimitExceededError(feature as string, capped ? limit : Number.MAX_SAFE_INTEGER, reservation.count);
        }
        if (capped && reservation.count === limit && tx.capabilities?.asyncTransactions && tx.outbox) {
          await tx.outbox.insert({ id: eventId, type: 'usage.limit_reached', subscriberId,
            data: { feature: feature as string, used: reservation.count, limit, periodStart: period.periodStart },
            occurredAt: new Date() });
        }
        return reservation.count;
      };
      used = this.db.capabilities?.asyncTransactions && this.db.outbox
        ? await this.db.transaction(reserve) : await reserve(this.db);
    } else {
      // A capped reservation cannot safely be emulated by incrementing and compensating.
      if (capped) throw new SubscriptionError("Capped usage requires atomic usage.reserve support", "ATOMIC_USAGE_NOT_SUPPORTED", 501);
      used = await this.db.usage.increment(subscriberId, feature as string, { count, ...period });
    }
    await this.invalidateUsage(subscriberId, feature as string);
    return this.usageStatus(feature as string, limit, used, definition.type === "metered");
  }

  async release<K extends keyof TFeatures>(subscriberId: string, feature: K, count = 1): Promise<UsageStatus> {
    this.validateQuantity(count);
    const definition = this.usageFeature(feature);
    const context = await this.entitlements(subscriberId);
    const limit = this.usageLimit(context.values[feature] as number, definition);
    const used = await this.db.usage.decrement(subscriberId, feature as string, {
      count, ...this.period(definition, context.subscription),
    });
    await this.invalidateUsage(subscriberId, feature as string);
    return this.usageStatus(feature as string, limit, used, definition.type === "metered");
  }

  async setUsage<K extends keyof TFeatures>(subscriberId: string, feature: K, count: number): Promise<void> {
    this.validateQuantity(count, true);
    const definition = this.usageFeature(feature);
    const context = await this.entitlements(subscriberId);
    await this.db.usage.set(subscriberId, feature as string, count, undefined, this.period(definition, context.subscription));
    await this.invalidateUsage(subscriberId, feature as string);
  }

  /** Reset the selected current period. Inventory gauges need an explicit feature. */
  async resetUsage(subscriberId: string, feature?: keyof TFeatures): Promise<void> {
    const context = await this.entitlements(subscriberId);
    const keys = feature === undefined ? Object.keys(this.features) : [feature];
    for (const key of keys) {
      const definition = this.features[key];
      if (!definition || (definition.type !== "limit" && definition.type !== "metered")) {
        if (feature !== undefined) this.usageFeature(feature);
        continue;
      }
      if (feature === undefined && definition.usage?.kind === "persistent") continue;
      await this.db.usage.reset(subscriberId, { feature: key as string, ...this.period(definition, context.subscription) });
      await this.invalidateUsage(subscriberId, key as string);
    }
  }

  async getFeatures(subscriberId: string): Promise<FeatureValues<TFeatures>> {
    return (await this.entitlements(subscriberId)).values;
  }

  async getLimit<K extends keyof TFeatures>(subscriberId: string, feature: K): Promise<number> {
    this.usageFeature(feature);
    return (await this.getFeatures(subscriberId))[feature] as number;
  }

  async getRate<K extends keyof TFeatures>(subscriberId: string, feature: K): Promise<number> {
    if (this.features[feature]?.type !== "rate") throw new SubscriptionError(`Feature "${String(feature)}" is not a rate`, "INVALID_USAGE_FEATURE");
    return (await this.getFeatures(subscriberId))[feature] as number;
  }

  async assertCan<K extends keyof TFeatures>(subscriberId: string, feature: K, planName?: string): Promise<void> {
    if (!await this.can(subscriberId, feature)) throw new FeatureNotAllowedError(feature as string, planName);
  }

  async assertCanUse<K extends keyof TFeatures>(subscriberId: string, feature: K, count = 1): Promise<void> {
    if (!await this.canUse(subscriberId, feature, count)) {
      const status = await this.remaining(subscriberId, feature);
      throw new UsageLimitExceededError(feature as string, status.limit, status.used);
    }
  }

  async getAllUsage(subscriberId: string): Promise<Record<string, UsageStatus>> {
    const result: Record<string, UsageStatus> = {};
    for (const [feature, definition] of Object.entries(this.features)) {
      if (definition.type === "limit" || definition.type === "metered") result[feature] = await this.remaining(subscriberId, feature as keyof TFeatures);
    }
    return result;
  }

  private async entitlements(subscriberId: string): Promise<EntitlementContext<TFeatures>> {
    // Eligibility is authoritative even when an external cache ignores its TTL.
    const subscription = await this.db.subscriptions.findBySubscriber(subscriberId);
    if (!subscription) return { subscription: null, values: resolveFeatures(this.features, null) };
    const validUntil = this.validateSubscriptionActive(subscription);
    const values = resolveFeatures(this.features, subscription.plan.features);
    // Resolved values also detect rapid plan writes sharing an updatedAt timestamp.
    const version = JSON.stringify([subscription.id, subscription.planId, subscription.status,
      subscription.currentPeriodStart, subscription.currentPeriodEnd, subscription.trialEnd,
      subscription.cancelAt, subscription.plan.updatedAt, values]);
    const key = this.key(CacheKeys.features(subscriberId));
    let cached: EntitlementEnvelope<TFeatures> | null = null;
    try { cached = await this.cache.get<EntitlementEnvelope<TFeatures>>(key); } catch { /* Cache is optional. */ }
    if (cached?.version === version && cached.validUntil > Date.now()) return { subscription, values: cached.values };
    const ttl = Math.min(this.cacheTtl, Math.floor((validUntil - Date.now()) / 1000));
    if (ttl > 0) {
      try { await this.cache.set(key, { version, validUntil, values }, ttl); } catch { /* Durable state wins. */ }
    }
    return { subscription, values };
  }

  private async status<K extends keyof TFeatures>(subscriberId: string, feature: K,
    definition: FeatureDefinition, context: EntitlementContext<TFeatures>): Promise<UsageStatus> {
    const limit = this.usageLimit(context.values[feature] as number, definition);
    const used = await this.db.usage.get(subscriberId, feature as string, this.period(definition, context.subscription));
    return this.usageStatus(feature as string, limit, used, definition.type === "metered");
  }

  private usageStatus(feature: string, limit: number, used: number, metered: boolean): UsageStatus {
    if (!Number.isSafeInteger(used) || used < 0) throw new SubscriptionError("Stored usage must be a nonnegative safe integer", "INVALID_USAGE_VALUE");
    const unlimited = !metered && limit === UNLIMITED;
    return { feature, used, limit: unlimited ? Infinity : limit,
      remaining: unlimited ? Infinity : metered ? limit - used : Math.max(0, limit - used),
      percentage: unlimited ? 0 : limit > 0 ? Math.round(used / limit * 100) : 100, unlimited };
  }

  private usageFeature(feature: keyof TFeatures): FeatureDefinition {
    const definition = this.features[feature];
    if (!definition || (definition.type !== "limit" && definition.type !== "metered")) {
      throw new SubscriptionError(`Feature "${String(feature)}" does not track usage`, "INVALID_USAGE_FEATURE");
    }
    return definition;
  }

  private usageLimit(value: number, definition: FeatureDefinition): number {
    if (!Number.isSafeInteger(value) || value < (definition.type === "metered" ? 0 : -1)) {
      throw new SubscriptionError("Usage limit must be a safe integer (use -1 for unlimited limits)", "INVALID_USAGE_VALUE");
    }
    return value;
  }

  private validateQuantity(count: number, allowZero = false): void {
    if (!Number.isSafeInteger(count) || count < (allowZero ? 0 : 1)) {
      throw new SubscriptionError(`Usage quantity must be a ${allowZero ? "nonnegative" : "positive"} safe integer`, "INVALID_USAGE_VALUE");
    }
  }

  private period(definition: FeatureDefinition, subscription: SubscriptionWithPlan<TFeatures> | null): UsagePeriod {
    if (definition.usage?.kind === "persistent") return { periodStart: new Date(0), periodEnd: new Date("9999-12-31T23:59:59.999Z") };
    if (definition.usage?.kind === "periodic" && definition.usage.reset === "subscription-cycle") {
      if (!subscription) throw new SubscriptionInactiveError("missing");
      return { periodStart: subscription.currentPeriodStart, periodEnd: subscription.currentPeriodEnd };
    }
    const now = new Date();
    return { periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
      periodEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
  }

  private key(key: string): string { return `${this.cacheNamespace}:${key}`; }
  private async invalidateUsage(subscriberId: string, feature: string): Promise<void> {
    try { await this.cache.delete(this.key(CacheKeys.usage(subscriberId, feature))); } catch { /* No accounting rollback. */ }
  }

  private validateSubscriptionActive(subscription: SubscriptionWithPlan<TFeatures>): number {
    const now = Date.now();
    if (!["active", "trialing", "past_due"].includes(subscription.status)) throw new SubscriptionInactiveError(subscription.status);
    const periodEnd = subscription.currentPeriodEnd.getTime();
    const periodStart = subscription.currentPeriodStart.getTime();
    if (!Number.isFinite(periodEnd) || !Number.isFinite(periodStart) || periodEnd <= periodStart) throw new SubscriptionInactiveError("expired");
    let validUntil = periodEnd + this.gracePeriodDays * 86400000;
    if (subscription.status === "trialing") validUntil = Math.min(validUntil, (subscription.trialEnd ?? subscription.currentPeriodEnd).getTime());
    if (subscription.cancelAt) validUntil = Math.min(validUntil, subscription.cancelAt.getTime());
    if (!Number.isFinite(validUntil) || now >= validUntil) throw new SubscriptionInactiveError("expired");
    return validUntil;
  }
}
