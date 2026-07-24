# Workers smoke test

Minimal Cloudflare Worker proving `@abshahin/subscriptions` runs on the pure
Workers runtime — no Node.js APIs, no `nodejs_compat` flag.

The worker ([`index.ts`](./index.ts)):

- imports `createSubscriptions` straight from the package source
  (`../../src/index.js`),
- wires the **memory database adapter** (`../../src/testing/memory-database.js`),
- wires the **Cloudflare KV cache adapter**
  (`../../src/adapters/cloudflare-kv.adapter.js`) against a structurally-typed
  fake KV namespace (a `Map` with TTL support) — no real binding needed,
- seeds one active plan and one subscriber (`demo-subscriber`) on boot.

## Routes

| Route | Description |
| --- | --- |
| `GET /can?feature=analytics` | Feature-gate check for the `x-subscriber-id` request header. Returns `{ subscriberId, feature, allowed }`. |
| `POST /webhooks/:provider` | Passes the raw `Request` to `subscriptions.handleWebhookRequest(provider, request)` (signature verification included). Returns `{ received, type }`. |

## Run it

From the package root (`packages/subscriptions-sdk`):

```sh
npx wrangler dev tests/workers-smoke/wrangler.toml
```

Then, in another terminal:

```sh
# Feature gate (seeded subscriber has `analytics: true`)
curl -H 'x-subscriber-id: demo-subscriber' \
  'http://localhost:8787/can?feature=analytics'
# -> {"subscriberId":"demo-subscriber","feature":"analytics","allowed":true}

# Unknown subscriber falls back to feature defaults
curl -H 'x-subscriber-id: nobody' \
  'http://localhost:8787/can?feature=analytics'
# -> {"...","allowed":false}

# Webhook (no payment adapter is configured in the smoke test, so any
# provider is rejected with a helpful 400 — which still proves the route,
# request parsing and error path all work inside Workers)
curl -X POST http://localhost:8787/webhooks/moyasar \
  -H 'content-type: application/json' -d '{}'
```

## Bundle check

[`bundle-check.mjs`](./bundle-check.mjs) bundles `src/index.ts` with esbuild
using `--platform=neutral --format=esm --target=es2022`, keeping optional peer
dependencies external. Any top-level `node:*` import anywhere in the reachable
module graph fails the build, so a green run proves the core is edge-safe:

```sh
node tests/workers-smoke/bundle-check.mjs
```

Exits non-zero (and prints the esbuild diagnostics) on failure. Run it in CI
to prevent Node-only imports from creeping back into the core.
