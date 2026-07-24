// file: packages/subscriptions/tests/workers-smoke/index.ts
// Minimal Cloudflare Worker smoke test for @abshahin/subscriptions.
//
// Proves the package boots inside a Workers (V8 isolate, no Node APIs)
// runtime: the core bundle, the in-memory database adapter and the
// Cloudflare KV cache adapter are all exercised through real HTTP routes.
//
// Routes:
//   GET  /can?feature=<key>   -> { allowed: boolean } using the
//                                `x-subscriber-id` header
//   POST /webhooks/:provider  -> subscriptions.handleWebhookRequest()
//
// Run with: npx wrangler dev tests/workers-smoke/wrangler.toml

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
  maxProducts: { type: "limit", default: 3 },
});

const kv = createFakeKV();

const subscriptions = createSubscriptions({
  database: memoryDatabaseAdapter<typeof features>(),
  features,
  cache: kvCacheAdapter(kv as never),
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

    // GET /can?feature=<key> — feature gate check for the caller's subscriber.
    if (request.method === "GET" && url.pathname === "/can") {
      const feature = url.searchParams.get("feature");
      const subscriberId = request.headers.get("x-subscriber-id");
      if (!feature || !subscriberId) {
        return json(
          { error: "Missing `feature` query param or `x-subscriber-id` header" },
          400,
        );
      }
      const allowed = await subscriptions.can(
        subscriberId,
        feature as keyof typeof features,
      );
      return json({ subscriberId, feature, allowed });
    }

    // POST /webhooks/:provider — signature-verified webhook handling.
    // The provider is taken from the URL and forwarded via a query-agnostic
    // option: handleWebhookRequest resolves it from config by default, so we
    // build a Request the factory can route with.
    const webhookMatch = url.pathname.match(/^\/webhooks\/([^/]+)$/);
    if (request.method === "POST" && webhookMatch) {
      // handleWebhookRequest returns a web-standard Response directly
      // (200 on success, 400 on verification failure, 500 otherwise).
      return subscriptions.handleWebhookRequest(request);
    }

    return json({ error: "Not found" }, 404);
  },
};
