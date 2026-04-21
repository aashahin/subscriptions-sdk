// file: packages/subscriptions/src/adapters/prisma.adapter.ts
// Prisma adapter implementation for @abshahin/subscriptions

import type {
    CreateInvoiceInput,
    CreatePlanInput,
    CreateSubscriptionInput,
    FeatureRegistry,
    Invoice,
    InvoiceWithDetails,
    Plan,
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
 */
type PrismaClient = {
  subscriptionPlan: any;
  subscription: any;
  invoice: any;
  usageRecord: any;
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
  const createAdapter = (client: PrismaClient): DatabaseAdapter<TFeatures> => ({
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
            interval: data.interval,
            intervalCount: data.intervalCount ?? 1,
            trialDays: data.trialDays ?? 0,
            features: data.features ?? {},
            isActive: data.isActive ?? true,
            sortOrder: data.sortOrder ?? 0,
            metadata: data.metadata ?? null,
          },
        });
        return mapPlanFromPrisma<TFeatures>(plan);
      },

      async update(
        id: string,
        data: UpdatePlanInput<TFeatures>,
      ): Promise<Plan<TFeatures>> {
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
            ...(data.metadata !== undefined && { metadata: data.metadata }),
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
            metadata: data.metadata ?? null,
          },
        });
        return mapSubscriptionFromPrisma(subscription);
      },

      async update(
        id: string,
        data: UpdateSubscriptionInput,
      ): Promise<Subscription> {
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
            ...(data.metadata !== undefined && { metadata: data.metadata }),
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
            metadata: data.metadata ?? null,
          },
        });
        return mapInvoiceFromPrisma(invoice);
      },

      async update(id: string, data: UpdateInvoiceInput): Promise<Invoice> {
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
            ...(data.metadata !== undefined && { metadata: data.metadata }),
          },
        });
        return mapInvoiceFromPrisma(invoice);
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

        // Get current count first
        const current = await this.get(subscriberId, feature, { tenantId });
        const newCount = Math.max(0, current - count);

        if (current > 0) {
          await client.usageRecord.update({
            where: {
              subscriberId_tenantId_feature_periodStart: {
                subscriberId,
                tenantId: tenantId,
                feature,
                periodStart,
              },
            },
            data: { count: newCount },
          });
        }

        return newCount;
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
  });

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

function mapPlanFromPrisma<TFeatures extends FeatureRegistry>(
  plan: any,
): Plan<TFeatures> {
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    price: Number(plan.price),
    currency: plan.currency,
    interval: plan.interval,
    intervalCount: plan.intervalCount ?? 1,
    trialDays: plan.trialDays ?? 0,
    features: parseJsonField(plan.features, {}),
    isActive: plan.isActive,
    sortOrder: plan.sortOrder,
    metadata: parseJsonField(plan.metadata, null),
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

function mapSubscriptionFromPrisma(subscription: any): Subscription {
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
    metadata: parseJsonField(subscription.metadata, null),
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
  return {
    id: invoice.id,
    subscriptionId: invoice.subscriptionId,
    subscriberId: invoice.tenantId ?? invoice.subscriberId,
    amount: Number(invoice.amount),
    currency: invoice.currency,
    status: invoice.status,
    gatewayInvoiceId: invoice.gatewayInvoiceId,
    paidAt: invoice.paidAt,
    dueDate: invoice.dueDate,
    lineItems: parseJsonField(invoice.lineItems, []),
    metadata: parseJsonField(invoice.metadata, null),
    createdAt: invoice.createdAt,
    updatedAt: invoice.updatedAt,
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

function getMonthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function getMonthEnd(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}
