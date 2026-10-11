# Integration Guide

The SDK owns subscription policy, durable usage admission, payment attempts, and settlement effects. Your application supplies authentication, tenant permissions, provider credentials, verified resource ownership, and a scheduler. Review the [schema migrations](prisma-schema.md) and [audit remediation record](AUDIT_REMEDIATION.md) before upgrading an existing installation.

## Define Feature Policies

```ts
import { defineFeatures } from "@abshahin/subscriptions";

export const features = defineFeatures({
  analyticsEnabled: { type: "boolean", default: false },
  maxProducts: {
    type: "limit", default: 10,
    usage: { kind: "persistent" },
  },
  maxMembers: {
    type: "limit", default: 3,
    usage: { kind: "persistent" },
  },
  apiRequests: {
    type: "limit", default: 1000,
    usage: { kind: "periodic", reset: "calendar-month" },
  },
  meteredExports: {
    type: "metered", default: 100,
    usage: { kind: "periodic", reset: "subscription-cycle" },
  },
  transactionFee: { type: "rate", default: 5 },
});
```

Existing products and team members remain counted across month boundaries. Periodic policies use UTC calendar months or the persisted subscription cycle. Omitted policies retain calendar-month behavior; migrate inventory features by reconciling their current domain resource counts with `setUsage`.

## Configure Storage, Cache, and Provider Identity

```ts
import { createSubscriptions } from "@abshahin/subscriptions";
import { prismaAdapter } from "@abshahin/subscriptions/adapters/prisma";
import { moyasarAdapter } from "@abshahin/subscriptions/adapters/moyasar";
import { redisCacheAdapter } from "@abshahin/subscriptions/adapters/redis";
import { Redis } from "ioredis";
import { db } from "./db";
import { features } from "./features";

const database = prismaAdapter(db);
export const subscriptions = createSubscriptions({
  database,
  features,
  cache: redisCacheAdapter(new Redis(process.env.REDIS_URL!)),
  providers: [{
    id: "moyasar-sa-live",
    accountId: "your-merchant-account-id",
    environment: "live",
    billingOwner: "sdk_managed",
    adapter: moyasarAdapter({
      secretKey: process.env.MOYASAR_SECRET_KEY!,
      webhookSecret: process.env.MOYASAR_WEBHOOK_SECRET!,
    }),
  }],
  defaultProvider: "moyasar-sa-live",
  options: {
    subscriberType: "tenant",
    trialDays: 14,
    gracePeriodDays: 3,
    defaultCurrency: "SAR",
    cacheNamespace: "my-app:production:main-db",
    cacheTtlSeconds: 300,
  },
});
```

The namespace must identify the application, environment, and database; every real cache requires it. Cache outages cannot reverse durable usage or make a committed plan update appear failed. Entitlement reads check authoritative subscription eligibility and plan features before using cached values.

Financial operations require awaited transactions, durable billing operations, provider-resource mappings, invoice sequencing, and an outbox. Install the documented schema before collection. Prisma transaction support depends on the connected database/driver. The Drizzle adapter's verified SQLite transaction mode is covered by real `bun:sqlite` tests; D1 and unspecified async driver modes fail closed for interactive financial transactions. Do not interpret memory conformance or a successful bundle as database financial integration evidence.

## Authenticate and Authorize Every Subscriber Operation

```ts
import { Elysia } from "elysia";
import { elysiaPlugin } from "@abshahin/subscriptions/elysia";
import { authenticatedSession, canManageTenantBilling, isPlanAdministrator } from "./auth";

const app = new Elysia().use(elysiaPlugin(subscriptions, {
  getSubscriberId: async ctx => (await authenticatedSession(ctx))?.activeTenantId ?? null,
  authorizeSubscriber: async (ctx, tenantId, operation) => {
    const session = await authenticatedSession(ctx);
    return !!session && await canManageTenantBilling(session, tenantId, operation);
  },
  adminRoutes: true,
  adminGuard: isPlanAdministrator,
}));
```

These auth functions belong to your application. Verify the session, current tenant membership, and operation permission against server-controlled records. A selected tenant ID alone does not prove membership. All subscriber routes fail closed without a trusted resolver. If you omit `authorizeSubscriber`, the resolver must enforce the relevant membership and operation permissions itself. Administrative routes are disabled by default and require their own explicit guard when enabled.

The fetch handler, Hono wrapper, and Next.js wrapper follow the same trust contract. Do not derive identity directly from caller-supplied headers or request bodies.

## Create Purchases and Bind Verified Payment Methods

Public `/subscribe` and `/create` accept the requested plan, then derive trial eligibility and duration from trusted policy. They reject client financial assertions, provider/resource bindings, administrative grant policies, and trial overrides. New purchases into inactive plans are rejected.

```ts
const subscription = await subscriptions.subscriptions.createSelfService(tenantId, planId);
// A paid plan without an eligible trial has status "incomplete".
```

Moyasar provides token payments, so the SDK schedules its renewals. After a server-side provider lookup verifies that a reusable payment method belongs to the authenticated subscriber and the intended merchant/environment, persist the ownership mapping and subscription binding. This is a trusted application operation; the example assumes verification already happened:

