// file: packages/subscriptions/src/integrations/elysia.ts
// Elysia integration for @abshahin/subscriptions

import { Elysia, t } from "elysia";
import {
  FeatureNotAllowedError,
  PaymentFailedError,
  SubscriptionError,
  UsageLimitExceededError,
} from "../core/errors.js";
import type { FeatureRegistry } from "../core/types.js";
import type { Subscriptions } from "../index.js";
import {
  generateSubscriptionInvoicePdf,
  type SubscriptionInvoiceData,
} from "../templates/invoice-utils.js";

/**
 * Platform info for invoice rendering
 */
export interface PlatformInfo {
  name: string;
  logo?: string;
  website?: string;
  supportEmail?: string;
  address?: string;
}

/**
 * Subscriber info resolver for invoice rendering
 */
export type SubscriberInfoResolver = (subscriberId: string) => Promise<{
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
} | null>;

/**
 * Options for the Elysia plugin
 */
export interface ElysiaPluginOptions<
  TPrefix extends string = "/subscriptions",
> {
  /**
   * Route prefix for subscription endpoints
   * @default '/subscriptions'
   */
  prefix?: TPrefix;

  /**
   * Function to extract subscriber ID from context
   * Defaults to using `user.activeTenantId`
   */
  getSubscriberId?: (ctx: unknown) => string | Promise<string>;

  /**
   * Enable admin routes (plan management)
   * @default true
   */
  adminRoutes?: boolean;

  /**
   * Custom authorization check for admin routes
   */
  adminGuard?: (ctx: unknown) => boolean | Promise<boolean>;

  /**
   * Invoice configuration for PDF/HTML generation
   */
  invoice?: {
    /**
     * Path to custom Handlebars template
     * Defaults to built-in subscription-invoice.hbs
     */
    templatePath?: string;

    /**
     * Platform information for invoice header
     */
    platform?: PlatformInfo;

    /**
     * Function to resolve subscriber info for invoice
     */
    getSubscriberInfo?: SubscriberInfoResolver;

    /**
     * Default locale for date/currency formatting
     * @default 'ar-EG'
     */
    locale?: string;
  };
}

/**
 * Create an Elysia plugin for subscription management
 *
 * @example
 * ```typescript
 * import { elysiaPlugin } from '@abshahin/subscriptions/elysia';
 *
 * app.use(elysiaPlugin(subs, {
 *   getSubscriberId: (ctx) => ctx.user.activeTenantId,
 * }));
 * ```
 */
export function elysiaPlugin<
  TFeatures extends FeatureRegistry,
  const TPrefix extends string = "/subscriptions",
