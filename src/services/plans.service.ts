// file: packages/subscriptions/src/services/plans.service.ts
// Plans service for CRUD operations on subscription plans

import type {
    Plan,
    CreatePlanInput,
    UpdatePlanInput,
    FeatureRegistry,
    FeatureValues,
} from '../core/types';
import type { DatabaseAdapter, PlanQueryOptions } from '../adapters/database.adapter';
import type { CacheAdapter } from '../adapters/cache.adapter';
import { CacheKeys, noopCacheAdapter } from '../adapters/cache.adapter';
import { PlanNotFoundError, InvalidPlanError } from '../core/errors';
import { resolveFeatures, validatePlanFeatures, getFeatureValue } from '../core/features';

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
}

export class PlansService<TFeatures extends FeatureRegistry> {
    private readonly cache: CacheAdapter;
    private readonly defaultCurrency: string;
    private readonly cacheTtl: number;

    constructor(
        private readonly db: DatabaseAdapter<TFeatures>,
        private readonly features: TFeatures,
        cache?: CacheAdapter,
        options?: PlansServiceOptions,
    ) {
        this.cache = cache ?? noopCacheAdapter;
        this.defaultCurrency = options?.defaultCurrency ?? 'USD';
        this.cacheTtl = options?.cacheTtlSeconds ?? 300;
    }

    /**
     * List all plans
     */
    async list(options?: { activeOnly?: boolean }): Promise<Plan<TFeatures>[]> {
        const cacheKey = options?.activeOnly ? CacheKeys.activePlans() : CacheKeys.plans();

        // Try cache first
        const cached = await this.cache.get<Plan<TFeatures>[]>(cacheKey);
        if (cached) {
            return cached;
        }

        const plans = await this.db.plans.findAll(options);

        // Cache the result
        await this.cache.set(cacheKey, plans, this.cacheTtl);

        return plans;
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
        const cacheKey = CacheKeys.plan(id);

        // Try cache first
        const cached = await this.cache.get<Plan<TFeatures>>(cacheKey);
        if (cached) {
            return cached;
        }

        const plan = await this.db.plans.findById(id);
        if (!plan) {
            throw new PlanNotFoundError(id);
        }

        // Cache the result
        await this.cache.set(cacheKey, plan, this.cacheTtl);

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

        const plan = await this.db.plans.create({
            ...data,
            currency: data.currency ?? this.defaultCurrency,
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

        const plan = await this.db.plans.update(id, data);

        // Invalidate caches
        await this.cache.delete(CacheKeys.plan(id));
        await this.invalidateListCaches();

        return plan;
    }

    /**
     * Delete a plan
     */
    async delete(id: string): Promise<void> {
        // Ensure plan exists
        await this.get(id);

        await this.db.plans.delete(id);

        // Invalidate caches
        await this.cache.delete(CacheKeys.plan(id));
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
        await this.cache.delete(CacheKeys.plans());
        await this.cache.delete(CacheKeys.activePlans());
    }
}
