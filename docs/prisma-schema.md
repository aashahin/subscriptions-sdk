# Prisma Schema

The core persistence models are:

- `SubscriptionPlan`
- `Subscription`
- `Invoice`
- `UsageRecord`

Financial SDK operations also require `BillingOperation`, `BillingOutbox`, `ProviderResource`, `BillingSequence`, and a connector with verified awaited interactive serializable transactions. Coupon redemption additionally requires `Coupon` and `CouponRedemption`. The four core models alone do not enable collection or atomic settlement.

The package is written around a generic `subscriberId`, but the Prisma adapter currently persists that identifier using the `tenantId` column. The schema below reflects the production backend usage and is the safest starting point for open-source users.

## Required Models

```prisma
model SubscriptionPlan {
  id            String   @id @default(cuid(2))
  name          String
  description   String?
  price         Decimal
  currency      String   @default("USD")
  interval      String
  intervalCount Int      @default(1)
  trialDays     Int      @default(0)

  features Json @default("{}")

  isActive  Boolean  @default(true)
  sortOrder Int      @default(0)
  metadata  Json?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  subscriptions Subscription[]

  @@index([isActive, sortOrder])
  @@map("subscription_plans")
}

model Subscription {
  id             String             @id @default(cuid(2))
  tenantId       String             @unique
  subscriberType String             @default("tenant")
  planId         String
  status         SubscriptionStatus

  currentPeriodStart DateTime
  currentPeriodEnd   DateTime
  cancelAt           DateTime?
  canceledAt         DateTime?
  trialStart         DateTime?
  trialEnd           DateTime?

  gatewaySubscriptionId String? @unique
  gatewayCustomerId     String?

  metadata  Json?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  invoices Invoice[]
  plan     SubscriptionPlan @relation(fields: [planId], references: [id])
  tenant   Tenant           @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([planId])
  @@index([status, currentPeriodEnd])
  @@index([gatewayCustomerId])
  @@map("subscriptions")
}

model Invoice {
  id             String        @id @default(cuid(2))
  subscriptionId String
  tenantId       String
  userId         String?
  amount         Decimal
  currency       String
  status         InvoiceStatus

  gatewayInvoiceId String?   @unique
  paidAt           DateTime?
  dueDate          DateTime?
  lineItems        Json      @default("[]")
  metadata         Json?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  subscription Subscription @relation(fields: [subscriptionId], references: [id], onDelete: Cascade)
  tenant       Tenant       @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  user         User?        @relation(fields: [userId], references: [id], onDelete: SetNull)

  @@index([tenantId, status])
  @@index([tenantId, createdAt])
  @@index([subscriptionId])
  @@index([userId])
  @@index([dueDate])
  @@map("invoices")
}

model UsageRecord {
  id           String   @id @default(cuid(2))
  subscriberId String
  tenantId     String?
  feature      String
  count        Int      @default(0)
  periodStart  DateTime
  periodEnd    DateTime
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  tenant Tenant? @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([subscriberId, tenantId, feature, periodStart])
  @@index([subscriberId, feature])
  @@index([tenantId])
  @@map("usage_records")
}

enum SubscriptionStatus {
  trialing
  active
  past_due
  canceled
  incomplete
  incomplete_expired
  unpaid
  paused
}

enum InvoiceStatus {
  draft
  open
  paid
  uncollectible
  void
}
```

## Field Expectations

### `SubscriptionPlan`

- `features` stores only plan overrides, not the fully resolved feature map
- `interval` is currently treated as a string by the adapter and service layer
- `sortOrder` drives public plan ordering

### `Subscription`

- `tenantId` is the persisted subscriber key used by the Prisma adapter
- one active subscription row per tenant is enforced by `@unique`
- `subscriberType` remains useful metadata even when the current adapter is tenant-oriented
- `gatewayCustomerId` and `gatewaySubscriptionId` are legacy compatibility fields; do not interpret them as payment proof or overload a customer ID with a reusable payment token
- `subscription.billing` exposes the persisted `_billing.binding`: provider ID, merchant account, environment, billing owner, and distinct `externalCustomerId`, `externalPaymentMethodId`, and `externalSubscriptionId`
- backfill legacy bindings and scoped resource mappings only from server-verified records; a configured default provider cannot infer historical ownership

