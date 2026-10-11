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
import { webhookFailureStatus, type SubscriptionOperation } from "./http.js";
import {
  renderSubscriptionInvoice,
  wrapInvoiceForPrint,
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
   * Resolve a subscriber ID from a trusted authenticated context.
   * Subscriber routes return 401 when absent. Validate tenant membership here
   * when authorizeSubscriber is omitted.
   */
  getSubscriberId?: (ctx: unknown) =>
    string | null | undefined | Promise<string | null | undefined>;

  /** Validate tenant membership and permission for each subscriber operation. */
  authorizeSubscriber?: (
    ctx: unknown,
    subscriberId: string,
    operation: SubscriptionOperation,
  ) => boolean | Promise<boolean>;

  /**
   * Enable admin routes (plan management)
   * @default false
   */
  adminRoutes?: boolean;

  /**
   * Explicit administrative authorization check. Required for adminRoutes.
   */
  adminGuard?: (ctx: unknown) => boolean | Promise<boolean>;

  /**
   * Invoice configuration for PDF/HTML generation
   *
   * The download route (`GET /invoices/:id/download`) supports two modes via
   * the `format` query param:
   * - `format=pdf` (default) — server-generated PDF. Uses `pdfRenderer` when
   *   configured (any runtime), otherwise falls back to the Node.js puppeteer
   *   renderer.
   * - `format=html` — printable invoice HTML; add `print=1` for a print-ready
   *   page and `autoPrint=1` to open the browser print dialog on load
   *   (client-side "Save as PDF", zero server cost).
   */
  invoice?: {
    /**
     * Path to custom Handlebars template (Node.js filesystem only).
     * Prefer `templateSource` on non-Node runtimes. Defaults to the built-in
     * inlined template, which needs no filesystem at all.
     */
    templatePath?: string;

    /**
     * Inline Handlebars template source. Runtime-agnostic alternative to
     * `templatePath`; takes precedence when both are set.
     */
    templateSource?: string;

    /**
     * PDF renderer for `format=pdf` (e.g. `puppeteerPdfRenderer` on Node,
     * `cloudflarePdfRenderer` on Workers). When omitted, the legacy Node.js
     * puppeteer path is used.
     */
    pdfRenderer?: import("../templates/pdf-renderer.js").PdfRenderer;

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
    options?.getSubscriberId ?? (() => null);
  const adminRoutes = options?.adminRoutes ?? false;
  const adminGuard = options?.adminGuard;
  if (adminRoutes && typeof adminGuard !== "function") {
    throw new Error("elysiaPlugin: adminRoutes requires an explicit adminGuard authorization policy");
  }

  const requireSubscriberId = async (
    ctx: unknown,
    operation: SubscriptionOperation,
  ): Promise<string> => {
    const subscriberId = await getSubscriberId(ctx);
    if (typeof subscriberId !== "string" || !subscriberId.trim()) {
      throw new SubscriptionError("Unauthorized", "UNAUTHORIZED", 401);
    }
    if (options?.authorizeSubscriber &&
      await options.authorizeSubscriber(ctx, subscriberId, operation) !== true) {
      throw new SubscriptionError("Access denied", "FORBIDDEN", 403);
    }
    return subscriberId;
  };

  const subscribeBodySchema = t.Object({
    planId: t.String({ minLength: 1 }),
  }, { additionalProperties: false });

  // A host Elysia app may normalize unknown fields before schema validation.
  // Transform runs first, so forbidden financial fields must be checked here.
  const rejectUnknownFields = (body: unknown, allowed: string[]): void => {
    if (!body || typeof body !== "object" || Array.isArray(body)) return;
    const unknown = Object.keys(body).find((field) => !allowed.includes(field));
    if (unknown) {
      throw new SubscriptionError(
        `Public request field is not allowed: ${unknown}`,
        "INVALID_PUBLIC_INPUT",
        400,
      );
    }
  };

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
      };
      set: { status: number };
    };
    const subscriberId = await requireSubscriberId(ctx, "subscribe");
    const subscription = await subs.subscriptions.createSelfService(subscriberId, context.body.planId);
    context.set.status = 201;

    return { subscription };
  };

  const app = new Elysia({ name: "Plugin.Subscriptions", prefix, normalize: false })
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
      const status = webhookFailureStatus(error);
      if (status) {
        set.status = status;
        return { error: error instanceof Error ? error.message : "Webhook verification failed" };
      }
    })
    // ==================== Subscriber Routes ====================

    // Get current subscription
    .get("/current", async (ctx) => {
      const subscriberId = await requireSubscriberId(ctx, "current");
      const subscription = await subs.subscriptions.get(subscriberId);
      return { subscription };
    })

    // Get available plans
    .get("/plans", async () => {
      const plans = await subs.plans.list({ activeOnly: true });
      return { plans };
    })

    // Subscribe to a plan
    .post("/subscribe", createSubscription, {
      body: subscribeBodySchema,
      transform: ({ body }) => rejectUnknownFields(body, ["planId"]),
    })

    // Alias route to avoid Eden Treaty reserved-name collision on "subscribe"
    .post("/create", createSubscription, {
      body: subscribeBodySchema,
      transform: ({ body }) => rejectUnknownFields(body, ["planId"]),
    })

    // Change plan
    .post(
      "/change-plan",
      async (ctx) => {
        const subscriberId = await requireSubscriberId(ctx, "change-plan");
        const { planId, immediately, prorate, quoteId } = ctx.body;
        const result = await subs.subscriptions.changePlan(
          subscriberId,
          planId,
          {
            ...(immediately !== undefined && { immediately }),
            ...(prorate !== undefined && { prorate }),
            quoteId,
          },
        );

        return result;
      },
      {
        transform: ({ body }) => rejectUnknownFields(body, ["planId", "quoteId", "immediately", "prorate"]),
        body: t.Object({
          planId: t.String({ minLength: 1 }),
          quoteId: t.String({ minLength: 1 }),
          immediately: t.Optional(t.Boolean()),
          prorate: t.Optional(t.Boolean()),
        }, { additionalProperties: false }),
      },
    )

    // Preview plan change (shows what user will pay)
    .get("/change-plan/preview/:planId", async (ctx) => {
      const subscriberId = await requireSubscriberId(ctx, "preview-change-plan");
      const preview = await subs.subscriptions.previewChangePlan(
        subscriberId,
        ctx.params.planId,
        {
          ...(ctx.query["immediately"] !== undefined && { immediately: ctx.query["immediately"] === "true" }),
          ...(ctx.query["prorate"] !== undefined && { prorate: ctx.query["prorate"] === "true" }),
        },
      );
      return { preview };
    }, {
      query: t.Object({
        immediately: t.Optional(t.Union([t.Literal("true"), t.Literal("false")])),
        prorate: t.Optional(t.Union([t.Literal("true"), t.Literal("false")])),
      }),
    })

    // Cancel subscription
    .post(
      "/cancel",
      async (ctx) => {
        const subscriberId = await requireSubscriberId(ctx, "cancel");
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
      const subscriberId = await requireSubscriberId(ctx, "resume");
      const subscription = await subs.subscriptions.resume(subscriberId);
      return { subscription };
    })

    // Reactivate subscription (undo scheduled cancellation)
    .post("/reactivate", async (ctx) => {
      const subscriberId = await requireSubscriberId(ctx, "reactivate");
      const subscription = await subs.subscriptions.reactivate(subscriberId);
      return { subscription };
    })

    // ==================== Usage & Permissions ====================

    // Get all feature values
    .get("/features", async (ctx) => {
      const subscriberId = await requireSubscriberId(ctx, "features");
      const features = await subs.permissions.getFeatures(subscriberId);
      return { features };
    })

    // Get usage for all limit features
    .get("/usage", async (ctx) => {
      const subscriberId = await requireSubscriberId(ctx, "usage");
      const usage = await subs.permissions.getAllUsage(subscriberId);
      return { usage };
    })

    // Get usage for a specific feature
    .get("/usage/:feature", async (ctx) => {
      const subscriberId = await requireSubscriberId(ctx, "usage");
      const usage = await subs.permissions.remaining(
        subscriberId,
        ctx.params.feature as keyof TFeatures,
      );
      return { usage };
    })

    // Check if can use a feature
    .get("/can/:feature", async (ctx) => {
      const subscriberId = await requireSubscriberId(ctx, "can");
      const can = await subs.can(
        subscriberId,
        ctx.params.feature as keyof TFeatures,
      );
      return { can };
    })

    // ==================== Invoices ====================

    .get("/invoices", async (ctx) => {
      const subscriberId = await requireSubscriberId(ctx, "invoices");
      const subscription = await subs.subscriptions.get(subscriberId);
      if (!subscription) {
        return { invoices: [] };
      }
      const invoices = await subs.invoices.listBySubscription(subscription.id);
      return { invoices };
    })

    // Download invoice as PDF (default) or printable HTML (?format=html&print=1)
    .get("/invoices/:id/download", async (ctx) => {
      const subscriberId = await requireSubscriberId(ctx, "invoice");
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
          // Invoice amounts are persisted in major/display units (e.g. SAR/USD).
          amount: invoice.amount,
          currency: invoice.currency,
          status: invoice.status,
          gatewayInvoiceId: invoice.gatewayInvoiceId,
          paidAt: invoice.paidAt,
          dueDate: invoice.dueDate,
          lineItems: invoice.lineItems.map((item) => ({
            ...item,
            amount: item.amount || 0,
            unitPrice: item.unitPrice || item.amount || 0,
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

      // Output modes: server-generated PDF (default) or printable HTML for
      // client-side printing (zero server cost).
      const { query } = ctx;
      const format = query["format"] ?? "pdf";
      const autoPrint = query["autoPrint"] === "1";
      const print = autoPrint || query["print"] === "1";

      // Resolve the template: explicit source > explicit path > built-in
      // inlined template (no filesystem, edge-safe).
      const renderSource = options?.invoice?.templateSource
        ? { templateSource: options.invoice.templateSource }
        : options?.invoice?.templatePath
          ? { templatePath: options.invoice.templatePath }
          : undefined;

      // Render the invoice HTML once; both modes build on it.
      const html = await renderSubscriptionInvoice(renderSource, invoiceData);

      if (format === "html") {
        const body = print
          ? wrapInvoiceForPrint(html, { autoPrint })
          : html;
        return new Response(body, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      // PDF mode: use the configured renderer (any runtime) or fall back to
      // the legacy Node.js puppeteer renderer — either way the HTML rendered
      // above is converted directly (no second render pass).
      const renderer =
        options?.invoice?.pdfRenderer ??
        (await import("../pdf/puppeteer.js")).puppeteerPdfRenderer();
      const pdfBytes = await renderer.render(html);

      // Copy into a fresh ArrayBuffer-backed view for the Response body
      const bytes = new Uint8Array(pdfBytes.byteLength);
      bytes.set(pdfBytes);
      return new Response(bytes.buffer, {
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
        ctx.headers["x-moyasar-signature"] ||
        ctx.headers["stripe-signature"] ||
        ctx.headers["x-webhook-signature"] ||
        "";
      const body = await ctx.request.text();

      const event = await subs.handleWebhook(provider, body, signature, {
        headers: Object.fromEntries(ctx.request.headers.entries()),
      });
      return { received: true, eventId: event.id };
    }, { parse: "none" })

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
          const subscriberId = await requireSubscriberId(ctx, "can");
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
          const subscriberId = await requireSubscriberId(ctx, "usage");
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
          const subscriberId = await requireSubscriberId(ctx, "consume-usage");
          await subs.use(subscriberId, feature);
        },
      }),
    });

  // Add admin routes if enabled
  if (adminRoutes) {
    app
      .guard({
        beforeHandle: async (ctx) => {
          const isAdmin = await adminGuard!(ctx);
          if (isAdmin !== true) {
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
