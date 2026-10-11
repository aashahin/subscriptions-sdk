# @abshahin/subscriptions

Type-safe subscription plans, feature gates, usage limits, invoices, and Elysia integration for TypeScript applications.

The package ships with:

- a Prisma database adapter
- an optional cache adapter interface
- optional Moyasar, Stripe, Paddle, and Lemon Squeezy payment adapters
- an optional Elysia integration with routes and controller macros

The service layer uses web-standard primitives and models the subscribed entity as a generic subscriber. Runtime compatibility and financial transaction capabilities are separate; see the runtime guide for actual verification limits.

## What It Solves

- Define typed subscription features once
- Store plan overrides as JSON while keeping feature access type-safe
- Enforce boolean feature access and numeric usage limits
- Manage subscription lifecycle: create, change plan, cancel, pause, resume, reactivate, renew
- Verify payment webhooks without coupling the core services to one provider
- Generate invoice HTML and, in Node.js environments, invoice PDFs

## Features

- **Runtime-agnostic core**: runs on Node.js, Bun, Deno, and Cloudflare Workers using web-standard primitives
- **Database adapters**: Prisma and Drizzle, with explicit transaction capabilities; unsupported financial transaction modes fail closed
- **Cache adapters**: Redis, Upstash, Cloudflare KV, and in-memory — all optional, with a noop fallback
- **Framework integrations**: Elysia, Hono, Next.js, and a framework-neutral fetch handler
- **Billing**: sequential invoice numbering, per-line-item inclusive/exclusive tax, credit notes, multi-currency price points, metered usage, and per-seat/add-on data fields — see `docs/billing.md`
- **Coupons**: percent/fixed discounts with once/repeating/forever durations, redemption caps, and expiry — see `docs/coupons.md`
- **Dunning**: configurable retry schedules with pause/cancel final actions — see `docs/dunning.md`
- **Events**: domain events persisted with supported business transactions; `withEvents` relays the outbox with at-least-once delivery — see `docs/events.md`
- **Audit logging**: pluggable audit trail via `createAuditLogger` — see `docs/audit.md`
- **Testing utilities**: in-memory adapters, a fake payment gateway, and adapter conformance suites from the `./testing` export — see `docs/testing.md`

## Runtime Support

- Core services and payment interfaces are runtime-neutral and accept webhook payloads as `string | Uint8Array`
- Existing Node.js callers can still pass `Buffer`, because `Buffer` extends `Uint8Array`
- Invoice HTML can be rendered anywhere by passing a template string (`templateSource`); filesystem template paths remain available on Node.js/Bun/Deno
- Invoice PDF generation via `puppeteer-html-pdf` is Node.js-only; on Cloudflare Workers use `@cloudflare/puppeteer` with a Browser Rendering binding
- See `docs/runtime-support.md` for the full support matrix and per-runtime setup recipes

## Installation

```bash
bun add @abshahin/subscriptions
```

Optional peer dependencies used by common integrations:

```bash
bun add elysia @prisma/client
```

Optional peer dependency for Node.js invoice PDF generation:

```bash
bun add puppeteer-html-pdf
```

If you only use the service layer, Prisma adapter, or webhook handling, you do not need the PDF dependency.

## Quick Start

### 1. Define Features

```ts
import { defineFeatures } from "@abshahin/subscriptions";

export const features = defineFeatures({
  analyticsEnabled: {
    type: "boolean",
    default: false,
    description: "Visitor analytics and reporting",
  },
  customDomain: {
    type: "boolean",
    default: false,
    description: "Connect a custom domain",
  },
  maxCourses: {
    type: "limit",
    default: 3,
    usage: { kind: "persistent" },
    description: "Maximum number of courses",
  },
  maxProducts: {
    type: "limit",
    default: 10,
    usage: { kind: "persistent" },
    description: "Maximum number of products",
  },
  transactionFee: {
    type: "rate",
    default: 5,
    description: "Platform transaction fee percentage",
  },
});

export type AppFeatures = typeof features;
```

### 2. Create a Subscriptions Instance

