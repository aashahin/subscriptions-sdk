// file: packages/subscriptions/src/adapters/lemonsqueezy.adapter.ts
// Lemon Squeezy payment gateway adapter for subscriptions package
// Uses plain fetch against the JSON:API (https://api.lemonsqueezy.com/v1) - no npm dependency

import type {
  CancelOptions,
  ChargePaymentInput,
  ChargePaymentResult,
  CheckoutSession,
  CreateCheckoutInput,
  CreateCustomerInput,
  GatewayCustomer,
  GatewaySubscription,
  PaymentGatewayAdapter,
  PortalSession,
  UpdateGatewaySubscriptionInput,
  WebhookEvent,
} from "./payment.adapter.js";
import { PaymentFailedError } from "../core/errors.js";

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface LemonSqueezyConfig {
  /** API key (from https://app.lemonsqueezy.com/settings/api) */
  apiKey: string;
  /** Store ID that owns the variants/customers */
  storeId: string | number;
  /** Webhook signing secret for X-Signature verification */
  webhookSecret?: string;
  /** Expected webhook environment (defaults to production). */
  environment?: "production" | "sandbox";
  /** API base URL (defaults to production) */
  apiUrl?: string;
}

/** Lemon Squeezy subscription status */
export type LemonSqueezySubscriptionStatus =
  | "on_trial"
  | "active"
  | "paused"
  | "past_due"
  | "unpaid"
  | "cancelled"
  | "expired";

/** Generic JSON:API resource wrapper */
interface JsonApiResource<A> {
  type: string;
  id: string;
  attributes: A;
  links?: { self?: string };
}

interface JsonApiResponse<A> {
  data: JsonApiResource<A>;
  jsonapi?: { version: string };
  links?: Record<string, string | null>;
}

interface JsonApiError {
  errors?: Array<{ detail?: string; title?: string; status?: string }>;
}

/** Customer attributes (subset) */
interface LemonSqueezyCustomerAttributes {
  store_id: number;
  name: string;
  email: string;
  status: string;
  urls?: { customer_portal?: string };
  created_at: string;
  updated_at: string;
}

/** Subscription attributes (subset) */
interface LemonSqueezySubscriptionAttributes {
  store_id: number;
  customer_id: number;
  order_id: number;
  product_id: number;
  variant_id: number;
  status: LemonSqueezySubscriptionStatus;
  card_brand?: string | null;
  card_last_four?: string | null;
  pause?: { mode: string; resumes_at: string | null } | null;
  cancelled: boolean;
  trial_ends_at: string | null;
  billing_anchor: number;
  renews_at: string | null;
  ends_at: string | null;
  created_at: string;
  updated_at: string;
  urls: { customer_portal?: string; update_payment_method?: string };
}

/** Checkout attributes (subset) */
interface LemonSqueezyCheckoutAttributes {
  store_id: number;
  variant_id: number;
  url: string;
  expires_at: string | null;
  created_at: string;
}

