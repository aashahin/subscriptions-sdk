// file: packages/subscriptions/src/adapters/drizzle-schema.ts
// Drizzle ORM (SQLite) schema for @abshahin/subscriptions
//
// These tables mirror the Prisma models documented in docs/prisma-schema.md and
// work with any SQLite-compatible Drizzle driver (Cloudflare D1, Turso/libSQL,
// bun:sqlite, better-sqlite3). See docs/drizzle-schema.md for the raw DDL, a
// PostgreSQL variant, and wiring examples.
//
// Note: pending plan changes (downgrades) are stored in
// `subscriptions.metadata.pendingDowngradePlanId`, exactly like the Prisma
// adapter — no separate table is required.

import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type {
  BillingInterval,
  InvoiceLineItem,
  InvoiceStatus,
  SubscriberType,
  SubscriptionStatus,
} from '../core/types.js';

/**
 * Subscription plans (Prisma `SubscriptionPlan` equivalent).
 */
export const subscriptionPlans = sqliteTable(
  'subscription_plans',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    price: real('price').notNull(),
    currency: text('currency').notNull().default('USD'),
    interval: text('interval').$type<BillingInterval>().notNull(),
    intervalCount: integer('interval_count').notNull().default(1),
    trialDays: integer('trial_days').notNull().default(0),
    features: text('features', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .notNull()
      .$defaultFn(() => ({})),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown> | null>(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('subscription_plans_is_active_sort_order_idx').on(table.isActive, table.sortOrder),
  ],
);

/**
 * Subscriptions (Prisma `Subscription` equivalent).
 *
 * `tenantId` is the persisted subscriber key used across the package; it maps
 * to the package-level `subscriberId`.
 */
export const subscriptions = sqliteTable(
  'subscriptions',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().unique(),
    subscriberType: text('subscriber_type').$type<SubscriberType>().notNull().default('tenant'),
    planId: text('plan_id')
      .notNull()
      .references(() => subscriptionPlans.id),
    status: text('status').$type<SubscriptionStatus>().notNull(),
    currentPeriodStart: integer('current_period_start', { mode: 'timestamp_ms' }).notNull(),
    currentPeriodEnd: integer('current_period_end', { mode: 'timestamp_ms' }).notNull(),
    cancelAt: integer('cancel_at', { mode: 'timestamp_ms' }),
    canceledAt: integer('canceled_at', { mode: 'timestamp_ms' }),
    trialStart: integer('trial_start', { mode: 'timestamp_ms' }),
    trialEnd: integer('trial_end', { mode: 'timestamp_ms' }),
    gatewaySubscriptionId: text('gateway_subscription_id').unique(),
    gatewayCustomerId: text('gateway_customer_id'),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown> | null>(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('subscriptions_plan_id_idx').on(table.planId),
    index('subscriptions_status_current_period_end_idx').on(table.status, table.currentPeriodEnd),
    index('subscriptions_gateway_customer_id_idx').on(table.gatewayCustomerId),
  ],
);

/**
 * Invoices (Prisma `Invoice` equivalent).
 */
export const invoices = sqliteTable(
  'invoices',
  {
    id: text('id').primaryKey(),
    subscriptionId: text('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'cascade' }),
    tenantId: text('tenant_id').notNull(),
    amount: real('amount').notNull(),
    currency: text('currency').notNull(),
    status: text('status').$type<InvoiceStatus>().notNull(),
    gatewayInvoiceId: text('gateway_invoice_id').unique(),
    paidAt: integer('paid_at', { mode: 'timestamp_ms' }),
    dueDate: integer('due_date', { mode: 'timestamp_ms' }),
    lineItems: text('line_items', { mode: 'json' })
      .$type<InvoiceLineItem[]>()
      .notNull()
      .$defaultFn(() => []),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown> | null>(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    index('invoices_tenant_id_status_idx').on(table.tenantId, table.status),
    index('invoices_tenant_id_created_at_idx').on(table.tenantId, table.createdAt),
    index('invoices_subscription_id_idx').on(table.subscriptionId),
    index('invoices_due_date_idx').on(table.dueDate),
  ],
);

/**
 * Usage records (Prisma `UsageRecord` equivalent).
 *
 * The unique index on (subscriberId, tenantId, feature, periodStart) backs the
 * atomic `INSERT ... ON CONFLICT DO UPDATE` used by usage increment/decrement.
 * The adapter always writes a non-null `tenantId` (defaulting to the
 * subscriberId) so the conflict target always matches.
 */
export const usageRecords = sqliteTable(
  'usage_records',
  {
    id: text('id').primaryKey(),
    subscriberId: text('subscriber_id').notNull(),
    tenantId: text('tenant_id'),
    feature: text('feature').notNull(),
    count: integer('count').notNull().default(0),
    periodStart: integer('period_start', { mode: 'timestamp_ms' }).notNull(),
    periodEnd: integer('period_end', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [
    uniqueIndex('usage_records_subscriber_tenant_feature_period_unique').on(
      table.subscriberId,
      table.tenantId,
      table.feature,
      table.periodStart,
    ),
    index('usage_records_subscriber_id_feature_idx').on(table.subscriberId, table.feature),
    index('usage_records_tenant_id_idx').on(table.tenantId),
  ],
);

/**
 * Billing sequences (Prisma `BillingSequence` equivalent).
 *
 * One row per invoice-number prefix, backing the atomic
 * `invoices.nextInvoiceNumber()` implementation.
 */
export const billingSequences = sqliteTable('billing_sequences', {
  prefix: text('prefix').primaryKey(),
  value: integer('value').notNull().default(0),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});

/**
 * Schema object ready to pass to `drizzle(client, { schema })`.
 */
export const subscriptionsSchema = {
  subscriptionPlans,
  subscriptions,
  invoices,
  usageRecords,
  billingSequences,
} as const;

export type SubscriptionsSchema = typeof subscriptionsSchema;

// ==================== Row types ====================

export type PlanRow = typeof subscriptionPlans.$inferSelect;
export type NewPlanRow = typeof subscriptionPlans.$inferInsert;
export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type NewSubscriptionRow = typeof subscriptions.$inferInsert;
export type InvoiceRow = typeof invoices.$inferSelect;
export type NewInvoiceRow = typeof invoices.$inferInsert;
export type UsageRecordRow = typeof usageRecords.$inferSelect;
export type NewUsageRecordRow = typeof usageRecords.$inferInsert;
export type BillingSequenceRow = typeof billingSequences.$inferSelect;
export type NewBillingSequenceRow = typeof billingSequences.$inferInsert;
