# Runtime Support

`@abshahin/subscriptions` is runtime-agnostic. The core services (`plans`, `subscriptions`, `permissions`, `invoices`) use only web-standard primitives (`fetch`, `crypto.subtle`, `TextEncoder`/`TextDecoder`, `Request`/`Response`, `crypto.randomUUID`) and run on Node.js, Bun, Deno, and Cloudflare Workers.

Node-only code paths (filesystem template loading, `puppeteer-html-pdf`) are lazy dynamic imports, so Workers bundles never reach them. Every optional capability degrades gracefully: omit a cache adapter and the package falls back to `noopCacheAdapter`; omit a payment adapter and manual subscription management still works.

## Support Matrix

| Capability | Node.js | Bun | Deno | Cloudflare Workers |
| --- | --- | --- | --- | --- |
| Core services | ✅ | ✅ | ✅ | ✅ |
| `prismaAdapter` | ✅ | ✅¹ | ✅¹ | ✅² |
| `drizzleAdapter` | ✅ | ✅ (incl. `bun:sqlite`) | ✅ | ✅ (incl. D1) |
| `redisCacheAdapter` | ✅ | ✅ | ✅ | ❌ (no TCP sockets) |
| `upstashCacheAdapter` | ✅ | ✅ | ✅ | ✅ |
| `kvCacheAdapter` (Cloudflare KV) | ❌ | ❌ | ❌ | ✅ |
| `memoryCacheAdapter` | ✅ (dev/test) | ✅ (dev/test) | ✅ (dev/test) | ⚠️ per-isolate, dev/test only |
| Invoice HTML via `templateSource` | ✅ | ✅ | ✅ | ✅ |
| Invoice client-side print (`?print=1` / `?autoPrint=1`, no Chromium) | ✅ | ✅ | ✅ | ✅ |
| Invoice PDF via `puppeteer-html-pdf` | ✅ | ✅ | ❌ | ❌ |
| Invoice PDF via `@cloudflare/puppeteer` (Browser Rendering) | ❌ | ❌ | ❌ | ✅ |
| `elysiaPlugin` | ✅ | ✅ | ⚠️³ | ✅ |
| Hono integration | ✅ | ✅ | ✅ | ✅ |
| Next.js integration | ✅ | ✅ | — | ✅⁴ |
| Framework-neutral fetch handler | ✅ | ✅ | ✅ | ✅ |

¹ Prisma on Bun/Deno requires a driver adapter (e.g. `@prisma/adapter-libsql`) or Prisma Accelerate; the `queryRaw`-free code paths of this package work anywhere the client connects.

² On Workers, use Prisma with a driver adapter (D1, Neon, Turso) or Prisma Accelerate — the classic TCP engine cannot run on Workers.

³ Elysia runs on Deno, but the Deno adapter surface is less battle-tested than Node/Bun/Workers.

⁴ Via OpenNext or the Next-on-Workers tooling.

## Setup Recipes

### Node.js (Prisma + Redis + Elysia)

```bash
npm install @abshahin/subscriptions @prisma/client elysia ioredis
npm install puppeteer-html-pdf   # optional: invoice PDFs
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

const subscriptions = createSubscriptions({
  database: prismaAdapter(new PrismaClient()),
  features,
  cache: redisCacheAdapter(new Redis(process.env.REDIS_URL!)),
});

const app = new Elysia().use(
  elysiaPlugin(subscriptions, {
    getSubscriberId: (ctx) => ctx.user.activeTenantId,
  }),
);

app.listen(3000);
```

### Bun (Drizzle + `bun:sqlite` + Hono)

```bash
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

const db = drizzle(new Database("app.db"));

const subscriptions = createSubscriptions({
  database: drizzleAdapter(db),
  features,
  // No cache configured: falls back to noopCacheAdapter.
});

const app = new Hono();
app.route("/subscriptions", honoPlugin(subscriptions, {
  getSubscriberId: (c) => c.get("user").activeTenantId,
}));

export default app;
```

### Deno (Drizzle + Upstash + fetch handler)