>(subs: Subscriptions<TFeatures>, options?: ElysiaPluginOptions<TPrefix>) {
  const prefix = (options?.prefix ?? "/subscriptions") as TPrefix;
  const getSubscriberId =
    options?.getSubscriberId ??
    ((ctx: unknown) =>
      (ctx as { user?: { activeTenantId?: string } }).user?.activeTenantId);
  const adminRoutes = options?.adminRoutes ?? true;
  const adminGuard = options?.adminGuard ?? (() => true);

  const requireSubscriberId = async (ctx: unknown): Promise<string> => {
    const subscriberId = await getSubscriberId(ctx);
    if (!subscriberId) {
      throw new Error("Subscriber ID is required");
    }
    return subscriberId;
  };

  const subscribeBodySchema = t.Object({
    planId: t.String(),
    /** Override plan's default trial days */
    trialDays: t.Optional(t.Number()),
    /** Verified token ID from frontend payment - save for future renewals */
    verifiedTokenId: t.Optional(t.String()),
    /** Payment ID from Moyasar after successful payment - used to create invoice */
    paymentId: t.Optional(t.String()),
  });

  const planIntervalSchema = t.Union([
    t.Literal("monthly"),
    t.Literal("yearly"),
    t.Literal("one_time"),
    t.Literal("custom"),
  ]);

  const adminCreatePlanBodySchema = t.Object({
    name: t.String(),
    description: t.Optional(t.Nullable(t.String())),
    price: t.Number(),
    currency: t.Optional(t.String()),
    interval: planIntervalSchema,
    intervalCount: t.Optional(t.Number()),
    trialDays: t.Optional(t.Number()),
    features: t.Optional(t.Record(t.String(), t.Any())),
    isActive: t.Optional(t.Boolean()),
    sortOrder: t.Optional(t.Number()),
    metadata: t.Optional(t.Record(t.String(), t.Any())),
  });

  const adminUpdatePlanBodySchema = t.Object({
    name: t.Optional(t.String()),
    description: t.Optional(t.Nullable(t.String())),
    price: t.Optional(t.Number()),
    currency: t.Optional(t.String()),
    interval: t.Optional(planIntervalSchema),
    intervalCount: t.Optional(t.Number()),
    trialDays: t.Optional(t.Number()),
    features: t.Optional(t.Record(t.String(), t.Any())),
    isActive: t.Optional(t.Boolean()),
    sortOrder: t.Optional(t.Number()),
    metadata: t.Optional(t.Record(t.String(), t.Any())),
  });

  const createSubscription = async (ctx: unknown) => {
    const context = ctx as {
      body: {
        planId: string;
        trialDays?: number;
        verifiedTokenId?: string;
        paymentId?: string;
      };
      set: { status: number };
    };
    const subscriberId = await requireSubscriberId(ctx);
    const {
      planId,
      trialDays: requestTrialDays,
      verifiedTokenId,
      paymentId,
    } = context.body;

    const plan = await subs.plans.get(planId);
    if (!plan) {
      context.set.status = 404;
      return { error: "Plan not found" };
    }

    const effectiveTrialDays = requestTrialDays ?? plan.trialDays;

    const subscription = await subs.subscriptions.create(subscriberId, planId, {
      ...(effectiveTrialDays > 0 && { trialDays: effectiveTrialDays }),
      ...(verifiedTokenId && { gatewayCustomerId: verifiedTokenId }),
    });

    if (verifiedTokenId && paymentId && subscription.status === "active") {
      if (plan.price > 0) {
        const amount = Math.round(plan.price * 100); // Convert to smallest unit (cents/halalas)
        await subs.invoices.create({
          subscriptionId: subscription.id,
          amount,
          currency: plan.currency,
          status: "paid",
          gatewayInvoiceId: paymentId,
          lineItems: [
            {
              description: `${plan.name} - Initial subscription`,
              quantity: 1,
              unitPrice: amount,
              amount: amount,
            },
          ],
          metadata: {
            paymentId,
            type: "initial_subscription",
          },
        });
      }
    }

    return { subscription };
  };

  const app = new Elysia({ name: "Plugin.Subscriptions", prefix })
    // Error handling
    .onError(({ error, set }) => {
      // Enhanced handling for payment errors
      if (error instanceof PaymentFailedError) {
        set.status = error.statusCode;
        return {
          error: error.code,
          message: error.message,
          ...(error.errorCode && { errorCode: error.errorCode }),
          ...(error.isRetryable !== undefined && {
            isRetryable: error.isRetryable,
          }),
          ...(error.userAction && { userAction: error.userAction }),
          ...(error.paymentId && { paymentId: error.paymentId }),
        };
      }
      if (error instanceof SubscriptionError) {
        set.status = error.statusCode;
        return {
          error: error.code,
          message: error.message,
        };
      }
    })
    // ==================== Subscriber Routes ====================

    // Get current subscription
    .get("/current", async (ctx) => {
      const subscriberId = await requireSubscriberId(ctx);
      const subscription = await subs.subscriptions.get(subscriberId);
      return { subscription };
    })

    // Get available plans
    .get("/plans", async () => {
      const plans = await subs.plans.list({ activeOnly: true });
      return { plans };
    })

    // Subscribe to a plan
    .post("/subscribe", createSubscription, { body: subscribeBodySchema })

    // Alias route to avoid Eden Treaty reserved-name collision on "subscribe"
    .post("/create", createSubscription, { body: subscribeBodySchema })

    // Change plan
    .post(
      "/change-plan",
      async (ctx) => {
        const subscriberId = await requireSubscriberId(ctx);
        const {
          planId,
          immediately,
          prorate,
          tokenId,
          callbackUrl,
          skipPayment,
          verifiedTokenId,
          paymentId,
        } = ctx.body;
        const result = await subs.subscriptions.changePlan(
          subscriberId,
          planId,
          {
            ...(immediately !== undefined && { immediately }),
            ...(prorate !== undefined && { prorate }),
            ...(tokenId && { tokenId }),
            ...(callbackUrl && { callbackUrl }),
            ...(skipPayment !== undefined && { skipPayment }),
            ...(verifiedTokenId && { verifiedTokenId }),
          },
        );

        // Create invoice if payment was made
        // paymentId is provided from frontend when:
        // 1. Direct payment success (charged via Moyasar Payments API)
        // 2. 3DS callback (payment was charged before redirect)
        // Note: result.charged may be false for 3DS flows (skipPayment: true)
        if (paymentId && result.subscription) {
          const plan = await subs.plans.get(planId);
          if (plan) {
            // Use the actual charged amount from the service (handles proration correctly).
            // Fallback to full plan price in smallest unit if chargeAmount is not available.
            const invoiceAmount =
              result.chargeAmount ?? Math.round(plan.price * 100);
            await subs.invoices.create({
              subscriptionId: result.subscription.id,
              amount: invoiceAmount,
              currency: plan.currency,
              status: "paid",
              paidAt: new Date(),
              gatewayInvoiceId: paymentId,
              lineItems: [
                {
                  description: `Plan upgrade to ${plan.name}`,
                  quantity: 1,
                  unitPrice: invoiceAmount,
                  amount: invoiceAmount,
                },
              ],
              metadata: {
                description: `Plan upgrade to ${plan.name}`,
                paymentId,
              },
            });
          }
        }

        return result;
      },
      {
        body: t.Object({
          planId: t.String(),
          immediately: t.Optional(t.Boolean()),
          prorate: t.Optional(t.Boolean()),
          tokenId: t.Optional(t.String()),
          callbackUrl: t.Optional(t.String()),
          skipPayment: t.Optional(t.Boolean()),
          /** Verified token ID from frontend 3DS - save for future renewals */
          verifiedTokenId: t.Optional(t.String()),
          /** Payment ID from Moyasar for invoice creation */
          paymentId: t.Optional(t.String()),
        }),
      },
    )

    // Preview plan change (shows what user will pay)
    .get("/change-plan/preview/:planId", async (ctx) => {
      const subscriberId = await requireSubscriberId(ctx);
      const preview = await subs.subscriptions.previewChangePlan(
        subscriberId,
        ctx.params.planId,
      );
      return { preview };
    })

    // Cancel subscription
    .post(
      "/cancel",
      async (ctx) => {
        const subscriberId = await requireSubscriberId(ctx);
        const { immediately, reason } = ctx.body;
        const subscription = await subs.subscriptions.cancel(subscriberId, {
          ...(immediately !== undefined && { immediately }),
          ...(reason !== undefined && { reason }),
        });
        return { subscription };
      },
      {
        body: t.Object({
          immediately: t.Optional(t.Boolean()),
          reason: t.Optional(t.String()),
        }),
      },
    )

    // Resume subscription (from paused status)
    .post("/resume", async (ctx) => {
      const subscriberId = await requireSubscriberId(ctx);
      const subscription = await subs.subscriptions.resume(subscriberId);
      return { subscription };
    })

    // Reactivate subscription (undo scheduled cancellation)
    .post("/reactivate", async (ctx) => {
      const subscriberId = await requireSubscriberId(ctx);
      const subscription = await subs.subscriptions.reactivate(subscriberId);
      return { subscription };
    })

    // ==================== Usage & Permissions ====================

    // Get all feature values
    .get("/features", async (ctx) => {
      const subscriberId = await requireSubscriberId(ctx);
      const features = await subs.permissions.getFeatures(subscriberId);
      return { features };
    })

    // Get usage for all limit features
    .get("/usage", async (ctx) => {
      const subscriberId = await requireSubscriberId(ctx);
      const usage = await subs.permissions.getAllUsage(subscriberId);
      return { usage };
    })

    // Get usage for a specific feature
    .get("/usage/:feature", async (ctx) => {
      const subscriberId = await requireSubscriberId(ctx);
      const usage = await subs.permissions.remaining(
        subscriberId,
        ctx.params.feature as keyof TFeatures,
      );
      return { usage };
    })

    // Check if can use a feature
    .get("/can/:feature", async (ctx) => {
      const subscriberId = await requireSubscriberId(ctx);
      const can = await subs.can(
        subscriberId,
        ctx.params.feature as keyof TFeatures,
      );
      return { can };
    })

    // ==================== Invoices ====================

    .get("/invoices", async (ctx) => {
      const subscriberId = await requireSubscriberId(ctx);
      const subscription = await subs.subscriptions.get(subscriberId);
      if (!subscription) {
        return { invoices: [] };
      }
      const invoices = await subs.invoices.listBySubscription(subscription.id);
      return { invoices };
    })

    // Download invoice as HTML
    .get("/invoices/:id/download", async (ctx) => {
      const subscriberId = await requireSubscriberId(ctx);
      const { id } = ctx.params;

      // Get invoice with full details
      const invoice = await subs.invoices.getWithDetails(id);

      if (!invoice) {
        ctx.set.status = 404;
        return { error: "Invoice not found" };
      }

      // Verify the invoice belongs to this subscriber
      if (invoice.subscription.subscriberId !== subscriberId) {
        ctx.set.status = 403;
        return { error: "Access denied" };
      }

      // Resolve subscriber info if resolver is configured
      let subscriberInfo: SubscriptionInvoiceData["subscriber"] = undefined;
      if (options?.invoice?.getSubscriberInfo) {
        const info = await options.invoice.getSubscriberInfo(subscriberId);
        if (info) {
          subscriberInfo = info;
        }
      }

      // Build invoice data for template
      const invoiceData: SubscriptionInvoiceData = {
        invoice: {
          id: invoice.id,
          subscriptionId: invoice.subscriptionId,
          subscriberId: invoice.subscriberId,
          // Convert from smallest unit (halalas/cents) to display unit (SAR/USD)
          amount: invoice.amount / 100,
          currency: invoice.currency,
          status: invoice.status,
          gatewayInvoiceId: invoice.gatewayInvoiceId,
          paidAt: invoice.paidAt,
          dueDate: invoice.dueDate,
          // Convert lineItem amounts from smallest units to display units
          lineItems: invoice.lineItems.map((item) => ({
            ...item,
            amount: (item.amount || 0) / 100,
            unitPrice: (item.unitPrice || item.amount || 0) / 100,
          })),
          metadata: invoice.metadata,
          createdAt: invoice.createdAt,
          updatedAt: invoice.updatedAt,
        },
        subscription: {
          id: invoice.subscription.id,
          status: invoice.subscription.status,
          currentPeriodStart: invoice.subscription.currentPeriodStart,
          currentPeriodEnd: invoice.subscription.currentPeriodEnd,
          subscriberId: invoice.subscription.subscriberId,
        },
        plan: {
          name: invoice.plan.name,
          description: invoice.plan.description,
          price: invoice.plan.price,
          currency: invoice.plan.currency,
          interval: invoice.plan.interval,
          intervalCount: invoice.plan.intervalCount,
        },
        platform: options?.invoice?.platform ?? {
          name: "Subscription Platform",
        },
        subscriber: subscriberInfo,
        locale: options?.invoice?.locale ?? "ar-EG",
      };

      // Resolve template path
      const templatePath =
        options?.invoice?.templatePath ??
        new URL("../templates/subscription-invoice.hbs", import.meta.url)
          .pathname;

      // Generate PDF
      const pdfBuffer = await generateSubscriptionInvoicePdf(
        templatePath,
        invoiceData,
      );
      const pdfBytes = new Uint8Array(pdfBuffer.byteLength);
      pdfBytes.set(pdfBuffer);

      // Return PDF Response
      return new Response(pdfBytes.buffer, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="invoice-${invoice.id}.pdf"`,
        },
      });
    })

    // ==================== Webhooks ====================

    .post("/webhooks/:provider", async (ctx) => {
      const { provider } = ctx.params;
      const signature =
        ctx.headers["stripe-signature"] ||
        ctx.headers["x-webhook-signature"] ||
        "";
      const body = await ctx.request.text();

      const event = await subs.handleWebhook(provider, body, signature);
      return { received: true, eventId: event.id };
    })

    // ==================== Macros ====================

    .macro({
      /**
       * Require a boolean feature to be enabled
       *
       * @example
       * ```typescript
       * app.get('/analytics', handler, { requireFeature: 'analytics' })
       * ```
       */
      requireFeature: (feature: keyof TFeatures) => ({
        beforeHandle: async (ctx: unknown) => {
          const subscriberId = await requireSubscriberId(ctx);
          const allowed = await subs.can(subscriberId, feature);
          if (!allowed) {
            throw new FeatureNotAllowedError(feature as string);
          }
        },
      }),

      /**
       * Require usage capacity for a limited feature
       *
       * @example
       * ```typescript
       * app.post('/products', handler, { requireUsage: { feature: 'maxProducts', count: 1 } })
       * ```
       */
      requireUsage: (config: { feature: keyof TFeatures; count?: number }) => ({
        beforeHandle: async (ctx: unknown) => {
          const subscriberId = await requireSubscriberId(ctx);
          const canUse = await subs.permissions.canUse(
            subscriberId,
            config.feature,
            config.count ?? 1,
          );
          if (!canUse) {
            const status = await subs.remaining(subscriberId, config.feature);
            throw new UsageLimitExceededError(
              config.feature as string,
              status.limit as number,
              status.used,
            );
          }
        },
      }),

      /**
       * Increment usage after successful handler execution
       *
       * @example
       * ```typescript
       * app.post('/products', handler, { useFeature: 'maxProducts' })
       * ```
       */
      useFeature: (feature: keyof TFeatures) => ({
        afterHandle: async (ctx: unknown) => {
          const subscriberId = await requireSubscriberId(ctx);
          await subs.use(subscriberId, feature);
        },
      }),
    });

  // Add admin routes if enabled
  if (adminRoutes) {
    app
      .guard({
        beforeHandle: async (ctx) => {
          const isAdmin = await adminGuard(ctx);
          if (!isAdmin) {
            throw new FeatureNotAllowedError("admin");
          }
        },
      })
      .group("/admin", (admin) =>
        admin
          // List all plans with filters (admin)
          .get(
            "/plans",
            async (ctx) => {
              const { isActive, interval, limit, offset } = ctx.query;
              const result = await subs.plans.listForAdmin({
                ...(isActive !== undefined && {
                  isActive: isActive === "true",
                }),
                ...(interval && { interval }),
                ...(limit && { limit: Number(limit) }),
                ...(offset && { offset: Number(offset) }),
              });
              return result;
            },
            {
              query: t.Object({
                isActive: t.Optional(
                  t.String({
                    description: "Filter by active status: true or false",
                  }),
                ),
                interval: t.Optional(
                  t.String({
                    description:
                      "Filter by billing interval: monthly, yearly, one_time",
                  }),
                ),
                limit: t.Optional(
                  t.String({ description: "Pagination limit" }),
                ),
                offset: t.Optional(
                  t.String({ description: "Pagination offset" }),
                ),
              }),
            },
          )

          // Create plan
          .post(
            "/plans",
            async (ctx) => {
              const plan = await subs.plans.create(ctx.body);
              return { plan };
            },
            {
              body: adminCreatePlanBodySchema,
            },
          )

          // Update plan
          .patch(
            "/plans/:id",
            async (ctx) => {
              const plan = await subs.plans.update(ctx.params.id, ctx.body);
              return { plan };
            },
            {
              params: t.Object({
                id: t.String(),
              }),
              body: adminUpdatePlanBodySchema,
            },
          )

          // Delete plan
          .delete(
            "/plans/:id",
            async (ctx) => {
              await subs.plans.delete(ctx.params.id);
              return { success: true };
            },
            {
              params: t.Object({
                id: t.String(),
              }),
            },
          )

          // Duplicate plan
          .post(
            "/plans/:id/duplicate",
            async (ctx) => {
              const plan = await subs.plans.duplicate(ctx.params.id, ctx.body);
              return { plan };
            },
            {
              params: t.Object({
                id: t.String(),
              }),
              body: adminUpdatePlanBodySchema,
            },
          ),
      );
  }

  return app;
}
