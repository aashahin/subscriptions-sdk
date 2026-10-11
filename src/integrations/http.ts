// file: packages/subscriptions/src/integrations/http.ts
// Framework-neutral, web-standard HTTP handler for @abshahin/subscriptions.
// Uses only Fetch API primitives (Request/Response) so it runs on Node, Bun,
// Deno, and Cloudflare Workers without any framework imports.

import {
  PaymentFailedError,
  SubscriptionError,
} from "../core/errors.js";
import type { FeatureRegistry } from "../core/types.js";
import type { Subscriptions } from "../index.js";
import type { SubscriptionInvoiceData } from "../templates/invoice-utils.js";

/**
 * Resolve subscriber display info for invoice rendering
 */
export type SubscriberInfoResolver = (
  subscriberId: string,
) => Promise<SubscriptionInvoiceData["subscriber"] | null>;

/** Operation names supplied to host authorization policies. */
export type SubscriptionOperation =
  | "current"
  | "subscribe"
  | "cancel"
  | "change-plan"
  | "preview-change-plan"
  | "resume"
  | "reactivate"
  | "features"
  | "usage"
  | "can"
  | "invoices"
  | "invoice"
  | "consume-usage";

/** Provider verification errors belong to the request; outages stay retryable. */
export function webhookFailureStatus(error: unknown): 400 | 401 | undefined {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "WEBHOOK_SECRET_INVALID" || code === "WEBHOOK_SCOPE_MISMATCH") return 401;
  if (error instanceof SyntaxError ||
    (error instanceof Error && /signature|verification|invalid (webhook|payload)|unknown payment provider/i.test(error.message))) {
    return 400;
  }
  return undefined;
}

/**
 * Options for the web-standard HTTP handler
 */
export interface SubscriptionsHttpOptions {
  /**
   * Route prefix for subscription endpoints.
   * The handler locates this prefix anywhere in the request path, so the
   * handler can be mounted under any base path (e.g. `/api` in Next.js or a
   * Hono sub-router) as long as the prefix itself appears in the URL.
   * @default '/subscriptions'
   */
  prefix?: string;

  /**
   * Resolve the subscriber ID from a trusted authenticated session.
   * Subscriber routes return 401 when this is absent or cannot resolve an ID.
   * The resolver must validate tenant membership when authorizeSubscriber is
   * omitted; an incoming subscriber header is not authentication.
   */
  getSubscriberId?: (
    request: Request,
  ) => string | null | undefined | Promise<string | null | undefined>;

  /** Validate tenant membership and permission for each subscriber operation. */
  authorizeSubscriber?: (
    request: Request,
    subscriberId: string,
    operation: SubscriptionOperation,
  ) => boolean | Promise<boolean>;

  /**
   * Optional signature header hint for `POST /webhooks/:provider`.
   * All headers and the raw body are sent to provider-specific verification;
   * providers such as Moyasar authenticate a body secret instead.
   * @default 'x-signature'
   */
  webhookSignatureHeader?: string;

  /**
   * Invoice configuration for `GET /invoices/:id`
   *
   * The route supports two output modes via the `format` query param:
   * - `format=html` (default) — rendered invoice HTML; add `print=1` to get a
   *   print-ready page (toolbar + print CSS) and `autoPrint=1` to open the
   *   browser print dialog on load (client-side "Save as PDF", zero server
   *   cost).
   * - `format=pdf` — server-generated PDF via the configured `pdfRenderer`.
   */
  invoice?: {
    /**
     * Path to a custom Handlebars template (Node.js filesystem only).
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
     * `cloudflarePdfRenderer` on Workers). Without it, `format=pdf`
     * returns 501 — use `format=html&print=1` for client-side printing.
     */
    pdfRenderer?: import("../templates/pdf-renderer.js").PdfRenderer;

    /**
     * Platform information for the invoice header
     */
    platform?: SubscriptionInvoiceData["platform"];

    /**
     * Resolve subscriber display info for the invoice
     */
    getSubscriberInfo?: SubscriberInfoResolver;

    /**
     * Locale for date/currency formatting
     * @default 'ar-EG'
     */
    locale?: string;

    /**
     * Custom HTML renderer. When provided, the built-in Handlebars renderer
     * is never invoked. Takes precedence over `templatePath`/`templateSource`.
     */
    renderHtml?: (data: SubscriptionInvoiceData) => Promise<string>;
  };
}