```ts
await subscriptions.bindProviderResource({
  providerId: "moyasar-sa-live",
  accountId: "your-merchant-account-id",
  environment: "live",
  kind: "payment_method",
  localId: `${tenantId}:${verifiedPaymentMethodId}`,
  externalId: verifiedPaymentMethodId,
});

const current = await subscriptions.subscriptions.get(tenantId);
if (!current?.billing) throw new Error("Verified provider ownership backfill required");
// Retain the existing billing ownership; replace only verified resource fields.
await database.subscriptions.update(current.id, {
  billing: {
    ...current.billing,
    externalPaymentMethodId: verifiedPaymentMethodId,
    ...(verifiedCustomerId ? { externalCustomerId: verifiedCustomerId } : {}),
  },
});

// Trusted server collection for the incomplete purchase.
await subscriptions.subscriptions.renew(tenantId);
```

Keep customer IDs, reusable payment-method IDs, and native subscription IDs distinct. A token's existence does not prove settlement. `renew` persists an immutable purchase/attempt before calling the provider, then verifies settlement amount, currency, scope, and resource/purchase binding before granting paid entitlement and persisting its invoice. Server resource association must never be exposed as a generic public metadata update.

Legacy subscriptions require an explicit backfill of provider/account/environment ownership, mapped resources, and verified historical paid-price snapshots where proration credit applies. A default provider affects new subscriptions; changing it does not migrate existing billing ownership.

## Confirm Plan-Change Quotes and Use the Returned Invoice

```ts
const preview = await subscriptions.subscriptions.previewChangePlan(tenantId, newPlanId, {
  immediately: true,
  prorate: true,
});
// Present preview.amountDueFormatted (major units), currency, and validUntil.
// After the authenticated subscriber confirms this quote:
const result = await subscriptions.subscriptions.changePlan(tenantId, newPlanId, {
  quoteId: preview.quoteId,
  immediately: true,
  prorate: true,
});

if (result.invoice) {
  return { subscription: result.subscription, invoice: result.invoice };
}
```

`amountDue` is in minor units; `amountDueFormatted` is the display amount in major units. Payable changes require the persisted quote identity. Expiration, subscription changes, or price changes require another preview and confirmation. Preserve the same timing/proration options. Immediate remaining-period proration preserves the existing billing anchor; deferred changes collect at renewal. Cross-currency and interval changes require an explicit migration policy and currently reject.

The operation creates the invoice using the actual immutable settlement quote. Do not create a second invoice using the full destination plan price. A callback URL or browser confirmation does not constitute payment evidence. Payment authentication/unknown outcomes are reconciled through persisted attempts and verified provider data; the SDK does not promise a working hosted frontend flow for every provider.

## Explicit Administrative Grants

```ts
// Authorized server staff/policy only:
await subscriptions.subscriptions.create(tenantId, planId, { policy: "manual_invoice" });
// Or create(..., { policy: "complimentary" }) for deliberate free access.
await subscriptions.subscriptions.renewAdministrative(tenantId, { policy: "manual_invoice" });
```

Manual invoicing grants entitlement under your explicit authorized credit policy and creates an open invoice; complimentary access grants deliberately without treating it as paid credit. Neither policy is a public purchase field. Trial start/extension and staff grants must remain protected administrative operations.

## Durable Usage Admission

```ts
const admitted = await subscriptions.use(tenantId, "maxProducts", 1);
try {
  await createProductInYourDomain();
} catch (error) {
  await subscriptions.release(tenantId, "maxProducts", 1);
  throw error;
}
```

`use` performs conditional database admission; previews and read caches do not reserve capacity. Align admission/release with domain transaction or durable operation IDs if requests can retry after a crash. The SDK's usage API is not a complete distributed transaction with arbitrary domain writes. Reconcile inventories from domain records when necessary. Metered overage and unlimited caps still require subscription eligibility; all quantities must be safe integers. Do not replace admission with a Redis read/check/increment sequence.

## Scheduling, Webhooks, and Delivery

Your scheduler selects due SDK-managed subscriptions and invokes `renew`. The SDK owns stable attempts, settlement invoice creation, cycle-scoped dunning, and payment reconciliation. Avoid collecting directly and then manually marking a renewal paid. Unknown payment outcomes must be reconciled before starting a new collection. Provider-managed subscriptions reject local scheduled collection; authoritative provider settlement/period events drive their owning integration.

Webhook URLs identify the registered provider account, for example `/subscriptions/webhooks/moyasar-sa-live`. Forward the original body and provider headers. Moyasar authenticates a body `secret_token`; HMAC providers use their documented raw-body headers. Provider snapshots are not payment evidence.

With supported local transaction capabilities, domain events and business effects commit together. `withEvents` relays persisted outbox events; delivery is at least once, so consumers deduplicate by event ID. A delivery failure leaves the outbox record retryable. See [events.md](events.md).

## Provider and Runtime Limits

Moyasar, Stripe, Paddle, and Lemon Squeezy adapters expose different capabilities; they are not interchangeable billing schedulers. Polar and Creem integrations are not implemented. The registry supports explicit account identity, persisted ownership, and scoped resource routing as a foundation for future integrations; unsupported native checkout/catalog/subscription paths fail explicitly.

See [runtime-support.md](runtime-support.md) for runtime and transaction limits, [adapters.md](adapters.md) for contracts, and [AUDIT_REMEDIATION.md](AUDIT_REMEDIATION.md) for actual checks and remaining external verification.
