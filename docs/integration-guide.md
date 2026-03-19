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
  \*\*\* Add File: /home/shhain/Documents/projects/personal/manhali/manhali/packages/subscriptions/docs/error-handling.md

# Error Handling

All package-specific errors extend `SubscriptionError` and include a machine-readable `code` plus an HTTP-friendly `statusCode`.

## Error Types

```ts
import {
  SubscriptionError,
  PlanNotFoundError,
  SubscriptionNotFoundError,
  FeatureNotAllowedError,
  UsageLimitExceededError,
  SubscriptionExpiredError,
  SubscriptionInactiveError,
  PaymentGatewayError,
  PaymentFailedError,
  InvalidPlanError,
  DuplicateSubscriptionError,
  SubscriptionNotCanceledError,
} from "@abshahin/subscriptions";
```

## Reference

| Error class                    | Code                        | Status | Typical cause                                                   |
| ------------------------------ | --------------------------- | ------ | --------------------------------------------------------------- |
| `PlanNotFoundError`            | `PLAN_NOT_FOUND`            | 404    | Requested plan ID does not exist                                |
| `SubscriptionNotFoundError`    | `SUBSCRIPTION_NOT_FOUND`    | 404    | Subscriber has no subscription                                  |
| `FeatureNotAllowedError`       | `FEATURE_NOT_ALLOWED`       | 403    | Boolean feature is disabled for the current plan                |
| `UsageLimitExceededError`      | `USAGE_LIMIT_EXCEEDED`      | 403    | A numeric feature limit has been exhausted                      |
| `SubscriptionExpiredError`     | `SUBSCRIPTION_EXPIRED`      | 402    | Subscription period expired                                     |
| `SubscriptionInactiveError`    | `SUBSCRIPTION_INACTIVE`     | 402    | Subscription is canceled, paused, unpaid, or otherwise inactive |
| `PaymentGatewayError`          | `PAYMENT_GATEWAY_ERROR`     | 502    | Gateway call failed at the integration layer                    |
| `PaymentFailedError`           | `PAYMENT_FAILED`            | 402    | Charge was declined or could not complete                       |
| `InvalidPlanError`             | `INVALID_PLAN`              | 400    | Plan feature overrides failed validation                        |
| `DuplicateSubscriptionError`   | `DUPLICATE_SUBSCRIPTION`    | 409    | Subscriber already has an active subscription                   |
| `SubscriptionNotCanceledError` | `SUBSCRIPTION_NOT_CANCELED` | 400    | Resume or reactivate was called in the wrong state              |

## Recommended Pattern

Catch specific package errors first, then fall back to the base `SubscriptionError`.

```ts
try {
  await subscriptions.permissions.assertCanUse(tenantId, "maxProducts", 1);
  await subscriptions.use(tenantId, "maxProducts");
} catch (error) {
  if (error instanceof UsageLimitExceededError) {
    return {
      error: error.code,
      message: error.message,
      feature: error.feature,
      limit: error.limit,
      used: error.used,
      upgradeRequired: true,
    };
  }

  if (error instanceof FeatureNotAllowedError) {
    return {
      error: error.code,
      message: error.message,
      feature: error.feature,
      upgradeRequired: true,
    };
  }

  if (error instanceof SubscriptionError) {
    return {
      error: error.code,
      message: error.message,
    };
  }

  throw error;
}
```

## Usage Limit Failures

`UsageLimitExceededError` includes enough data to build an upgrade message immediately.

```ts
try {
  await subscriptions.use(tenantId, "maxProducts", 5);
} catch (error) {
  if (error instanceof UsageLimitExceededError) {
    console.log({
      feature: error.feature,
      limit: error.limit,
      used: error.used,
    });
  }
}
```

## Feature Gate Failures

`FeatureNotAllowedError` is the expected result when a boolean feature is disabled on the current plan.

```ts
try {
  await subscriptions.permissions.assertCan(tenantId, "customDomain");
} catch (error) {
  if (error instanceof FeatureNotAllowedError) {
    return {
      error: error.code,
      feature: error.feature,
      message: error.message,
    };
  }
}
```

## Payment Failures

`PaymentFailedError` is intended for user-facing payment failures. It exposes optional metadata from the gateway adapter.

```ts
try {
  await subscriptions.subscriptions.changePlan(tenantId, nextPlanId, {
    prorate: true,
    verifiedTokenId,
  });
} catch (error) {
  if (error instanceof PaymentFailedError) {
    return {
      error: error.code,
      message: error.message,
      paymentId: error.paymentId,
      errorCode: error.errorCode,
      isRetryable: error.isRetryable,
      userAction: error.userAction,
    };
  }
}
```

Use `PaymentGatewayError` for transport or upstream integration failures that should usually be logged and retried rather than presented as a business-rule denial.

## Subscription State Failures

When a route requires an active subscription, the most common failures are:

- `SubscriptionNotFoundError`
- `SubscriptionExpiredError`
- `SubscriptionInactiveError`

```ts
try {
  await subscriptions.permissions.getFeatures(tenantId);
} catch (error) {
  if (error instanceof SubscriptionNotFoundError) {
    return { error: error.code, message: "Select a plan first" };
  }

  if (error instanceof SubscriptionExpiredError) {
    return { error: error.code, message: "Renew subscription" };
  }

  if (error instanceof SubscriptionInactiveError) {
    return { error: error.code, message: "Billing action required" };
  }
}
```

## Elysia Integration Pattern

The package's Elysia plugin already maps package errors to HTTP responses. If you need custom shaping for your app, add a shared error handler around it.

```ts
import { Elysia } from "elysia";
import {
  FeatureNotAllowedError,
  PaymentFailedError,
  SubscriptionError,
  UsageLimitExceededError,
} from "@abshahin/subscriptions";

export const subscriptionErrorHandler = new Elysia().onError(
  ({ error, set }) => {
    if (!(error instanceof SubscriptionError)) {
      return;
    }

    set.status = error.statusCode;

    const response: Record<string, unknown> = {
      error: error.code,
      message: error.message,
    };

    if (error instanceof FeatureNotAllowedError) {
      response.feature = error.feature;
    }

    if (error instanceof UsageLimitExceededError) {
      response.feature = error.feature;
      response.limit = error.limit;
      response.used = error.used;
    }

    if (error instanceof PaymentFailedError) {
      response.paymentId = error.paymentId;
      response.errorCode = error.errorCode;
      response.isRetryable = error.isRetryable;
      response.userAction = error.userAction;
    }

    return response;
  },
);
```

## Operational Advice

- Log `PaymentGatewayError` with the upstream error payload if available.
- Treat `UsageLimitExceededError` and `FeatureNotAllowedError` as normal product events, not system failures.
- Keep error codes stable if your frontend depends on them.
- When adding custom routes around the package, preserve `statusCode` unless you have a deliberate API contract reason to remap it.
