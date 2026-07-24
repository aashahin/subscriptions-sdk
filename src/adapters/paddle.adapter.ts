// file: packages/subscriptions/src/adapters/paddle.adapter.ts
// Paddle Billing payment gateway adapter for subscriptions package
// Runtime-agnostic: plain fetch + WebCrypto only, no npm dependencies

import type {
  CancelOptions,
  ChargePaymentInput,
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

export interface PaddleConfig {
  /** Paddle Billing API key (Bearer token, from Paddle dashboard → Developer tools → Authentication) */
  apiKey: string;
  /** Webhook notification secret (pdl_ntfset_xxx) for signature verification */
  webhookSecret?: string;
  /** Paddle environment (defaults to production) */
  environment?: "production" | "sandbox";
  /** Override the API base URL (defaults to the environment's URL) */
  apiUrl?: string;
}

/** Paddle subscription status */
export type PaddleSubscriptionStatus =
  | "active"
  | "canceled"
  | "inactive"
  | "past_due"
  | "paused"
  | "trialing";

/** Paddle transaction status */
export type PaddleTransactionStatus =
  | "draft"
  | "ready"
  | "billed"
  | "paid"
  | "completed"
  | "canceled"
  | "past_due";

/** Response from Paddle customers API */
export interface PaddleCustomer {
  id: string;
  email: string;
  name?: string;
  status: string;
  custom_data?: Record<string, string> | null;
  created_at: string;
  updated_at: string;
}

/** Response from Paddle subscriptions API */
export interface PaddleSubscription {
  id: string;
  status: PaddleSubscriptionStatus;
  customer_id: string;
  currency_code: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  first_billed_at: string | null;
  next_billed_at: string | null;
  paused_at: string | null;
  canceled_at: string | null;
  current_billing_period: {
    starts_at: string;
    ends_at: string;
  } | null;
  scheduled_change: {
    action: "cancel" | "pause" | "resume";
    effective_at: string;
    resume_at: string | null;
  } | null;
  items: Array<{
    price: { id: string };
    quantity: number;
  }>;
  custom_data?: Record<string, string> | null;
}

/** Response from Paddle transactions API */
export interface PaddleTransaction {
  id: string;
  status: PaddleTransactionStatus;
  customer_id: string | null;
  currency_code: string;
  created_at: string;
  updated_at: string;
  billed_at: string | null;
  details?: {
    totals: {
      total: string;
      subtotal: string;
      tax: string;
    };
  } | null;
  checkout?: {
    url: string | null;
  } | null;
  custom_data?: Record<string, string> | null;
}

/** Response from Paddle customer portal sessions API */
export interface PaddlePortalSession {
  id: string;
  urls: {
    general: {
      overview: string;
    };
    subscriptions: Array<{
      id: string;
      cancel_subscription_url: string;
      update_subscription_payment_method_url: string;
    }>;
  };
}

/** Paddle webhook notification payload */
export interface PaddleWebhookPayload {
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: Record<string, unknown>;
}

/** Error response from Paddle API */
export interface PaddleErrorResponse {
  error?: {
    type?: string;
    code?: string;
    detail?: string;
    documentation_url?: string;
    errors?: Array<{ field: string; message: string }>;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Error Class
// ═══════════════════════════════════════════════════════════════════════════════

/** HTTP status code messages */
const HTTP_STATUS_MESSAGES: Record<
  number,
  { message: string; isRetryable: boolean }
> = {
  400: { message: "Invalid request parameters", isRetryable: false },
  401: { message: "Invalid API credentials", isRetryable: false },
  403: { message: "Access forbidden", isRetryable: false },
  404: { message: "Resource not found", isRetryable: false },
  409: { message: "Resource conflict", isRetryable: false },
  429: { message: "Too many requests - please slow down", isRetryable: true },
  500: { message: "Payment service error", isRetryable: true },
  503: {
    message: "Payment service temporarily unavailable",
    isRetryable: true,
  },
};

/**
 * Paddle adapter error with user-friendly messages
 */
export class PaddleAdapterError extends Error {
  constructor(
    message: string,
    public readonly code: string = "UNKNOWN",
    public readonly httpStatus?: number,
    public readonly userMessage?: string,
    public readonly isRetryable: boolean = false,
    public readonly fieldErrors?: Array<{ field: string; message: string }>,
  ) {
    super(message);
    this.name = "PaddleAdapterError";
  }

  /** Create from HTTP response */
  static fromHttpResponse(
    status: number,
    errorResponse?: PaddleErrorResponse,
  ): PaddleAdapterError {
    const httpInfo = HTTP_STATUS_MESSAGES[status] ?? {
      message: `HTTP error ${status}`,
      isRetryable: false,
    };

    const detail = errorResponse?.error?.detail ?? httpInfo.message;
    const code = errorResponse?.error?.code ?? `HTTP_${status}`;
    const fieldErrors = errorResponse?.error?.errors;

    let detailedMessage = detail;
    if (fieldErrors && fieldErrors.length > 0) {
      const errorDetails = fieldErrors
        .map(({ field, message }) => `${field}: ${message}`)
        .join("; ");
      detailedMessage = `${detail} (${errorDetails})`;
    }

    return new PaddleAdapterError(
      detailedMessage,
      code,
      status,
      httpInfo.message,
      httpInfo.isRetryable,
      fieldErrors,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP Client
// ═══════════════════════════════════════════════════════════════════════════════

class PaddleClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(config: PaddleConfig) {
    this.baseUrl =
      config.apiUrl ??
      (config.environment === "sandbox"
        ? "https://sandbox-api.paddle.com"
        : "https://api.paddle.com");
    // Paddle Billing uses Bearer token authentication
    this.authHeader = `Bearer ${config.apiKey}`;
  }

  async request<T>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: this.authHeader,
        },
        ...(body && { body: JSON.stringify(body) }),
      });
    } catch (error) {
      // Network error (DNS, connection refused, etc.)
      throw new PaddleAdapterError(
        error instanceof Error ? error.message : "Network error",
        "NETWORK_ERROR",
        undefined,
        "Unable to connect to payment service",
        true,
      );
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      // Non-JSON response (rare, but handle it)
      if (!response.ok) {
        throw PaddleAdapterError.fromHttpResponse(response.status);
      }
      throw new PaddleAdapterError(
        "Invalid response from payment service",
        "INVALID_RESPONSE",
        response.status,
        "Invalid response from payment service",
        true,
      );
    }

    if (!response.ok) {
      throw PaddleAdapterError.fromHttpResponse(
        response.status,
        data as PaddleErrorResponse,
      );
    }

    // Paddle wraps every resource in a `data` envelope
    return (data as { data: T }).data;
  }

  // Customers
  async createCustomer(params: {
    email: string;
    name?: string;
    customData?: Record<string, string>;
  }): Promise<PaddleCustomer> {
    return this.request<PaddleCustomer>("POST", "/customers", {
      email: params.email,
      ...(params.name && { name: params.name }),
      ...(params.customData && { custom_data: params.customData }),
    });
  }

  async getCustomer(id: string): Promise<PaddleCustomer> {
    return this.request<PaddleCustomer>("GET", `/customers/${id}`);
  }

  async updateCustomer(
    id: string,
    params: {
      email?: string;
      name?: string;
      customData?: Record<string, string>;
    },
  ): Promise<PaddleCustomer> {
    return this.request<PaddleCustomer>("PATCH", `/customers/${id}`, {
      ...(params.email && { email: params.email }),
      ...(params.name && { name: params.name }),
      ...(params.customData && { custom_data: params.customData }),
    });
  }

  async createPortalSession(customerId: string): Promise<PaddlePortalSession> {
    return this.request<PaddlePortalSession>(
      "POST",
      `/customers/${customerId}/portal-sessions`,
      {},
    );
  }

  // Subscriptions
  async getSubscription(id: string): Promise<PaddleSubscription> {
    return this.request<PaddleSubscription>("GET", `/subscriptions/${id}`);
  }

  async updateSubscription(
    id: string,
    params: {
      priceId?: string;
      customData?: Record<string, string>;
    },
  ): Promise<PaddleSubscription> {
    return this.request<PaddleSubscription>("PATCH", `/subscriptions/${id}`, {
      ...(params.priceId && {
        items: [{ price_id: params.priceId, quantity: 1 }],
        proration_billing_mode: "prorated_immediately",
      }),
      ...(params.customData && { custom_data: params.customData }),
    });
  }

  async cancelSubscription(
    id: string,
    immediately: boolean,
  ): Promise<PaddleSubscription> {
    return this.request<PaddleSubscription>(
      "POST",
      `/subscriptions/${id}/cancel`,
      {
        effective_from: immediately ? "immediately" : "next_billing_period",
      },
    );
  }

  async pauseSubscription(id: string): Promise<PaddleSubscription> {
    return this.request<PaddleSubscription>(
      "POST",
      `/subscriptions/${id}/pause`,
      {
        effective_from: "next_billing_period",
      },
    );
  }

  async resumeSubscription(id: string): Promise<PaddleSubscription> {
    return this.request<PaddleSubscription>(
      "POST",
      `/subscriptions/${id}/resume`,
      {
        effective_from: "immediately",
      },
    );
  }

  async chargeSubscription(
    id: string,
    params: {
      amount: number;
      currency: string;
      description?: string;
    },
  ): Promise<PaddleTransaction> {
    return this.request<PaddleTransaction>(
      "POST",
      `/subscriptions/${id}/charge`,
      {
        effective_from: "immediately",
        items: [
          {
            quantity: 1,
            price: {
              name: params.description ?? "One-off charge",
              unit_price: {
                // Paddle amounts are strings in the lowest currency denomination
                amount: String(params.amount),
                currency_code: params.currency,
              },
              product: {
                name: params.description ?? "One-off charge",
                tax_category: "standard",
              },
            },
          },
        ],
      },
    );
  }

  // Transactions
  async createTransaction(params: {
    customerId?: string;
    priceId?: string;
    amount?: number;
    currency?: string;
    description?: string;
    successUrl?: string;
    customData?: Record<string, string>;
  }): Promise<PaddleTransaction> {
    const item: Record<string, unknown> = params.priceId
      ? { price_id: params.priceId, quantity: 1 }
      : {
          quantity: 1,
          price: {
            name: params.description ?? "One-off charge",
            unit_price: {
              amount: String(params.amount ?? 0),
              currency_code: params.currency ?? "USD",
            },
            product: {
              name: params.description ?? "One-off charge",
              tax_category: "standard",
            },
          },
        };

    return this.request<PaddleTransaction>("POST", "/transactions", {
      items: [item],
      ...(params.customerId && { customer_id: params.customerId }),
      ...(params.successUrl && { checkout: { url: params.successUrl } }),
      ...(params.customData && { custom_data: params.customData }),
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════════

function mapCustomer(customer: PaddleCustomer): GatewayCustomer {
  return {
    id: customer.id,
    email: customer.email,
    ...(customer.name && { name: customer.name }),
    ...(customer.custom_data && { metadata: customer.custom_data }),
  };
}

function mapSubscription(subscription: PaddleSubscription): GatewaySubscription {
  const now = new Date();
  const periodStart = subscription.current_billing_period?.starts_at
    ? new Date(subscription.current_billing_period.starts_at)
    : subscription.started_at
      ? new Date(subscription.started_at)
      : now;
  const periodEnd = subscription.current_billing_period?.ends_at
    ? new Date(subscription.current_billing_period.ends_at)
    : subscription.next_billed_at
      ? new Date(subscription.next_billed_at)
      : now;

  const isTrialing = subscription.status === "trialing";

  return {
    id: subscription.id,
    customerId: subscription.customer_id,
    status: subscription.status,
    ...(subscription.items[0]?.price.id && {
      priceId: subscription.items[0].price.id,
    }),
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    cancelAt:
      subscription.scheduled_change?.action === "cancel"
        ? new Date(subscription.scheduled_change.effective_at)
        : null,
    canceledAt: subscription.canceled_at
      ? new Date(subscription.canceled_at)
      : null,
    // Paddle has no explicit trial dates on the subscription object;
    // while trialing, the billing period end marks the trial end
    trialStart:
      isTrialing && subscription.started_at
        ? new Date(subscription.started_at)
        : null,
    trialEnd: isTrialing ? periodEnd : null,
    ...(subscription.custom_data && { metadata: subscription.custom_data }),
  };
}

/** Maximum age of a webhook timestamp before it is rejected (5 minutes) */
const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

/**
 * Parse the Paddle-Signature header (`ts=...,h1=...`).
 */
function parseSignatureHeader(header: string): {
  timestamp: number;
  signature: string;
} | null {
  const parts: Record<string, string> = {};
  for (const pair of header.split(",")) {
    const [key, ...rest] = pair.split("=");
    if (key && rest.length > 0) {
      parts[key.trim()] = rest.join("=").trim();
    }
  }

  const timestamp = Number(parts["ts"]);
  const signature = parts["h1"];

  if (!Number.isFinite(timestamp) || !signature) {
    return null;
  }

  return { timestamp, signature };
}

/**
 * Verify a Paddle webhook signature using HMAC-SHA256 via WebCrypto.
 *
 * Paddle signs `${ts}:${payload}` with the notification secret and sends the
 * result in the `h1` part of the Paddle-Signature header. A timestamp
 * tolerance guards against replay attacks.
 */
async function verifySignature(
  payload: string,
  signatureHeader: string,
  webhookSecret: string,
): Promise<{ valid: boolean; error?: string }> {
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) {
    return { valid: false, error: "Malformed Paddle-Signature header" };
  }

  // Reject stale timestamps to prevent replay attacks
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    Math.abs(nowSeconds - parsed.timestamp) > WEBHOOK_TOLERANCE_SECONDS
  ) {
    return { valid: false, error: "Webhook timestamp outside tolerance" };
  }

  const normalizedSignature = parsed.signature.toLowerCase();
  if (
    normalizedSignature.length === 0 ||
    normalizedSignature.length % 2 !== 0 ||
    !/^[0-9a-f]+$/.test(normalizedSignature)
  ) {
    return { valid: false, error: "Malformed signature value" };
  }

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(webhookSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  // Decode the hex signature to bytes for timing-safe comparison
  const signatureBytes = new Uint8Array(
    (normalizedSignature.match(/.{1,2}/g) ?? []).map((byte) =>
      parseInt(byte, 16),
    ),
  );

  // crypto.subtle.verify performs a constant-time comparison internally
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    encoder.encode(`${parsed.timestamp}:${payload}`),
  );

  return valid ? { valid: true } : { valid: false, error: "Invalid webhook signature" };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Adapter Implementation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a Paddle Billing payment adapter for subscriptions.
 *
 * Uses the Paddle Billing API directly over `fetch` (no npm dependency):
 *
 * 1. `createCheckoutSession()` creates a Paddle transaction and returns its
 *    hosted checkout URL — the customer completes payment there
 * 2. Paddle creates the subscription when checkout completes; subscribe to the
 *    `subscription.created` / `transaction.completed` webhooks to sync state
 * 3. `createPortalSession()` returns a Paddle customer portal link for
 *    self-service billing management
 * 4. Webhooks are verified with the Paddle-Signature header (HMAC-SHA256)
 *
 * @example
 * ```typescript
 * import { paddleAdapter } from '@abshahin/subscriptions/adapters/paddle';
 *
 * const payment = paddleAdapter({
 *   apiKey: process.env.PADDLE_API_KEY!,
 *   webhookSecret: process.env.PADDLE_WEBHOOK_SECRET!,
 *   environment: 'sandbox',
 * });
 * ```
 */
export function paddleAdapter(config: PaddleConfig): PaymentGatewayAdapter {
  const client = new PaddleClient(config);

  return {
    provider: "paddle",

    // ==================== Customer Management ====================

    async createCustomer(data: CreateCustomerInput): Promise<GatewayCustomer> {
      const customer = await client.createCustomer({
        email: data.email,
        ...(data.name && { name: data.name }),
        ...(data.metadata && { customData: data.metadata }),
      });
      return mapCustomer(customer);
    },

    async getCustomer(customerId: string): Promise<GatewayCustomer | null> {
      try {
        const customer = await client.getCustomer(customerId);
        return mapCustomer(customer);
      } catch {
        return null;
      }
    },

    async updateCustomer(
      customerId: string,
      data: Partial<CreateCustomerInput>,
    ): Promise<GatewayCustomer> {
      const customer = await client.updateCustomer(customerId, {
        ...(data.email && { email: data.email }),
        ...(data.name && { name: data.name }),
        ...(data.metadata && { customData: data.metadata }),
      });
      return mapCustomer(customer);
    },

    // ==================== Subscription Management ====================

    async createSubscription(
      data: CreateGatewaySubscriptionInput,
    ): Promise<GatewaySubscription> {
      // Paddle Billing has no server-side "create subscription" endpoint —
      // subscriptions are created when a customer completes checkout for a
      // recurring price. Use createCheckoutSession() and handle the
      // `subscription.created` webhook instead.
      throw new PaddleAdapterError(
        "Paddle does not support creating subscriptions server-side. " +
          "Use createCheckoutSession() and handle the subscription.created webhook.",
        "UNSUPPORTED_OPERATION",
      );
    },

    async getSubscription(
      subscriptionId: string,
    ): Promise<GatewaySubscription | null> {
      try {
        const subscription = await client.getSubscription(subscriptionId);
        return mapSubscription(subscription);
      } catch {
        return null;
      }
    },

    async updateSubscription(
      subscriptionId: string,
      data: UpdateGatewaySubscriptionInput,
    ): Promise<GatewaySubscription> {
      if (data.cancelAtPeriodEnd) {
        // Scheduled cancellation is a dedicated endpoint in Paddle
        const subscription = await client.cancelSubscription(
          subscriptionId,
          false,
        );
        return mapSubscription(subscription);
      }

      const subscription = await client.updateSubscription(subscriptionId, {
        ...(data.priceId && { priceId: data.priceId }),
        ...(data.metadata && { customData: data.metadata }),
      });
      return mapSubscription(subscription);
    },

    async cancelSubscription(
      subscriptionId: string,
      options?: CancelOptions,
    ): Promise<GatewaySubscription> {
      const subscription = await client.cancelSubscription(
        subscriptionId,
        options?.immediately ?? false,
      );
      return mapSubscription(subscription);
    },

    async pauseSubscription(
      subscriptionId: string,
    ): Promise<GatewaySubscription> {
      const subscription = await client.pauseSubscription(subscriptionId);
      return mapSubscription(subscription);
    },

    async resumeSubscription(
      subscriptionId: string,
    ): Promise<GatewaySubscription> {
      const subscription = await client.resumeSubscription(subscriptionId);
      return mapSubscription(subscription);
    },

    // ==================== Checkout & Portal ====================

    async createCheckoutSession(
      data: CreateCheckoutInput,
    ): Promise<CheckoutSession> {
      // A transaction created with a price gets a hosted checkout URL
      const transaction = await client.createTransaction({
        ...(data.customerId && { customerId: data.customerId }),
        priceId: data.priceId,
        successUrl: data.successUrl,
        customData: {
          ...(data.metadata ?? {}),
          ...(data.trialDays !== undefined && {
            trialDays: String(data.trialDays),
          }),
        },
      });

      const checkoutUrl = transaction.checkout?.url;
      if (!checkoutUrl) {
        throw new PaddleAdapterError(
          "Paddle did not return a checkout URL for this transaction",
          "CHECKOUT_URL_MISSING",
        );
      }

      // Paddle doesn't expose a checkout expiry; hosted checkouts are
      // effectively valid for 24 hours
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 24);

      return {
        id: transaction.id,
        url: checkoutUrl,
        expiresAt,
      };
    },

    async createPortalSession(
      customerId: string,
      _returnUrl: string,
    ): Promise<PortalSession> {
      // Paddle hosts its own customer portal; the returnUrl is handled by
      // Paddle's configured portal settings rather than the API call
      const session = await client.createPortalSession(customerId);
      return {
        id: session.id,
        url: session.urls.general.overview,
      };
    },

    // ==================== Webhooks ====================

    async constructWebhookEvent(
      payload: string | Uint8Array,
      signature: string,
    ): Promise<WebhookEvent> {
      const payloadStr =
        typeof payload === "string" ? payload : new TextDecoder().decode(payload);

      // Fail CLOSED: when a secret is configured we require a valid signature.
      // A missing/empty signature must be rejected rather than silently
      // accepted, otherwise an attacker could bypass verification by simply
      // omitting the header.
      if (config.webhookSecret) {
        if (!signature) {
          throw new PaddleAdapterError(
            "Missing webhook signature",
            "WEBHOOK_SIGNATURE_MISSING",
          );
        }
        const result = await verifySignature(
          payloadStr,
          signature,
          config.webhookSecret,
        );
        if (!result.valid) {
          throw new PaddleAdapterError(
            result.error ?? "Invalid webhook signature",
            "WEBHOOK_SIGNATURE_INVALID",
          );
        }
      } else {
        console.warn(
          "[Paddle] WARNING: No webhookSecret configured. Webhook payloads are accepted without signature verification. " +
            "Set webhookSecret in PaddleConfig to enable verification.",
        );
      }

      const webhookData = JSON.parse(payloadStr) as PaddleWebhookPayload;

      return {
        id: webhookData.event_id,
        type: webhookData.event_type,
        data: webhookData.data,
        createdAt: new Date(webhookData.occurred_at),
      };
    },

    // ==================== Direct Payment ====================

    /**
     * Charge a one-off payment.
     *
     * **Limitations** (Paddle Billing has no generic off-session charge API):
     *
     * - If `customerId` is a Paddle subscription ID (`sub_...`), the saved
     *   payment method of that subscription is charged immediately via the
     *   one-off charge endpoint (`POST /subscriptions/{id}/charge`). This is
     *   the only true off-session charge Paddle supports.
     * - Otherwise a one-off transaction is created for the customer. Paddle
     *   does NOT capture it automatically — the customer must complete the
     *   hosted checkout. The result is returned as `pending` with
     *   `verificationUrl` set to the checkout URL; a `transaction.completed`
     *   webhook confirms the payment.
     */
    async chargePayment(data: ChargePaymentInput) {
      try {
        const isSubscriptionId = data.customerId.startsWith("sub_");

        const transaction = isSubscriptionId
          ? await client.chargeSubscription(data.customerId, {
              amount: data.amount,
              currency: data.currency,
              ...(data.description && { description: data.description }),
            })
          : await client.createTransaction({
              customerId: data.customerId,
              amount: data.amount,
              currency: data.currency,
              ...(data.description && { description: data.description }),
              ...(data.callbackUrl && { successUrl: data.callbackUrl }),
              ...(data.metadata && { customData: data.metadata }),
            });

        // Map Paddle transaction status to our status
        let status: "paid" | "pending" | "failed";
        if (
          transaction.status === "completed" ||
          transaction.status === "paid"
        ) {
          status = "paid";
        } else if (transaction.status === "canceled") {
          status = "failed";
        } else {
          // draft/ready/billed/past_due — awaiting payment
          status = "pending";
        }

        const amount = transaction.details?.totals.total
          ? Number(transaction.details.totals.total)
          : data.amount;

        if (status === "failed") {
          return {
            id: transaction.id,
            status,
            amount,
            currency: transaction.currency_code,
            errorMessage: "Payment could not be processed",
            errorCode: "PAYMENT_FAILED",
            isRetryable: false,
            userAction: "use_different_card" as const,
          };
        }

        return {
          id: transaction.id,
          status,
          amount,
          currency: transaction.currency_code,
          ...(transaction.checkout?.url && {
            verificationUrl: transaction.checkout.url,
          }),
        };
      } catch (error) {
        // Handle PaddleAdapterError with rich error info
        if (error instanceof PaddleAdapterError) {
          return {
            id: "",
            status: "failed" as const,
            amount: data.amount,
            currency: data.currency,
            errorMessage: error.userMessage ?? error.message,
            errorCode: error.code,
            isRetryable: error.isRetryable,
            userAction: "retry_later" as const,
            ...(error.httpStatus && { httpStatus: error.httpStatus }),
          };
        }

        // Handle generic errors
        const errorMessage =
          error instanceof Error ? error.message : "Payment failed";
        return {
          id: "",
          status: "failed" as const,
          amount: data.amount,
          currency: data.currency,
          errorMessage,
          errorCode: "UNKNOWN",
          isRetryable: false,
          userAction: "retry_later" as const,
        };
      }
    },

    /**
     * Paddle Billing does not expose reusable payment tokens — saved payment
     * methods are always scoped to a subscription. Always returns null;
     * use the subscription ID for renewal charges instead (see chargePayment).
     */
    async getPaymentSource(_paymentId: string): Promise<string | null> {
      return null;
    },
  };
}