```ts
import { createSubscriptions } from "@abshahin/subscriptions";
import type { CacheAdapter } from "@abshahin/subscriptions/adapters/cache";
import { prismaAdapter } from "@abshahin/subscriptions/adapters/prisma";
import { db } from "./db";
import { features } from "./features";

const cacheAdapter: CacheAdapter = {
  async get(key) {
    return redis.get(key);
  },
  async set(key, value, ttlSeconds) {
    await redis.set(key, value, { ttl: ttlSeconds });
  },
  async delete(key) {
    await redis.del(key);
  },
  async deletePattern(pattern) {
    await redis.deleteByPattern(pattern);
  },
};

export const subscriptions = createSubscriptions({
  database: prismaAdapter(db),
  features,
  cache: cacheAdapter,
  options: {
    subscriberType: "tenant",
    trialDays: 14,
    gracePeriodDays: 3,
    defaultCurrency: "USD",
    cacheTtlSeconds: 300,
    cacheNamespace: "my-app:production:main-db",
  },
});
```

### 3. Use the Service Layer

```ts
const tenantId = "tenant_123";

if (await subscriptions.can(tenantId, "analyticsEnabled")) {
  console.log("analytics enabled");
}

const usage = await subscriptions.remaining(tenantId, "maxProducts");
console.log(usage.remaining);

await subscriptions.use(tenantId, "maxProducts");
await subscriptions.release(tenantId, "maxProducts");

const fee = await subscriptions.permissions.getRate(
  tenantId,
  "transactionFee",
);
```

## Core Model

### Feature Types

`defineFeatures` supports four feature kinds:

- `boolean`: enable or disable a capability
- `limit`: numeric usage caps, with `-1` meaning unlimited
- `rate`: numeric values such as fees or delays
- `metered`: tracks overage for eligible subscriptions; `remaining` may go negative so you can bill it

Plan records only store overrides. Any omitted feature falls back to the default declared in `defineFeatures`.

Declare resource inventories with `usage: { kind: "persistent" }`. For consumption, choose `usage: { kind: "periodic", reset: "calendar-month" }` or `"subscription-cycle"`. Omitted usage policy preserves calendar-month counters. Consume/release quantities must be positive safe integers; absolute usage must be a nonnegative safe integer. `canUse` is a preview; `use` performs atomic admission and may reject when another request consumes capacity first.

### Subscriber Model

The package refers to the subscribed entity as a subscriber. That can be either:

- a tenant, when a whole workspace or organization shares a subscription
- a user, when each user owns their own subscription

`options.subscriberType` sets the default type for newly created subscriptions. The current Prisma adapter persists subscriber IDs through the `tenantId` column, so tenant-based usage is the most mature path and the one used in the backend project.

## Service API

### Plans

```ts
const plan = await subscriptions.plans.create({
  name: "Pro",
  description: "For growing teams",
  price: 49,
  currency: "USD",
  interval: "monthly",
  trialDays: 14,
  features: {
    customDomain: true,
    maxProducts: 1000,
    transactionFee: 2.5,
  },
});

const plans = await subscriptions.plans.list({ activeOnly: true });
const current = await subscriptions.plans.get(plan.id);
const duplicated = await subscriptions.plans.duplicate(plan.id, {
  name: "Pro Annual",
  interval: "yearly",
});
```

### Subscriptions

```ts
// Public purchase entry: trial policy comes from trusted plan/application config.
const subscription = await subscriptions.subscriptions.createSelfService(tenantId, plan.id);
// A paid purchase without a trial remains incomplete until verified settlement.

const preview = await subscriptions.subscriptions.previewChangePlan(tenantId, "plan_enterprise");
// Display preview.amountDueFormatted / preview.currency and obtain confirmation.
const result = await subscriptions.subscriptions.changePlan(tenantId, "plan_enterprise", {
  quoteId: preview.quoteId,
});
// The operation creates its settlement invoice; use result.invoice directly.

await subscriptions.subscriptions.cancel(tenantId, { immediately: false });
await subscriptions.subscriptions.resume(tenantId);
await subscriptions.subscriptions.reactivate(tenantId);
await subscriptions.subscriptions.renew(tenantId); // trusted scheduled collection
```

Trusted administrative callers can deliberately grant access with `create(tenantId, plan.id, { policy: "manual_invoice" })` or `{ policy: "complimentary" }`. Use `renewAdministrative(tenantId, { policy: "manual_invoice" | "complimentary" })` for the corresponding server-authorized renewal policy. These choices are privileged service operations and must not be passed through public request bodies. An incomplete Moyasar purchase can be collected by trusted `renew` after the server stores a verified reusable payment-method binding; client payment references never constitute settlement.

