// file: packages/subscriptions/src/adapters/upstash.adapter.ts
// Upstash Redis (REST) cache adapter implementation for @abshahin/subscriptions

import type { CacheAdapter } from "./cache.adapter.js";

/**
 * Options for the Upstash cache adapter
 */
export interface UpstashCacheAdapterOptions {
    /**
     * Upstash Redis REST URL (e.g., 'https://xxx.upstash.io')
     */
    url: string;

    /**
     * Upstash Redis REST token
     */
    token: string;

    /**
     * Custom fetch implementation (defaults to global fetch)
     *
     * Useful for runtimes without global fetch or for testing.
     */
    fetch?: typeof fetch;
}

/**
 * Upstash REST API response envelope
 * @see https://upstash.com/docs/redis/features/restapi
 */
type UpstashResponse<T> =
    | { result: T; error?: never }
    | { result?: never; error: string };

/**
 * Create a cache adapter backed by Upstash Redis via its REST API
 *
 * Uses plain `fetch` against the Upstash REST endpoint, so it is edge-safe
 * (Cloudflare Workers, Deno, Bun, Node 18+) and requires no npm dependency.
 *
 * @example
 * ```ts
 * const cache = upstashCacheAdapter({
 *     url: process.env.UPSTASH_REDIS_REST_URL!,
 *     token: process.env.UPSTASH_REDIS_REST_TOKEN!,
 * });
 * ```
 */
export function upstashCacheAdapter(options: UpstashCacheAdapterOptions): CacheAdapter {
    const baseUrl = options.url.replace(/\/+$/, "");
    const headers = {
        Authorization: `Bearer ${options.token}`,
        "Content-Type": "application/json",
    };

    const getFetch = (): typeof fetch => {
        const f = options.fetch ?? globalThis.fetch;
        if (typeof f !== "function") {
            throw new Error(
                "upstashCacheAdapter: no fetch implementation available. " +
                "Use a runtime with global fetch (Node 18+, Bun, Deno, Workers) or pass a custom `fetch` option."
            );
        }
        return f;
    };

    /**
     * Execute a Redis command via the Upstash REST API
     * @param command - Command parts, e.g. ['SET', key, value, 'EX', 60]
     * @returns The `result` field of the Upstash response envelope
     */
    const command = async <T>(command: unknown[]): Promise<T> => {
        let response: Response;
        try {
            response = await getFetch()(baseUrl, {
                method: "POST",
                headers,
                body: JSON.stringify(command),
            });
        } catch (error) {
            throw new Error(
                `upstashCacheAdapter: request to Upstash REST API failed: ${(error as Error).message}`
            );
        }

        const envelope = (await response.json().catch(() => null)) as UpstashResponse<T> | null;
        if (!response.ok || !envelope || envelope.error) {
            throw new Error(
                `upstashCacheAdapter: Upstash Redis error: ${envelope?.error ?? `HTTP ${response.status}`}`
            );
        }
        return envelope.result as T;
    };

    return {
        async get<T>(key: string): Promise<T | null> {
            const result = await command<string | null>(["GET", key]);
            if (result === null) return null;
            try {
                return JSON.parse(result) as T;
            } catch {
                return result as T;
            }
        },

        async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
            const serialized = JSON.stringify(value);
            if (ttlSeconds !== undefined) {
                await command<string>(["SET", key, serialized, "EX", Math.max(1, Math.floor(ttlSeconds))]);
            } else {
                await command<string>(["SET", key, serialized]);
            }
        },

        async delete(key: string): Promise<void> {
            await command<number>(["DEL", key]);
        },

        async deletePattern(pattern: string): Promise<void> {
            let cursor = "0";
            do {
                // SCAN returns [nextCursor, keys[]]
                const [nextCursor, keys] = await command<[string | number, string[]]>([
                    "SCAN", cursor, "MATCH", pattern, "COUNT", 100,
                ]);
                if (keys.length > 0) {
                    await command<number>(["DEL", ...keys]);
                }
                cursor = String(nextCursor);
            } while (cursor !== "0");
        },

        async incrBy(key: string, count: number): Promise<number> {
            return command<number>(["INCRBY", key, count]);
        },

        async decrBy(key: string, count: number): Promise<number> {
            return command<number>(["DECRBY", key, count]);
        },

        async exists(key: string): Promise<boolean> {
            const result = await command<number>(["EXISTS", key]);
            return result > 0;
        },
    };
}