/** Webhook payload shape */
interface LemonSqueezyWebhookPayload {
  meta: {
    event_name: string;
    custom_data?: Record<string, unknown>;
    test_mode?: boolean;
  };
  data: {
    type: string;
    id: string;
    attributes: Record<string, unknown>;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Error Type
// ═══════════════════════════════════════════════════════════════════════════════

/** Error thrown by the Lemon Squeezy adapter */
export class LemonSqueezyAdapterError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly gatewayError?: unknown,
  ) {
    super(message);
    this.name = "LemonSqueezyAdapterError";
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP Client
// ═══════════════════════════════════════════════════════════════════════════════

class LemonSqueezyClient {
  private readonly baseUrl: string;

  constructor(private readonly config: LemonSqueezyConfig) {
    this.baseUrl = config.apiUrl ?? "https://api.lemonsqueezy.com/v1";
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
          Accept: "application/vnd.api+json",
          "Content-Type": "application/vnd.api+json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        ...(body && { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new LemonSqueezyAdapterError(
        `Network error calling Lemon Squeezy: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // DELETE returns 204 with no body on success
    if (response.status === 204) {
      return undefined as T;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new LemonSqueezyAdapterError(
        `Invalid JSON response from Lemon Squeezy (HTTP ${response.status})`,
        response.status,
      );
    }

    if (!response.ok) {
      const err = payload as JsonApiError;
      const detail =
        err.errors?.map((e) => e.detail ?? e.title).filter(Boolean).join("; ") ??
        `HTTP ${response.status}`;
      throw new LemonSqueezyAdapterError(
        `Lemon Squeezy API error: ${detail}`,
        response.status,
        payload,
      );
    }

    return payload as T;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════════

function mapSubscriptionStatus(status: LemonSqueezySubscriptionStatus): string {
  const statusMap: Record<LemonSqueezySubscriptionStatus, string> = {
    on_trial: "trialing",
    active: "active",
    paused: "paused",
    past_due: "past_due",
    unpaid: "past_due",
    cancelled: "canceled",
    expired: "canceled",
  };
  return statusMap[status] ?? "active";
}

function toGatewayCustomer(
  resource: JsonApiResource<LemonSqueezyCustomerAttributes>,
): GatewayCustomer {
  return {
    id: resource.id,
    email: resource.attributes.email,
    ...(resource.attributes.name && { name: resource.attributes.name }),
    metadata: {
      storeId: String(resource.attributes.store_id),
      status: resource.attributes.status,
    },
  };
}

function toGatewaySubscription(
  resource: JsonApiResource<LemonSqueezySubscriptionAttributes>,
): GatewaySubscription {
  const attrs = resource.attributes;
  const createdAt = new Date(attrs.created_at);
  // Lemon Squeezy does not expose the current period start directly;
  // created_at is used as the anchor and renews_at/ends_at as the period end.
  const periodEnd = attrs.ends_at ?? attrs.renews_at ?? attrs.trial_ends_at;

  return {
    id: resource.id,
    customerId: String(attrs.customer_id),
    status: mapSubscriptionStatus(attrs.status),
    priceId: String(attrs.variant_id),
    currentPeriodStart: createdAt,
    currentPeriodEnd: periodEnd ? new Date(periodEnd) : createdAt,
    cancelAt: attrs.cancelled && attrs.ends_at ? new Date(attrs.ends_at) : null,
    canceledAt: attrs.cancelled ? new Date(attrs.updated_at) : null,
    trialStart: attrs.status === "on_trial" ? createdAt : null,
    trialEnd: attrs.trial_ends_at ? new Date(attrs.trial_ends_at) : null,
    metadata: {
      storeId: String(attrs.store_id),
      orderId: String(attrs.order_id),
      productId: String(attrs.product_id),
      ...(attrs.card_brand && { cardBrand: attrs.card_brand }),
      ...(attrs.card_last_four && { cardLastFour: attrs.card_last_four }),
    },
  };
}

function flatMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v)).map(([k, v]) => [k, String(v)]));
}

async function verifySignature(
  payload: string | Uint8Array,
  signature: string,
  webhookSecret: string,
): Promise<boolean> {
  // Lemon Squeezy signs the raw request body with HMAC-SHA256 (hex digest)
  const normalizedSignature = signature.trim().toLowerCase();
  if (
    normalizedSignature.length === 0 ||
    normalizedSignature.length % 2 !== 0 ||
    !/^[0-9a-f]+$/.test(normalizedSignature)
  ) {
    return false;
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

  const bodyBytes =
    typeof payload === "string" ? encoder.encode(payload) : payload;

  // crypto.subtle.verify performs a constant-time comparison internally
  return crypto.subtle.verify("HMAC", key, signatureBytes, bodyBytes as BufferSource);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Adapter Implementation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a Lemon Squeezy payment adapter for subscriptions.
 *
 * **Notes on Lemon Squeezy's model**:
 *
 * - Subscriptions are created exclusively through hosted checkouts; there is
 *   no API to create a subscription server-side. Use `createCheckoutSession()` and
 *   handle the resulting `subscription_created` webhook.
 * - `createCheckoutSession()` passes `metadata` through as `checkout_data.custom`,
 *   which Lemon Squeezy echoes back in webhook `meta.custom_data` - use it to
 *   carry your internal `subscriberId`.
 * - Cancellations are always at period end (`ends_at = renews_at`); immediate
 *   cancellation is not supported by the API.
 * - Off-session charges (`chargePayment()`) are not supported - Lemon Squeezy
 *   is merchant-of-record and manages all renewals itself.
 *
 * @example
 * ```typescript
 * import { lemonSqueezyAdapter } from '@abshahin/subscriptions/adapters/lemonsqueezy';
 *
 * const payment = lemonSqueezyAdapter({
 *   apiKey: process.env.LEMONSQUEEZY_API_KEY!,
 *   storeId: process.env.LEMONSQUEEZY_STORE_ID!,
 *   webhookSecret: process.env.LEMONSQUEEZY_WEBHOOK_SECRET!,
 * });
 * ```
 */
export function lemonSqueezyAdapter(
  config: LemonSqueezyConfig,
): PaymentGatewayAdapter {
  const client = new LemonSqueezyClient(config);
  const storeId = String(config.storeId);

  return {
    provider: "lemonsqueezy",
    capabilities: {
      customers: true, nativeSubscriptions: true, checkout: "hosted", portal: true,
      directPayments: false, paymentLookup: false, idempotentCharges: false,
    },

    // ==================== Customer Management ====================
    // Customers are usually created automatically by Lemon Squeezy at checkout;
    // createCustomer() uses the store customers API for pre-provisioning.

    async createCustomer(data: CreateCustomerInput): Promise<GatewayCustomer> {
      const response = await client.request<
        JsonApiResponse<LemonSqueezyCustomerAttributes>
      >("POST", "/customers", {
        data: {
          type: "customers",
          attributes: {
            ...(data.name && { name: data.name }),
            email: data.email,
          },
          relationships: {
            store: {
              data: { type: "stores", id: storeId },
            },
          },
        },
      });

      return toGatewayCustomer(response.data);
    },

    async getCustomer(customerId: string): Promise<GatewayCustomer | null> {
      try {
        const response = await client.request<
          JsonApiResponse<LemonSqueezyCustomerAttributes>
        >("GET", `/customers/${encodeURIComponent(customerId)}`);
        return toGatewayCustomer(response.data);
      } catch (error) {
        if (error instanceof LemonSqueezyAdapterError && error.statusCode === 404) return null;
        throw error;
      }
    },

    async updateCustomer(
      customerId: string,
      data: Partial<CreateCustomerInput>,
    ): Promise<GatewayCustomer> {
      const response = await client.request<
        JsonApiResponse<LemonSqueezyCustomerAttributes>
      >("PATCH", `/customers/${encodeURIComponent(customerId)}`, {
        data: {
          type: "customers",
          id: customerId,
          attributes: {
            ...(data.name && { name: data.name }),
            ...(data.email && { email: data.email }),
          },
        },
      });

      return toGatewayCustomer(response.data);
    },

    // ==================== Subscription Management ====================

    async getSubscription(
      subscriptionId: string,
    ): Promise<GatewaySubscription | null> {
      try {
        const response = await client.request<
          JsonApiResponse<LemonSqueezySubscriptionAttributes>
        >("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
        return toGatewaySubscription(response.data);
      } catch (error) {
        if (error instanceof LemonSqueezyAdapterError && error.statusCode === 404) return null;
        throw error;
      }
    },

    async updateSubscription(
      subscriptionId: string,
      data: UpdateGatewaySubscriptionInput,
    ): Promise<GatewaySubscription> {
      // priceId maps to the Lemon Squeezy variant ID (plan change)
      const response = await client.request<
        JsonApiResponse<LemonSqueezySubscriptionAttributes>
      >("PATCH", `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        data: {
          type: "subscriptions",
          id: subscriptionId,
          attributes: {
            ...(data.priceId && { variant_id: Number(data.priceId) }),
            ...(data.cancelAtPeriodEnd !== undefined && {
              cancelled: data.cancelAtPeriodEnd,
            }),
          },
        },
      });

      return toGatewaySubscription(response.data);
    },

