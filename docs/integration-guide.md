# Integration Guide

This guide documents the integration pattern already used in the backend project. It focuses on the current package API, not a hypothetical future abstraction.

The backend uses `@abshahin/subscriptions` as the subscription source of truth and adds app-level layers around it for faster usage counters and scheduled renewals.

## Recommended Architecture

Split the integration into three layers:

1. A single shared subscriptions instance in your application core
2. An Elysia controller exposing subscription routes and policy checks
3. Optional app-specific infrastructure for Redis counters, cron jobs, and payment verification callbacks

## 1. Define Features in One Place

The backend keeps all subscription features in one module and exports the inferred feature type.

```ts
import { defineFeatures } from "@abshahin/subscriptions";

export const features = defineFeatures({
  analyticsEnabled: {
    type: "boolean",
    default: true,
    description: "Visitor analytics and reporting",
  },
  certificatesEnabled: {
    type: "boolean",
    default: true,
    description: "Issue completion certificates",
  },
  customDomain: {
    type: "boolean",
    default: true,
    description: "Connect custom domain to store",
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
  maxMembers: {
    type: "limit",
    default: -1,
    description: "Maximum team members",
  },
  transactionFee: {
    type: "rate",
    default: 5,
    description: "Platform transaction fee percentage",
  },
});

export type AppFeatures = typeof features;
```

## 2. Create a Shared Subscriptions Instance

```ts
import { createSubscriptions } from "@abshahin/subscriptions";
import type { CacheAdapter } from "@abshahin/subscriptions/adapters/cache";
import { moyasarAdapter } from "@abshahin/subscriptions/adapters/moyasar";
import { prismaAdapter } from "@abshahin/subscriptions/adapters/prisma";
import { db } from "./db";
import { features } from "./features";

const paymentAdapter = process.env.MOYASAR_LIVE_SECRET_KEY
  ? moyasarAdapter({
      secretKey: process.env.MOYASAR_LIVE_SECRET_KEY,
      publishableKey: process.env.MOYASAR_LIVE_PUBLIC_KEY ?? "",
      webhookSecret: process.env.MOYASAR_WEBHOOK_SECRET,
      callbackUrl: "https://platform.example.com/subscription",
    })
  : undefined;

const cacheAdapter: CacheAdapter = {
  async get<T>(key) {
    try {
      return await redis.get<T>(`subscriptions:${key}`);
    } catch {
      return null;
    }
  },
  async set<T>(key, value, ttlSeconds) {
    try {
      await redis.set(`subscriptions:${key}`, value, { ttl: ttlSeconds });
    } catch {
      // cache failures should not break billing
    }
  },
  async delete(key) {
    try {
      await redis.del(`subscriptions:${key}`);
    } catch {
      // ignore cache delete failures
    }
  },
  async deletePattern(pattern) {
    try {
      await redis.deleteByPattern(`subscriptions:${pattern}`);
    } catch {
      // ignore cache delete failures
    }
  },
};

export const subscriptions = createSubscriptions({
  database: prismaAdapter(db),
  features,
  cache: cacheAdapter,
  payment: paymentAdapter,
  options: {
    subscriberType: "tenant",
    trialDays: 14,
    gracePeriodDays: 3,
    defaultCurrency: "USD",
    cacheTtlSeconds: 300,
  },
});
```

This is the same overall pattern used in the backend project.

## 3. Resolve Subscriber IDs from Auth Context

The package itself stays neutral about auth. In the backend integration, the subscriber ID is the current tenant ID.

```ts
function extractTenantId(ctx: {
  user?: { activeTenantId?: string | null };
  member?: { tenantId: string } | null;
}): string {
  const tenantId = ctx.user?.activeTenantId ?? ctx.member?.tenantId ?? null;

  if (!tenantId) {
    throw new Error("Tenant context required");
  }

  return tenantId;
}
```

Keep this resolution logic in one place. It reduces route bugs and makes it easier to evolve auth later.

## 4. Mount the Elysia Plugin

