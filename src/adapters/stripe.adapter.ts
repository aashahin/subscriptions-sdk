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
  currency: string;
  payment_method: string | null;
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
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: this.headers,
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

  post<T>(path: string, params?: Record<string, string>): Promise<T> {
    return this.request<T>("POST", path, params);
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
): void {
  if (!metadata) return;
  for (const [key, value] of Object.entries(metadata)) {
    params[`metadata[${key}]`] = value;
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

/** Constant-time string comparison for hex signatures */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) return false;

  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i]! ^ bBytes[i]!;
  }
  return diff === 0;
}

/**
 * Verify a Stripe webhook signature (Stripe-Signature header).
 *
 * The header is a comma-separated list of `t=<timestamp>,v1=<hex hmac>` pairs.
 * The expected signature is HMAC-SHA256 of `${t}.${payload}` with the webhook
 * signing secret. Requests older than the tolerance window are rejected.
 */
async function verifyStripeSignature(
  payload: string,
  signatureHeader: string,
  webhookSecret: string,
  toleranceSeconds: number,
): Promise<boolean> {
  // Parse the Stripe-Signature header
  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of signatureHeader.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key === "t" && value) {
      timestamp = value;
    } else if (key === "v1" && value) {
      signatures.push(value);
    }
  }

  if (!timestamp || signatures.length === 0) {
    return false;
  }

  // Reject events outside the tolerance window (replay protection)
  const timestampMs = parseInt(timestamp, 10) * 1000;
  if (Number.isNaN(timestampMs)) {
    return false;
  }
  const ageMs = Math.abs(Date.now() - timestampMs);
  if (ageMs > toleranceSeconds * 1000) {
    return false;
  }

  // Compute the expected HMAC-SHA256 signature
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBytes = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${payload}`),
  );
  const expectedSignature = Array.from(new Uint8Array(signatureBytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time compare against every v1 signature (Stripe may send several
  // when the endpoint secret is being rolled)
  return signatures.some((signature) =>
    timingSafeEqual(signature.toLowerCase(), expectedSignature),
  );
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
      } catch {
        return null;
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
      } catch {
        return null;
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
        // Empty string unsets pause_collection
        { "pause_collection[behavior]": "" },
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
    ): Promise<WebhookEvent> {
      const payloadStr =
        typeof payload === "string" ? payload : new TextDecoder().decode(payload);

      // Fail CLOSED: when a secret is configured we require a valid signature.
      if (config.webhookSecret) {
        if (!signature) {
          throw new StripeAdapterError(
            "Missing webhook signature",
            "authentication_error",
            "WEBHOOK_SIGNATURE_MISSING",
          );
        }
        const isValid = await verifyStripeSignature(
          payloadStr,
          signature,
          config.webhookSecret,
          config.webhookToleranceSeconds ?? 300,
        );
        if (!isValid) {
          throw new StripeAdapterError(
            "Invalid webhook signature",
            "authentication_error",
            "WEBHOOK_SIGNATURE_INVALID",
          );
        }
      } else {
        console.warn(
          "[Stripe] WARNING: No webhookSecret configured. Webhook payloads are accepted without signature verification. " +
            "Set webhookSecret in StripeConfig to enable verification.",
        );
      }

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

      return {
        id: event.id,
        type: event.type,
        data: event.data.object,
        createdAt: new Date(event.created * 1000),
      };
    },

    // ==================== Direct Payment ====================

    async chargePayment(data: ChargePaymentInput): Promise<ChargePaymentResult> {
      try {
        // Off-session charge requires a saved payment method on the customer
        const paymentMethod = await resolveDefaultPaymentMethod(data.customerId);
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
          );
        } catch (error) {
          // Card errors surface as HTTP 402 with a decline code
          if (error instanceof StripeAdapterError) {
            const { isRetryable, userAction } = mapDeclineCode(error.declineCode);
            return {
              id: "",
              status: "failed",
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
          return {
            id: intent.id,
            status: "paid",
            amount: intent.amount,
            currency: intent.currency,
          };
        }

        if (
          intent.status === "processing" ||
          intent.status === "requires_action" ||
          intent.status === "requires_capture"
        ) {
          return {
            id: intent.id,
            status: "pending",
            amount: intent.amount,
            currency: intent.currency,
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
          currency: intent.currency,
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
          status: "failed",
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
      } catch {
        return null;
      }
    },
  };
}