    async cancelSubscription(
      subscriptionId: string,
      options?: CancelOptions,
    ): Promise<GatewaySubscription> {
      if (options?.immediately) {
        throw new LemonSqueezyAdapterError(
          "Lemon Squeezy does not support immediate cancellation via API. " +
            "Subscriptions are always cancelled at the end of the current billing period.",
        );
      }

      // DELETE sets cancelled=true; the subscription stays active until ends_at
      await client.request<void>(
        "DELETE",
        `/subscriptions/${encodeURIComponent(subscriptionId)}`,
      );

      const response = await client.request<
        JsonApiResponse<LemonSqueezySubscriptionAttributes>
      >("GET", `/subscriptions/${encodeURIComponent(subscriptionId)}`);

      return toGatewaySubscription(response.data);
    },

    async pauseSubscription(
      subscriptionId: string,
    ): Promise<GatewaySubscription> {
      const response = await client.request<
        JsonApiResponse<LemonSqueezySubscriptionAttributes>
      >("PATCH", `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        data: {
          type: "subscriptions",
          id: subscriptionId,
          attributes: { pause: { mode: "void" } },
        },
      });

      return toGatewaySubscription(response.data);
    },

    async resumeSubscription(
      subscriptionId: string,
    ): Promise<GatewaySubscription> {
      const response = await client.request<
        JsonApiResponse<LemonSqueezySubscriptionAttributes>
      >("PATCH", `/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        data: {
          type: "subscriptions",
          id: subscriptionId,
          attributes: { pause: null },
        },
      });

