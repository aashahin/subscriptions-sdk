# Drizzle Schema

The Drizzle adapter ships a ready-made schema in `src/adapters/drizzle-schema.ts`, defined with `drizzle-orm/sqlite-core` for SQLite-compatible persistence. Transaction capabilities differ by driver:

- Cloudflare D1 (`drizzle-orm/d1`)
- Turso / libSQL (`drizzle-orm/libsql`)
- `bun:sqlite` (`drizzle-orm/bun-sqlite`)
- better-sqlite3 (`drizzle-orm/better-sqlite3`)

It defines ten tables:

- `subscription_plans`
- `subscriptions`
- `invoices`
- `usage_records`
- `billing_sequences`
- `billing_operations`
- `provider_resources`
- `billing_outbox`
- `coupons`
- `coupon_redemptions`

The tables mirror the Prisma models from [prisma-schema.md](./prisma-schema.md), including the same conventions:

- The package-level `subscriberId` is persisted in the `tenant_id` column of `subscriptions` / `invoices`.
- Pending plan changes (downgrades) live in `subscriptions.metadata.pendingDowngradePlanId` — no separate table.
- SDK-managed fields without dedicated columns (plan `prices`, subscription provider `binding` and `quantity`/`addOns`, invoice `invoiceNumber`/tax breakdown/`creditNoteOfId`) are stored inside the `metadata` JSON column under the reserved `_billing` key, so a database can be shared with the Prisma adapter.

## Using the Bundled Schema

```typescript
import { drizzle } from 'drizzle-orm/d1';
import {
  drizzleAdapter,
  subscriptionsSchema,
} from '@abshahin/subscriptions/adapters/drizzle';

const db = drizzle(env.DB, { schema: subscriptionsSchema });

const subs = createSubscriptions({
  database: drizzleAdapter(db, { transactionMode: 'unsupported' }),
  features,
});
```

All ten table objects are exported from this entry point. The original tables (`subscriptionPlans`, `subscriptions`, `invoices`, `usageRecords`, `billingSequences`) also expose named row types (`PlanRow`, `SubscriptionRow`, `InvoiceRow`, `UsageRecordRow`, `BillingSequenceRow`, plus `New*Row` insert types) are exported from the same entry point if you want to query them directly.

This D1 wiring supports reads and direct adapter single-statement persistence. Billing, coupon reservations, and service mutations requiring transactional outbox persistence fail closed; D1 does not provide the awaited interactive transaction required by these paths.

If you maintain your own table objects (e.g. different column names), pass them via `drizzleAdapter(db, { schema: { ... } })`.

## Raw SQLite DDL

Use this when you manage migrations yourself (e.g. `wrangler d1 migrations`):

