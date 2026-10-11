// file: packages/subscriptions/src/services/plans.service.ts
// Plans service for CRUD operations on subscription plans

import type { CacheAdapter } from '../adapters/cache.adapter.js';
import { CacheKeys, noopCacheAdapter } from '../adapters/cache.adapter.js';
import type { DatabaseAdapter, PlanQueryOptions } from '../adapters/database.adapter.js';
import { InvalidPlanError, PlanNotFoundError, SubscriptionError } from '../core/errors.js';
import { getFeatureValue, resolveFeatures, validatePlanFeatures } from '../core/features.js';
import type {
    CreatePlanInput,
    FeatureRegistry,
    FeatureValues,
    Plan,
    PlanPrice,
    UpdatePlanInput,
} from '../core/types.js';

export interface PlansServiceOptions {
    /**
     * Default currency for new plans
     * @default 'USD'
     */
    defaultCurrency?: string;

    /**
     * Cache TTL in seconds
     * @default 300
     */
    cacheTtlSeconds?: number;
    /** Identify the application, database and environment when caching is enabled. */
    cacheNamespace?: string;
}

export class PlansService<TFeatures extends FeatureRegistry> {
    private readonly cache: CacheAdapter;
    private readonly defaultCurrency: string;
    private readonly cacheNamespace: string;

    constructor(
        private readonly db: DatabaseAdapter<TFeatures>,
        private readonly features: TFeatures,
        cache?: CacheAdapter,
        options?: PlansServiceOptions,
    ) {
        if (cache && cache !== noopCacheAdapter && !options?.cacheNamespace?.trim()) {
            throw new SubscriptionError('A cacheNamespace is required when caching is enabled', 'CACHE_NAMESPACE_REQUIRED');
        }
        this.cache = cache ?? noopCacheAdapter;
        this.defaultCurrency = options?.defaultCurrency ?? 'USD';
        this.cacheNamespace = options?.cacheNamespace?.trim() ?? 'uncached';
    }

    /**
     * List all plans
     */
    async list(options?: { activeOnly?: boolean }): Promise<Plan<TFeatures>[]> {
        // Plan activation, pricing and entitlement updates must be authoritative.
        // Adapter-level revision lookups would be required to safely cache these reads.
        return this.db.plans.findAll(options);
    }

    /**
     * List all plans with advanced filtering for admin dashboard.
     * Does NOT use cache - always returns fresh data.
     */
    async listForAdmin(options?: PlanQueryOptions): Promise<{ plans: Plan<TFeatures>[]; total: number }> {
        return this.db.plans.findAllForAdmin(options);
    }

    /**
     * Get a plan by ID
     */
    async get(id: string): Promise<Plan<TFeatures>> {
        const plan = await this.db.plans.findById(id);
        if (!plan) {
            throw new PlanNotFoundError(id);
        }

        return plan;
    }

    /**
     * Create a new plan
     */
    async create(data: CreatePlanInput<TFeatures>): Promise<Plan<TFeatures>> {
        // Validate features if provided
        if (data.features) {
            const validation = validatePlanFeatures(this.features, data.features);
            if (!validation.valid) {
                throw new InvalidPlanError(`Invalid features: ${validation.errors.join(', ')}`);
            }
        }

        const plan = await this.mutate(async tx => {
            const created = await tx.plans.create({
                ...data,
                currency: data.currency ?? this.defaultCurrency,
            });
            await this.recordEvent(tx, `plan.created:${created.id}`, 'plan.created', { planId: created.id, name: created.name });
            return created;
        });

        // Invalidate list caches
        await this.invalidateListCaches();

        return plan;
    }

    /**
     * Update an existing plan
     */
    async update(id: string, data: UpdatePlanInput<TFeatures>): Promise<Plan<TFeatures>> {
        // Ensure plan exists
        await this.get(id);

        // Validate features if provided
        if (data.features) {
            const validation = validatePlanFeatures(this.features, data.features);
            if (!validation.valid) {
                throw new InvalidPlanError(`Invalid features: ${validation.errors.join(', ')}`);
            }
        }

        const eventId = `plan.updated:${id}:${crypto.randomUUID()}`;
        const plan = await this.mutate(async tx => {
            const updated = await tx.plans.update(id, data);
            await this.recordEvent(tx, eventId, 'plan.updated', { planId: id, name: updated.name });
            return updated;
        });

        // Invalidate caches
        await this.invalidateCache(CacheKeys.plan(id));
        await this.invalidateListCaches();

        return plan;
    }

