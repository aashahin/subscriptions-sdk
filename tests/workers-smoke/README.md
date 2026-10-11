# Workers Smoke Fixture

This local fixture uses the SDK source, the in-memory database, and the Cloudflare KV adapter backed by a fake KV namespace. It seeds one free plan and the fixed `demo-subscriber` identity. It uses no live payment provider or durable database and requires no Cloudflare resources.

The fixed identity is a non-authenticated demonstration. Do not copy it into a production API. Production integrations must resolve a trusted session and authorize tenant membership and each subscription operation; caller-supplied subscriber headers are not authentication. The cache configuration includes a mandatory application/environment/database namespace, and the product inventory is declared persistent.

## Routes

| Route | Behavior |
| --- | --- |
| `GET /can?feature=analytics` | Checks the fixed demo subscriber and returns `{ subscriberId, feature, allowed }` |
| `GET /can?feature=unknown` | Returns false for an unknown feature |
| `POST /webhooks` | Exercises the SDK's raw Request/no-provider error path; returns 400 |

No provider is registered, so this fixture does not test payment authentication, live settlement, or native subscription integration. It does not establish D1 transaction support.

## Run Locally

From the repository root:

```sh
bunx --bun wrangler dev --config tests/workers-smoke/wrangler.toml
```

In another terminal:

```sh
curl 'http://localhost:8787/can?feature=analytics'
# {"subscriberId":"demo-subscriber","feature":"analytics","allowed":true}

curl 'http://localhost:8787/can?feature=unknown'
# {"subscriberId":"demo-subscriber","feature":"unknown","allowed":false}

curl -X POST http://localhost:8787/webhooks \
  -H 'content-type: application/json' -d '{}'
# 400: no provider is registered
```

Wrangler runtime execution is a separate check from bundling. The smoke configuration omits `nodejs_compat`; this example is intended for the native Workers APIs.

## Neutral Bundle Check

```sh
bun tests/workers-smoke/bundle-check.mjs
```

The script invokes esbuild for the package core with `platform=neutral`, `format=esm`, and `target=es2022`, keeping optional dependencies external. It exits nonzero on unresolved Node-only imports. A passing check establishes that the core bundles for the selected platform; it does not prove optional dynamic paths, real Workers runtime execution, live D1/Prisma transactions, Browser Rendering, or real provider behavior.

D1 financial operations requiring interactive awaited transactions fail closed. Durable billing requires a storage backend with verified rollback/commit semantics plus the migrated operation, resource mapping, invoice sequence, and outbox tables. See [runtime-support.md](../../docs/runtime-support.md).