### `Invoice`

- `amount` is stored in regular currency units in the current backend schema
- `lineItems` is JSON to avoid coupling invoice rendering to a separate relational structure
- `gatewayInvoiceId` for new paid settlements is the serialized provider/account/environment/payment identity, enabling scoped settlement deduplication; preserve historical values unless a verified migration mapping exists

### `UsageRecord`

- the package uses this table for persisted usage accounting
- conditional durable `usage.reserve` admits capped usage; read caches or periodic Redis synchronization cannot replace this admission boundary
- periods are explicit: persistent gauges use a nonresetting bucket; periodic consumption uses UTC calendar-month or authoritative subscription-cycle boundaries
- reconcile current inventory from domain records when migrating historical monthly counters to persistent gauges

## Integration Notes

- If you already have `Tenant`, `User`, or other domain models, keep the relations shown above.
- If you do not need tenant or user relations, you can adapt the schema, but you must also update or replace the Prisma adapter accordingly.
- If you want truly user-scoped subscriptions, do not reuse this schema blindly. The current adapter implementation assumes a `tenantId`-based storage model.

## Billing Storage and Metadata Extensions

The adapter stores extra fields (plan price points, provider `binding`, subscription `quantity`/`addOns`, invoice number/tax breakdown, and credit-note linkage) in the existing metadata JSON under the reserved `_billing` key. Public metadata replacement preserves this reserved state; callers cannot directly supply `_billing`.

This metadata compatibility does not eliminate the required billing tables. Add the operation, provider-resource, outbox, and invoice-sequence models below before enabling financial SDK operations. Coupon tables are optional only when coupon functionality is unused. Dedicated reporting columns remain optional and must be kept consistent with the metadata representation by the application.

### Coupon model (enables `CouponsService`)

Without this model, the adapter omits the `coupons` section and
`CouponsService` fails with a helpful setup error.

```prisma
model Coupon {
  id    String @id @default(cuid(2))
  code  String @unique
  type  String // "percent" | "fixed"
  value Decimal

  currency String? // required for "fixed" coupons

  duration         String @default("once") // "once" | "repeating" | "forever"
  durationInMonths Int?

  maxRedemptions Int?
  expiresAt      DateTime?
  isActive       Boolean  @default(true)
  timesRedeemed  Int      @default(0)

  metadata  Json?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("coupons")
}
```

### BillingSequence model (strict invoice numbering)

Enables atomic `nextInvoiceNumber(prefix)` sequences. It is required for service invoice creation. Without it, numbering fails explicitly; the unsafe count-based fallback has been removed. Numbers are unique within a prefix; transactions that commit a sequence before a later invoice failure may leave a gap.

```prisma
model BillingSequence {
  prefix String @id // e.g. "INV-", "CN-"
  value  Int    @default(0)

  @@map("billing_sequences")
}
```

### Billing operation, outbox, and purchase-bound coupon models

Paid SDK operations require `BillingOperation`, `BillingOutbox`, `ProviderResource`, `BillingSequence`, and awaited interactive transactions. Merely creating these models does not establish provider acceptance or repair historical payment ownership. Coupon reservation also requires `CouponRedemption`.

```prisma
model ProviderResource {
  providerId  String
  accountId   String
  environment String // "test" | "live"
  kind        String // customer | payment_method | subscription | product | price | payment
  localId     String
  externalId  String

  @@id([providerId, accountId, environment, kind, externalId], name: "providerScopeExternal")
  @@unique([providerId, accountId, environment, kind, localId], name: "providerScopeLocal")
  @@map("provider_resources")
}

model BillingOperation {
  key           String   @id
  reservationId String
  status        String
  payload       Json
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@map("billing_operations")
}

model BillingOutbox {
  id         String    @id
  event      Json
  status     String    @default("pending")
  claimedAt  DateTime?
  claimToken String?

  @@index([status, claimedAt])
  @@map("billing_outbox")
}

model CouponRedemption {
  purchaseId     String @id
  couponId       String
  status         String @default("reserved")
  couponSnapshot Json

  @@index([couponId])
  @@map("coupon_redemptions")
}
```