/**
 * Web-standard handler returned by {@link createSubscriptionsHttpHandler}
 */
export interface SubscriptionsHttpHandler {
  fetch(request: Request): Promise<Response>;
}

type RouteParams = Record<string, string>;

type RouteHandler = (
  request: Request,
  params: RouteParams,
  subscriberId: string | null,
) => Promise<Response>;

interface Route {
  method: "GET" | "POST";
  /** Path segments; `:name` entries capture a segment into params */
  pattern: string[];
  /** Whether a subscriber ID is required (401 when unresolved) */
  auth: boolean;
  operation?: SubscriptionOperation;
  handler: RouteHandler;
}

/**
 * Create a framework-neutral HTTP handler exposing the subscription API over
 * web-standard Request/Response. Mount it from any framework (Hono, Next.js
 * route handlers, a plain `fetch` listener, etc.).
 *
 * Routes (under `options.prefix`, default `/subscriptions`):
 * - `GET  /plans`               — list active plans
 * - `GET  /current`             — current subscription for the subscriber
 * - `POST /subscribe`           — `{ planId }`; trusted self-service policy
 * - `POST /cancel`              — `{ immediately?, reason? }`
 * - `GET /change-plan/preview/:planId` — trusted quote for a plan change
 * - `POST /change-plan`         — `{ planId, quoteId, immediately?, prorate? }`
 * - `GET  /usage`               — usage for all limit features
 * - `GET  /invoices`            — invoices for the subscriber
 * - `GET  /invoices/:id`        — invoice as HTML (`?print=1` / `?autoPrint=1`
 *                                 for client-side printing) or PDF (`?format=pdf`,
 *                                 requires `invoice.pdfRenderer`)
 * - `POST /webhooks/:provider`  — payment gateway webhooks
 *
 * @example
 * ```typescript
 * const handler = createSubscriptionsHttpHandler(subs, {
 *   getSubscriberId: async (req) => (await authenticate(req))?.subscriberId,
 * });
 *
 * // Cloudflare Workers / plain fetch
 * export default { fetch: handler.fetch };
 * ```
 */
export function createSubscriptionsHttpHandler<
  TFeatures extends FeatureRegistry,