```ts
import { createSubscriptions } from "npm:@abshahin/subscriptions";
import { drizzleAdapter } from "npm:@abshahin/subscriptions/adapters/drizzle";
import { upstashCacheAdapter } from "npm:@abshahin/subscriptions/adapters/upstash";
import { createSubscriptionsHttpHandler } from "npm:@abshahin/subscriptions/integrations/http";
import { features } from "./features.ts";

const subscriptions = createSubscriptions({
  database: drizzleAdapter(db),
  features,
  cache: upstashCacheAdapter({
    url: Deno.env.get("UPSTASH_REDIS_REST_URL")!,
    token: Deno.env.get("UPSTASH_REDIS_REST_TOKEN")!,
  }),
});

const handler = createSubscriptionsHttpHandler(subscriptions, {
  getSubscriberId: (req) => req.headers.get("x-subscriber-id")!,
});

Deno.serve(handler.fetch);
```

### Cloudflare Workers (D1 + KV + Hono + Browser Rendering PDFs)

```bash
npm install @abshahin/subscriptions drizzle-orm hono @cloudflare/puppeteer
```

```ts
import { createSubscriptions } from "@abshahin/subscriptions";
import { drizzleAdapter } from "@abshahin/subscriptions/adapters/drizzle";
import { kvCacheAdapter } from "@abshahin/subscriptions/adapters/cloudflare-kv";
import { honoPlugin } from "@abshahin/subscriptions/integrations/hono";
import { renderSubscriptionInvoice } from "@abshahin/subscriptions";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { features } from "./features";
import invoiceTemplate from "./invoice.hbs";

interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  BROWSER: Fetcher; // Browser Rendering binding
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  const subscriptions = createSubscriptions({
    database: drizzleAdapter(drizzle(c.env.DB)),
    features,
    cache: kvCacheAdapter(c.env.CACHE),
  });
  c.set("subscriptions", subscriptions);
  await next();
});

// Invoice PDF on Workers: render HTML from a template string, then print it
// with Browser Rendering via @cloudflare/puppeteer.
app.get("/invoices/:id/pdf", async (c) => {
  const subscriptions = c.get("subscriptions");
  const invoice = await subscriptions.invoices.getWithDetails(c.req.param("id"));
  if (!invoice) return c.notFound();

  const html = await renderSubscriptionInvoice({
    templateSource: invoiceTemplate, // bundled as a string — no filesystem
    data: invoice,
  });

  const puppeteer = await import("@cloudflare/puppeteer");
  const browser = await puppeteer.default.launch(c.env.BROWSER);
  const page = await browser.newPage();
  await page.setContent(html);
  const pdf = await page.pdf({ format: "a4" });
  await browser.close();

  return new Response(pdf, {
    headers: { "content-type": "application/pdf" },
  });
});

export default app;
```

Notes for Workers:

- There is no filesystem, so pass the invoice template as a bundled string via `templateSource` (e.g. an `import ... from "./invoice.hbs"` with a text loader, or an inline template literal). `templatePath` remains available on Node.js/Bun/Deno.
- KV is eventually consistent; the cache adapter is a read-through optimization, so correctness never depends on it.
- Run dunning and renewal sweeps from a `scheduled()` handler or Cron Trigger. See `dunning.md`.

## Choosing Adapters

- **Database**: `prismaAdapter` if you already run Prisma; `drizzleAdapter` for everything else, and required for D1, Turso, and `bun:sqlite`.
- **Cache**: `redisCacheAdapter` on long-lived servers; `upstashCacheAdapter` anywhere (HTTP-based, edge-safe); `kvCacheAdapter` on Workers; `memoryCacheAdapter` for local dev and tests.
- **Payments**: `moyasarAdapter`, `stripeAdapter`, `paddleAdapter`, and `lemonSqueezyAdapter` all use `fetch` + Web Crypto for API calls and webhook signature verification, so they run on every runtime.
- **PDF**: `puppeteerPdfRenderer` (from `@abshahin/subscriptions/pdf/puppeteer`) on Node/Bun; `cloudflarePdfRenderer` (from `@abshahin/subscriptions/pdf/cloudflare`) with a Browser Rendering binding on Workers; everywhere else, render HTML with `templateSource` and print it with your platform's tooling.
