// file: packages/subscriptions/src/adapters/redis.adapter.ts
// Redis cache adapter implementation for @abshahin/subscriptions

import type { CacheAdapter } from "./cache.adapter.js";

/**
 * Structural type for an ioredis-compatible client.
 *
 * Any client exposing these methods works — ioredis, ioredis-mock,
 * or a custom wrapper around another Redis driver.
 */
export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  scan(
    cursor: string | number,
    ...args: unknown[]
  ): Promise<[string, string[]]>;
  incrby(key: string, increment: number): Promise<number>;
  decrby(key: string, decrement: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  pipeline?(commands: unknown[][]): {
    exec(): Promise<[Error | null, unknown][]>;
  };
  disconnect?(): void;
}

/**
 * Connection options for creating a new ioredis client.
 * Mirrors the most common ioredis constructor shapes.
 */
export interface RedisAdapterOptions {
  /**
   * Redis connection URL (e.g. 'redis://localhost:6379')
   * or a port number. Defaults to ioredis defaults (localhost:6379).
   */
  url?: string;
  /**
   * Additional ioredis options passed to the constructor.
   * Typed loosely to avoid a hard dependency on ioredis types.
   */
  options?: Record<string, unknown>;
}

/**
 * Redis cache adapter for the subscriptions package
 *
 * Wraps an ioredis client. JSON-serializes values, supports TTL,
 * atomic counters, and pattern deletion via SCAN + MATCH.
 *
 * Accepts either an existing client (recommended — you own the
 * connection lifecycle) or connection options, in which case the
 * `ioredis` package is lazy-loaded.
 *
 * @example
 * ```typescript
 * import { redisCacheAdapter } from '@abshahin/subscriptions/adapters/redis';
 * import Redis from 'ioredis';
 *
 * // With an existing client
 * const cache = redisCacheAdapter(new Redis());
 *
 * // Or with connection options (lazy-loads ioredis)
 * const cache = redisCacheAdapter({ url: process.env.REDIS_URL });
 *
 * const subs = createSubscriptions({
 *   database: prismaAdapter(db),
 *   cache,
 *   features: { ... },
 * });
 * ```
 */
export function redisCacheAdapter(
  redisOrOptions: RedisLikeClient | RedisAdapterOptions = {},
): CacheAdapter {
  let clientPromise: Promise<RedisLikeClient> | null = null;

  /**
   * Resolve the Redis client, lazy-importing ioredis only when
   * connection options were given instead of a client instance.
   */
  const resolveClient = (): Promise<RedisLikeClient> => {
    if (isRedisLikeClient(redisOrOptions)) {
      return Promise.resolve(redisOrOptions);
    }
    if (!clientPromise) {
      clientPromise = (async () => {
        let RedisCtor: new (
          url?: string | number,
          options?: Record<string, unknown>,
        ) => RedisLikeClient;
        try {
          // Optional peer dependency — resolved at runtime only
          // @ts-ignore -- ioredis may not be installed in this workspace
          const mod = await import("ioredis");
          RedisCtor = (mod.default ?? mod) as unknown as typeof RedisCtor;
        } catch {
          throw new Error(
            "redisCacheAdapter: the 'ioredis' package is required when passing connection options. " +
              "Install it with `npm install ioredis`, or pass an existing Redis client instead.",
          );
        }
        const { url, options } = redisOrOptions;
        return new RedisCtor(url, options);
      })();
    }
    return clientPromise;
  };

  return {
    async get<T>(key: string): Promise<T | null> {
      const client = await resolveClient();
      const raw = await client.get(key);
      if (raw === null) {
        return null;
      }
      try {
        return JSON.parse(raw) as T;
      } catch {
        // Corrupted or non-JSON value — treat as a cache miss
        return null;
      }
    },

    async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
      const client = await resolveClient();
      const serialized = JSON.stringify(value);
      if (ttlSeconds && ttlSeconds > 0) {
        await client.set(key, serialized, "EX", ttlSeconds);
      } else {
        await client.set(key, serialized);
      }
    },

    async delete(key: string): Promise<void> {
      const client = await resolveClient();
      await client.del(key);
    },

    async deletePattern(pattern: string): Promise<void> {
      const client = await resolveClient();
      let cursor = "0";
      do {
        const [nextCursor, keys] = await client.scan(
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          "100",
        );
        cursor = nextCursor;
        if (keys.length > 0) {
          if (client.pipeline) {
            const pipeline = client.pipeline(keys.map((key) => ["del", key]));
            await pipeline.exec();
          } else {
            await client.del(...keys);
          }
        }
      } while (cursor !== "0");
    },

    async incrBy(key: string, count: number): Promise<number> {
      const client = await resolveClient();
      return client.incrby(key, count);
    },

    async decrBy(key: string, count: number): Promise<number> {
      const client = await resolveClient();
      return client.decrby(key, count);
    },

    async exists(key: string): Promise<boolean> {
      const client = await resolveClient();
      return (await client.exists(key)) > 0;
    },
  };
}

/**
 * Type guard: a value is a RedisLikeClient when it exposes the
 * core Redis command methods the adapter relies on.
 */
function isRedisLikeClient(
  value: RedisLikeClient | RedisAdapterOptions,
): value is RedisLikeClient {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RedisLikeClient).get === "function" &&
    typeof (value as RedisLikeClient).set === "function" &&
    typeof (value as RedisLikeClient).del === "function" &&
    typeof (value as RedisLikeClient).scan === "function" &&
    typeof (value as RedisLikeClient).incrby === "function" &&
    typeof (value as RedisLikeClient).decrby === "function" &&
    typeof (value as RedisLikeClient).expire === "function"
  );
}
