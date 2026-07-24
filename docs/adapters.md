# Adapters

`@abshahin/subscriptions` separates persistence, caching, and payment concerns behind adapter contracts.

The package currently ships with:

- `prismaAdapter` and `drizzleAdapter` for storage
- `moyasarAdapter`, `stripeAdapter`, `paddleAdapter`, and `lemonSqueezyAdapter` for payments
- `redisCacheAdapter`, `upstashCacheAdapter`, and `kvCacheAdapter` (Cloudflare KV) behind the `CacheAdapter` interface for optional caching

## Database Adapter

The database adapter is required. It is the source of truth for plans, subscriptions, invoices, and persisted usage records.

### Prisma Adapter

```ts
import { prismaAdapter } from "@abshahin/subscriptions/adapters/prisma";

const database = prismaAdapter(db);
```

The current Prisma adapter expects these model delegates on the Prisma client:

- `subscriptionPlan`
- `subscription`
- `invoice`
- `usageRecord`

See `prisma-schema.md` for the schema shape used in the backend project.

### Drizzle Adapter

```ts
import { drizzle } from "drizzle-orm/d1";
import {
  drizzleAdapter,
  subscriptionsSchema,
} from "@abshahin/subscriptions/adapters/drizzle";

const db = drizzle(env.DB, { schema: subscriptionsSchema });
const database = drizzleAdapter(db);
```

The Drizzle adapter works with any Drizzle driver — D1, Turso, `bun:sqlite`, Postgres, and more — making it the portable alternative to Prisma (and the required choice on Cloudflare Workers without a Prisma driver adapter). It accepts an optional second argument (`drizzleAdapter(db, { schema })`) to override the bundled table definitions, and the `./adapters/drizzle` subpath re-exports the schema (`subscriptionsSchema` and the individual tables) so you can merge it into your own Drizzle schema. See `drizzle-schema.md` for the table shapes and `runtime-support.md` for per-runtime setup.

### Responsibilities

The adapter covers four areas:

- plan CRUD and admin listing
- subscription lookup and lifecycle persistence
- invoice storage and invoice detail lookup
- usage record persistence

Conceptually, the adapter surface looks like this:

```ts
interface DatabaseAdapter<TFeatures extends FeatureRegistry> {
  plans: {
    findById(id: string): Promise<Plan<TFeatures> | null>;
    findAll(options?: { activeOnly?: boolean }): Promise<Plan<TFeatures>[]>;
    findAllForAdmin(
      options?: PlanQueryOptions,
    ): Promise<{ plans: Plan<TFeatures>[]; total: number }>;
    create(data: CreatePlanInput<TFeatures>): Promise<Plan<TFeatures>>;
    update(
      id: string,
      data: UpdatePlanInput<TFeatures>,
    ): Promise<Plan<TFeatures>>;
    delete(id: string): Promise<void>;
  };

  subscriptions: {
    findById(id: string): Promise<SubscriptionWithPlan<TFeatures> | null>;
    findBySubscriber(
      subscriberId: string,
    ): Promise<SubscriptionWithPlan<TFeatures> | null>;
    findAll(options?: SubscriptionQueryOptions): Promise<Subscription[]>;
    create(data: CreateSubscriptionInput): Promise<Subscription>;
    update(id: string, data: UpdateSubscriptionInput): Promise<Subscription>;
    delete(id: string): Promise<void>;
    findExpiring(withinDays: number): Promise<Subscription[]>;
  };

  invoices: {
    findById(id: string): Promise<Invoice | null>;
    findByIdWithDetails(
      id: string,
    ): Promise<InvoiceWithDetails<TFeatures> | null>;
    findBySubscription(subscriptionId: string): Promise<Invoice[]>;
    create(data: CreateInvoiceInput): Promise<Invoice>;
    update(id: string, data: UpdateInvoiceInput): Promise<Invoice>;
  };

  usage: {
    get(subscriberId: string, feature: string): Promise<number>;
    increment(
      subscriberId: string,
      feature: string,
      options?: { count?: number },
    ): Promise<number>;
    decrement(
      subscriberId: string,
      feature: string,
      options?: { count?: number },
    ): Promise<number>;
    set(subscriberId: string, feature: string, count: number): Promise<void>;
    reset(subscriberId: string, options?: { feature?: string }): Promise<void>;
  };
}
```

