// file: packages/subscriptions/src/integrations/elysia.ts
// Elysia integration for @abshahin/subscriptions

import { Elysia, ElysiaCustomStatusResponse, StatusMap, t } from "elysia";
import {
  FeatureNotAllowedError,
  PaymentFailedError,
  SubscriptionError,
} from "../core/errors.js";
import type { FeatureRegistry } from "../core/types.js";
import type { Subscriptions } from "../index.js";
import type { UsageAdmission } from "../services/permissions.service.js";
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
     * Prefer `template` on Workers. Defaults to the built-in precompiled
     * template, which needs no filesystem at all.
     */
    templatePath?: string;

    /**
     * Inline Handlebars source, compiled lazily on server runtimes.
     * Takes precedence over `templatePath`. Use `template` on Workers.
     */
    templateSource?: string;

    /** Precompiled template function; takes precedence over source and path. */
    template?: import("../templates/invoice-utils.js").SubscriptionInvoiceTemplateRenderer;

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

  const subscriberIds = new WeakMap<Request, string>();
  const requireSubscriberId = async (
    ctx: unknown,
    operation: SubscriptionOperation,
  ): Promise<string> => {
    const request = (ctx as { request: Request }).request;
    const subscriberId = subscriberIds.get(request) ?? await getSubscriberId(ctx);
    if (typeof subscriberId !== "string" || !subscriberId.trim()) {
      throw new SubscriptionError("Unauthorized", "UNAUTHORIZED", 401);
    }
    subscriberIds.set(request, subscriberId);
    if (options?.authorizeSubscriber &&
      await options.authorizeSubscriber(ctx, subscriberId, operation) !== true) {
      throw new SubscriptionError("Access denied", "FORBIDDEN", 403);
    }
    return subscriberId;
  };

  type UsageContext = {
    request: Request;
    response?: unknown;
    set: { status?: number | keyof typeof StatusMap };
    error?: unknown;
  };
  const admissions = new WeakMap<Request, Map<keyof TFeatures, {
    receipt: UsageAdmission;
    consume: boolean;
  }>>();

  const admitFeature = async (
    ctx: UsageContext,
    feature: keyof TFeatures,
    count: number,
    operation: "usage" | "consume-usage",
  ): Promise<void> => {
    const subscriberId = await requireSubscriberId(ctx, operation);
    let requestAdmissions = admissions.get(ctx.request);
    if (!requestAdmissions) {
      requestAdmissions = new Map();
      admissions.set(ctx.request, requestAdmissions);
    }
    const existing = requestAdmissions.get(feature);
    if (existing) {
      existing.consume ||= operation === "consume-usage";
      return;
    }
    const receipt = await subs.permissions.admitUsage(subscriberId, feature, count);
    requestAdmissions.set(feature, { receipt, consume: operation === "consume-usage" });
  };

  const finishUsage = async (ctx: UsageContext): Promise<void> => {
    const requestAdmissions = admissions.get(ctx.request);
    if (!requestAdmissions) return;
    const configuredStatus = typeof ctx.set.status === "string" ? StatusMap[ctx.set.status] : ctx.set.status ?? 200;
    const responseStatus = ctx.response instanceof Response
      ? ctx.response.status === 200 ? configuredStatus : ctx.response.status
      : ctx.response instanceof ElysiaCustomStatusResponse ? ctx.response.code
      : configuredStatus;
    for (const [feature, admission] of requestAdmissions) {
      if (!ctx.error && !(ctx.response instanceof Error) && responseStatus < 400 && admission.consume) await admission.receipt.commit();
      else await admission.receipt.release();
      requestAdmissions.delete(feature);
    }
    admissions.delete(ctx.request);
  };

  const subscriptionErrorResponse = ({ error, set }: UsageContext) => {
    if (error instanceof PaymentFailedError) {
      set.status = error.statusCode;
      return {
        error: error.code, message: error.message,
        ...(error.errorCode && { errorCode: error.errorCode }),
        ...(error.isRetryable !== undefined && { isRetryable: error.isRetryable }),
        ...(error.userAction && { userAction: error.userAction }),
        ...(error.paymentId && { paymentId: error.paymentId }),
      };
    }
    if (error instanceof SubscriptionError) {
      set.status = error.statusCode;
      return { error: error.code, message: error.message };
    }
    const status = webhookFailureStatus(error);
    if (status) {
      set.status = status;
      return { error: error instanceof Error ? error.message : "Webhook verification failed" };
    }
  };

  const usageErrorResponse = async (ctx: UsageContext) => {
    await finishUsage(ctx);
    return subscriptionErrorResponse(ctx);
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
    .onError(subscriptionErrorResponse)
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
      const { subscription: invoiceSubscription, plan: invoicePlan, ...invoiceRecord } = invoice;
      const invoiceData: SubscriptionInvoiceData = {
        invoice: {
          ...invoiceRecord,
          lineItems: invoice.lineItems.map((item) => ({
            ...item,
            amount: item.amount ?? 0,
            unitPrice: item.unitPrice ?? item.amount ?? 0,
          })),
        },
        subscription: {
          id: invoiceSubscription.id,
          status: invoiceSubscription.status,
          currentPeriodStart: invoiceSubscription.currentPeriodStart,
          currentPeriodEnd: invoiceSubscription.currentPeriodEnd,
          subscriberId: invoiceSubscription.subscriberId,
        },
        plan: {
          name: invoicePlan.name,
          description: invoicePlan.description,
          price: invoicePlan.price,
          currency: invoicePlan.currency,
          interval: invoicePlan.interval,
          intervalCount: invoicePlan.intervalCount,
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

      const html = await renderSubscriptionInvoice(options?.invoice, invoiceData);

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
        error: subscriptionErrorResponse,
      }),

      /**
       * Reserve capacity while the handler runs. Commit consumption only when
       * paired with useFeature for the same feature; otherwise release it.
       *
       * @example
       * ```typescript
       * app.post('/products', handler, { requireUsage: { feature: 'maxProducts', count: 1 } })
       * ```
       */
      requireUsage: (config: { feature: keyof TFeatures; count?: number }) => ({
        beforeHandle: async (ctx: UsageContext) => {
          await admitFeature(ctx, config.feature, config.count ?? 1, "usage");
        },
        mapResponse: finishUsage,
        error: usageErrorResponse,
      }),

      /**
       * Authorize and reserve usage before execution; retain it only for a
       * successful response. A matching requireUsage supplies the count.
       *
       * @example
       * ```typescript
       * app.post('/products', handler, { useFeature: 'maxProducts' })
       * ```
       */
      useFeature: (feature: keyof TFeatures) => {
        let count = 1;
        return {
          // Expansion order can remove requireUsage before this macro reads it.
          // An existing request admission therefore also carries its exact count.
          introspect: (routeOptions: unknown) => {
            const usageConfig = (routeOptions as { requireUsage?: { feature: keyof TFeatures; count?: number } }).requireUsage;
            if (usageConfig?.feature === feature) count = usageConfig.count ?? 1;
          },
          beforeHandle: async (ctx: UsageContext) => {
            await admitFeature(ctx, feature, count, "consume-usage");
          },
          mapResponse: finishUsage,
          error: usageErrorResponse,
        };
      },
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