```sql
CREATE TABLE subscription_plans (
  id text PRIMARY KEY NOT NULL,
  name text NOT NULL,
  description text,
  price real NOT NULL,
  currency text NOT NULL DEFAULT 'USD',
  interval text NOT NULL,
  interval_count integer NOT NULL DEFAULT 1,
  trial_days integer NOT NULL DEFAULT 0,
  features text NOT NULL DEFAULT '{}',
  is_active integer NOT NULL DEFAULT 1,
  sort_order integer NOT NULL DEFAULT 0,
  metadata text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX subscription_plans_is_active_sort_order_idx
  ON subscription_plans (is_active, sort_order);

CREATE TABLE subscriptions (
  id text PRIMARY KEY NOT NULL,
  tenant_id text NOT NULL UNIQUE,
  subscriber_type text NOT NULL DEFAULT 'tenant',
  plan_id text NOT NULL REFERENCES subscription_plans(id),
  status text NOT NULL,
  current_period_start integer NOT NULL,
  current_period_end integer NOT NULL,
  cancel_at integer,
  canceled_at integer,
  trial_start integer,
  trial_end integer,
  gateway_subscription_id text UNIQUE,
  gateway_customer_id text,
  metadata text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX subscriptions_plan_id_idx ON subscriptions (plan_id);
CREATE INDEX subscriptions_status_current_period_end_idx
  ON subscriptions (status, current_period_end);
CREATE INDEX subscriptions_gateway_customer_id_idx
  ON subscriptions (gateway_customer_id);

CREATE TABLE invoices (
  id text PRIMARY KEY NOT NULL,
  subscription_id text NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  amount real NOT NULL,
  currency text NOT NULL,
  status text NOT NULL,
  gateway_invoice_id text UNIQUE,
  paid_at integer,
  due_date integer,
  line_items text NOT NULL DEFAULT '[]',
  metadata text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX invoices_tenant_id_status_idx ON invoices (tenant_id, status);
CREATE INDEX invoices_tenant_id_created_at_idx ON invoices (tenant_id, created_at);
CREATE INDEX invoices_subscription_id_idx ON invoices (subscription_id);
CREATE INDEX invoices_due_date_idx ON invoices (due_date);

CREATE TABLE usage_records (
  id text PRIMARY KEY NOT NULL,
  subscriber_id text NOT NULL,
  tenant_id text,
  feature text NOT NULL,
  count integer NOT NULL DEFAULT 0,
  period_start integer NOT NULL,
  period_end integer NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE UNIQUE INDEX usage_records_subscriber_tenant_feature_period_unique
  ON usage_records (subscriber_id, tenant_id, feature, period_start);
CREATE INDEX usage_records_subscriber_id_feature_idx
  ON usage_records (subscriber_id, feature);
CREATE INDEX usage_records_tenant_id_idx ON usage_records (tenant_id);

CREATE TABLE billing_sequences (
  prefix text PRIMARY KEY NOT NULL,
  value integer NOT NULL DEFAULT 0,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);

CREATE TABLE provider_resources (
  provider_id text NOT NULL,
  account_id text NOT NULL,
  environment text NOT NULL,
  kind text NOT NULL,
  local_id text NOT NULL,
  external_id text NOT NULL
);
CREATE UNIQUE INDEX provider_resources_scope_external_unique
  ON provider_resources (provider_id, account_id, environment, kind, external_id);
CREATE UNIQUE INDEX provider_resources_scope_local_unique
  ON provider_resources (provider_id, account_id, environment, kind, local_id);
CREATE TABLE billing_operations (
  key text PRIMARY KEY NOT NULL,
  status text NOT NULL,
  payload text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE TABLE billing_outbox (
  id text PRIMARY KEY NOT NULL,
  event text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  claimed_at integer
);
CREATE TABLE coupons (
  id text PRIMARY KEY NOT NULL,
  code text NOT NULL UNIQUE,
  type text NOT NULL,
  value real NOT NULL,
  currency text,
  duration text NOT NULL DEFAULT 'once',
  duration_in_months integer,
  max_redemptions integer,
  expires_at integer,
  is_active integer NOT NULL DEFAULT 1,
  times_redeemed integer NOT NULL DEFAULT 0,
  metadata text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE TABLE coupon_redemptions (
  purchase_id text PRIMARY KEY NOT NULL,
  coupon_id text NOT NULL REFERENCES coupons(id),
  coupon_snapshot text NOT NULL,
  status text NOT NULL DEFAULT 'reserved'
);
```

Timestamps are stored as integer milliseconds since the Unix epoch (`timestamp_ms` columns); JSON columns (`features`, `metadata`, `line_items`) are stored as JSON text. Both mappings are handled by Drizzle automatically.

## Generating a PostgreSQL Variant

The query builder supports a PostgreSQL schema equivalent. Set `dialect: 'postgresql'` for its atomic JSONB metadata update and `transactionMode: 'async'` for a driver with awaited interactive transactions. PostgreSQL support is implemented but has not been verified against a live PostgreSQL server in the audit regressions. Convert every bundled table as follows:

- `sqliteTable` → `pgTable`, `drizzle-orm/sqlite-core` → `drizzle-orm/pg-core`
- `real('price')` → `numeric('price')` (or `doublePrecision`)
- `text('features', { mode: 'json' })` → `jsonb('features')`
- `integer('is_active', { mode: 'boolean' })` → `boolean('is_active')`
- `integer('created_at', { mode: 'timestamp_ms' })` → `timestamp('created_at', { mode: 'date' })`
- Indexes and `uniqueIndex` carry over unchanged; `onConflictDoUpdate` has the same API on PG.

Example (`usage_records` as `pg-core`):

```typescript
import { integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const usageRecords = pgTable(
  'usage_records',
  {
    id: text('id').primaryKey(),
    subscriberId: text('subscriber_id').notNull(),
    tenantId: text('tenant_id'),
    feature: text('feature').notNull(),
    count: integer('count').notNull().default(0),
    periodStart: timestamp('period_start', { mode: 'date' }).notNull(),
    periodEnd: timestamp('period_end', { mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('usage_records_subscriber_tenant_feature_period_unique').on(
      table.subscriberId,
      table.tenantId,
      table.feature,
      table.periodStart,
    ),
  ],
);
```

Then pass your tables to the adapter:

```typescript
import * as mySchema from './schema.js';

const db = drizzle(pool, { schema: mySchema });
const subs = createSubscriptions({
  database: drizzleAdapter(db, {
    dialect: 'postgresql',
    transactionMode: 'async',
    schema: {
      subscriptionPlans: mySchema.subscriptionPlans,
      subscriptions: mySchema.subscriptions,
      invoices: mySchema.invoices,
      usageRecords: mySchema.usageRecords,
      billingSequences: mySchema.billingSequences,
      billingOperations: mySchema.billingOperations,
      providerResources: mySchema.providerResources,
      billingOutbox: mySchema.billingOutbox,
      coupons: mySchema.coupons,
      couponRedemptions: mySchema.couponRedemptions,
    },
  }),
  features,
});
```

MySQL is **not** supported: atomic usage upserts rely on `INSERT ... ON CONFLICT DO UPDATE` (SQLite/PostgreSQL), which has no MySQL equivalent in Drizzle (`onDuplicateKeyUpdate` is a different API).

## Wiring Examples

### Cloudflare D1 (Workers)

```typescript
import { drizzle } from 'drizzle-orm/d1';
import { drizzleAdapter, subscriptionsSchema } from '@abshahin/subscriptions/adapters/drizzle';

export default {
  async fetch(request: Request, env: Env) {
    const db = drizzle(env.DB, { schema: subscriptionsSchema });
    const subs = createSubscriptions({ database: drizzleAdapter(db, { transactionMode: 'unsupported' }), features });
    // ...
  },
};
```

Apply the DDL above with `wrangler d1 migrations create` / `wrangler d1 migrations apply`. This mode exposes `asyncTransactions: false`; financial and transaction-owned outbox mutations are unavailable and fail closed before the callback runs. Direct adapter single-statement quota reservations remain available.

### Turso / libSQL

```typescript
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { drizzleAdapter, subscriptionsSchema } from '@abshahin/subscriptions/adapters/drizzle';

const client = createClient({ url: process.env.TURSO_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
const db = drizzle(client, { schema: subscriptionsSchema });

const subs = createSubscriptions({ database: drizzleAdapter(db, { transactionMode: 'async' }), features });
```

Configure async mode only after verifying that the selected libSQL connector awaits async transaction callbacks and rolls back on rejection. This connector has not been run against a live service in the audit suite; the configuration alone is not integration evidence.

### bun:sqlite

```typescript
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { drizzleAdapter, subscriptionsSchema } from '@abshahin/subscriptions/adapters/drizzle';

const sqlite = new Database('app.db');
// Apply the DDL above, e.g. sqlite.exec(ddl) or your migration runner.
const db = drizzle(sqlite, { schema: subscriptionsSchema });

const subs = createSubscriptions({ database: drizzleAdapter(db), features });
```

## Field Expectations

### `subscription_plans`

- `features` stores only plan overrides, not the fully resolved feature map
- `sort_order` drives public plan ordering
- extra price points (`Plan.prices`) are stored in `metadata` under `_billing.prices`

### `subscriptions`

- `tenant_id` is the persisted subscriber key; one subscription row per subscriber is enforced by `UNIQUE`
- pending downgrades are stored in `metadata.pendingDowngradePlanId`
- `quantity` / `addOns` are stored in `metadata` under `_billing`

### `invoices`

- `amount` is stored in regular currency units
- `line_items` is JSON to avoid coupling invoice rendering to a relational structure
- New settlement `gateway_invoice_id` values serialize provider/account/environment and external payment identity; they back scoped settlement deduplication through `findByGatewayInvoiceId`. Historical bare gateway references remain unchanged until an application has a verified mapping.
- `invoiceNumber`, tax breakdown, discounts, and credit-note linkage are stored in `metadata` under `_billing`

### `usage_records`

- Usage policies select explicit periods in application code: persistent gauges do not reset, calendar consumption uses UTC boundaries, and subscription-cycle consumption uses authoritative subscription boundaries. Adapter calls without explicit boundaries retain the legacy UTC monthly period.
- The unique index on `(subscriber_id, tenant_id, feature, period_start)` backs the atomic `INSERT ... ON CONFLICT DO UPDATE` used by `usage.increment`, `usage.set`, and conditional `usage.reserve`
- The adapter always writes a non-null `tenant_id` (defaulting to the subscriber ID) so the conflict target always matches; decrements are a single guarded `UPDATE` that floors the counter at zero

### `billing_sequences`

- One row per invoice-number prefix; `invoices.nextInvoiceNumber()` atomically upserts and increments it (`ON CONFLICT DO UPDATE ... RETURNING`) so concurrent invoice creation never yields duplicate numbers

