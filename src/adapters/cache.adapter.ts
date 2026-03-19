// file: packages/subscriptions/src/adapters/cache.adapter.ts
// Cache adapter interface for subscriptions package

/**
 * Cache adapter interface
 *
 * Implement this interface to enable caching for subscription/permission lookups.
 * Caching is optional but recommended for performance.
 */
export interface CacheAdapter {
    /**
     * Get a value from cache
     * @returns The cached value or null if not found/expired
     */
    get<T>(key: string): Promise<T | null>;

    /**
     * Set a value in cache
     * @param key - Cache key
     * @param value - Value to cache
     * @param ttlSeconds - Time to live in seconds (optional)
     */
    set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;

    /**
     * Delete a value from cache
     */
    delete(key: string): Promise<void>;

    /**
     * Delete all values matching a pattern
     * @param pattern - Key pattern (e.g., 'sub:tenant:*')
     */
    deletePattern?(pattern: string): Promise<void>;

    /**
     * Atomically increment a numeric value
     * @returns The new value after increment
     */
    incrBy?(key: string, count: number): Promise<number>;

    /**
     * Atomically decrement a numeric value
     * @returns The new value after decrement
     */
    decrBy?(key: string, count: number): Promise<number>;

    /**
     * Check if a key exists
     */
    exists?(key: string): Promise<boolean>;
}

/**
 * Create cache keys for subscription data
 */
export const CacheKeys = {
    subscription: (subscriberId: string) => `sub:${subscriberId}`,
    plan: (planId: string) => `plan:${planId}`,
    plans: () => 'plans:all',
    activePlans: () => 'plans:active',
    features: (subscriberId: string) => `features:${subscriberId}`,
    usage: (subscriberId: string, feature: string) => `usage:${subscriberId}:${feature}`,
    usageAll: (subscriberId: string) => `usage:${subscriberId}:*`,
} as const;

/**
 * No-op cache adapter for when caching is disabled
 */
export const noopCacheAdapter: CacheAdapter = {
    get: async () => null,
    set: async () => { },
    delete: async () => { },
};