`BillingOperation.key` identifies one logical purchase, attempt, or accepted settlement. The payment quote and provider/account/environment association are persisted before collection. `compareAndSet` admits one collector. The operation record, subscription state, invoice, and unique outbox identity are changed in the same local transaction; provider calls must occur outside the callback.

Transactions use Prisma's `Serializable` isolation and retry serialization/unique conflicts up to four times. Callback code must contain local database effects only, because a retried callback may run again. Deployments must verify their actual Prisma connector supports interactive serializable transactions. This change has adapter delegate regression coverage, **not live Prisma integration coverage**.

Coupon redemption requires a unique purchase ID. Reservation checks the current eligibility and cap inside a serializable transaction and saves an immutable coupon snapshot. A retry with the same purchase returns that snapshot without another increment. Release decrements once and leaves a tombstone: use a new purchase ID for a new purchase. Unconditional `incrementRedemptions` now rejects the operation.

The outbox uses stable event IDs and a five-minute expiring relay claim. Failed relay delivery releases its claim; crashes are reclaimed after the lease. Delivery is at least once, so receivers must deduplicate the event ID.

### Optional dedicated columns

When present, the adapter reads these columns preferentially over the
`_billing` metadata fallback. Writes always go to metadata, so adding these
columns is only useful for reporting/querying, not required for correctness.

```prisma
// On SubscriptionPlan: additional currency price points
// ({ currency: string; amount: number }[])
prices Json?

// On Subscription
quantity Int?
addOns   Json? // string[]

// On Invoice
invoiceNumber  String?  @unique
subtotal       Decimal?
taxRate        Decimal?
taxAmount      Decimal?
discountAmount Decimal?
total          Decimal?
creditNoteOfId String?
```

### Migration Strategy for Existing Projects

1. Add `BillingOperation`, `BillingOutbox`, `ProviderResource`, and `BillingSequence`. Add `Coupon` and `CouponRedemption` if coupons are enabled (and any optional columns).
2. Run `prisma migrate dev`.
3. Regenerate the Prisma client so `prisma.coupon` and
   `prisma.billingSequence` exist — the adapter detects them at runtime.

## Migration Strategy

For a new project:

1. Add these models and enums to your Prisma schema.
2. Generate or run your migrations.
3. Seed at least one plan.
4. Wire the adapter through `prismaAdapter(prisma)`.
5. Verify the full create subscription and usage lifecycle before exposing public billing routes.

## Audit migration requirements

- Preserve the existing `_billing` JSON object. Public metadata replacement now preserves all reserved billing fields, and explicit `_billing` replacement is rejected. Subscription provider ownership is stored as `_billing.binding` and is hidden from public metadata while returned as `subscription.billing`.
- Backfill each existing subscription's provider ID, account ID, environment, billing owner, and distinct external resource identifiers using verified application/provider records. A global default must not guess historical ownership.
- Existing external invoice identifiers are retained. New settlement identifiers are serialized with provider/account/environment scope; do not rewrite old IDs without an application-specific verified mapping.
- Set non-null usage tenant IDs before relying on the composite uniqueness constraint. Persistent gauges and subscription-cycle counters use explicit `periodStart`/`periodEnd`; historical calendar counters are not proof of current inventory. Backfill persistent gauges from authoritative resources.
- Run migrations and regenerate the Prisma client before enabling paid operations. If operation/outbox models are absent, paid operations fail closed. If `BillingSequence` is absent, service invoice creation fails explicitly.

## External resource mappings

`providerResources.bind(mapping)` persists an immutable association for one provider/account/environment and resource kind. `findByExternal(scope, externalId)` and `findByLocal(scope, localId)` always require that full scope. Both external and local IDs are unique within it; replaying the same association is idempotent and conflicting assignments fail. The same literal ID may exist in another provider, account, environment, or resource kind.

Customers, reusable payment methods, subscriptions, products, prices, and settled payments use separate mappings. Bind only server-verified ownership. New purchases persist their customer/payment-method/subscription mappings, and settlement maps the local attempt to the external payment. Products/prices can be registered through the server API. No existing gateway identifier is guessed or automatically reinterpreted during migration; backfill mappings from verified application/provider records before resuming billing.
