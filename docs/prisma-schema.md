# Prisma Schema

The current Prisma adapter expects four models:

- `SubscriptionPlan`
- `Subscription`
- `Invoice`
- `UsageRecord`

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
- `gatewayCustomerId` is commonly used to store a reusable token or customer identifier for later charges

### `Invoice`

- `amount` is stored in regular currency units in the current backend schema
- `lineItems` is JSON to avoid coupling invoice rendering to a separate relational structure
- `gatewayInvoiceId` is typically the external payment or invoice identifier from the gateway

### `UsageRecord`

- the package uses this table for persisted usage accounting
- the backend project may additionally maintain faster Redis counters and periodically sync them back here
- the monthly period pattern is handled in application code and adapter logic, not by Prisma itself

## Integration Notes

- If you already have `Tenant`, `User`, or other domain models, keep the relations shown above.
- If you do not need tenant or user relations, you can adapt the schema, but you must also update or replace the Prisma adapter accordingly.
- If you want truly user-scoped subscriptions, do not reuse this schema blindly. The current adapter implementation assumes a `tenantId`-based storage model.

## Migration Strategy

For a new project:

1. Add these models and enums to your Prisma schema.
2. Generate or run your migrations.
3. Seed at least one plan.
4. Wire the adapter through `prismaAdapter(prisma)`.
5. Verify the full create subscription and usage lifecycle before exposing public billing routes.