```ts
import { Elysia } from "elysia";
import { elysiaPlugin } from "@abshahin/subscriptions/elysia";
import { subscriptions } from "./subscriptions";

const app = new Elysia().use(
  elysiaPlugin(subscriptions, {
    prefix: "/subscriptions",
    getSubscriberId: extractTenantId,
    adminRoutes: true,
    adminGuard: (ctx) => ctx.user?.role === "admin",
    invoice: {
      platform: {
        name: "Manhali",
        website: "https://example.com",
        supportEmail: "support@example.com",
      },
      locale: "ar-EG",
      getSubscriberInfo: async (tenantId) => {
        const tenant = await db.tenant.findUnique({
          where: { id: tenantId },
          select: { name: true },
        });

        return tenant ? { name: tenant.name ?? undefined } : null;
      },
    },
  }),
);
```

This gives you the built-in subscription endpoints plus admin plan management endpoints.

## 5. Use Controller Macros for Feature Enforcement

The built-in Elysia macros are useful when your application uses the package's database-backed usage records directly.

```ts
app.get("/analytics", handler, {
  requireFeature: "analyticsEnabled",
});

app.post("/courses", handler, {
  requireUsage: { feature: "maxCourses", count: 1 },
});

app.post("/courses", handler, {
  useFeature: "maxCourses",
});
```

In the backend project, controller-level macros are still valuable, but some domain modules route usage tracking through a Redis-backed layer for speed. That is an application concern on top of this package, not a package requirement.

## 6. Handle Payment-Backed Upgrades Carefully

The backend uses saved Moyasar token IDs for plan upgrades and renewals.

Typical upgrade flow:

1. Frontend verifies the card or reusable payment source.
2. App stores the reusable token as `gatewayCustomerId` on the subscription.
3. App calls `subscriptions.subscriptions.changePlan(...)`.
4. If payment succeeds, app creates an invoice.
5. If 3DS is required, the result exposes `paymentPending` and `verificationUrl`.

Example:

```ts
const result = await subscriptions.subscriptions.changePlan(
  tenantId,
  newPlanId,
  {
    prorate: true,
    verifiedTokenId: verifiedTokenIdFromFrontend,
    callbackUrl: "https://platform.example.com/subscription/callback",
  },
);

if (result.paymentPending) {
  return {
    verificationUrl: result.verificationUrl,
  };
}

if (result.charged && result.paymentId) {
  await subscriptions.invoices.create({
    subscriptionId: result.subscription.id,
    amount: result.subscription.plan.price,
    currency: result.subscription.plan.currency,
    status: "paid",
    gatewayInvoiceId: result.paymentId,
  });
}
```

## 7. Keep Hot-Path Counters Outside the Package When Needed

The package already persists usage through `UsageRecord` and exposes `permissions.use`, `release`, and `remaining`.

The backend adds a Redis-backed hot-path usage layer because some domain endpoints need lower latency and atomic counters shared across many writes.

That pattern works well when you need:

- faster admission checks than a database round trip
- periodic reconciliation from domain entities
- tenant-specific dashboards with near-real-time numbers

The important boundary is this:

- package: subscription policy, plan definitions, persisted usage records
- app: performance optimizations, reconciliation jobs, tenant dashboards

## 8. Add Renewal Scheduling in App Code

Scheduled billing orchestration stays in application code, not the package.

The backend project runs a cron job that:

- finds subscriptions nearing expiry
- charges saved payment sources through Moyasar
- renews subscriptions on success
- creates invoices
- records payment failure metadata when renewals fail

The package supports this well because the renewal step is small:

```ts
await subscriptions.subscriptions.renew(tenantId);
```

Everything around that call, including selection logic, retries, notifications, and failure thresholds, belongs in your app.

## 9. Expose Tenant-Specific Dashboard Endpoints Separately

The backend project adds custom routes such as tenant usage summaries and tenant batch capability checks. Those routes sit next to the package plugin rather than inside it.

This is a good pattern whenever you need:

- auth or tenant rules that are app-specific
- response shapes tailored to a frontend dashboard
- data combined from subscriptions and domain entities

## Checklist

Before shipping your integration, verify the following:

- Prisma models match the package adapter expectations
- feature keys are stable and centrally defined
- subscriber ID extraction is consistent across routes
- payment adapter configuration is optional in non-billing environments
- invoice creation happens after confirmed payment events
- cache failures never break subscription logic
- renewal jobs are idempotent

If you expose invoice downloads through the Elysia plugin, add one more deployment check:

- invoice download routes run on Node.js and have `puppeteer-html-pdf` installed
