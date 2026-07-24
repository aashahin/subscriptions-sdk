# Testing

The `@abshahin/subscriptions/testing` export gives you in-memory adapters, a fake payment gateway, and conformance suites so you can test your application — and any custom adapters you write — without infrastructure.

```ts
import {
  memoryDatabaseAdapter,
  memoryCacheAdapter,
  fakePaymentGateway,
  databaseAdapterConformance,
  cacheAdapterConformance,
} from "@abshahin/subscriptions/testing";
```

This subpath is not pulled into production bundles unless you import it explicitly.

## In-Memory Adapters

### `memoryDatabaseAdapter()`

A full `DatabaseAdapter` implementation backed by in-memory maps: plans (including `findAllForAdmin` filtering/pagination), subscriptions (status filters, expiring windows), invoices (including `findByGatewayInvoiceId` for idempotent webhook handling), usage tracking with never-below-zero decrements, and transactions all behave like the real adapters.

```ts
import { createSubscriptions, defineFeatures } from "@abshahin/subscriptions";
import {
  memoryDatabaseAdapter,
  memoryCacheAdapter,
} from "@abshahin/subscriptions/testing";

const features = defineFeatures({
  analytics: { type: "boolean", default: false },
  maxProducts: { type: "limit", default: 100 },
});

function buildSubs() {
  return createSubscriptions({
    database: memoryDatabaseAdapter(),
    features,
    cache: memoryCacheAdapter(),
  });
}
```

Create a fresh instance per test for isolation.

### `memoryCacheAdapter()`

A `CacheAdapter` with TTL support (expiry is lazy — entries expire on read). Useful both in unit tests and as a dev-mode cache.

## `fakePaymentGateway()`

A scriptable `PaymentGatewayAdapter` for payment flows:

```ts
const gateway = fakePaymentGateway({
  provider: "fake", // default
  // Queue of outcomes consumed one per charge; when empty, charges succeed:
  chargeOutcomes: ["failed", "paid"],
});

const subs = createSubscriptions({
  database: memoryDatabaseAdapter(),
  features,
  payment: gateway,
});

// Inspect what your code did:
expect(gateway.calls[0].method).toBe("chargePayment");
```

Behavior controls:

- `chargeOutcomes`: a queue of `'paid' | 'pending' | 'failed'`, partial `ChargePaymentResult` objects, or functions of the charge input — one consumed per `chargePayment` call. Add more mid-test with `gateway.queueChargeOutcome(outcome)`.
- `gateway.calls`: every call made to the adapter, in order (`{ method, args }`), for assertions. Reset with `gateway.clearCalls()` or `gateway.reset()`.
- `constructWebhookEvent` accepts unsigned JSON payloads of the shape `{ "type": string, "data": object }`, so you can drive `subs.handleWebhook("fake", JSON.stringify(event), "")` in tests without signing anything. Set `webhookSecret` to exercise signature verification (HMAC-SHA256, `sha256=<hex>`).

Typical scenarios it covers end-to-end: paid subscribe with invoice creation, upgrade proration, failed renewal → dunning retries → pause, and idempotent webhook replay.

## Conformance Suites for Custom Adapters

If you implement your own database or cache adapter, run the same behavioral contract the shipped adapters are tested against. The suites register `bun:test` `describe`/`it` blocks (the runner is imported lazily, so importing the module never loads it in production) and run with `bun test`.

```ts
// tests/conformance.drizzle.test.ts
import { databaseAdapterConformance } from "@abshahin/subscriptions/testing";
import { drizzleAdapter } from "@abshahin/subscriptions/adapters/drizzle";

// The factory must return a FRESH adapter backed by an empty database
// for every call (the suite tests isolation and atomicity).
await databaseAdapterConformance("drizzleAdapter", () =>
  drizzleAdapter(createTestDb()),
);
```

```ts
import { cacheAdapterConformance } from "@abshahin/subscriptions/testing";
import { redisCacheAdapter } from "@abshahin/subscriptions/adapters/redis";

await cacheAdapterConformance("redisCacheAdapter", () =>
  redisCacheAdapter(createTestRedis()),
);
```

The database suite covers, among others: plan CRUD and filtering, subscription lifecycle persistence, invoice creation and `findByGatewayInvoiceId`, usage increment/decrement atomicity and the zero floor, and transaction commit/rollback. The cache suite covers TTL expiry, `deletePattern`, the optional `incrBy`/`decrBy` counters, and key existence checks.

An adapter that passes its conformance suite is a drop-in replacement for the shipped ones.
