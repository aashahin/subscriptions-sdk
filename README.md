# @abshahin/subscriptions

Type-safe subscription plans, feature gates, usage limits, invoices, and Elysia integration for TypeScript applications.

The package ships with:

- a Prisma database adapter
- an optional cache adapter interface
- an optional Moyasar payment adapter
- an optional Elysia integration with routes and controller macros

The service layer is runtime-neutral and uses web-standard primitives for binary payloads and crypto-friendly flows. The current production integration uses tenant-scoped subscriptions, but the core package still models the subscribed entity as a generic subscriber.

## What It Solves

- Define typed subscription features once
- Store plan overrides as JSON while keeping feature access type-safe
- Enforce boolean feature access and numeric usage limits
- Manage subscription lifecycle: create, change plan, cancel, pause, resume, reactivate, renew
- Verify payment webhooks without coupling the core services to one provider
- Generate invoice HTML and, in Node.js environments, invoice PDFs

## Runtime Support

- Core services and payment interfaces are runtime-neutral and accept webhook payloads as `string | Uint8Array`
- Existing Node.js callers can still pass `Buffer`, because `Buffer` extends `Uint8Array`
- Invoice PDF generation is Node.js-only because it depends on filesystem template loading and `puppeteer-html-pdf`

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
    default: true,
    description: "Visitor analytics and reporting",
  },
  customDomain: {
    type: "boolean",
    default: true,
    description: "Connect a custom domain",
  },
  maxCourses: {
    type: "limit",
    default: -1,
    description: "Maximum number of courses",
  },
  maxProducts: {
    type: "limit",
    default: -1,
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

`defineFeatures` supports three feature kinds:

- `boolean`: enable or disable a capability
- `limit`: numeric usage caps, with `-1` meaning unlimited
- `rate`: numeric values such as fees or delays

Plan records only store overrides. Any omitted feature falls back to the default declared in `defineFeatures`.

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
const subscription = await subscriptions.subscriptions.create(
  tenantId,
  plan.id,
  {
    trialDays: 14,
    gatewayCustomerId: "token_or_customer_id",
  },
);

await subscriptions.subscriptions.changePlan(tenantId, "plan_enterprise", {
  prorate: true,
  verifiedTokenId: "verified_token_id",
});

await subscriptions.subscriptions.cancel(tenantId, { immediately: false });
await subscriptions.subscriptions.resume(tenantId);
await subscriptions.subscriptions.reactivate(tenantId);
await subscriptions.subscriptions.renew(tenantId);
```

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
  "moyasar",
  rawBody,
  signature,
);
```

This works in Node.js, Bun, and edge-style runtimes as long as you preserve the raw request body.

### Invoices

```ts
const invoice = await subscriptions.invoices.create({
  subscriptionId: subscription.id,
  amount: 49,
  currency: "USD",
  status: "paid",
  gatewayInvoiceId: "pay_123",
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

Invoice HTML rendering and PDF generation are exported from the package root. PDF generation is intended for Node.js environments.

## Elysia Integration

The package exports `elysiaPlugin` from `@abshahin/subscriptions/elysia`.

```ts
import { Elysia } from "elysia";
import { elysiaPlugin } from "@abshahin/subscriptions/elysia";
import { subscriptions } from "./subscriptions";

const app = new Elysia().use(
  elysiaPlugin(subscriptions, {
    prefix: "/subscriptions",
    getSubscriberId: (ctx) => ctx.user.activeTenantId,
    adminRoutes: true,
    adminGuard: (ctx) => ctx.user.role === "admin",
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

Payments are optional. If no payment adapter is configured, the package still supports manual subscription management.

For Moyasar:

```ts
import { moyasarAdapter } from "@abshahin/subscriptions/adapters/moyasar";

const payment = moyasarAdapter({
  secretKey: process.env.MOYASAR_SECRET_KEY!,
  publishableKey: process.env.MOYASAR_PUBLIC_KEY!,
  webhookSecret: process.env.MOYASAR_WEBHOOK_SECRET,
  callbackUrl: "https://app.example.com/subscription",
});
```

The backend project currently uses direct payment charges plus saved token IDs for renewals and plan upgrades. That pattern is covered in the integration guide.

## Prisma Schema Requirements

The package expects four core models:

- `SubscriptionPlan`
- `Subscription`
- `Invoice`
- `UsageRecord`

See `docs/prisma-schema.md` for a schema example based on the backend project.

## What Stays Outside This Package

The backend project uses this package as the subscription source of truth, but keeps a few concerns in app code:

- Redis-backed hot-path usage counters
- cron-based renewal orchestration
- tenant-aware cache invalidation across the broader app
- payment verification callbacks specific to the frontend flow

That split is intentional. This package owns subscription state and policy. Your application can add faster counters, schedulers, and dashboards around it.

## Type Safety

The package provides full type inference for features:

```ts
const features = defineFeatures({
  analytics: { type: "boolean", default: false },
  maxProducts: { type: "limit", default: 100 },
});

await subs.can(tenantId, "analytics");
await subs.permissions.getFeatures(tenantId);
```

## Documentation

- `CHANGELOG.md`
- `docs/README.md`
- `docs/adapters.md`
- `docs/error-handling.md`
- `docs/integration-guide.md`
- `docs/prisma-schema.md`

## License

MIT