### Tenant-Oriented Storage

The core package uses the neutral term `subscriberId`, but the current Prisma adapter stores that value in the `tenantId` column.

That means tenant-based subscriptions are the best-supported production path today and the one exercised by the backend project.

## Cache Adapter

Caching is optional. If you do not provide one, the package falls back to `noopCacheAdapter`.

### Interface

```ts
interface CacheAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  deletePattern?(pattern: string): Promise<void>;
  incrBy?(key: string, count: number): Promise<number>;
  decrBy?(key: string, count: number): Promise<number>;
  exists?(key: string): Promise<boolean>;
}
```

The package uses cache entries for:

- plan lists and individual plans
- subscription lookups
- resolved feature maps

### Example

```ts
import type { CacheAdapter } from "@abshahin/subscriptions/adapters/cache";

const cacheAdapter: CacheAdapter = {
  async get<T>(key) {
    return redis.get<T>(key);
  },
  async set<T>(key, value, ttlSeconds) {
    await redis.set(key, value, { ttl: ttlSeconds });
  },
  async delete(key) {
    await redis.del(key);
  },
  async deletePattern(pattern) {
    await redis.deleteByPattern(pattern);
  },
};
```

### Exported Cache Keys

If you want your cache namespace to align with the package, use `CacheKeys`.

```ts
CacheKeys.subscription(subscriberId);
CacheKeys.plan(planId);
CacheKeys.plans();
CacheKeys.activePlans();
CacheKeys.features(subscriberId);
CacheKeys.usage(subscriberId, feature);
```

### Shipped Implementations

Three ready-made cache adapters cover the common backends; `memoryCacheAdapter` from `./testing` covers local dev and tests:

```ts
// Redis (ioredis) — pass an existing client, or connection options
// ({ url, options }) and ioredis is lazy-loaded.
import { redisCacheAdapter } from "@abshahin/subscriptions/adapters/redis";
const cache = redisCacheAdapter(new Redis(process.env.REDIS_URL!));

// Upstash Redis — HTTP-based, edge-safe (no TCP), works on every runtime.
import { upstashCacheAdapter } from "@abshahin/subscriptions/adapters/upstash";
const cache = upstashCacheAdapter({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Cloudflare KV — pass a KV namespace binding.
import { kvCacheAdapter } from "@abshahin/subscriptions/adapters/cloudflare-kv";
const cache = kvCacheAdapter(env.CACHE);
```

See `runtime-support.md` for the per-runtime support matrix (e.g. `redisCacheAdapter` needs TCP sockets, so it does not run on Cloudflare Workers).

## Payment Adapter

Payments are optional. Manual subscription management still works without a payment adapter.

Webhook payload handling is runtime-neutral. Public adapter methods accept `string | Uint8Array`, which keeps the interface compatible with Node.js, Bun, and edge-style runtimes.

### Interface

```ts
interface PaymentGatewayAdapter {
  readonly provider: string;

  createCustomer(data: CreateCustomerInput): Promise<GatewayCustomer>;
  getCustomer(customerId: string): Promise<GatewayCustomer | null>;
  updateCustomer?(
    customerId: string,
    data: Partial<CreateCustomerInput>,
  ): Promise<GatewayCustomer>;

  createSubscription(
    data: CreateGatewaySubscriptionInput,
  ): Promise<GatewaySubscription>;
  getSubscription(subscriptionId: string): Promise<GatewaySubscription | null>;
  updateSubscription(
    subscriptionId: string,
    data: UpdateGatewaySubscriptionInput,
  ): Promise<GatewaySubscription>;
  cancelSubscription(
    subscriptionId: string,
    options?: CancelOptions,
  ): Promise<GatewaySubscription>;

  pauseSubscription?(subscriptionId: string): Promise<GatewaySubscription>;
  resumeSubscription?(subscriptionId: string): Promise<GatewaySubscription>;

  createCheckoutSession(data: CreateCheckoutInput): Promise<CheckoutSession>;
  createPortalSession(
    customerId: string,
    returnUrl: string,
  ): Promise<PortalSession>;

  chargePayment?(data: ChargePaymentInput): Promise<ChargePaymentResult>;
  getPaymentSource?(paymentId: string): Promise<string | null>;

  constructWebhookEvent(
    payload: string | Uint8Array,
    signature: string,
  ): Promise<WebhookEvent>;
}
```

