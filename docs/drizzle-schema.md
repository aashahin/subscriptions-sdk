# Drizzle Schema

The Drizzle adapter ships a ready-made schema in `src/adapters/drizzle-schema.ts`, defined with `drizzle-orm/sqlite-core` so it works with every SQLite-compatible Drizzle driver:

- Cloudflare D1 (`drizzle-orm/d1`)
- Turso / libSQL (`drizzle-orm/libsql`)
- `bun:sqlite` (`drizzle-orm/bun-sqlite`)
- better-sqlite3 (`drizzle-orm/better-sqlite3`)

It defines five tables:

- `subscription_plans`
- `subscriptions`
- `invoices`
- `usage_records`
- `billing_sequences`

The tables mirror the Prisma models from [prisma-schema.md](./prisma-schema.md), including the same conventions:

- The package-level `subscriberId` is persisted in the `tenant_id` column of `subscriptions` / `invoices`.
- Pending plan changes (downgrades) live in `subscriptions.metadata.pendingDowngradePlanId` — no separate table.
- SDK-managed fields without dedicated columns (plan `prices`, subscription `quantity`/`addOns`, invoice `invoiceNumber`/tax breakdown/`creditNoteOfId`) are stored inside the `metadata` JSON column under the reserved `_billing` key, so a database can be shared with the Prisma adapter.

## Using the Bundled Schema

```typescript
import { drizzle } from 'drizzle-orm/d1';
import {
  drizzleAdapter,
  subscriptionsSchema,
} from '@abshahin/subscriptions/adapters/drizzle';

const db = drizzle(env.DB, { schema: subscriptionsSchema });

const subs = createSubscriptions({
  database: drizzleAdapter(db),
  features,
});
```

Individual tables (`subscriptionPlans`, `subscriptions`, `invoices`, `usageRecords`, `billingSequences`) and their row types (`PlanRow`, `SubscriptionRow`, `InvoiceRow`, `UsageRecordRow`, `BillingSequenceRow`, plus `New*Row` insert types) are exported from the same entry point if you want to query them directly.

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
```

Timestamps are stored as integer milliseconds since the Unix epoch (`timestamp_ms` columns); JSON columns (`features`, `metadata`, `line_items`) are stored as JSON text. Both mappings are handled by Drizzle automatically.

## Generating a PostgreSQL Variant

The adapter itself is dialect-agnostic (it uses the standard query builder plus portable `sql` fragments, and applies JSON-path filtering in JS), so a PostgreSQL schema works too. Convert the bundled schema as follows:

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
    schema: {
      subscriptionPlans: mySchema.subscriptionPlans,
      subscriptions: mySchema.subscriptions,
      invoices: mySchema.invoices,
      usageRecords: mySchema.usageRecords,
      billingSequences: mySchema.billingSequences,
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
    const subs = createSubscriptions({ database: drizzleAdapter(db), features });
    // ...
  },
};
```

Apply the DDL above with `wrangler d1 migrations create` / `wrangler d1 migrations apply`.

### Turso / libSQL

```typescript
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { drizzleAdapter, subscriptionsSchema } from '@abshahin/subscriptions/adapters/drizzle';

const client = createClient({ url: process.env.TURSO_URL!, authToken: process.env.TURSO_AUTH_TOKEN });
const db = drizzle(client, { schema: subscriptionsSchema });

const subs = createSubscriptions({ database: drizzleAdapter(db), features });
```

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
- `gateway_invoice_id` is the external payment/invoice identifier; it backs idempotent webhook handling via `findByGatewayInvoiceId`
- `invoiceNumber`, tax breakdown, discounts, and credit-note linkage are stored in `metadata` under `_billing`

### `usage_records`

- Monthly usage periods are computed in application code (UTC month boundaries), not by the database
- The unique index on `(subscriber_id, tenant_id, feature, period_start)` backs the atomic `INSERT ... ON CONFLICT DO UPDATE` used by `usage.increment` / `usage.set`
- The adapter always writes a non-null `tenant_id` (defaulting to the subscriber ID) so the conflict target always matches; decrements are a single guarded `UPDATE` that floors the counter at zero

### `billing_sequences`

- One row per invoice-number prefix; `invoices.nextInvoiceNumber()` atomically upserts and increments it (`ON CONFLICT DO UPDATE ... RETURNING`) so concurrent invoice creation never yields duplicate numbers

## Transactions

`adapter.transaction(fn)` delegates to Drizzle's `db.transaction`.

- **Async drivers** (D1, libSQL/Turso, PostgreSQL drivers) support async transaction callbacks and provide a real transactional boundary.
- **Synchronous drivers** (`bun:sqlite`, better-sqlite3) execute statements serially on a single connection: the operations still run, but the commit boundary is best-effort because the driver cannot await the async callback. Use an async driver when strict transactional guarantees matter.

## Migrations with drizzle-kit

You can point drizzle-kit at the bundled schema instead of hand-writing DDL. Re-export the tables from your own schema file (so drizzle-kit picks up your other tables in the same migration):

```typescript
// src/db/schema.ts
export {
  billingSequences,
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
