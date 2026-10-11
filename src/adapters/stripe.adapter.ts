// file: packages/subscriptions/src/adapters/stripe.adapter.ts
// Stripe payment gateway adapter for subscriptions package
// Uses plain fetch against the Stripe REST API (no stripe npm dependency)
// so the adapter stays edge-safe (Node, Bun, Deno, Cloudflare Workers).

import type {
  CancelOptions,
  ChargePaymentInput,
  ChargePaymentResult,
  CheckoutSession,
  CreateCheckoutInput,
  CreateCustomerInput,
  CreateGatewaySubscriptionInput,
  GatewayCustomer,
  GatewayPayment,
  GatewaySubscription,
  PaymentGatewayAdapter,
  PortalSession,
  UpdateGatewaySubscriptionInput,
  WebhookEvent,
} from "./payment.adapter.js";

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface StripeConfig {
  /** Secret API key (sk_live_xxx or sk_test_xxx) */
  secretKey: string;
  /** Webhook signing secret (whsec_xxx) for signature verification */
  webhookSecret?: string;
  /** Stripe API version to pin (sent as Stripe-Version header) */
  apiVersion?: string;
  /** API base URL (defaults to production) */
  apiUrl?: string;
  /** Webhook timestamp tolerance in seconds (defaults to 300 = 5 minutes) */
  webhookToleranceSeconds?: number;
}

/** Stripe subscription status */
export type StripeSubscriptionStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused";

/** Response from the Stripe customers API */
export interface StripeCustomer {
  id: string;
  email: string | null;
  name: string | null;
  metadata?: Record<string, string>;
  invoice_settings?: {
    default_payment_method?: string | null;
  };
}

/** Response from the Stripe subscriptions API */
export interface StripeSubscription {
  id: string;
  customer: string;
  status: StripeSubscriptionStatus;
  metadata?: Record<string, string>;
  current_period_start?: number | null;
  current_period_end?: number | null;
  cancel_at: number | null;
  canceled_at: number | null;
  cancel_at_period_end: boolean;
  trial_start: number | null;
  trial_end: number | null;
  items?: {
    data: Array<{
      id: string;
      price: { id: string };
      current_period_start?: number;
      current_period_end?: number;
    }>;
  };
}

/** Response from the Stripe checkout sessions API */
export interface StripeCheckoutSession {
  id: string;
  url: string | null;
  expires_at: number;
}

/** Response from the Stripe billing portal sessions API */
export interface StripePortalSession {
  id: string;
  url: string;
}

/** Response from the Stripe payment intents API */
export interface StripePaymentIntent {
  id: string;
  status:
    | "requires_payment_method"
    | "requires_confirmation"
    | "requires_action"
    | "processing"
    | "requires_capture"
    | "canceled"
    | "succeeded";
  amount: number;
  amount_received?: number;
  currency: string;
  payment_method: string | null;
  metadata?: Record<string, string>;
  created?: number;
  next_action?: {
    type: string;
    redirect_to_url?: { url: string };
  } | null;
  last_payment_error?: {
    code?: string;
    decline_code?: string;
    message?: string;
  } | null;
}

/** Stripe API error payload */
export interface StripeErrorResponse {
  error: {
    type: string;
    code?: string;
    decline_code?: string;
    message?: string;
    param?: string;
  };
}

/** Stripe webhook event payload */
export interface StripeWebhookPayload {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
  created: number;
  livemode?: boolean;
  account?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Error Class
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Stripe adapter error with structured details from the Stripe API.
 */
export class StripeAdapterError extends Error {
  constructor(
    message: string,
    public readonly type: string = "api_error",
    public readonly code: string = "UNKNOWN",
    public readonly httpStatus?: number,
    public readonly declineCode?: string,
    public readonly isRetryable: boolean = false,
  ) {
    super(message);
    this.name = "StripeAdapterError";
  }

