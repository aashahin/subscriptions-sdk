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