## Transactions

`adapter.capabilities.asyncTransactions` reports whether the configured mode provides an awaited callback and rollback.

- **bun:sqlite**: the adapter detects `$client.exec`, serializes all adapter calls on the connection, executes `BEGIN IMMEDIATE`, awaits the callback, and commits or rolls back explicitly. The regression suite verifies actual SQLite commit, rollback, uniqueness failure, and concurrent quota/coupon admission. All access sharing that connection must use this adapter during transactions; direct driver calls bypass its queue.
- **better-sqlite3**: pass `transactionMode: 'sqlite'` and `sqliteClient: { exec: sql => sqlite.exec(sql) }`. This uses the same explicit transaction implementation, but this driver has not been run in the audit suite.
- **libSQL/Turso and PostgreSQL**: explicitly pass `transactionMode: 'async'` only for a driver that awaits async callbacks. The adapter requests serializable isolation and retries recognized serialization/deadlock/busy/unique conflicts. These drivers require live connector validation before relying on the guarantee in deployment.
- **D1 and unknown drivers**: awaited interactive transactions are unavailable by default. `transaction()` rejects before invoking the callback. Reads and direct adapter single-statement writes/quota reservations remain available; paid billing, purchase-bound coupon reservations, and service mutations requiring transactional outbox persistence fail closed. D1 support for ordinary persistence does not imply financial transaction support.

Provider network calls must occur outside transactions. Async callbacks may be retried and must contain local database effects only. Invoice sequences require `RETURNING`; the unsafe later-read fallback is removed.

Public metadata replacement preserves `_billing` using one current-row JSON update, including provider ownership, quantity, add-ons, prices, invoice numbers, and tax/credit fields. Custom equivalent schemas must use the selected dialect's JSON mapping. Caller-supplied `_billing` metadata is reserved.

Stable outbox IDs deduplicate inserts. Claims expire after five minutes so crashed relays can retry, and failed deliveries release the claim. Receivers must deduplicate because delivery remains at least once.

Coupon redemption requires an idempotent purchase ID. Eligibility, the cap, an immutable coupon snapshot, and the purchase reservation are persisted atomically. Release decrements once and keeps a tombstone; a new purchase requires a new ID. Unconditional `incrementRedemptions` rejects the operation.

## Migrations with drizzle-kit

You can point drizzle-kit at the bundled schema instead of hand-writing DDL. Re-export the tables from your own schema file (so drizzle-kit picks up your other tables in the same migration):

```typescript
// src/db/schema.ts
export {
  billingSequences,
  billingOperations,
  providerResources,
  billingOutbox,
  coupons,
  couponRedemptions,
  invoices,
  subscriptionPlans,
  subscriptions,
  usageRecords,
} from '@abshahin/subscriptions/adapters/drizzle';
```

```typescript
// drizzle.config.ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
```

## Audit migration requirements

Apply additive migrations for the five new tables before enabling billing. Preserve existing `_billing` JSON, and backfill `_billing.binding` from verified ownership records rather than the configured global default. It contains provider/account/environment, `sdk_managed` or `provider_managed` ownership, and separate customer/payment-method/subscription identifiers.

Usage accepts explicit periods. Persistent gauges use epoch-to-far-future boundaries; consumption uses a UTC calendar or an authoritative subscription cycle. Backfill persistent gauges from current resources, since old monthly counters do not establish inventory. Normalize historical null usage tenant IDs to their subscriber ID before relying on the composite unique key.

Keep historical gateway invoice IDs unless the application has a verified mapping. New paid settlement IDs include provider/account/environment scope. Unsupported financial drivers now fail closed and must migrate to a supported transaction mode or use a custom adapter with equivalent guarantees.

## External resource mappings

`provider_resources` persists immutable external customer, payment-method, subscription, product, price, and payment associations. Both local and external IDs have unique constraints scoped to provider ID, account ID, environment, and resource kind. `providerResources.bind(mapping)` idempotently replays the identical association and rejects reassignment of either side. `findByExternal(scope, externalId)` and `findByLocal(scope, localId)` require the complete scope, preventing a repeated ID in another account/environment from being treated as the same resource.

Bind only server-verified identifiers. Subscription creation and settlement populate their distinct resource mappings; server-controlled product/price registration supports provider-managed catalog preparation. Apply the additive table migration and backfill verified associations before enabling billing. The SDK does not infer historical resource ownership from a global provider default or overloaded gateway ID. The real SQLite regression exercises conflicting/replayed bindings, all six kinds, account/environment/provider separation, and transaction rollback.