>(
  subs: Subscriptions<TFeatures>,
  options?: SubscriptionsHttpOptions,
): SubscriptionsHttpHandler {
  const prefix = options?.prefix ?? "/subscriptions";
  const getSubscriberId =
    options?.getSubscriberId ?? (() => null);
  const webhookSignatureHeader =
    options?.webhookSignatureHeader ?? "x-signature";

  // ==================== Helpers ====================

  const json = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const errorResponse = (error: unknown): Response => {
    if (error instanceof PaymentFailedError) {
      return json(
        {
          error: error.code,
          message: error.message,
          ...(error.errorCode && { errorCode: error.errorCode }),
          ...(error.isRetryable !== undefined && {
            isRetryable: error.isRetryable,
          }),
          ...(error.userAction && { userAction: error.userAction }),
          ...(error.paymentId && { paymentId: error.paymentId }),
        },
        error.statusCode,
      );
    }
    if (error instanceof SubscriptionError) {
      return json(
        { error: error.code, message: error.message },
        error.statusCode,
      );
    }
    return json({ error: "Internal server error" }, 500);
  };

  const readJsonBody = async (
    request: Request,
  ): Promise<Record<string, unknown>> => {
    const rawBody = await request.text();
    if (!rawBody.trim()) return {};
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new SubscriptionError("Request body must contain valid JSON", "INVALID_PUBLIC_INPUT", 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new SubscriptionError("Request body must be a JSON object", "INVALID_PUBLIC_INPUT", 400);
    }
    return body as Record<string, unknown>;
  };

  const rejectUnknownFields = (
    body: Record<string, unknown>,
    allowed: string[],
  ): void => {
    const unknown = Object.keys(body).find((field) => !allowed.includes(field));
    if (unknown) {
      throw new SubscriptionError(
        `Public request field is not allowed: ${unknown}`,
        "INVALID_PUBLIC_INPUT",
        400,
      );
    }
  };

  const validateBooleanFields = (body: Record<string, unknown>, fields: string[]): void => {
    for (const field of fields) {
      if (field in body && typeof body[field] !== "boolean") {
        throw new SubscriptionError(`${field} must be a boolean`, "INVALID_PUBLIC_INPUT", 400);
      }
    }
  };

  /**
   * Strip everything up to and including the configured prefix from the
   * request path. Locating the prefix anywhere in the path lets callers mount
   * the handler under an arbitrary base path.
   */
  const stripPrefix = (pathname: string): string[] | null => {
    const index = pathname.indexOf(prefix);
    if (index === -1) {
      return null;
    }
    const rest = pathname.slice(index + prefix.length);
    return rest.split("/").filter((segment) => segment.length > 0);
  };

  const matchRoute = (
    route: Route,
    segments: string[],
  ): RouteParams | null => {
    if (route.pattern.length !== segments.length) {
      return null;
    }
    const params: RouteParams = {};
    for (let i = 0; i < route.pattern.length; i++) {
      const patternSegment = route.pattern[i] as string;
      const segment = segments[i] as string;
      if (patternSegment.startsWith(":")) {
        try {
          params[patternSegment.slice(1)] = decodeURIComponent(segment);
        } catch (error) {
          if (!(error instanceof URIError)) throw error;
          throw new SubscriptionError("Malformed URL encoding", "INVALID_PUBLIC_INPUT", 400);
        }
      } else if (patternSegment !== segment) {
        return null;
      }
    }
    return params;
  };

  const extractWebhookSignature = (headers: Headers): string | null =>
    headers.get(webhookSignatureHeader) ??
    headers.get("x-moyasar-signature") ??
    headers.get("stripe-signature") ??
    headers.get("x-webhook-signature");

  // ==================== Handlers ====================

  const listPlans: RouteHandler = async () => {
    const plans = await subs.plans.list({ activeOnly: true });
    return json({ plans });
  };

  const getCurrent: RouteHandler = async (
    _request,
    _params,
    subscriberId,
  ) => {
    const subscription = await subs.subscriptions.get(subscriberId as string);
    return json({ subscription });
  };

  const subscribe: RouteHandler = async (
    request,
    _params,
    subscriberId,
  ) => {
    const body = await readJsonBody(request);
    rejectUnknownFields(body, ["planId"]);
    const planId = body.planId;
    if (typeof planId !== "string" || !planId) {
      return json({ error: "planId is required" }, 400);
    }
    const subscription = await subs.subscriptions.createSelfService(
      subscriberId as string,
      planId,
    );

    return json({ subscription }, 201);
  };

  const cancel: RouteHandler = async (
    request,
    _params,
    subscriberId,
  ) => {
    const body = await readJsonBody(request);
    rejectUnknownFields(body, ["immediately", "reason"]);
    validateBooleanFields(body, ["immediately"]);
    const subscription = await subs.subscriptions.cancel(
      subscriberId as string,
      {
        ...(typeof body.immediately === "boolean" && {
          immediately: body.immediately,
        }),
        ...(typeof body.reason === "string" && { reason: body.reason }),
      },
    );
    return json({ subscription });
  };

  const changePlan: RouteHandler = async (
    request,
    _params,
    subscriberId,
  ) => {
    const body = await readJsonBody(request);
    rejectUnknownFields(body, ["planId", "immediately", "prorate", "quoteId"]);
    validateBooleanFields(body, ["immediately", "prorate"]);
    const planId = body.planId;
    if (typeof planId !== "string" || !planId) {
      return json({ error: "planId is required" }, 400);
    }
    if (typeof body.quoteId !== "string" || !body.quoteId) {
      return json({ error: "quoteId is required; preview the plan change first" }, 400);
    }
    const result = await subs.subscriptions.changePlan(
      subscriberId as string,
      planId,
      {
        ...(typeof body.immediately === "boolean" && {
          immediately: body.immediately,
        }),
        ...(typeof body.prorate === "boolean" && { prorate: body.prorate }),
        quoteId: body.quoteId,
      },
    );
    return json(result);
  };

  const previewChangePlan: RouteHandler = async (request, params, subscriberId) => {
    const query = new URL(request.url).searchParams;
    for (const field of ["immediately", "prorate"]) {
      if (query.has(field) && query.get(field) !== "true" && query.get(field) !== "false") {
        throw new SubscriptionError(`${field} must be true or false`, "INVALID_PUBLIC_INPUT", 400);
      }
    }
    const preview = await subs.subscriptions.previewChangePlan(
      subscriberId as string,
      params.planId as string,
      {
        ...(query.has("immediately") && { immediately: query.get("immediately") === "true" }),
        ...(query.has("prorate") && { prorate: query.get("prorate") === "true" }),
      },
    );
    return json({ preview });
  };

  const getUsage: RouteHandler = async (
    _request,
    _params,
    subscriberId,
  ) => {
    const usage = await subs.permissions.getAllUsage(subscriberId as string);
    return json({ usage });
  };

  const listInvoices: RouteHandler = async (
    _request,
    _params,
    subscriberId,
  ) => {
    const subscription = await subs.subscriptions.get(subscriberId as string);
    if (!subscription) {
      return json({ invoices: [] });
    }
    const invoices = await subs.invoices.listBySubscription(subscription.id);
    return json({ invoices });
  };

  const getInvoiceHtml: RouteHandler = async (
    request,
    params,
    subscriberId,
  ) => {
    const invoice = await subs.invoices.getWithDetails(params.id as string);
    if (!invoice) {
      return json({ error: "Invoice not found" }, 404);
    }
    if (invoice.subscription.subscriberId !== subscriberId) {
      return json({ error: "Access denied" }, 403);
    }

    // Resolve subscriber display info if a resolver is configured
    let subscriberInfo: SubscriptionInvoiceData["subscriber"] = undefined;
    if (options?.invoice?.getSubscriberInfo) {
      const info = await options.invoice.getSubscriberInfo(
        subscriberId as string,
      );
      if (info) {
        subscriberInfo = info;
      }
    }

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

    let html: string;
    if (options?.invoice?.renderHtml) {
      html = await options.invoice.renderHtml(invoiceData);
    } else {
      // Lazy import so the invoice template machinery is only loaded when
      // this route is actually hit. The built-in template is precompiled;
      // only explicit source/path options need a compiler or filesystem.
      const { renderSubscriptionInvoice } = await import(
        "../templates/invoice-utils.js"
      );
      html = await renderSubscriptionInvoice(options?.invoice, invoiceData);
    }

    // Output modes: printable HTML (default, zero server cost) or a
    // server-generated PDF via the configured PdfRenderer.
    const url = new URL(request.url);
    const format = url.searchParams.get("format") ?? "html";
    const autoPrint = url.searchParams.get("autoPrint") === "1";
    const print = autoPrint || url.searchParams.get("print") === "1";

    if (format === "pdf") {
      const renderer = options?.invoice?.pdfRenderer;
      if (!renderer) {
        return json(
          {
            error:
              "PDF output is not configured. Provide `invoice.pdfRenderer` " +
              "(e.g. puppeteerPdfRenderer on Node, cloudflarePdfRenderer on Workers), " +
              "or use `format=html&print=1` for client-side printing.",
          },
          501,
        );
      }
      const pdf = await renderer.render(html);
      // Copy into a fresh ArrayBuffer-backed view for the Response body
      const bytes = new Uint8Array(pdf.byteLength);
      bytes.set(pdf);
      return new Response(bytes.buffer, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="invoice-${invoice.id}.pdf"`,
        },
      });
    }

    const body = print
      ? (
          await import("../templates/invoice-utils.js")
        ).wrapInvoiceForPrint(html, { autoPrint })
      : html;

    return new Response(body, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  };

  const handleWebhookRoute: RouteHandler = async (
    request,
    params,
  ) => {
    const provider = params.provider as string;
    const signature = extractWebhookSignature(request.headers);
    const body = await request.text();
    try {
      const event = await subs.handleWebhook(provider, body, signature ?? "", {
        headers: Object.fromEntries(request.headers.entries()),
      });
      return json({ received: true, eventId: event.id });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Webhook handling failed";
      const status = webhookFailureStatus(error);
      if (!status) {
        return errorResponse(error);
      }
      return json({ error: message }, status);
    }
  };

  // ==================== Route Table ====================

  const routes: Route[] = [
    { method: "GET", pattern: ["plans"], auth: false, handler: listPlans },
    { method: "GET", pattern: ["current"], auth: true, operation: "current", handler: getCurrent },
    { method: "POST", pattern: ["subscribe"], auth: true, operation: "subscribe", handler: subscribe },
    { method: "POST", pattern: ["cancel"], auth: true, operation: "cancel", handler: cancel },
    {
      method: "POST",
      pattern: ["change-plan"],
      auth: true,
      operation: "change-plan",
      handler: changePlan,
    },
    {
      method: "GET",
      pattern: ["change-plan", "preview", ":planId"],
      auth: true,
      operation: "preview-change-plan",
      handler: previewChangePlan,
    },
    { method: "GET", pattern: ["usage"], auth: true, operation: "usage", handler: getUsage },
    {
      method: "GET",
      pattern: ["invoices"],
      auth: true,
      operation: "invoices",
      handler: listInvoices,
    },
    {
      method: "GET",
      pattern: ["invoices", ":id"],
      auth: true,
      operation: "invoice",
      handler: getInvoiceHtml,
    },
    {
      method: "POST",
      pattern: ["webhooks", ":provider"],
      auth: false,
      handler: handleWebhookRoute,
    },
  ];

  // ==================== Dispatch ====================

  const fetch = async (request: Request): Promise<Response> => {
    try {
      const pathname = new URL(request.url).pathname;
      const segments = stripPrefix(pathname);
      if (!segments) {
        return json({ error: "Not found" }, 404);
      }

      // Match on path shape first so a known path with the wrong method
      // returns 405 instead of 404.
      let methodMismatch = false;
      let matched: { route: Route; params: RouteParams } | null = null;

      for (const route of routes) {
        const params = matchRoute(route, segments);
        if (!params) {
          continue;
        }
        if (route.method === request.method) {
          matched = { route, params };
          break;
        }
        methodMismatch = true;
      }

      if (!matched) {
        return json({ error: "Not found" }, methodMismatch ? 405 : 404);
      }

      let subscriberId: string | null = null;
      if (matched.route.auth) {
        const resolved = await getSubscriberId(request);
        if (typeof resolved !== "string" || !resolved.trim()) {
          return json({ error: "Unauthorized" }, 401);
        }
        subscriberId = resolved;
        if (options?.authorizeSubscriber &&
          await options.authorizeSubscriber(request, subscriberId, matched.route.operation as SubscriptionOperation) !== true) {
          return json({ error: "Access denied" }, 403);
        }
      }
      return await matched.route.handler(request, matched.params, subscriberId);
    } catch (error) {
      return errorResponse(error);
    }
  };

  return { fetch };
}