    /**
     * Delete a plan
     */
    async delete(id: string): Promise<void> {
        // Ensure plan exists
        await this.get(id);

        // Prevent deletion if plan has active subscribers
        await this.mutate(async tx => {
            const hasSubscribers = await tx.plans.hasActiveSubscribers(id);
            const hasPendingDowngrades = await tx.plans.hasPendingDowngrades(id);
            if (hasSubscribers || hasPendingDowngrades) {
                throw new InvalidPlanError('Cannot delete plan with active or pending subscribers. Deactivate it instead.');
            }
            await tx.plans.delete(id);
            await this.recordEvent(tx, `plan.deleted:${id}`, 'plan.deleted', { planId: id });
        });

        // Invalidate caches
        await this.invalidateCache(CacheKeys.plan(id));
        await this.invalidateListCaches();
    }

    /**
     * Duplicate a plan with optional overrides
     */
    async duplicate(
        id: string,
        overrides?: Partial<CreatePlanInput<TFeatures>>,
    ): Promise<Plan<TFeatures>> {
        const original = await this.get(id);

        const newPlan = await this.create({
            name: `${original.name} (Copy)`,
            description: original.description,
            price: original.price,
            currency: original.currency,
            interval: original.interval,
            intervalCount: original.intervalCount,
            features: original.features,
            isActive: false, // Duplicates start inactive
            sortOrder: original.sortOrder + 1,
            ...overrides,
        });

        return newPlan;
    }

    /**
     * Get the price of a plan in a specific currency.
     *
     * Returns the plan's canonical `price` when `currency` matches
     * `plan.currency`; otherwise looks up the additional `prices` price
     * points. Returns null when the plan has no price in that currency.
     * Currency matching is case-insensitive.
     */
    getPrice(
        plan: Plan<TFeatures>,
        currency: string,
    ): PlanPrice | null {
        const normalized = currency.toUpperCase();

        if (plan.currency.toUpperCase() === normalized) {
            return { currency: plan.currency, amount: plan.price };
        }

        const pricePoint = plan.prices?.find(
            (p) => p.currency.toUpperCase() === normalized,
        );

        return pricePoint ?? null;
    }

    /**
     * Get the resolved value of a specific feature for a plan
     */
    getFeatureValue<K extends keyof TFeatures>(
        plan: Plan<TFeatures>,
        feature: K,
    ): TFeatures[K]['type'] extends 'boolean' ? boolean : number {
        return getFeatureValue(this.features, plan.features, feature) as any;
    }

    /**
     * Get all resolved feature values for a plan
     */
    getResolvedFeatures(plan: Plan<TFeatures>): FeatureValues<TFeatures> {
        return resolveFeatures(this.features, plan.features);
    }

    /**
     * Compare features between two plans
     */
    compareFeatures(
        planA: Plan<TFeatures>,
        planB: Plan<TFeatures>,
    ): Record<keyof TFeatures, { planA: unknown; planB: unknown; diff: 'same' | 'upgrade' | 'downgrade' }> {
        const featuresA = this.getResolvedFeatures(planA);
        const featuresB = this.getResolvedFeatures(planB);

        const comparison = {} as Record<keyof TFeatures, { planA: unknown; planB: unknown; diff: 'same' | 'upgrade' | 'downgrade' }>;

        for (const key of Object.keys(this.features) as (keyof TFeatures)[]) {
            const valueA = featuresA[key];
            const valueB = featuresB[key];

            let diff: 'same' | 'upgrade' | 'downgrade' = 'same';

            if (valueA !== valueB) {
                if (typeof valueA === 'boolean') {
                    diff = valueB ? 'upgrade' : 'downgrade';
                } else if (typeof valueA === 'number') {
                    diff = (valueB as number) > valueA ? 'upgrade' : 'downgrade';
                }
            }

            comparison[key] = { planA: valueA, planB: valueB, diff };
        }

        return comparison;
    }

    private async invalidateListCaches(): Promise<void> {
        await this.invalidateCache(CacheKeys.plans());
        await this.invalidateCache(CacheKeys.activePlans());
    }

    private mutate<T>(operation: (tx: DatabaseAdapter<TFeatures>) => Promise<T>): Promise<T> {
        return this.db.capabilities?.asyncTransactions ? this.db.transaction(operation) : operation(this.db);
    }

    private async recordEvent(tx: DatabaseAdapter<TFeatures>, id: string, type: string,
        data: Record<string, unknown>): Promise<void> {
        // Never claim durable event guarantees for an adapter without rollback.
        if (tx.capabilities?.asyncTransactions && tx.outbox) {
            await tx.outbox.insert({ id, type, data, occurredAt: new Date() });
        }
    }

    private async invalidateCache(key: string): Promise<void> {
        try { await this.cache.delete(`${this.cacheNamespace}:${key}`); } catch {
            // A cache outage cannot turn a committed plan mutation into a failed operation.
        }
    }
}
