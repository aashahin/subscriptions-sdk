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
| `PaymentFailedError`           | `PAYMENT_FAILED`            | 402    | Provider confirmed failure or a required payment method is unavailable |
| `InvalidPlanError`             | `INVALID_PLAN`              | 400    | Plan feature overrides failed validation                        |
| `DuplicateSubscriptionError`   | `DUPLICATE_SUBSCRIPTION`    | 409    | Subscriber already has an active subscription                   |
| `SubscriptionNotCanceledError` | `SUBSCRIPTION_NOT_CANCELED` | 400    | Resume or reactivate was called in the wrong state              |
| `CouponNotFoundError`          | `COUPON_NOT_FOUND`          | 404    | Coupon code does not exist                                      |
| `CouponInvalidError`           | `COUPON_INVALID`            | 400    | Coupon is inactive, expired, or exhausted (`reason` field)      |
| `InvoiceVoidError`             | `INVOICE_VOID`              | 400    | Invoice cannot be voided or credited in its current state       |
| `SubscriptionError`            | `PAYMENT_OUTCOME_UNKNOWN`   | 409    | Collection may have succeeded; reconcile the persisted attempt before retrying |
| `SubscriptionError`            | `QUOTE_REQUIRED` / `QUOTE_EXPIRED` | 409 | Preview and confirm the current payable quote |
| `SubscriptionError`            | `BILLING_STORAGE_UNSUPPORTED` | 409  | Driver/schema cannot provide the required financial transaction |
| `SubscriptionError`            | `PROVIDER_BINDING_REQUIRED` | 409    | Legacy subscription needs provider/account/environment backfill |
| `SubscriptionError`            | `ATOMIC_USAGE_NOT_SUPPORTED` | 501  | Capped usage adapter lacks conditional admission |
| `SubscriptionError`            | `INVALID_USAGE_VALUE`      | 400    | Quantity is not an allowed safe integer |
| `SubscriptionError`            | `CACHE_NAMESPACE_REQUIRED` | 400    | Real cache lacks an application/database/environment namespace |

## Recommended Pattern

Catch specific package errors first, then fall back to the base `SubscriptionError`.

```ts
try {
  // This performs durable conditional admission; preview checks do not reserve.
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
  const preview = await subscriptions.subscriptions.previewChangePlan(tenantId, nextPlanId);
  // Present the quote to the authenticated subscriber and obtain confirmation.
  await subscriptions.subscriptions.changePlan(tenantId, nextPlanId, {
    quoteId: preview.quoteId,
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

Transport failures may mean the provider accepted the charge. The SDK persists an unknown attempt and returns `PAYMENT_OUTCOME_UNKNOWN`; log the context and reconcile that same attempt. Do not start a new charge, release a coupon reservation, or manually grant access on the assumption that a rejected HTTP call proves payment failure. Confirmed failures may advance to a cycle-scoped server retry according to the dunning policy. Expired quotes require another preview and renewed confirmation.

Provider-managed subscriptions reject local scheduled collection with `PROVIDER_OWNS_BILLING`. Unsupported native lifecycle operations return `UNSUPPORTED_OPERATION`. These are integration decisions to resolve on the server, not client payment fields to override.

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

- Log payment errors with the persisted attempt identity; avoid retaining payment secrets or raw webhook authentication tokens.
- Treat `UsageLimitExceededError` and `FeatureNotAllowedError` as normal product events, not system failures.
- Keep error codes stable if your frontend depends on them.
- When adding custom routes around the package, preserve `statusCode` unless you have a deliberate API contract reason to remap it.
- Configure trusted identity and operation-level tenant membership authorization before exposing routes. Missing identity returns 401; denied permissions return 403. Administrative guards are separate from subscriber authentication.