If your runtime exposes `Buffer`, it will continue to work because `Buffer` extends `Uint8Array`.

## Moyasar Adapter

The included Moyasar adapter is built for token-based recurring billing. That matches the backend project's current production pattern.

```ts
import { moyasarAdapter } from "@abshahin/subscriptions/adapters/moyasar";

const payment = moyasarAdapter({
  secretKey: process.env.MOYASAR_SECRET_KEY!,
  publishableKey: process.env.MOYASAR_PUBLIC_KEY!,
  webhookSecret: process.env.MOYASAR_WEBHOOK_SECRET,
  callbackUrl: "https://app.example.com/subscription",
});
```

Typical backend flow:

1. Verify a reusable payment source in the frontend.
2. Save the resulting token as `gatewayCustomerId`.
3. Charge upgrades or renewals through `chargePayment`.
4. Create invoices after successful payment.

The included Moyasar adapter verifies webhook signatures using the Web Crypto API and decodes binary payloads through `TextDecoder`, so it does not require `Buffer` in its public surface.

## Stripe, Paddle, and Lemon Squeezy Adapters

Three more payment gateways ship alongside Moyasar. All are dependency-free — API calls go through `fetch` and webhook signature verification uses Web Crypto — so they run on Node.js, Bun, Deno, and Cloudflare Workers alike.

```ts
import { stripeAdapter } from "@abshahin/subscriptions/adapters/stripe";

const payment = stripeAdapter({
  secretKey: process.env.STRIPE_SECRET_KEY!,       // sk_live_xxx / sk_test_xxx
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET, // whsec_xxx
});
```

```ts
import { paddleAdapter } from "@abshahin/subscriptions/adapters/paddle";

const payment = paddleAdapter({
  apiKey: process.env.PADDLE_API_KEY!,
  webhookSecret: process.env.PADDLE_WEBHOOK_SECRET, // pdl_ntfset_xxx
  environment: "sandbox",                           // optional; defaults to production
});
```

```ts
import { lemonSqueezyAdapter } from "@abshahin/subscriptions/adapters/lemonsqueezy";

const payment = lemonSqueezyAdapter({
  apiKey: process.env.LEMONSQUEEZY_API_KEY!,
  storeId: process.env.LEMONSQUEEZY_STORE_ID!,
  webhookSecret: process.env.LEMONSQUEEZY_WEBHOOK_SECRET,
});
```

Webhook delivery reaches them through `subscriptions.handleWebhook(provider, payload, signature)` or the web-standard `subscriptions.handleWebhookRequest(request)` — set `options.webhookProvider`/`options.webhookSignatureHeader` when the defaults do not match your setup. See `runtime-support.md` for the full matrix.

## Custom Payment Adapters

If you integrate another provider, implement the interface directly and pass it to `createSubscriptions`.

Prioritize these flows first:

- customer creation and lookup
- webhook verification
- cancellation and subscription lookup
- direct payment charging for upgrades and renewals

## Invoice Rendering Helpers

The package also exports invoice rendering helpers from the root entrypoint:

- `renderSubscriptionInvoice(...)` — accepts `(templatePath, data)`, an options object `({ templatePath? | templateSource? }, data)`, or just `(data)` to use the built-in inlined template
- `generateSubscriptionInvoicePdf(templatePathOrOptions, data, options?)`

With `templateSource` or the built-in template, HTML rendering works on any runtime — no filesystem is touched. PDF generation delegates to a `PdfRenderer`:

- `puppeteerPdfRenderer` from `@abshahin/subscriptions/pdf/puppeteer` (Node.js, uses the optional `puppeteer-html-pdf` peer dependency)
- `cloudflarePdfRenderer(browserBinding)` from `@abshahin/subscriptions/pdf/cloudflare` (Cloudflare Workers Browser Rendering)

If you need invoice generation in another runtime, render HTML with `templateSource` and print it with your platform's tooling.
