// file: packages/subscriptions/src/adapters/cloudflare-kv.adapter.ts
// Cloudflare KV cache adapter implementation for @abshahin/subscriptions

import type { CacheAdapter } from "./cache.adapter.js";

/**
 * Minimal structurally-typed subset of Cloudflare's `KVNamespace`.
 *
 * Defined locally (instead of importing `@cloudflare/workers-types`) so the
 * adapter stays runtime-agnostic and imposes no type dependency on consumers.
 * Any real `KVNamespace` binding satisfies this interface.
 */
export interface MinimalKVNamespace {
    get(key: string, type?: "text" | "json"): Promise<unknown>;
    put(
        key: string,
        value: string,
        options?: { expirationTtl?: number },
    ): Promise<void>;
    delete(key: string): Promise<void>;
    list(options?: {
        prefix?: string;
        cursor?: string;
    }): Promise<{ keys: { name: string }[]; cursor?: string; list_complete?: boolean }>;
}

/**
 * Create a Cloudflare KV cache adapter for the subscriptions package
 *
 * Note: Cloudflare KV is eventually consistent. Writes may take up to ~60s
 * to propagate globally, so cached reads may briefly return stale data.
 *
 * @example
 * ```typescript
 * import { kvCacheAdapter } from '@abshahin/subscriptions/adapters/cloudflare-kv';
 *
 * const subs = createSubscriptions({
 *   // ...
 *   cache: kvCacheAdapter(env.SUBSCRIPTIONS_KV),
 * });
 * ```
 */
export function kvCacheAdapter(namespace: MinimalKVNamespace): CacheAdapter {
    return {
        async get<T>(key: string): Promise<T | null> {
            // Prefer native JSON parsing; fall back to text + JSON.parse for
            // compatibility with non-Workers KV implementations (e.g. some
            // local dev shims) that do not support the 'json' read type.
            try {
                const value = await namespace.get(key, "json");
                return (value as T | null) ?? null;
            } catch {
                const text = (await namespace.get(key, "text")) as string | null;
                if (text === null) return null;
                try {
                    return JSON.parse(text) as T;
                } catch {
                    return text as unknown as T;
                }
            }
        },

        async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
            await namespace.put(key, JSON.stringify(value), {
                // Cloudflare KV enforces a minimum TTL of 60 seconds
                ...(ttlSeconds !== undefined
                    ? { expirationTtl: Math.max(60, Math.floor(ttlSeconds)) }
                    : {}),
            });
        },

        async delete(key: string): Promise<void> {
            await namespace.delete(key);
        },

        async deletePattern(pattern: string): Promise<void> {
            // KV has no glob matching; strip the trailing '*' to get a prefix
            // and delete everything under it, paginating through list().
            const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
            let cursor: string | undefined;
            do {
                const result = await namespace.list(
                    cursor !== undefined ? { prefix, cursor } : { prefix },
                );
                await Promise.all(result.keys.map((k) => namespace.delete(k.name)));
                cursor =
                    result.list_complete === false ? result.cursor : undefined;
            } while (cursor);
        },

        // IMPORTANT: Cloudflare KV does not support atomic increment/decrement.
        // This is a read-modify-write operation and is subject to race
        // conditions under concurrent writes. For high-contention counters
        // (e.g. usage metering), use the database adapter's usage tracking
        // instead of relying on this cache method.
        async incrBy(key: string, count: number): Promise<number> {
            const current = await this.get<number>(key);
            const next = (typeof current === "number" ? current : 0) + count;
            await this.set(key, next);
            return next;
        },

        // See the note on `incrBy` — this is also non-atomic read-modify-write.
        async decrBy(key: string, count: number): Promise<number> {
            const current = await this.get<number>(key);
            const next = (typeof current === "number" ? current : 0) - count;
            await this.set(key, next);
            return next;
        },

        async exists(key: string): Promise<boolean> {
            return (await namespace.get(key)) !== null;
        },
    };
}
