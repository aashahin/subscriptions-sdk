// file: packages/subscriptions/src/testing/memory-cache.ts
// In-memory CacheAdapter for tests, examples, and local development

import type { CacheAdapter } from '../adapters/cache.adapter.js';

/**
 * Stored cache entry with an absolute expiry timestamp (ms since epoch),
 * or null when the entry never expires.
 */
interface CacheEntry {
    value: unknown;
    expiresAt: number | null;
}

/**
 * Create a fully in-memory {@link CacheAdapter}.
 *
 * Supports TTL expiry, `deletePattern` with glob patterns (`*` matches any
 * run of characters, e.g. `'sub:tenant:*'`), atomic `incrBy`/`decrBy`, and
 * `exists`. Useful for unit tests and as a reference implementation when
 * building a custom cache adapter (e.g. backed by Redis or Workers KV).
 *
 * @example
 * ```typescript
 * import { memoryCacheAdapter } from '@abshahin/subscriptions/testing';
 *
 * const subs = createSubscriptions({
 *   database,
 *   features,
 *   cache: memoryCacheAdapter(),
 * });
 * ```
 */
export function memoryCacheAdapter(): CacheAdapter {
    const store = new Map<string, CacheEntry>();

    /**
     * Read a live entry, evicting it lazily when expired.
     */
    const read = (key: string): CacheEntry | undefined => {
        const entry = store.get(key);
        if (!entry) {
            return undefined;
        }
        if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
            store.delete(key);
            return undefined;
        }
        return entry;
    };

    return {
        async get<T>(key: string): Promise<T | null> {
            const entry = read(key);
            return entry ? (entry.value as T) : null;
        },

        async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
            store.set(key, {
                value,
                expiresAt:
                    ttlSeconds !== undefined ? Date.now() + ttlSeconds * 1000 : null,
            });
        },

        async delete(key: string): Promise<void> {
            store.delete(key);
        },

        async deletePattern(pattern: string): Promise<void> {
            const regex = globToRegExp(pattern);
            for (const key of store.keys()) {
                if (regex.test(key)) {
                    store.delete(key);
                }
            }
        },

        async incrBy(key: string, count: number): Promise<number> {
            const entry = read(key);
            const current = typeof entry?.value === 'number' ? entry.value : 0;
            const next = current + count;
            store.set(key, { value: next, expiresAt: entry?.expiresAt ?? null });
            return next;
        },

        async decrBy(key: string, count: number): Promise<number> {
            const entry = read(key);
            const current = typeof entry?.value === 'number' ? entry.value : 0;
            const next = current - count;
            store.set(key, { value: next, expiresAt: entry?.expiresAt ?? null });
            return next;
        },

        async exists(key: string): Promise<boolean> {
            return read(key) !== undefined;
        },
    };
}

/**
 * Convert a glob pattern (where `*` matches any run of characters) into an
 * anchored RegExp. All other regex metacharacters are escaped.
 */
function globToRegExp(pattern: string): RegExp {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (char) =>
        char === '*' ? '.*' : `\\${char}`,
    );
    return new RegExp(`^${escaped}$`);
}