  /** Create from an HTTP error response */
  static fromHttpResponse(
    status: number,
    errorResponse?: StripeErrorResponse,
  ): StripeAdapterError {
    const err = errorResponse?.error;
    const isRetryable = status === 429 || status >= 500;
    return new StripeAdapterError(
      err?.message ?? `Stripe API error (HTTP ${status})`,
      err?.type ?? "http_error",
      err?.code ?? `HTTP_${status}`,
      status,
      err?.decline_code,
      isRetryable,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP Client
// ═══════════════════════════════════════════════════════════════════════════════

class StripeClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(private readonly config: StripeConfig) {
    this.baseUrl = config.apiUrl ?? "https://api.stripe.com/v1";
    // Stripe uses HTTP Basic Auth with the secret key as username
    this.headers = {
      Authorization: `Basic ${btoa(`${config.secretKey}:`)}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      ...(config.apiVersion && { "Stripe-Version": config.apiVersion }),
    };
  }

  async request<T>(
    method: string,
    path: string,
    params?: Record<string, string>,
    idempotencyKey?: string,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { ...this.headers, ...(idempotencyKey && { "Idempotency-Key": idempotencyKey }) },
        // Stripe expects form-encoded bodies; GET/DELETE send no body
        ...(params &&
          method !== "GET" && {
            body: new URLSearchParams(params).toString(),
          }),
      });
    } catch (error) {
      // Network error (DNS, connection refused, etc.)
      throw new StripeAdapterError(
        error instanceof Error ? error.message : "Network error",
        "network_error",
        "NETWORK_ERROR",
        undefined,
        undefined,
        true,
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      if (!response.ok) {
        throw StripeAdapterError.fromHttpResponse(response.status);
      }
      throw new StripeAdapterError(
        "Invalid response from Stripe",
        "api_error",
        "INVALID_RESPONSE",
        response.status,
        undefined,
        true,
      );
    }

    if (!response.ok) {
      throw StripeAdapterError.fromHttpResponse(
        response.status,
        data as StripeErrorResponse,
      );
    }

    return data as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  post<T>(path: string, params?: Record<string, string>, idempotencyKey?: string): Promise<T> {
    return this.request<T>("POST", path, params, idempotencyKey);
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════════

/** Encode flat metadata into Stripe's form-encoded bracket syntax */
function encodeMetadata(
  metadata: Record<string, string> | undefined,
  params: Record<string, string>,
  prefix = "metadata",
): void {
  if (!metadata) return;
  for (const [key, value] of Object.entries(metadata)) {
    params[`${prefix}[${key}]`] = value;
  }
}

/** Map Stripe subscription statuses to the package's status vocabulary */
function mapSubscriptionStatus(status: StripeSubscriptionStatus): string {
  const statusMap: Record<StripeSubscriptionStatus, string> = {
    active: "active",
    trialing: "trialing",
    past_due: "past_due",
    unpaid: "unpaid",
    paused: "paused",
    canceled: "canceled",
    incomplete: "incomplete",
    incomplete_expired: "incomplete_expired",
  };
  return statusMap[status] ?? "incomplete";
}

function toDateOrNull(unixSeconds: number | null | undefined): Date | null {
  return unixSeconds ? new Date(unixSeconds * 1000) : null;
}

function mapCustomer(customer: StripeCustomer): GatewayCustomer {
  return {
    id: customer.id,
    email: customer.email ?? "",
    ...(customer.name && { name: customer.name }),
    ...(customer.metadata && { metadata: customer.metadata }),
  };
}

function mapSubscription(sub: StripeSubscription): GatewaySubscription {
  // Newer API versions moved period bounds onto the subscription item
  const item = sub.items?.data?.[0];
  const periodStart = sub.current_period_start ?? item?.current_period_start ?? null;
  const periodEnd = sub.current_period_end ?? item?.current_period_end ?? null;

  return {
    id: sub.id,
    customerId: sub.customer,
    status: mapSubscriptionStatus(sub.status),
    ...(item?.price.id && { priceId: item.price.id }),
    currentPeriodStart: toDateOrNull(periodStart) ?? new Date(),
    currentPeriodEnd: toDateOrNull(periodEnd) ?? new Date(),
    cancelAt: toDateOrNull(sub.cancel_at),
    canceledAt: toDateOrNull(sub.canceled_at),
    trialStart: toDateOrNull(sub.trial_start),
    trialEnd: toDateOrNull(sub.trial_end),
    ...(sub.metadata && { metadata: sub.metadata }),
  };
}

/** Verify the signed raw bytes without parsing/re-encoding the request body. */
async function verifyStripeSignature(
  payload: string | Uint8Array,
  signatureHeader: string,
  webhookSecret: string,
  toleranceSeconds: number,
): Promise<boolean> {
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of signatureHeader.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t") timestamp = value;
    if (key === "v1" && value) signatures.push(value);
  }
  if (!timestamp || !/^\d+$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp)) || !signatures.length ||
      !Number.isFinite(toleranceSeconds) || toleranceSeconds < 0 ||
      Math.abs(Date.now() - Number(timestamp) * 1000) > toleranceSeconds * 1000) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(webhookSecret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const rawBytes = typeof payload === "string" ? encoder.encode(payload) : payload;
  const prefix = encoder.encode(`${timestamp}.`);
  const signedBytes = new Uint8Array(prefix.length + rawBytes.length);
  signedBytes.set(prefix);
  signedBytes.set(rawBytes, prefix.length);
  for (const signature of signatures) {
    if (!/^[a-f0-9]{64}$/i.test(signature)) continue;
    const bytes = new Uint8Array(signature.match(/.{2}/g)!.map(byte => parseInt(byte, 16)));
    if (await crypto.subtle.verify("HMAC", key, bytes, signedBytes)) return true;
  }
  return false;
}

/** Map a Stripe card decline code to user-facing guidance */
function mapDeclineCode(declineCode?: string): {
  isRetryable: boolean;
  userAction: NonNullable<ChargePaymentResult["userAction"]>;
} {
  switch (declineCode) {
    case "insufficient_funds":
    case "card_not_supported":
    case "expired_card":
    case "lost_card":
    case "stolen_card":
      return { isRetryable: false, userAction: "use_different_card" };
    case "incorrect_number":
    case "invalid_number":
    case "incorrect_cvc":
    case "invalid_cvc":
    case "incorrect_expiry":
      return { isRetryable: true, userAction: "check_details" };
    case "do_not_honor":
    case "generic_decline":
    case "withdrawal_count_limit_exceeded":
      return { isRetryable: true, userAction: "retry_later" };
    case "fraudulent":
    case "pickup_card":
      return { isRetryable: false, userAction: "contact_bank" };
    default:
      return { isRetryable: false, userAction: "use_different_card" };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Adapter Implementation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a Stripe payment adapter for subscriptions.
 *
 * Uses the Stripe REST API directly via `fetch` with form-encoded bodies —
 * no `stripe` npm dependency — so it works in any runtime with web-standard
 * APIs (Node 18+, Bun, Deno, Cloudflare Workers).
 *
 * @example
 * ```typescript
 * import { stripeAdapter } from '@abshahin/subscriptions/adapters/stripe';
 *
 * const payment = stripeAdapter({
 *   secretKey: process.env.STRIPE_SECRET_KEY!,
 *   webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
 * });
 * ```
 */
export function stripeAdapter(config: StripeConfig): PaymentGatewayAdapter {
  const client = new StripeClient(config);

  /** Resolve the customer's default (or first) saved payment method */
  async function resolveDefaultPaymentMethod(
    customerId: string,
  ): Promise<string | null> {
    const customer = await client.get<StripeCustomer>(`/customers/${customerId}`);
    if (customer.invoice_settings?.default_payment_method) {
      return customer.invoice_settings.default_payment_method;
    }

    // Fall back to the first attached card payment method
    const methods = await client.get<{
      data: Array<{ id: string }>;
    }>(`/payment_methods?customer=${encodeURIComponent(customerId)}&type=card`);
    return methods.data[0]?.id ?? null;
  }

  return {
    provider: "stripe",
    capabilities: {
      customers: true, nativeSubscriptions: true, checkout: "hosted", portal: true,
      directPayments: true, paymentLookup: true, idempotentCharges: true,
    },

    // ==================== Customer Management ====================

    async createCustomer(data: CreateCustomerInput): Promise<GatewayCustomer> {
      const params: Record<string, string> = { email: data.email };
      if (data.name) params["name"] = data.name;
      encodeMetadata(data.metadata, params);

      const customer = await client.post<StripeCustomer>("/customers", params);
      return mapCustomer(customer);
    },

    async getCustomer(customerId: string): Promise<GatewayCustomer | null> {
      try {
        const customer = await client.get<StripeCustomer>(
          `/customers/${encodeURIComponent(customerId)}`,
        );
        return mapCustomer(customer);
      } catch (error) {
        if (error instanceof StripeAdapterError && error.httpStatus === 404) return null;
        throw error;
      }
    },

    async updateCustomer(
      customerId: string,
      data: Partial<CreateCustomerInput>,
    ): Promise<GatewayCustomer> {
      const params: Record<string, string> = {};
      if (data.email) params["email"] = data.email;
      if (data.name) params["name"] = data.name;
      encodeMetadata(data.metadata, params);

      const customer = await client.post<StripeCustomer>(
        `/customers/${encodeURIComponent(customerId)}`,
        params,
      );
      return mapCustomer(customer);
    },

    // ==================== Subscription Management ====================

    async createSubscription(
      data: CreateGatewaySubscriptionInput,
    ): Promise<GatewaySubscription> {
      const params: Record<string, string> = {
        customer: data.customerId,
        "items[0][price]": data.priceId,
      };
      if (data.trialDays) {
        params["trial_period_days"] = String(data.trialDays);
      }
      encodeMetadata(data.metadata, params);

      const subscription = await client.post<StripeSubscription>(
        "/subscriptions",
        params,
      );
      return mapSubscription(subscription);
    },

    async getSubscription(
      subscriptionId: string,
    ): Promise<GatewaySubscription | null> {
      try {
        const subscription = await client.get<StripeSubscription>(
          `/subscriptions/${encodeURIComponent(subscriptionId)}`,
        );
        return mapSubscription(subscription);
      } catch (error) {
        if (error instanceof StripeAdapterError && error.httpStatus === 404) return null;
        throw error;
      }
    },

    async updateSubscription(
      subscriptionId: string,
      data: UpdateGatewaySubscriptionInput,
    ): Promise<GatewaySubscription> {
      const params: Record<string, string> = {};

      // Changing the price requires the existing subscription item ID
      if (data.priceId) {
        const current = await client.get<StripeSubscription>(
          `/subscriptions/${encodeURIComponent(subscriptionId)}`,
        );
        const itemId = current.items?.data?.[0]?.id;
        if (!itemId) {
          throw new StripeAdapterError(
            "Cannot update price: subscription has no items",
            "invalid_request_error",
            "SUBSCRIPTION_ITEM_MISSING",
          );
        }
        params["items[0][id]"] = itemId;
        params["items[0][price]"] = data.priceId;
        params["proration_behavior"] = "create_prorations";
      }
      if (data.cancelAtPeriodEnd !== undefined) {
        params["cancel_at_period_end"] = String(data.cancelAtPeriodEnd);
      }
      encodeMetadata(data.metadata, params);

      const subscription = await client.post<StripeSubscription>(
        `/subscriptions/${encodeURIComponent(subscriptionId)}`,
        params,
      );
      return mapSubscription(subscription);
    },

    async cancelSubscription(
      subscriptionId: string,
      options?: CancelOptions,
    ): Promise<GatewaySubscription> {
      const path = `/subscriptions/${encodeURIComponent(subscriptionId)}`;

      if (options?.immediately) {
        const canceled = await client.delete<StripeSubscription>(path);
        return mapSubscription(canceled);
      }

      // Default: cancel at the end of the current billing period
      const params: Record<string, string> = { cancel_at_period_end: "true" };
      if (options?.reason) {
        params["metadata[cancellation_reason]"] = options.reason;
      }
      const subscription = await client.post<StripeSubscription>(path, params);
      return mapSubscription(subscription);
    },

    async pauseSubscription(
      subscriptionId: string,
    ): Promise<GatewaySubscription> {
      const subscription = await client.post<StripeSubscription>(
        `/subscriptions/${encodeURIComponent(subscriptionId)}`,
        { "pause_collection[behavior]": "void" },
      );
      return mapSubscription(subscription);
    },

    async resumeSubscription(
      subscriptionId: string,
    ): Promise<GatewaySubscription> {
      const subscription = await client.post<StripeSubscription>(
        `/subscriptions/${encodeURIComponent(subscriptionId)}`,
        { pause_collection: "" },
      );
      return mapSubscription(subscription);
    },

    // ==================== Checkout & Portal ====================

    async createCheckoutSession(
      data: CreateCheckoutInput,
    ): Promise<CheckoutSession> {
      const params: Record<string, string> = {
        mode: "subscription",
        "line_items[0][price]": data.priceId,
        "line_items[0][quantity]": "1",
        success_url: data.successUrl,
        cancel_url: data.cancelUrl,
      };
      if (data.customerId) {
        params["customer"] = data.customerId;
      } else if (data.customerEmail) {
        params["customer_email"] = data.customerEmail;
      }
      if (data.trialDays) {
        params["subscription_data[trial_period_days]"] = String(data.trialDays);
      }
      encodeMetadata(data.metadata, params);
      encodeMetadata(data.metadata, params, "subscription_data[metadata]");

      const session = await client.post<StripeCheckoutSession>(
        "/checkout/sessions",
        params,
      );

      if (!session.url) {
        throw new StripeAdapterError(
          "Stripe checkout session has no URL",
          "api_error",
          "CHECKOUT_URL_MISSING",
        );
      }

      return {
        id: session.id,
        url: session.url,
        expiresAt: new Date(session.expires_at * 1000),
      };
    },

    async createPortalSession(
      customerId: string,
      returnUrl: string,
    ): Promise<PortalSession> {
      const session = await client.post<StripePortalSession>(
        "/billing_portal/sessions",
        {
          customer: customerId,
          return_url: returnUrl,
        },
      );
      return { id: session.id, url: session.url };
    },

    // ==================== Webhooks ====================

    async constructWebhookEvent(
      payload: string | Uint8Array,
      signature: string,
      context?: { headers: Record<string, string> },
    ): Promise<WebhookEvent> {
      const payloadStr =
        typeof payload === "string" ? payload : new TextDecoder().decode(payload);

      if (!config.webhookSecret) throw new StripeAdapterError("webhookSecret is required to verify Stripe webhooks", "authentication_error", "WEBHOOK_SECRET_MISSING");
      const signatureHeader = signature || Object.entries(context?.headers ?? {}).find(([name]) => name.toLowerCase() === "stripe-signature")?.[1];
      if (!signatureHeader) throw new StripeAdapterError("Missing webhook signature", "authentication_error", "WEBHOOK_SIGNATURE_MISSING");
      const valid = await verifyStripeSignature(payload, signatureHeader, config.webhookSecret, config.webhookToleranceSeconds ?? 300);
      if (!valid) throw new StripeAdapterError("Invalid webhook signature", "authentication_error", "WEBHOOK_SIGNATURE_INVALID");

      let event: StripeWebhookPayload;
      try {
        event = JSON.parse(payloadStr) as StripeWebhookPayload;
      } catch {
        throw new StripeAdapterError(
          "Invalid webhook payload: not valid JSON",
          "invalid_request_error",
          "WEBHOOK_PAYLOAD_INVALID",
        );
      }

      if (!event || typeof event.id !== "string" || !event.id || typeof event.type !== "string" ||
          !Number.isFinite(event.created) || !event.data?.object || typeof event.data.object !== "object" || Array.isArray(event.data.object)) {
        throw new StripeAdapterError("Invalid Stripe webhook payload", "invalid_request_error", "WEBHOOK_PAYLOAD_INVALID");
      }
      if ((config.secretKey.startsWith("sk_test_") && event.livemode === true) ||
          (config.secretKey.startsWith("sk_live_") && event.livemode === false)) {
        throw new StripeAdapterError("Webhook environment does not match the API key", "authentication_error", "WEBHOOK_ENVIRONMENT_MISMATCH");
      }
      const data = event.data.object;
      const parent = data.parent as { subscription_details?: { subscription?: unknown; metadata?: Record<string, string> } } | undefined;
      const subscriptionDetails = (data.subscription_details ?? parent?.subscription_details) as { metadata?: Record<string, string>; subscription?: unknown } | undefined;
      const metadata = { ...(subscriptionDetails?.metadata ?? {}), ...((data.metadata as Record<string, string> | undefined) ?? {}) };
      if (data.billing_reason === "subscription_cycle") metadata.type = "subscription_renewal";
      let type = event.type;
      if (type === "payment_intent.succeeded" && data.status === "succeeded") type = "payment.paid";
      else if (type === "invoice.payment_succeeded" && (data.paid === true || data.status === "paid")) type = "payment.paid";
      else if (type === "payment_intent.payment_failed" || type === "invoice.payment_failed") type = "payment.failed";
      const settlement = type === "payment.paid" || type === "payment.failed";
      const amount = type === "payment.paid"
        ? (event.type.startsWith("invoice.") ? data.amount_paid : data.amount_received)
        : (event.type.startsWith("invoice.") ? data.amount_due : data.amount);
      if (settlement && (typeof data.id !== "string" || !data.id || !Number.isSafeInteger(amount) || (amount as number) < 0 || typeof data.currency !== "string")) {
        throw new StripeAdapterError("Invalid Stripe settlement payload", "invalid_request_error", "WEBHOOK_PAYLOAD_INVALID");
      }
      const subscriptionId = data.subscription ?? subscriptionDetails?.subscription;
      const invoicePayments = (data.payments as { data?: Array<{ payment?: { type?: string; payment_intent?: string } }> } | undefined)?.data;
      const paymentId = typeof data.payment_intent === "string" ? data.payment_intent
        : invoicePayments?.length === 1 && invoicePayments[0]?.payment?.type === "payment_intent" ? invoicePayments[0].payment.payment_intent ?? data.id : data.id;
      const invoiceLines = (data.lines as { data?: Array<{ subscription?: unknown; type?: string; period?: { start?: number; end?: number }; parent?: { type?: string } }> } | undefined)?.data;
      const invoicedPeriod = invoiceLines?.find(line => line.type === "subscription" || line.parent?.type === "subscription_item_details")?.period;
      const periodStart = data.current_period_start ?? invoicedPeriod?.start;
      const periodEnd = data.current_period_end ?? invoicedPeriod?.end;
      return {
        id: event.id,
        type,
        originalType: event.type,
        ...(typeof event.livemode === "boolean" && { environment: event.livemode ? "live" : "test" }),
        data: {
          ...data,
          metadata,
          ...(settlement && { paymentId, amount, currency: (data.currency as string).toUpperCase() }),
          ...(typeof subscriptionId === "string" && { subscriptionId }),
          ...(type.startsWith("customer.subscription.") && { subscriptionId: data.id }),
          ...(typeof periodStart === "number" && { currentPeriodStart: new Date(periodStart * 1000).toISOString() }),
          ...(typeof periodEnd === "number" && { currentPeriodEnd: new Date(periodEnd * 1000).toISOString() }),
          ...(event.account && { providerAccountId: event.account }),
          ...(typeof event.livemode === "boolean" && { environment: event.livemode ? "live" : "test" }),
        },
        createdAt: new Date(event.created * 1000),
      };
    },

    // ==================== Direct Payment ====================

    async chargePayment(data: ChargePaymentInput): Promise<ChargePaymentResult> {
      if (!data.idempotencyKey?.trim()) {
        throw new StripeAdapterError("A stable idempotencyKey is required for direct charges", "invalid_request_error", "IDEMPOTENCY_KEY_REQUIRED");
      }
      try {
        // Off-session charge requires a saved payment method on the customer
        const paymentMethod = data.paymentMethodId ?? await resolveDefaultPaymentMethod(data.customerId);
        if (!paymentMethod) {
          return {
            id: "",
            status: "failed",
            amount: data.amount,
            currency: data.currency,
            errorMessage: "Customer has no saved payment method",
            errorCode: "PAYMENT_METHOD_MISSING",
            isRetryable: false,
            userAction: "use_different_card",
          };
        }

        const params: Record<string, string> = {
          amount: String(data.amount),
          currency: data.currency.toLowerCase(),
          customer: data.customerId,
          payment_method: paymentMethod,
          off_session: "true",
          confirm: "true",
        };
        if (data.description) params["description"] = data.description;
        encodeMetadata(data.metadata, params);

        let intent: StripePaymentIntent;
        try {
          intent = await client.post<StripePaymentIntent>(
            "/payment_intents",
            params,
            data.idempotencyKey,
          );
        } catch (error) {
          // Card errors surface as HTTP 402 with a decline code
          if (error instanceof StripeAdapterError) {
            const { isRetryable, userAction } = mapDeclineCode(error.declineCode);
            return {
              id: "",
              status: error.code === "NETWORK_ERROR" || error.code === "INVALID_RESPONSE" || (error.httpStatus ?? 0) >= 500 ? "unknown" : "failed",
              amount: data.amount,
              currency: data.currency,
              errorMessage: error.message,
              errorCode: error.code,
              isRetryable: error.isRetryable || isRetryable,
              userAction,
              ...(error.declineCode && { gatewayCode: error.declineCode }),
              ...(error.httpStatus && { httpStatus: error.httpStatus }),
            };
          }
          throw error;
        }

        if (intent.status === "succeeded") {
          if (typeof intent.id !== "string" || !Number.isSafeInteger(intent.amount_received) || (intent.amount_received as number) < 0 || typeof intent.currency !== "string") {
            throw new StripeAdapterError("Stripe response does not prove the settled amount", "api_error", "INVALID_RESPONSE");
          }
          return {
            id: intent.id,
            status: "paid",
            amount: intent.amount_received!,
            currency: intent.currency.toUpperCase(),
          };
        }

        if (
          intent.status === "processing" ||
          intent.status === "requires_action" ||
          intent.status === "requires_capture"
        ) {
          return {
            id: intent.id,
            status: intent.status === "requires_capture" ? "authorized" : "pending",
            amount: intent.amount,
            currency: intent.currency.toUpperCase(),
            ...(intent.next_action?.redirect_to_url?.url && {
              verificationUrl: intent.next_action.redirect_to_url.url,
            }),
          };
        }

        const lastError = intent.last_payment_error;
        const { isRetryable, userAction } = mapDeclineCode(
          lastError?.decline_code,
        );
        return {
          id: intent.id,
          status: "failed",
          amount: intent.amount,
          currency: intent.currency.toUpperCase(),
          errorMessage: lastError?.message ?? "Payment failed",
          errorCode: lastError?.code ?? "PAYMENT_FAILED",
          isRetryable,
          userAction,
          ...(lastError?.decline_code && {
            gatewayCode: lastError.decline_code,
          }),
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Payment failed";
        return {
          id: "",
          status: !(error instanceof StripeAdapterError) || error.code === "NETWORK_ERROR" || error.code === "INVALID_RESPONSE" || (error.httpStatus ?? 0) >= 500 ? "unknown" : "failed",
          amount: data.amount,
          currency: data.currency,
          errorMessage,
          errorCode:
            error instanceof StripeAdapterError ? error.code : "UNKNOWN",
          isRetryable:
            error instanceof StripeAdapterError ? error.isRetryable : false,
          userAction: "retry_later",
          ...(error instanceof StripeAdapterError &&
            error.httpStatus && { httpStatus: error.httpStatus }),
        };
      }
    },

    async getPayment(paymentId: string): Promise<GatewayPayment | null> {
      let intent: StripePaymentIntent;
      try {
        intent = await client.get<StripePaymentIntent>(`/payment_intents/${encodeURIComponent(paymentId)}`);
      } catch (error) {
        if (error instanceof StripeAdapterError && error.httpStatus === 404) return null;
        throw error;
      }
      if (typeof intent.id !== "string" || intent.id !== paymentId || !Number.isSafeInteger(intent.amount) || intent.amount < 0 || typeof intent.currency !== "string" ||
          (intent.status === "succeeded" && (!Number.isSafeInteger(intent.amount_received) || (intent.amount_received as number) < 0))) {
        throw new StripeAdapterError("Invalid Stripe payment lookup response", "api_error", "INVALID_RESPONSE");
      }
      const status = intent.status === "succeeded" ? "paid"
        : intent.status === "requires_capture" ? "authorized"
        : intent.status === "canceled" || intent.status === "requires_payment_method" ? "failed"
        : ["processing", "requires_action", "requires_confirmation"].includes(intent.status) ? "pending" : "unknown";
      return {
        id: intent.id,
        status,
        amount: status === "paid" ? intent.amount_received! : intent.amount,
        currency: intent.currency.toUpperCase(),
        ...(intent.payment_method && { paymentMethodId: intent.payment_method }),
        ...(intent.metadata && { metadata: intent.metadata }),
        ...(typeof intent.created === "number" && { createdAt: new Date(intent.created * 1000) }),
        ...(intent.last_payment_error?.message && { errorMessage: intent.last_payment_error.message }),
      };
    },

    /**
     * Get the reusable payment method ID from a completed payment intent.
     * Use this to save the payment method for future renewals.
     */
    async getPaymentSource(paymentId: string): Promise<string | null> {
      try {
        const intent = await client.get<StripePaymentIntent>(
          `/payment_intents/${encodeURIComponent(paymentId)}`,
        );
        if (intent.status === "succeeded" && intent.payment_method) {
          return intent.payment_method;
        }
        return null;
      } catch (error) {
        if (error instanceof StripeAdapterError && error.httpStatus === 404) return null;
        throw error;
      }
    },
  };
}
