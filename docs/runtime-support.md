# Runtime Support

The core uses web-standard APIs (`fetch`, Web Crypto, `Request`, `Response`, and typed arrays) and can bundle for Node.js, Bun, Deno, and Cloudflare Workers. Filesystem invoice templates and Chromium PDF rendering are optional runtime-specific paths. A successful bundle establishes import compatibility; it does not establish live provider behavior or database transaction guarantees.

## Capabilities and Verification

| Capability | Node.js / Bun | Deno | Cloudflare Workers |
| --- | --- | --- | --- |
| Core API and raw webhook payloads | Web-standard API support | Web-standard API support | Neutral bundle checked |
| Prisma adapter | Requires compatible client/database transactions | Requires compatible Prisma driver | Requires edge-compatible Prisma driver; transaction support must be verified |
| Drizzle reads / individual atomic commands | Driver-dependent | Driver-dependent | D1 available for supported non-financial commands |
| Drizzle financial transactions | Real `bun:sqlite` rollback/concurrency tests; other drivers require explicit configuration | Unverified async driver modes fail closed by default | D1 interactive financial transactions unsupported; fail closed |
| Redis TCP cache | Supported on server runtimes with TCP | Requires compatible client/runtime | Use HTTP cache or KV |
| Upstash HTTP cache | Web-standard HTTP | Web-standard HTTP | Web-standard HTTP |
| Cloudflare KV cache | Requires a KV-compatible binding | Requires a KV-compatible binding | Supported cache binding |
| In-memory database/cache | Development/test only | Development/test only | Per-isolate development/test only |
| Invoice HTML with `templateSource` | Supported | Supported | Supported without filesystem access |
| `puppeteer-html-pdf` | Optional Node/Bun dependency | Unsupported recipe | Unsupported |
| Browser Rendering PDF | Use platform tooling | Use platform tooling | Optional `@cloudflare/puppeteer` and Browser Rendering binding |
| HTTP integrations | Fetch handler; Elysia/Hono/Next per framework runtime support | Fetch handler; framework support varies | Fetch/Hono; other frameworks require their own deployment support |

The regression suite exercises production SDK services, mocked Prisma storage boundaries, and real SQLite operations. It does not claim live PostgreSQL, D1, Turso/libSQL, Prisma-engine, Deno, Browser Rendering, or provider payment integration coverage. See [AUDIT_REMEDIATION.md](AUDIT_REMEDIATION.md) for the exact validation record.

Financial operations require `capabilities.asyncTransactions`, durable billing operations, provider-resource mappings, a transaction-owned outbox, and the documented migrated schema. Do not mark an unsupported driver as `async` simply because it exposes a function named `transaction`. Awaited commit/rollback semantics must support the SDK callback. D1 cannot hold the required interactive async transaction; its financial operations reject instead of pretending rollback exists.

## Node.js: Prisma, Redis, and Elysia

```sh
bun add @abshahin/subscriptions @prisma/client elysia ioredis
bun add puppeteer-html-pdf # optional PDF rendering
```

```ts
import { createSubscriptions } from "@abshahin/subscriptions";
import { prismaAdapter } from "@abshahin/subscriptions/adapters/prisma";
import { redisCacheAdapter } from "@abshahin/subscriptions/adapters/redis";
import { elysiaPlugin } from "@abshahin/subscriptions/elysia";
import { PrismaClient } from "@prisma/client";
import { Elysia } from "elysia";
import { Redis } from "ioredis";
import { features } from "./features";
import { resolveAuthenticatedTenant, authorizeTenantBillingOperation } from "./auth";

const subscriptions = createSubscriptions({
  database: prismaAdapter(new PrismaClient()),
  features,
  cache: redisCacheAdapter(new Redis(process.env.REDIS_URL!)),
  options: { cacheNamespace: "my-app:production:prisma-main" },
});

const app = new Elysia().use(elysiaPlugin(subscriptions, {
  getSubscriberId: resolveAuthenticatedTenant,
  authorizeSubscriber: authorizeTenantBillingOperation,
}));
app.listen(3000);
```

Auth helpers must verify the authenticated session, tenant membership, and operation permission. Administrative routes stay disabled unless enabled with an explicit administrative guard. For collection, add provider account registrations and persisted subscription bindings as shown in [integration-guide.md](integration-guide.md).

## Bun: Drizzle SQLite and Hono

```sh
bun add @abshahin/subscriptions drizzle-orm hono
```