Useful helpers:

- `get(subscriberId)`
- `previewChangePlan(subscriberId, newPlanId)`
- `pause(subscriberId)`
- `resume(subscriberId)`
- `reactivate(subscriberId)`
- `startTrial(subscriberId, planId, days)`
- `extendTrial(subscriberId, days)`
- `isActive(subscriberId)`
- `isTrialing(subscriberId)`
- `daysRemaining(subscriberId)`

### Permissions and Usage

```ts
await subscriptions.permissions.assertCan(tenantId, "customDomain");
await subscriptions.permissions.assertCanUse(tenantId, "maxProducts", 5);

const allFeatures = await subscriptions.permissions.getFeatures(tenantId);
const allUsage = await subscriptions.permissions.getAllUsage(tenantId);

await subscriptions.permissions.setUsage(tenantId, "maxProducts", 42);
await subscriptions.permissions.resetUsage(tenantId, "maxProducts");
```

### Webhooks

Webhook handlers accept raw payloads as `string | Uint8Array`.

```ts
const event = await subscriptions.handleWebhook(
  "moyasar-sa-live", // registered provider account ID
  rawBody,
  signature,
);
```

This works in Node.js, Bun, and edge-style runtimes as long as you preserve the raw request body.
Authentication is provider-specific: Moyasar verifies the body's `secret_token`; other providers use their documented headers/signatures. A request does not require a universal signature header. See the adapter documentation for each provider's contract.

### Invoices

Paid subscription operations return/persist their settlement invoice. For a deliberate administrative manual invoice, create an open invoice; creating an invoice is not payment proof or a public access-grant operation.

```ts
const invoice = await subscriptions.invoices.create({
  subscriptionId: subscription.id,
  amount: 49,
  currency: "USD",
  status: "open",
  lineItems: [
    {
      description: "Pro monthly subscription",
      quantity: 1,
      unitPrice: 49,
      amount: 49,
    },
  ],
});

const detailed = await subscriptions.invoices.getWithDetails(invoice.id);
```

Invoice HTML rendering is available across supported runtimes. The Node/Bun PDF renderer uses `puppeteer-html-pdf`; Workers PDF rendering requires Browser Rendering and the Cloudflare renderer.

## Elysia Integration

The package exports `elysiaPlugin` from `@abshahin/subscriptions/elysia`.

```ts
import { Elysia } from "elysia";
import { elysiaPlugin } from "@abshahin/subscriptions/elysia";
import { subscriptions } from "./subscriptions";
import { resolveAuthenticatedTenant, authorizeTenantBillingOperation, isPlanAdministrator } from "./auth";

const app = new Elysia().use(
  elysiaPlugin(subscriptions, {
    prefix: "/subscriptions",
    getSubscriberId: resolveAuthenticatedTenant,
    authorizeSubscriber: authorizeTenantBillingOperation,
    adminRoutes: true,
    adminGuard: isPlanAdministrator,
    invoice: {
      platform: {
        name: "Manhali",
        website: "https://example.com",
        supportEmail: "support@example.com",
      },
      locale: "ar-EG",
      getSubscriberInfo: async (subscriberId) => ({
        name: `Tenant ${subscriberId}`,
      }),
    },
  }),
);
```

The application supplies `resolveAuthenticatedTenant` from a verified session and `authorizeTenantBillingOperation` to check membership and permissions for each operation. Subscriber routes fail closed when no trusted resolver is supplied. Administrative routes are disabled by default; enabling them requires an explicit administrative guard.

Built-in routes include:

- `GET /current`
- `GET /plans`
- `POST /subscribe`
- `POST /create`
- `POST /change-plan`
- `GET /change-plan/preview/:planId`
- `POST /cancel`
- `POST /resume`
- `POST /reactivate`
- `GET /features`
- `GET /usage`
- `GET /usage/:feature`
- `GET /can/:feature`
- `GET /invoices`
- `GET /invoices/:id/download`
- `POST /webhooks/:provider`

It also adds route macros for controller-level enforcement:

```ts
app.get("/analytics", handler, {
  requireFeature: "analyticsEnabled",
});

app.post("/products", handler, {
  requireUsage: { feature: "maxProducts", count: 1 },
});

app.post("/products", handler, {
  useFeature: "maxProducts",
});
```

