// file: packages/subscriptions/src/adapters/prisma.adapter.ts
// Prisma adapter implementation for @abshahin/subscriptions

import type {
    Coupon,
    CreateCouponInput,
    UpdateCouponInput,
} from "../core/coupons.js";
import type {
    CreateInvoiceInput,
    CreatePlanInput,
    CreateSubscriptionInput,
    FeatureRegistry,
    Invoice,
    InvoiceWithDetails,
    Plan,
    PlanPrice,
    Subscription,
    SubscriptionStatus,
    SubscriptionWithPlan,
    UpdateInvoiceInput,
    UpdatePlanInput,
    UpdateSubscriptionInput,
    UsageRecord,
} from "../core/types.js";
import type {
    DatabaseAdapter,
    PlanQueryOptions,
    SubscriptionQueryOptions,
} from "./database.adapter.js";

/**
 * Prisma client type (accepts any Prisma client instance)
 *
 * `coupon` and `billingSequence` are optional models that enable the coupon
 * and invoice-numbering features — see docs/prisma-schema.md. When they are
 * missing, the adapter degrades gracefully (no coupons, fallback numbering).
 */
type PrismaClient = {
  subscriptionPlan: any;
  subscription: any;
  invoice: any;
  usageRecord: any;
  coupon?: any;
  billingSequence?: any;
  $transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

/**
 * Options for the Prisma adapter
 */
export interface PrismaAdapterOptions {
  /**
   * Custom table names if different from defaults
   */
  tableNames?: {
    plans?: string;
    subscriptions?: string;
    invoices?: string;
    usageRecords?: string;
  };
}

/**
 * Create a Prisma adapter for the subscriptions package
 *
 * @example
 * ```typescript
 * import { prismaAdapter } from '@abshahin/subscriptions/adapters/prisma';
 * import { db } from './lib/db.js';
 *
 * const subs = createSubscriptions({
 *   database: prismaAdapter(db),
 *   features,
 * });
 * ```
 */
export function prismaAdapter<TFeatures extends FeatureRegistry>(
  prisma: PrismaClient,
  _options?: PrismaAdapterOptions,
): DatabaseAdapter<TFeatures> {
  const createAdapter = (client: PrismaClient): DatabaseAdapter<TFeatures> => {
    // Optional coupon persistence — undefined when the Prisma schema has no
    // Coupon model, so CouponsService can raise a helpful setup error.
    const coupons = createCouponsSection(client);

    return {
    // ==================== Plans ====================
    plans: {
      async findById(id: string): Promise<Plan<TFeatures> | null> {
        const plan = await client.subscriptionPlan.findUnique({
          where: { id },
        });
        return plan ? mapPlanFromPrisma<TFeatures>(plan) : null;
      },

      async findAll(options?: {
        activeOnly?: boolean;
      }): Promise<Plan<TFeatures>[]> {
        const plans = await client.subscriptionPlan.findMany({
          where: options?.activeOnly ? { isActive: true } : undefined,
          orderBy: { sortOrder: "asc" },
        });
        return plans.map(mapPlanFromPrisma<TFeatures>);
      },

      async findAllForAdmin(
        options?: PlanQueryOptions,
      ): Promise<{ plans: Plan<TFeatures>[]; total: number }> {
        const where: Record<string, any> = {};

        if (options?.isActive !== undefined) {
          where.isActive = options.isActive;
        }

        if (options?.interval) {
          where.interval = options.interval;
        }

        const [plans, total] = await Promise.all([
          client.subscriptionPlan.findMany({
            where,
            take: options?.limit,
            skip: options?.offset,
            orderBy: { sortOrder: "asc" },
          }),
          client.subscriptionPlan.count({ where }),
        ]);

        return {
          plans: plans.map(mapPlanFromPrisma<TFeatures>),
          total,
        };
      },

      async create(data: CreatePlanInput<TFeatures>): Promise<Plan<TFeatures>> {
        const plan = await client.subscriptionPlan.create({
          data: {
            name: data.name,
            description: data.description ?? null,
            price: data.price,
            currency: data.currency ?? "USD",
            // Additional price points have no dedicated column in the base
            // schema; they are persisted inside the metadata JSON column.
            metadata: mergeBillingExtras(data.metadata ?? null, {
              prices: data.prices,
            }),
            interval: data.interval,
            intervalCount: data.intervalCount ?? 1,
            trialDays: data.trialDays ?? 0,
            features: data.features ?? {},
            isActive: data.isActive ?? true,
            sortOrder: data.sortOrder ?? 0,
          },
        });
        return mapPlanFromPrisma<TFeatures>(plan);
      },

      async update(
        id: string,
        data: UpdatePlanInput<TFeatures>,
      ): Promise<Plan<TFeatures>> {
        const metadata = await metadataForUpdate(
          client.subscriptionPlan,
          id,
          data.metadata,
          { prices: data.prices },
        );

        const plan = await client.subscriptionPlan.update({
          where: { id },
          data: {
            ...(data.name !== undefined && { name: data.name }),
            ...(data.description !== undefined && {
              description: data.description,
            }),
            ...(data.price !== undefined && { price: data.price }),
            ...(data.currency !== undefined && { currency: data.currency }),
            ...(data.interval !== undefined && { interval: data.interval }),
            ...(data.intervalCount !== undefined && {
              intervalCount: data.intervalCount,
            }),
            ...(data.trialDays !== undefined && { trialDays: data.trialDays }),
            ...(data.features !== undefined && { features: data.features }),
            ...(data.isActive !== undefined && { isActive: data.isActive }),
            ...(data.sortOrder !== undefined && { sortOrder: data.sortOrder }),
            ...(metadata !== undefined && { metadata }),
          },
        });
        return mapPlanFromPrisma<TFeatures>(plan);
      },

      async delete(id: string): Promise<void> {
        await client.subscriptionPlan.delete({
          where: { id },
        });
      },

      async hasActiveSubscribers(id: string): Promise<boolean> {
        const count = await client.subscription.count({
          where: {
            planId: id,
            status: { in: ["active", "trialing", "past_due"] },
          },
        });
        return count > 0;
      },

      async hasPendingDowngrades(id: string): Promise<boolean> {
        const count = await client.subscription.count({
          where: {
            status: { in: ["active", "trialing", "past_due"] },
            metadata: {
              path: ["pendingDowngradePlanId"],
              equals: id,
            },
          },
        });
        return count > 0;
      },
    },

    // ==================== Subscriptions ====================
    subscriptions: {
      async findById(
        id: string,
      ): Promise<SubscriptionWithPlan<TFeatures> | null> {
        const subscription = await client.subscription.findUnique({
          where: { id },
          include: { plan: true },
        });
        return subscription
          ? mapSubscriptionWithPlanFromPrisma<TFeatures>(subscription)
          : null;
      },

      async findBySubscriber(
        subscriberId: string,
      ): Promise<SubscriptionWithPlan<TFeatures> | null> {
        const subscription = await client.subscription.findFirst({
          where: {
            tenantId: subscriberId,
          },
          include: { plan: true },
          orderBy: { createdAt: "desc" },
        });
        return subscription
          ? mapSubscriptionWithPlanFromPrisma<TFeatures>(subscription)
          : null;
      },

      async findAll(
        options?: SubscriptionQueryOptions,
      ): Promise<Subscription[]> {
        const where: Record<string, any> = {};

        if (options?.status) {
          where.status = Array.isArray(options.status)
            ? { in: options.status }
            : options.status;
        }

        if (options?.planId) {
          where.planId = options.planId;
        }

        const subscriptions = await client.subscription.findMany({
          where,
          take: options?.limit,
          skip: options?.offset,
          orderBy: { createdAt: "desc" },
        });

        return subscriptions.map(mapSubscriptionFromPrisma);
      },

      async create(data: CreateSubscriptionInput): Promise<Subscription> {
        const now = new Date();
        const subscription = await client.subscription.create({
          data: {
            tenantId: data.subscriberId,
            subscriberType: data.subscriberType ?? "tenant",
            planId: data.planId,
            status: data.status ?? "active",
            currentPeriodStart: data.currentPeriodStart ?? now,
            currentPeriodEnd:
              data.currentPeriodEnd ??
              new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
            trialStart: data.trialStart ?? null,
            trialEnd: data.trialEnd ?? null,
            gatewaySubscriptionId: data.gatewaySubscriptionId ?? null,
            gatewayCustomerId: data.gatewayCustomerId ?? null,
            // quantity/addOns have no dedicated columns in the base schema;
            // they are persisted inside the metadata JSON column.
            metadata: mergeBillingExtras(data.metadata ?? null, {
              quantity: data.quantity,
              addOns: data.addOns,
            }),
          },
        });
        return mapSubscriptionFromPrisma(subscription);
      },

      async update(
        id: string,
        data: UpdateSubscriptionInput,
      ): Promise<Subscription> {
        const metadata = await metadataForUpdate(
          client.subscription,
          id,
          data.metadata,
          { quantity: data.quantity, addOns: data.addOns },
        );

        const subscription = await client.subscription.update({
          where: { id },
          data: {
            ...(data.planId !== undefined && { planId: data.planId }),
            ...(data.status !== undefined && { status: data.status }),
            ...(data.currentPeriodStart !== undefined && {
              currentPeriodStart: data.currentPeriodStart,
            }),
            ...(data.currentPeriodEnd !== undefined && {
              currentPeriodEnd: data.currentPeriodEnd,
            }),
            ...(data.cancelAt !== undefined && { cancelAt: data.cancelAt }),
            ...(data.canceledAt !== undefined && {
              canceledAt: data.canceledAt,
            }),
            ...(data.trialStart !== undefined && {
              trialStart: data.trialStart,
            }),
            ...(data.trialEnd !== undefined && { trialEnd: data.trialEnd }),
            ...(data.gatewaySubscriptionId !== undefined && {
              gatewaySubscriptionId: data.gatewaySubscriptionId,
            }),
            ...(data.gatewayCustomerId !== undefined && {
              gatewayCustomerId: data.gatewayCustomerId,
            }),
            ...(metadata !== undefined && { metadata }),
          },
        });
        return mapSubscriptionFromPrisma(subscription);
      },

      async delete(id: string): Promise<void> {
        await client.subscription.delete({
          where: { id },
        });
      },

      async findExpiring(withinDays: number): Promise<Subscription[]> {
        const now = new Date();
        const endDate = new Date(
          now.getTime() + withinDays * 24 * 60 * 60 * 1000,
        );

        const subscriptions = await client.subscription.findMany({
          where: {
            status: { in: ["active", "trialing"] },
            currentPeriodEnd: {
              gte: now,
              lte: endDate,
            },
          },
        });

        return subscriptions.map(mapSubscriptionFromPrisma);
      },
    },

    // ==================== Invoices ====================
    invoices: {
      async findById(id: string): Promise<Invoice | null> {
        const invoice = await client.invoice.findUnique({
          where: { id },
        });
        return invoice ? mapInvoiceFromPrisma(invoice) : null;
      },

      async findByIdWithDetails(
        id: string,
      ): Promise<InvoiceWithDetails<TFeatures> | null> {
        const invoice = await client.invoice.findUnique({
          where: { id },
          include: {
            subscription: {
              include: {
                plan: true,
              },
            },
          },
        });

        if (!invoice || !invoice.subscription) {
          return null;
        }

        return {
          ...mapInvoiceFromPrisma(invoice),
          subscription: mapSubscriptionFromPrisma(invoice.subscription),
          plan: mapPlanFromPrisma<TFeatures>(invoice.subscription.plan),
        };
      },

      async findByGatewayInvoiceId(
        gatewayInvoiceId: string,
      ): Promise<Invoice | null> {
        const invoice = await client.invoice.findFirst({
          where: { gatewayInvoiceId },
          orderBy: { createdAt: "desc" },
        });
        return invoice ? mapInvoiceFromPrisma(invoice) : null;
      },

      async findBySubscription(subscriptionId: string): Promise<Invoice[]> {
        const invoices = await client.invoice.findMany({
          where: { subscriptionId },
          orderBy: { createdAt: "desc" },
        });
        return invoices.map(mapInvoiceFromPrisma);
      },

      async findBySubscriber(subscriberId: string): Promise<Invoice[]> {
        const invoices = await client.invoice.findMany({
          where: { tenantId: subscriberId },
          orderBy: { createdAt: "desc" },
        });
        return invoices.map(mapInvoiceFromPrisma);
      },

      async create(data: CreateInvoiceInput): Promise<Invoice> {
        // First, get the subscription to extract tenantId
        const subscription = await client.subscription.findUnique({
          where: { id: data.subscriptionId },
          select: { tenantId: true },
        });

        if (!subscription) {
          throw new Error(`Subscription not found: ${data.subscriptionId}`);
        }

        const invoice = await client.invoice.create({
          data: {
            subscriptionId: data.subscriptionId,
            tenantId: subscription.tenantId,
            amount: data.amount,
            currency: data.currency,
            status: data.status ?? "draft",
            gatewayInvoiceId: data.gatewayInvoiceId ?? null,
            paidAt: data.paidAt ?? (data.status === "paid" ? new Date() : null),
            dueDate: data.dueDate ?? null,
            lineItems: data.lineItems ?? [],
            // Extended billing fields (invoiceNumber, tax breakdown, credit
            // note linkage) have no dedicated columns in the base schema;
            // they are persisted inside the metadata JSON column.
            metadata: mergeBillingExtras(data.metadata ?? null, {
              invoiceNumber: data.invoiceNumber,
              subtotal: data.subtotal,
              taxRate: data.taxRate,
              taxAmount: data.taxAmount,
              discountAmount: data.discountAmount,
              total: data.total,
              creditNoteOfId: data.creditNoteOfId,
            }),
          },
        });
        return mapInvoiceFromPrisma(invoice);
      },

      async update(id: string, data: UpdateInvoiceInput): Promise<Invoice> {
        const metadata = await metadataForUpdate(client.invoice, id, data.metadata, {
          invoiceNumber: data.invoiceNumber,
          subtotal: data.subtotal,
          taxRate: data.taxRate,
          taxAmount: data.taxAmount,
          discountAmount: data.discountAmount,
          total: data.total,
          creditNoteOfId: data.creditNoteOfId,
        });

        const invoice = await client.invoice.update({
          where: { id },
          data: {
            ...(data.amount !== undefined && { amount: data.amount }),
            ...(data.status !== undefined && { status: data.status }),
            ...(data.gatewayInvoiceId !== undefined && {
              gatewayInvoiceId: data.gatewayInvoiceId,
            }),
            ...(data.paidAt !== undefined && { paidAt: data.paidAt }),
            ...(data.dueDate !== undefined && { dueDate: data.dueDate }),
            ...(data.lineItems !== undefined && { lineItems: data.lineItems }),
            ...(metadata !== undefined && { metadata }),
          },
        });
        return mapInvoiceFromPrisma(invoice);
      },

      async nextInvoiceNumber(prefix: string): Promise<string> {
        // Preferred path: dedicated BillingSequence table with an atomic
        // upsert+increment (see docs/prisma-schema.md).
        if (client.billingSequence) {
          const row = await client.billingSequence.upsert({
            where: { prefix },
            create: { prefix, value: 1 },
            update: { value: { increment: 1 } },
          });
          return `${prefix}${String(row.value).padStart(6, "0")}`;
        }

        // Fallback when the BillingSequence model is not present: derive the
        // next number from the current invoice count. This is NOT
        // concurrency-safe — add the BillingSequence model for strictly
        // sequential, gap-free numbering.
        const count = await client.invoice.count();
        return `${prefix}${String(count + 1).padStart(6, "0")}`;
      },
    },

    // ==================== Usage Tracking ====================
    usage: {
      async get(
        subscriberId: string,
        feature: string,
        options?: { period?: Date; tenantId?: string | null },
      ): Promise<number> {
        const now = options?.period ?? new Date();
        const tenantId = options?.tenantId ?? subscriberId;

        const record = await client.usageRecord.findFirst({
          where: {
            subscriberId,
            tenantId: tenantId,
            feature,
            periodStart: { lte: now },
            periodEnd: { gte: now },
          },
        });
        return record?.count ?? 0;
      },

      async increment(
        subscriberId: string,
        feature: string,
        options?: { count?: number; tenantId?: string | null },
      ): Promise<number> {
        const count = options?.count ?? 1;
        const tenantId = options?.tenantId ?? subscriberId;
        const now = new Date();
        const periodStart = getMonthStart(now);
        const periodEnd = getMonthEnd(now);

        const record = await client.usageRecord.upsert({
          where: {
            subscriberId_tenantId_feature_periodStart: {
              subscriberId,
              tenantId: tenantId,
              feature,
              periodStart,
            },
          },
          create: {
            subscriberId,
            tenantId: tenantId,
            feature,
            count,
            periodStart,
            periodEnd,
          },
          update: {
            count: { increment: count },
          },
        });

        return record.count;
      },

      async decrement(
        subscriberId: string,
        feature: string,
        options?: { count?: number; tenantId?: string | null },
      ): Promise<number> {
        const count = options?.count ?? 1;
        const tenantId = options?.tenantId ?? subscriberId;
        const now = new Date();
        const periodStart = getMonthStart(now);

        // Atomic decrement that never drops below zero.
        //
        // A read-then-write (`get` then `update`) loses concurrent decrements,
        // so we issue a single guarded atomic decrement. When the stored count
        // is large enough we decrement in place; otherwise we floor it to zero.
        // Both branches are conditional `updateMany` calls, so no row is ever
        // overwritten with a stale value.
        const baseWhere = { subscriberId, tenantId, feature, periodStart };

        const decremented = await client.usageRecord.updateMany({
          where: { ...baseWhere, count: { gte: count } },
          data: { count: { decrement: count } },
        });

        if (decremented.count === 0) {
          // Either no record exists, or the stored count is smaller than the
          // amount to release. Clamp any existing record to zero.
          await client.usageRecord.updateMany({
            where: { ...baseWhere, count: { lt: count } },
            data: { count: 0 },
          });
        }

        return this.get(subscriberId, feature, { tenantId });
      },

      async set(
        subscriberId: string,
        feature: string,
        count: number,
        tenantId?: string | null,
      ): Promise<void> {
        const tid = tenantId ?? subscriberId;
        const now = new Date();
        const periodStart = getMonthStart(now);
        const periodEnd = getMonthEnd(now);

        await client.usageRecord.upsert({
          where: {
            subscriberId_tenantId_feature_periodStart: {
              subscriberId,
              tenantId: tid,
              feature,
              periodStart,
            },
          },
          create: {
            subscriberId,
            tenantId: tid,
            feature,
            count,
            periodStart,
            periodEnd,
          },
          update: { count },
        });
      },

      async reset(
        subscriberId: string,
        options?: { feature?: string; tenantId?: string | null },
      ): Promise<void> {
        const where: Record<string, any> = { subscriberId };
        if (options?.feature) {
          where.feature = options.feature;
        }
        if (options?.tenantId !== undefined) {
          where.tenantId = options.tenantId;
        }

        await client.usageRecord.deleteMany({ where });
      },

      async getAll(
        subscriberId: string,
        tenantId?: string | null,
      ): Promise<UsageRecord[]> {
        const now = new Date();
        const where: Record<string, any> = {
          subscriberId,
          periodStart: { lte: now },
          periodEnd: { gte: now },
        };
        if (tenantId !== undefined) {
          where.tenantId = tenantId;
        }

        const records = await client.usageRecord.findMany({ where });
        return records.map(mapUsageRecordFromPrisma);
      },
    },

    // ==================== Transactions ====================
    transaction<T>(
      fn: (tx: DatabaseAdapter<TFeatures>) => Promise<T>,
    ): Promise<T> {
      return prisma.$transaction(async (txClient) => {
        const txAdapter = createAdapter(txClient);
        return fn(txAdapter);
      });
    },

    // ==================== Coupons (optional) ====================
    ...(coupons ? { coupons } : {}),
    };
  };

  return createAdapter(prisma);
}

// ==================== Mappers ====================

/**
 * Safely parse JSON that might be a string or already an object.
 * Some database drivers return JSON columns as strings.
 */
function parseJsonField<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

/**
 * Reserved metadata key under which SDK-managed extra fields are stored when
 * the schema has no dedicated columns for them (plan price points,
 * subscription quantity/addOns, invoice tax breakdown, etc.).
 *
 * The key is stripped from `metadata` when records are mapped back, so
 * consumers never see the internal storage detail.
 */
const BILLING_METADATA_KEY = "_billing";

/**
 * Merge SDK-managed extra fields into a JSON metadata column under the
 * reserved `_billing` key. Entries with `undefined` values are ignored.
 */
function mergeBillingExtras(
  metadata: Record<string, unknown> | null,
  extras: Record<string, unknown>,
): Record<string, unknown> | null {
  const definedExtras = Object.fromEntries(
    Object.entries(extras).filter(([, value]) => value !== undefined),
  );

  if (Object.keys(definedExtras).length === 0) {
    return metadata;
  }

  const base = metadata ?? {};
  const existing = parseJsonField<Record<string, unknown>>(
    base[BILLING_METADATA_KEY],
    {},
  );

  return {
    ...base,
    [BILLING_METADATA_KEY]: { ...existing, ...definedExtras },
  };
}

/**
 * Split SDK-managed extra fields out of a stored metadata value.
 * Returns the cleaned metadata (without the reserved key) and the extras.
 */
function extractBillingExtras<T extends Record<string, unknown>>(
  metadata: unknown,
): { metadata: Record<string, unknown> | null; extras: Partial<T> } {
  const parsed = parseJsonField<Record<string, unknown> | null>(
    metadata,
    null,
  );

  if (!parsed || !(BILLING_METADATA_KEY in parsed)) {
    return { metadata: parsed, extras: {} };
  }

  const { [BILLING_METADATA_KEY]: extras, ...rest } = parsed;
  return {
    metadata: Object.keys(rest).length > 0 ? rest : null,
    extras: parseJsonField<Partial<T>>(extras, {}),
  };
}

/**
 * Resolve the metadata column value for an update that may carry SDK-managed
 * extra fields. Returns `undefined` when the column should be left untouched.
 *
 * When extras are present but no explicit metadata was provided, the existing
 * row's metadata is loaded first so unrelated keys are not wiped out.
 */
async function metadataForUpdate(
  model: any,
  id: string,
  provided: Record<string, unknown> | undefined,
  extras: Record<string, unknown>,
): Promise<Record<string, unknown> | null | undefined> {
  const hasExtras = Object.values(extras).some(
    (value) => value !== undefined,
  );

  if (provided === undefined && !hasExtras) {
    return undefined;
  }

  let base = provided;
  if (base === undefined) {
    const existing = await model.findUnique({
      where: { id },
      select: { metadata: true },
    });
    base =
      parseJsonField<Record<string, unknown> | null>(
        existing?.metadata,
        null,
      ) ?? undefined;
  }

  return mergeBillingExtras(base ?? null, extras);
}

function mapPlanFromPrisma<TFeatures extends FeatureRegistry>(
  plan: any,
): Plan<TFeatures> {
  const { metadata, extras } = extractBillingExtras<{ prices?: PlanPrice[] }>(
    plan.metadata,
  );
  // Prefer a dedicated `prices` JSON column when the schema provides one;
  // otherwise fall back to the value stored inside metadata.
  const prices =
    parseJsonField<PlanPrice[] | undefined>(plan.prices, undefined) ??
    extras.prices;

  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    price: Number(plan.price),
    currency: plan.currency,
    ...(prices ? { prices } : {}),
    interval: plan.interval,
    intervalCount: plan.intervalCount ?? 1,
    trialDays: plan.trialDays ?? 0,
    features: parseJsonField(plan.features, {}),
    isActive: plan.isActive,
    sortOrder: plan.sortOrder,
    metadata,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

function mapSubscriptionFromPrisma(subscription: any): Subscription {
  const { metadata, extras } = extractBillingExtras<{
    quantity?: number;
    addOns?: string[];
  }>(subscription.metadata);
  const quantity = subscription.quantity ?? extras.quantity;
  const addOns = subscription.addOns ?? extras.addOns;

  return {
    id: subscription.id,
    subscriberId: subscription.tenantId,
    subscriberType: subscription.subscriberType ?? "tenant",
    planId: subscription.planId,
    status: subscription.status as SubscriptionStatus,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    cancelAt: subscription.cancelAt,
    canceledAt: subscription.canceledAt,
    trialStart: subscription.trialStart,
    trialEnd: subscription.trialEnd,
    gatewaySubscriptionId: subscription.gatewaySubscriptionId,
    gatewayCustomerId: subscription.gatewayCustomerId,
    ...(quantity !== undefined && quantity !== null ? { quantity } : {}),
    ...(addOns ? { addOns } : {}),
    metadata,
    createdAt: subscription.createdAt,
    updatedAt: subscription.updatedAt,
  };
}

function mapSubscriptionWithPlanFromPrisma<TFeatures extends FeatureRegistry>(
  subscription: any,
): SubscriptionWithPlan<TFeatures> {
  return {
    ...mapSubscriptionFromPrisma(subscription),
    plan: mapPlanFromPrisma<TFeatures>(subscription.plan),
  };
}

function mapInvoiceFromPrisma(invoice: any): Invoice {
  const { metadata, extras } = extractBillingExtras<{
    invoiceNumber?: string | null;
    subtotal?: number;
    taxRate?: number;
    taxAmount?: number;
    discountAmount?: number;
    total?: number;
    creditNoteOfId?: string | null;
  }>(invoice.metadata);

  // Prefer dedicated columns when the schema provides them; otherwise fall
  // back to the values stored inside metadata.
  const subtotal = invoice.subtotal ?? extras.subtotal;
  const taxRate = invoice.taxRate ?? extras.taxRate;
  const taxAmount = invoice.taxAmount ?? extras.taxAmount;
  const discountAmount = invoice.discountAmount ?? extras.discountAmount;
  const total = invoice.total ?? extras.total;

  return {
    id: invoice.id,
    subscriptionId: invoice.subscriptionId,
    subscriberId: invoice.tenantId ?? invoice.subscriberId,
    amount: Number(invoice.amount),
    currency: invoice.currency,
    status: invoice.status,
    invoiceNumber: invoice.invoiceNumber ?? extras.invoiceNumber ?? null,
    ...(subtotal !== undefined && subtotal !== null
      ? { subtotal: Number(subtotal) }
      : {}),
    ...(taxRate !== undefined && taxRate !== null
      ? { taxRate: Number(taxRate) }
      : {}),
    ...(taxAmount !== undefined && taxAmount !== null
      ? { taxAmount: Number(taxAmount) }
      : {}),
    ...(discountAmount !== undefined && discountAmount !== null
      ? { discountAmount: Number(discountAmount) }
      : {}),
    ...(total !== undefined && total !== null ? { total: Number(total) } : {}),
    creditNoteOfId: invoice.creditNoteOfId ?? extras.creditNoteOfId ?? null,
    gatewayInvoiceId: invoice.gatewayInvoiceId,
    paidAt: invoice.paidAt,
    dueDate: invoice.dueDate,
    lineItems: parseJsonField(invoice.lineItems, []),
    metadata,
    createdAt: invoice.createdAt,
    updatedAt: invoice.updatedAt,
  };
}

function mapCouponFromPrisma(coupon: any): Coupon {
  return {
    id: coupon.id,
    code: coupon.code,
    type: coupon.type,
    value: Number(coupon.value),
    currency: coupon.currency ?? null,
    duration: coupon.duration,
    durationInMonths: coupon.durationInMonths ?? null,
    maxRedemptions: coupon.maxRedemptions ?? null,
    expiresAt: coupon.expiresAt ?? null,
    isActive: coupon.isActive,
    timesRedeemed: coupon.timesRedeemed ?? 0,
    metadata: parseJsonField(coupon.metadata, null),
    createdAt: coupon.createdAt,
    updatedAt: coupon.updatedAt,
  };
}

/**
 * Build the optional `coupons` section for the adapter.
 *
 * Returns undefined when the Prisma client has no `coupon` model, so the
 * adapter simply omits the section and CouponsService degrades gracefully
 * with a helpful setup error.
 */
function createCouponsSection(
  client: PrismaClient,
): NonNullable<DatabaseAdapter["coupons"]> | undefined {
  if (!client.coupon) {
    return undefined;
  }

  return {
    async findByCode(code: string): Promise<Coupon | null> {
      const coupon = await client.coupon.findUnique({ where: { code } });
      return coupon ? mapCouponFromPrisma(coupon) : null;
    },

    async findById(id: string): Promise<Coupon | null> {
      const coupon = await client.coupon.findUnique({ where: { id } });
      return coupon ? mapCouponFromPrisma(coupon) : null;
    },

    async create(data: CreateCouponInput): Promise<Coupon> {
      const coupon = await client.coupon.create({
        data: {
          code: data.code,
          type: data.type,
          value: data.value,
          currency: data.currency ?? null,
          duration: data.duration ?? "once",
          durationInMonths: data.durationInMonths ?? null,
          maxRedemptions: data.maxRedemptions ?? null,
          expiresAt: data.expiresAt ?? null,
          isActive: data.isActive ?? true,
          timesRedeemed: 0,
          metadata: data.metadata ?? null,
        },
      });
      return mapCouponFromPrisma(coupon);
    },

    async update(id: string, data: UpdateCouponInput): Promise<Coupon> {
      const coupon = await client.coupon.update({
        where: { id },
        data: {
          ...(data.type !== undefined && { type: data.type }),
          ...(data.value !== undefined && { value: data.value }),
          ...(data.currency !== undefined && { currency: data.currency }),
          ...(data.duration !== undefined && { duration: data.duration }),
          ...(data.durationInMonths !== undefined && {
            durationInMonths: data.durationInMonths,
          }),
          ...(data.maxRedemptions !== undefined && {
            maxRedemptions: data.maxRedemptions,
          }),
          ...(data.expiresAt !== undefined && { expiresAt: data.expiresAt }),
          ...(data.isActive !== undefined && { isActive: data.isActive }),
          ...(data.metadata !== undefined && { metadata: data.metadata }),
        },
      });
      return mapCouponFromPrisma(coupon);
    },

    async incrementRedemptions(id: string): Promise<Coupon> {
      const coupon = await client.coupon.update({
        where: { id },
        data: { timesRedeemed: { increment: 1 } },
      });
      return mapCouponFromPrisma(coupon);
    },
  };
}

function mapUsageRecordFromPrisma(record: any): UsageRecord {
  return {
    id: record.id,
    subscriberId: record.subscriberId,
    feature: record.feature,
    count: record.count,
    periodStart: record.periodStart,
    periodEnd: record.periodEnd,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

// ==================== Helpers ====================

// Usage periods are computed in UTC so that period boundaries are deterministic
// and independent of the server's local timezone or DST transitions. Using
// local time would shift the billing window per region and could split a single
// calendar month into two usage buckets across a deploy region change.
function getMonthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function getMonthEnd(date: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      0,
      23,
      59,
      59,
      999,
    ),
  );
}