      return toGatewaySubscription(response.data);
    },

    // ==================== Checkout & Portal ====================

    async createCheckoutSession(
      data: CreateCheckoutInput,
    ): Promise<CheckoutSession> {
      if (data.trialDays !== undefined) {
        throw new LemonSqueezyAdapterError("Lemon Squeezy trials must be configured on the variant; per-checkout trialDays overrides are unsupported", 400);
      }
      const response = await client.request<
        JsonApiResponse<LemonSqueezyCheckoutAttributes>
      >("POST", "/checkouts", {
        data: {
          type: "checkouts",
          attributes: {
            checkout_data: {
              ...(data.customerEmail && { email: data.customerEmail }),
              // Custom data is echoed back in webhook meta.custom_data -
              // the canonical place to pass your internal subscriberId
              ...(data.metadata && { custom: { ...data.metadata } }),
            },
            product_options: {
              redirect_url: data.successUrl,
              enabled_variants: [Number(data.priceId)],
            },
            // Lemon Squeezy checkouts do not expire by default.
            expires_at: null,
          },
          relationships: {
            store: {
              data: { type: "stores", id: storeId },
            },
            variant: {
              data: { type: "variants", id: String(data.priceId) },
            },
          },
        },
      });

      const attrs = response.data.attributes;
      return {
        id: response.data.id,
        url: attrs.url,
        ...(attrs.expires_at && { expiresAt: new Date(attrs.expires_at) }),
      };
    },

    async createPortalSession(
      customerId: string,
      _returnUrl: string,
    ): Promise<PortalSession> {
      // Lemon Squeezy exposes a signed customer portal URL on the customer
      // resource; returnUrl is not supported (portal handles its own navigation)
      const response = await client.request<
        JsonApiResponse<LemonSqueezyCustomerAttributes>
      >("GET", `/customers/${encodeURIComponent(customerId)}`);

      const portalUrl = response.data.attributes.urls?.customer_portal;
      if (!portalUrl) {
        throw new LemonSqueezyAdapterError(
          `Customer ${customerId} has no customer portal URL. ` +
            "The customer must have at least one order or subscription.",
        );
      }

      return {
        id: `ls_portal_${customerId}`,
        url: portalUrl,
      };
    },

    // ==================== Direct Payment ====================

    async chargePayment(
      _data: ChargePaymentInput,
    ): Promise<ChargePaymentResult> {
      throw new PaymentFailedError(
        "Lemon Squeezy does not support off-session charges. As merchant of record, " +
          "it manages all recurring billing internally - renewals arrive via subscription_payment_success webhooks.",
        undefined,
        "OFF_SESSION_CHARGES_UNSUPPORTED",
        false,
        "none",
      );
    },

    async getPaymentSource(_paymentId: string): Promise<string | null> {
      // No reusable payment tokens are exposed by the Lemon Squeezy API
      return null;
    },

    // ==================== Webhooks ====================

    async constructWebhookEvent(
      payload: string | Uint8Array,
      signature: string,
      context?: { headers: Record<string, string> },
    ): Promise<WebhookEvent> {
      if (!config.webhookSecret) {
        throw new LemonSqueezyAdapterError(
          "webhookSecret is required to verify Lemon Squeezy webhook signatures",
        );
      }

      const isValid = await verifySignature(
        payload,
        signature || Object.entries(context?.headers ?? {}).find(([name]) => name.toLowerCase() === "x-signature")?.[1] || "",
        config.webhookSecret,
      );
      if (!isValid) {
        throw new LemonSqueezyAdapterError("Invalid webhook signature", 401);
      }

      const rawBody =
        typeof payload === "string" ? payload : new TextDecoder().decode(payload);

      let parsed: LemonSqueezyWebhookPayload;
      try {
        parsed = JSON.parse(rawBody) as LemonSqueezyWebhookPayload;
      } catch {
        throw new LemonSqueezyAdapterError("Invalid webhook payload JSON", 400);
      }

      if (!parsed || !parsed.meta || typeof parsed.meta.event_name !== "string" || !parsed.data ||
          typeof parsed.data.id !== "string" || !parsed.data.id || typeof parsed.data.type !== "string" ||
          !parsed.data.attributes || typeof parsed.data.attributes !== "object" || Array.isArray(parsed.data.attributes)) {
        throw new LemonSqueezyAdapterError("Invalid Lemon Squeezy webhook payload", 400);
      }
      const attrs = parsed.data.attributes;
      if (String(attrs.store_id) !== storeId) throw new LemonSqueezyAdapterError("Webhook belongs to another Lemon Squeezy store", 401);
      const sandbox = parsed.meta.test_mode === true || attrs.test_mode === true;
      if (sandbox !== (config.environment === "sandbox")) throw new LemonSqueezyAdapterError("Webhook environment does not match the configured environment", 401);
      const eventName = parsed.meta.event_name;
      let type = eventName;
      if ((eventName === "subscription_payment_success" || eventName === "subscription_payment_recovered") && attrs.status === "paid") type = "payment.paid";
      else if (eventName === "subscription_payment_failed") type = "payment.failed";
      else if (eventName === "order_created" && attrs.status === "paid") type = "payment.paid";
      else if (eventName === "subscription_expired") type = "customer.subscription.deleted";
      else if (eventName === "subscription_created") type = "customer.subscription.created";
      else if (["subscription_updated", "subscription_cancelled", "subscription_resumed", "subscription_paused", "subscription_unpaused"].includes(eventName)) type = "customer.subscription.updated";
      const metadata = flatMetadata(parsed.meta.custom_data);
      // Billing reason is provider evidence of a renewal. A snapshot never supplies settlement.
      if (attrs.billing_reason === "renewal") metadata.type = "subscription_renewal";
      const settlement = type === "payment.paid" || type === "payment.failed";
      if (settlement && (!Number.isSafeInteger(attrs.total) || (attrs.total as number) < 0 || typeof attrs.currency !== "string")) {
        throw new LemonSqueezyAdapterError("Invalid Lemon Squeezy payment settlement", 400);
      }
      const timestamp = attrs.updated_at ?? attrs.created_at;
      if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) throw new LemonSqueezyAdapterError("Invalid webhook timestamp", 400);
      // Lemon Squeezy supplies resource IDs but no event ID. Hash the authenticated
      // body for replay deduplication, retaining the invoice/order ID for settlement.
      const rawBytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
      const digest = await crypto.subtle.digest("SHA-256", rawBytes as BufferSource);
      const eventId = `ls_${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
      const periodEnd = attrs.ends_at ?? attrs.renews_at;
      return {
        id: eventId,
        type,
        originalType: eventName,
        environment: sandbox ? "test" : "live",
        data: {
          ...attrs,
          id: parsed.data.id,
          metadata,
          resourceType: parsed.data.type,
          providerEventType: eventName,
          providerAccountId: storeId,
          environment: sandbox ? "test" : "live",
          ...(settlement && { paymentId: parsed.data.id, amount: attrs.total, currency: attrs.currency }),
          ...(attrs.subscription_id !== undefined && { subscriptionId: String(attrs.subscription_id) }),
          ...(type.startsWith("customer.subscription.") && { subscriptionId: parsed.data.id }),
          ...(typeof periodEnd === "string" && { currentPeriodEnd: periodEnd }),
          ...(parsed.meta.custom_data && { custom_data: parsed.meta.custom_data }),
        },
        createdAt: new Date(timestamp),
      };
    },
  };
}
