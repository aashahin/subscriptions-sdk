// file: packages/subscriptions/tests/workers-smoke/index.ts
// Minimal Cloudflare Worker smoke test for @abshahin/subscriptions.
//
// Exercises the core, memory database and fake KV through local HTTP routes.
// This is a demonstration fixture, not production authentication or durable billing.
//
// Routes:
//   GET  /can?feature=<key>   -> fixed demo-subscriber feature check
//   POST /webhooks           -> no-provider error path
//
// Run with: bunx wrangler dev --config tests/workers-smoke/wrangler.toml

import { createSubscriptions, defineFeatures } from "../../src/index.js";
import { memoryDatabaseAdapter } from "../../src/testing/memory-database.js";
import { kvCacheAdapter } from "../../src/adapters/cloudflare-kv.adapter.js";

/**
 * Structural subset of the Cloudflare `KVNamespace` binding used by the KV
 * cache adapter. Typed structurally so this file compiles without
 * `@cloudflare/workers-types`.
 */
interface KVNamespaceLike {
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
    limit?: number;
  }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

/**
 * In-memory fake of the KV binding for the smoke run — same surface as a real
 * KV namespace, backed by a Map. Honours `expirationTtl` lazily on read.
 */
function createFakeKV(): KVNamespaceLike {
  const store = new Map<string, { value: string; expiresAt: number | null }>();

  const isLive = (key: string) => {
    const entry = store.get(key);
    if (!entry) return false;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      store.delete(key);
      return false;
    }
    return true;
  };

  return {
    async get(key, type = "text") {
      if (!isLive(key)) return null;
      const { value } = store.get(key)!;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value, options) {
      store.set(key, {
        value,
        expiresAt: options?.expirationTtl
          ? Date.now() + options.expirationTtl * 1000
          : null,
      });
    },
    async delete(key) {
      store.delete(key);
    },
    async list(options) {
      const keys = [...store.keys()]
        .filter((name) => isLive(name))
        .filter((name) => !options?.prefix || name.startsWith(options.prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

const features = defineFeatures({
  analytics: { type: "boolean", default: false },
  maxProducts: { type: "limit", default: 3, usage: { kind: "persistent" } },
});

const kv = createFakeKV();

const subscriptions = createSubscriptions({
  database: memoryDatabaseAdapter<typeof features>(),
  features,
  cache: kvCacheAdapter(kv as never),
  options: { cacheNamespace: "workers-smoke:development:memory" },
});

// Seed one active plan + subscriber so /can returns meaningful answers.
const seedPromise = (async () => {
  const plan = await subscriptions.plans.create({
    name: "Smoke Plan",
    price: 0,
    interval: "monthly",
    features: { analytics: true, maxProducts: 10 },
  });
  await subscriptions.subscriptions.create("demo-subscriber", plan.id);
})();

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export default {
  async fetch(request: Request): Promise<Response> {
    await seedPromise;

    const url = new URL(request.url);

    // Fixed identity demonstration only. Real APIs require trusted sessions
    // and membership/operation authorization; request headers never authenticate here.
    if (request.method === "GET" && url.pathname === "/can") {
      const feature = url.searchParams.get("feature");
      const subscriberId = "demo-subscriber";
      if (!feature) {
        return json(
          { error: "Missing `feature` query param" },
          400,
        );
      }
      const allowed = await subscriptions.can(
        subscriberId,
        feature as keyof typeof features,
      );
      return json({ subscriberId, feature, allowed });
    }

    // No payment provider is configured: test raw Request/error handling,
    // without claiming real provider authentication or settlement coverage.
    if (request.method === "POST" && url.pathname === "/webhooks") {
      // handleWebhookRequest returns a web-standard Response directly
      // (200 on success, 400 on verification failure, 500 otherwise).
      return subscriptions.handleWebhookRequest(request);
    }

    return json({ error: "Not found" }, 404);
  },
};