If you enable invoice downloads through the Elysia plugin, run that endpoint on Node.js and install `puppeteer-html-pdf`.

## Payments

Payments are optional. Deliberate manual invoicing and complimentary access use explicit administrative policies. Paid self-service purchases cannot activate through absence of an adapter.

For Moyasar:

```ts
import { moyasarAdapter } from "@abshahin/subscriptions/adapters/moyasar";

const payment = moyasarAdapter({
  secretKey: process.env.MOYASAR_SECRET_KEY!,
  publishableKey: process.env.MOYASAR_PUBLIC_KEY!,
  webhookSecret: process.env.MOYASAR_WEBHOOK_SECRET,
  callbackUrl: "https://app.example.com/subscription",
});

const subscriptions = createSubscriptions({
  database: prismaAdapter(db),
  features,
  providers: [{
    id: "moyasar-sa-live",
    accountId: "merchant-account-id",
    environment: "live",
    billingOwner: "sdk_managed",
    adapter: payment,
  }],
  defaultProvider: "moyasar-sa-live",
});
```

Stripe (`@abshahin/subscriptions/adapters/stripe`), Paddle (`@abshahin/subscriptions/adapters/paddle`), and Lemon Squeezy (`@abshahin/subscriptions/adapters/lemonsqueezy`) adapters ship as well — all dependency-free (`fetch` + Web Crypto). See `docs/adapters.md`.

Each subscription persists its owning provider/account/environment and separate `externalCustomerId`, `externalPaymentMethodId`, and optional `externalSubscriptionId` in `billing`. Moyasar is a token-payment provider with SDK-managed scheduling. Changing the configured default does not migrate existing subscriptions. A reusable payment token is not a customer ID or proof that a purchase was paid. See the integration guide for trusted resource binding and settlement.

Polar and Creem adapters are not implemented. The provider registry establishes the ownership and routing foundation for them; native checkout, catalog synchronization, webhooks, and subscription lifecycle integration remain separate work. Unsupported provider-managed operations fail explicitly.

## Prisma Schema Requirements

The package expects the core subscription models plus durable billing operation, provider-resource mapping, and outbox storage for financial operations:

- `SubscriptionPlan`
- `Subscription`
- `Invoice`
- `UsageRecord`
- `BillingOperation`, `ProviderResource`, `BillingOutbox`, and `BillingSequence`
- `Coupon` and `CouponRedemption` when using coupons

See `docs/prisma-schema.md` for a schema example based on the backend project.

## What Stays Outside This Package

The backend project uses this package as the subscription source of truth, but keeps a few concerns in app code:

- cron-based renewal orchestration
- tenant-aware cache invalidation across the broader app
- authentication, tenant membership, and server verification of payment-method ownership

This package owns subscription state, conditional durable usage admission, payment attempts and settlement effects. Application dashboards and read caches must not replace durable admission or initiate another charge after an unknown outcome. SDK outbox delivery is at least once; consumers must deduplicate using the event ID.

Security migration: supply trusted subscriber identity and membership authorization; configure a cache namespace and explicit provider account identity; backfill existing subscriptions' owning provider/resource IDs and verified paid-price snapshots. Public payment assertions and configurable public trial duration are rejected. Migrate the documented persistence schema before collection. D1 and unverified async driver modes cannot perform the interactive financial transactions required by this release. See `docs/AUDIT_REMEDIATION.md` for finding-specific changes and validation limits.

## Type Safety

The package provides full type inference for features:

```ts
const features = defineFeatures({
  analytics: { type: "boolean", default: false },
  maxProducts: { type: "limit", default: 100, usage: { kind: "persistent" } },
});

await subs.can(tenantId, "analytics");
await subs.permissions.getFeatures(tenantId);
```

## Documentation

- `CHANGELOG.md`
- `docs/README.md`
- `docs/runtime-support.md`
- `docs/adapters.md`
- `docs/billing.md`
- `docs/coupons.md`
- `docs/dunning.md`
- `docs/events.md`
- `docs/audit.md`
- `docs/testing.md`
- `docs/error-handling.md`
- `docs/integration-guide.md`
- `docs/prisma-schema.md`

## License

MIT