```ts
import { createSubscriptions } from "@abshahin/subscriptions";
import { drizzleAdapter } from "@abshahin/subscriptions/adapters/drizzle";
import { honoPlugin } from "@abshahin/subscriptions/integrations/hono";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Hono } from "hono";
import { features } from "./features";
import { resolveAuthenticatedTenant, authorizeTenantBillingOperation } from "./auth";

const client = new Database("app.db");
const subscriptions = createSubscriptions({
  database: drizzleAdapter(drizzle(client), { transactionMode: "sqlite", sqliteClient: client }),
  features,
});
const app = new Hono();
const router = await honoPlugin(subscriptions, {
  getSubscriberId: resolveAuthenticatedTenant,
  authorizeSubscriber: authorizeTenantBillingOperation,
});
app.all("/subscriptions/*", c => router.fetch(c.req.raw));
export default app;
```

Apply the bundled schema migration before using billing. The adapter serializes awaited SQLite transactions on its local connection and rejects incompatible nested transaction modes. Remote databases and other Drizzle drivers require separately verified semantics; this recipe does not prove them.

## Turso / libSQL: Explicit Async Transaction Mode

```ts
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { drizzleAdapter, subscriptionsSchema } from "@abshahin/subscriptions/adapters/drizzle";

const client = createClient({
  url: process.env.TURSO_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const database = drizzleAdapter(drizzle(client, { schema: subscriptionsSchema }), {
  transactionMode: "async",
  dialect: "sqlite",
});
```

The default unknown-driver mode cannot perform financial transactions. This opt-in requires a connector that actually awaits the transaction callback and rolls back on rejection. The SDK's live libSQL/Turso integration was not exercised in the audit suite; validate the configured connector before enabling billing. Do not use `transactionMode: "sqlite"` for a remote libSQL connection or enable `"async"` on D1. Read [drizzle-schema.md](drizzle-schema.md) for all required tables and migration details.

## Deno: Trusted Fetch Handler

```ts
import { createSubscriptionsHttpHandler } from "npm:@abshahin/subscriptions/integrations/http";
import { resolveAuthenticatedTenant, authorizeTenantBillingOperation } from "./auth.ts";

// Configure a subscriptions instance with a Deno-compatible database driver.
// Financial operations need proven awaited transactions; cache needs a namespace.
const handler = createSubscriptionsHttpHandler(subscriptions, {
  getSubscriberId: resolveAuthenticatedTenant,
  authorizeSubscriber: authorizeTenantBillingOperation,
});
Deno.serve(handler.fetch);
```

The resolver must verify a session or server-verified bearer credential. Caller-supplied subscriber identifiers are not an authentication mechanism.

## Workers: D1 Reads, KV Cache, and Invoice HTML

```ts
import { createSubscriptions } from "@abshahin/subscriptions";
import { drizzleAdapter } from "@abshahin/subscriptions/adapters/drizzle";
import { kvCacheAdapter } from "@abshahin/subscriptions/adapters/cloudflare-kv";
import { createSubscriptionsHttpHandler } from "@abshahin/subscriptions/integrations/http";
import { drizzle } from "drizzle-orm/d1";
import { features } from "./features";
import { resolveAuthenticatedTenant, authorizeTenantBillingOperation } from "./auth";

export default {
  async fetch(request, env) {
    const subscriptions = createSubscriptions({
      database: drizzleAdapter(drizzle(env.DB), { transactionMode: "unsupported" }),
      features,
      cache: kvCacheAdapter(env.CACHE),
      options: { cacheNamespace: "my-app:production:d1-main" },
    });
    return createSubscriptionsHttpHandler(subscriptions, {
      getSubscriberId: resolveAuthenticatedTenant,
      authorizeSubscriber: authorizeTenantBillingOperation,
    }).fetch(request);
  },
};
```

This illustrates runtime wiring for supported reads; paid purchase, renewal, and other operations requiring financial transactions fail closed on D1. Keep collection and atomic settlement on a storage backend with verified transaction support. KV is eventually consistent and must never authorize entitlement or quota admission by itself.

Render invoice HTML using a bundled `templateSource` or the built-in template. Use the SDK's authorized invoice routes, or verify invoice subscriber ownership before rendering a custom endpoint. For PDF, supply Browser Rendering through `@cloudflare/puppeteer`; `puppeteer-html-pdf` is unavailable in Workers. The neutral bundle check does not test Browser Rendering or a live D1 integration.

The [Workers smoke fixture](../tests/workers-smoke/README.md) uses a memory database and fake KV, with a fixed demonstration subscriber and no production authentication. It validates bundling and local route behavior, not durable Workers billing.

## Provider and Delivery Boundaries

Payment adapters use web-standard HTTP/crypto, but their capabilities differ. Moyasar supplies token payments with local SDK scheduling; a registered provider-managed subscription cannot be collected by the SDK scheduler. The shipped registry is a foundation for provider ownership and scoped resource mapping. Polar and Creem integrations remain unimplemented.

Use a stable provider account identity plus environment and billing ownership. Keep external customer, payment-method, and native subscription IDs separate. Webhooks must preserve provider-specific authentication and raw payloads; there is no universal HMAC/header requirement. Outbox persistence is atomic only with supported database transactions; delivery is at least once and requires event-ID deduplication.
