import { mockFetch } from './helpers/fetch.ts';
import { afterEach, describe, expect, it } from "bun:test";
import { paddleAdapter } from "../src/adapters/paddle.adapter.ts";
import { lemonSqueezyAdapter } from "../src/adapters/lemonsqueezy.adapter.ts";
import { stripeAdapter } from "../src/adapters/stripe.adapter.ts";

const secret = "local-webhook-secret";
const now = () => Math.floor(Date.now() / 1000);
const instant = "2026-10-11T07:00:00.000Z";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

async function hmac(body: string | Uint8Array, prefix = "") {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const raw = typeof body === "string" ? encoder.encode(body) : body;
  const start = encoder.encode(prefix);
  const bytes = new Uint8Array(start.length + raw.length);
  bytes.set(start); bytes.set(raw, start.length);
  return Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
}
const paddle = () => paddleAdapter({ apiKey: "local", webhookSecret: secret });
const lemon = () => lemonSqueezyAdapter({ apiKey: "local", storeId: 1, webhookSecret: secret });
const stripe = () => stripeAdapter({ secretKey: "sk_test_local", webhookSecret: secret });

async function paddleEvent(type: string, data: Record<string, unknown>) {
  const body = JSON.stringify({ event_id: `evt_${type}`, event_type: type, occurred_at: instant, data });
  const timestamp = now();
  const signature = `ts=${timestamp};h1=${await hmac(body, `${timestamp}:`)}`;
  return paddle().constructWebhookEvent(new TextEncoder().encode(body), "", { headers: { "Paddle-Signature": signature } });
}
async function lemonEvent(name: string, attributes: Record<string, unknown>, custom: Record<string, unknown> = { subscriberId: "tenant" }) {
  const body = JSON.stringify({ meta: { event_name: name, custom_data: custom, test_mode: false }, data: { type: name.startsWith("subscription_payment") ? "subscription-invoices" : "subscriptions", id: "42", attributes: { store_id: 1, created_at: instant, updated_at: instant, test_mode: false, ...attributes } } });
  return lemon().constructWebhookEvent(body, await hmac(body));
}
async function stripeEvent(type: string, data: Record<string, unknown>) {
  const timestamp = now();
  const body = JSON.stringify({ id: `evt_${type}`, type, created: timestamp, livemode: false, data: { object: data } });
  return stripe().constructWebhookEvent(body, `t=${timestamp},v1=${await hmac(body, `${timestamp}.`)}`);
}

describe("provider webhook authentication", () => {
  it("Paddle, Stripe, and Lemon Squeezy fail closed without configured signing secrets", async () => {
    await expect(paddleAdapter({ apiKey: "local" }).constructWebhookEvent("{}", "")).rejects.toThrow("webhookSecret");
    await expect(stripeAdapter({ secretKey: "local" }).constructWebhookEvent("{}", "")).rejects.toThrow("webhookSecret");
    await expect(lemonSqueezyAdapter({ apiKey: "local", storeId: 1 }).constructWebhookEvent("{}", "")).rejects.toThrow("webhookSecret");
  });

  it("Paddle authenticates native semicolon headers, raw UTF-8 bytes, and rotated signatures", async () => {
    const body = new TextEncoder().encode(JSON.stringify({ event_id: "evt_unicode", event_type: "subscription.updated", occurred_at: instant, data: { id: "sub_1", custom_data: { subscriberId: "\u0623\u062d\u0645\u062f" }, status: "active" } }));
    const timestamp = now();
    const signature = `ts=${timestamp};h1=${"0".repeat(64)};h1=${await hmac(body, `${timestamp}:`)}`;
    const event = await paddle().constructWebhookEvent(body, signature);
    expect(event.type).toBe("customer.subscription.updated");
    expect((event.data.metadata as Record<string, string>).subscriberId).toBe("\u0623\u062d\u0645\u062f");
    await expect(paddle().constructWebhookEvent(new TextDecoder().decode(body) + " ", signature)).rejects.toThrow("signature");
    await expect(paddle().constructWebhookEvent(body, `ts=${timestamp - 1000};h1=${await hmac(body, `${timestamp - 1000}:`)}`)).rejects.toThrow("tolerance");
  });

  it("Lemon Squeezy validates the configured store and environment after authentication", async () => {
    await expect(lemonEvent("subscription_updated", { store_id: 2 })).rejects.toThrow("store");
    await expect(lemonEvent("subscription_updated", { test_mode: true })).rejects.toThrow("environment");
    await expect(lemon().constructWebhookEvent("{}", await hmac("{}"))).rejects.toThrow("payload");
    await expect(lemon().constructWebhookEvent("{}", "not-a-signature")).rejects.toThrow("signature");
  });

  it("Stripe verifies raw bytes, full native headers, malformed and mismatched environments", async () => {
    const timestamp = now();
    const body = new TextEncoder().encode(JSON.stringify({ id: "evt_1", type: "customer.subscription.updated", livemode: false, created: timestamp, data: { object: { id: "sub_1", status: "past_due" } } }));
    const signature = `t=${timestamp},v1=${await hmac(body, `${timestamp}.`)}`;
    expect((await stripe().constructWebhookEvent(body, "", { headers: { "Stripe-Signature": signature } })).type).toBe("customer.subscription.updated");
    await expect(stripe().constructWebhookEvent(new TextDecoder().decode(body) + " ", signature)).rejects.toThrow("signature");
    const live = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated", livemode: true, created: timestamp, data: { object: { id: "sub_1" } } });
    await expect(stripe().constructWebhookEvent(live, `t=${timestamp},v1=${await hmac(live, `${timestamp}.`)}`)).rejects.toThrow("environment");
  });
});

describe("provider event normalization", () => {
  it("Paddle completed transactions carry actual settlement IDs, minor units, metadata and billing bounds", async () => {
    const event = await paddleEvent("transaction.completed", { id: "txn_1", status: "completed", origin: "subscription_recurring", subscription_id: "sub_1", currency_code: "USD", details: { totals: { total: "1234" } }, billing_period: { starts_at: instant, ends_at: "2026-11-11T07:00:00.000Z" }, custom_data: { subscriberId: "tenant", paymentAttemptId: "attempt" } });
    expect(event.type).toBe("payment.paid");
    expect(event.originalType).toBe("transaction.completed");
    expect(event.data.id).toBe("txn_1");
    expect(event.data.paymentId).toBe("txn_1");
    expect(event.data.amount).toBe(1234);
    expect(event.data.currency).toBe("USD");
    expect(event.data.subscriptionId).toBe("sub_1");
    expect(event.data.currentPeriodStart).toBe(instant);
    expect(event.data.metadata).toEqual({ subscriberId: "tenant", paymentAttemptId: "attempt", type: "subscription_renewal" });
  });

  it("Paddle payment failures and subscription snapshots remain distinct", async () => {
    const failed = await paddleEvent("transaction.payment_failed", { id: "txn_failure", currency_code: "USD", details: { totals: { total: "100" } }, custom_data: { subscriberId: "tenant" } });
    expect(failed.type).toBe("payment.failed");
    const snapshot = await paddleEvent("subscription.past_due", { id: "sub_1", status: "past_due", custom_data: { type: "subscription_renewal", subscriberId: "tenant" } });
    expect(snapshot.type).toBe("customer.subscription.updated");
    expect(snapshot.data.paymentId).toBeUndefined();
    expect((await paddleEvent("subscription.canceled", { id: "sub_1", status: "canceled" })).type).toBe("customer.subscription.deleted");
  });

  it("Lemon Squeezy success and recovered deliveries share the actual invoice identity", async () => {
    const invoice = { subscription_id: 7, total: 2500, currency: "USD", status: "paid", billing_reason: "renewal" };
    const paid = await lemonEvent("subscription_payment_success", invoice);
    const recovered = await lemonEvent("subscription_payment_recovered", invoice);
    expect(paid.type).toBe("payment.paid");
    expect(recovered.type).toBe("payment.paid");
    expect(paid.id).not.toBe(recovered.id);
    expect(paid.data.paymentId).toBe("42");
    expect(recovered.data.paymentId).toBe("42");
    expect(paid.data.subscriptionId).toBe("7");
    expect(paid.data.amount).toBe(2500);
    expect(paid.data.metadata).toEqual({ subscriberId: "tenant", type: "subscription_renewal" });
    expect((await lemonEvent("subscription_payment_success", invoice)).id).toBe(paid.id);
  });

  it("Lemon Squeezy scheduled cancellations preserve paid access until expiry and failures are payments", async () => {
    const cancelled = await lemonEvent("subscription_cancelled", { status: "cancelled", cancelled: true, ends_at: "2026-11-11T07:00:00.000Z" });
    expect(cancelled.type).toBe("customer.subscription.updated");
    expect(cancelled.data.paymentId).toBeUndefined();
    expect(cancelled.data.currentPeriodEnd).toBe("2026-11-11T07:00:00.000Z");
    expect((await lemonEvent("subscription_expired", { status: "expired" })).type).toBe("customer.subscription.deleted");
    expect((await lemonEvent("subscription_payment_failed", { subscription_id: 7, total: 100, currency: "USD", status: "pending" })).type).toBe("payment.failed");
  });

  it("Stripe PaymentIntents normalize actual settlement while snapshots retain their own event type", async () => {
    const paid = await stripeEvent("payment_intent.succeeded", { id: "pi_1", status: "succeeded", amount: 150, amount_received: 125, currency: "usd", metadata: { subscriberId: "tenant", paymentAttemptId: "attempt" } });
    expect(paid.type).toBe("payment.paid");
    expect(paid.data.paymentId).toBe("pi_1");
    expect(paid.data.amount).toBe(125);
    const snapshot = await stripeEvent("customer.subscription.updated", { id: "sub_1", status: "past_due", metadata: { type: "subscription_renewal" } });
    expect(snapshot.type).toBe("customer.subscription.updated");
    expect(snapshot.data.paymentId).toBeUndefined();
    const invoice = await stripeEvent("invoice.payment_succeeded", { id: "in_1", payment_intent: "pi_1", paid: true, amount_paid: 125, currency: "usd", billing_reason: "subscription_cycle", subscription: "sub_1", subscription_details: { metadata: { subscriberId: "tenant" } } });
    expect(invoice.type).toBe("payment.paid");
    expect(invoice.data.paymentId).toBe("pi_1");
    expect(invoice.data.metadata).toEqual({ subscriberId: "tenant", type: "subscription_renewal" });
  });
});

describe("provider charge contract", () => {
  it("Stripe sends the stable idempotency key and selected payment method and separates authorization from capture", async () => {
    let request: RequestInit | undefined;
    mockFetch(async (_url, init) => {
      request = init;
      return Response.json({ id: "pi_1", status: "requires_capture", amount: 100, currency: "usd" });
    });
    const result = await stripe().chargePayment!({ customerId: "cus_1", paymentMethodId: "pm_selected", amount: 100, currency: "USD", idempotencyKey: "attempt_1" });
    expect(result.status).toBe("authorized");
    expect(new Headers(request?.headers).get("Idempotency-Key")).toBe("attempt_1");
    expect(new URLSearchParams(String(request?.body)).get("payment_method")).toBe("pm_selected");
  });

  it("Stripe transport/5xx outcomes remain unknown and cannot invite a new charge", async () => {
    const input = { customerId: "cus_1", paymentMethodId: "pm_1", amount: 100, currency: "USD", idempotencyKey: "attempt_1" };
    mockFetch(async () => { throw new Error("connection lost after write"); });
    expect((await stripe().chargePayment!(input)).status).toBe("unknown");
    mockFetch(async () => Response.json({ error: { message: "service unavailable" } }, { status: 503 }));
    expect((await stripe().chargePayment!(input)).status).toBe("unknown");
  });

  it("Paddle cannot use a subscription entity as payment evidence and reports hosted transaction uncertainty", async () => {
    let calls = 0;
    mockFetch(async () => { calls++; throw new Error("network error"); });
    const rejected = await paddle().chargePayment!({ customerId: "sub_1", amount: 100, currency: "USD" });
    expect(rejected.status).toBe("failed");
    expect(rejected.errorCode).toBe("UNSUPPORTED_OPERATION");
    expect(calls).toBe(0);
    expect((await paddle().chargePayment!({ customerId: "ctm_1", amount: 100, currency: "USD" })).status).toBe("unknown");
    expect(paddle().capabilities?.directPayments).toBe(false);
    expect(lemon().capabilities?.directPayments).toBe(false);
    expect(paddle().createSubscription).toBeUndefined();
    expect(lemon().createSubscription).toBeUndefined();
  });

  it("Stripe rejects direct charges without stable idempotency before any provider request", async () => {
    let calls = 0;
    mockFetch(async () => { calls++; return Response.json({}); });
    await expect(stripe().chargePayment!({ customerId: "cus_1", paymentMethodId: "pm_1", amount: 100, currency: "USD" })).rejects.toThrow("idempotencyKey");
    expect(calls).toBe(0);
  });

  it("Stripe lookup returns actual captured minor units, saved method and metadata, and propagates outages", async () => {
    mockFetch(async () => Response.json({ id: "pi_1", status: "succeeded", amount: 100, amount_received: 70, currency: "usd", payment_method: "pm_1", metadata: { paymentAttemptId: "attempt_1" } }));
    const payment = await stripe().getPayment!("pi_1");
    expect(payment?.status).toBe("paid");
    expect(payment?.amount).toBe(70);
    expect(payment?.currency).toBe("USD");
    expect(payment?.paymentMethodId).toBe("pm_1");
    expect(payment?.metadata).toEqual({ paymentAttemptId: "attempt_1" });
    expect(stripe().capabilities?.paymentLookup).toBe(true);
    mockFetch(async () => Response.json({ error: { message: "not found" } }, { status: 404 }));
    expect(await stripe().getPayment!("pi_missing")).toBeNull();
    mockFetch(async () => Response.json({ error: { message: "service unavailable" } }, { status: 503 }));
    await expect(stripe().getPayment!("pi_1")).rejects.toThrow("service unavailable");
  });

  it("Paddle reactivation clears the provider scheduled change before reporting success", async () => {
    let body: Record<string, unknown> | undefined;
    mockFetch(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ data: { id: "sub_1", status: "active", customer_id: "ctm_1", current_billing_period: { starts_at: instant, ends_at: "2026-11-11T07:00:00.000Z" }, scheduled_change: null, items: [], canceled_at: null } });
    });
    const subscription = await paddle().updateSubscription!("sub_1", { cancelAtPeriodEnd: false });
    expect(body).toEqual({ scheduled_change: null });
    expect(subscription.cancelAt).toBeNull();
  });

  it("provider responses cannot substitute requested amounts for missing settlement evidence", async () => {
    mockFetch(async () => Response.json({ id: "pi_1", status: "succeeded", amount: 100, currency: "usd" }));
    expect((await stripe().chargePayment!({ customerId: "cus_1", paymentMethodId: "pm_1", amount: 100, currency: "USD", idempotencyKey: "attempt_1" })).status).toBe("unknown");
    await expect(stripe().getPayment!("pi_1")).rejects.toThrow("lookup response");
    mockFetch(async () => Response.json({ data: { id: "txn_1", status: "completed", currency_code: "USD" } }));
    expect((await paddle().chargePayment!({ customerId: "ctm_1", amount: 100, currency: "USD" })).status).toBe("unknown");
  });

  it("Paddle and Lemon Squeezy reject unsupported trial overrides before creating checkouts", async () => {
    let calls = 0;
    mockFetch(async () => { calls++; return Response.json({}); });
    const checkout = { priceId: "1", successUrl: "https://app.example/success", cancelUrl: "https://app.example/cancel", trialDays: 14 };
    await expect(paddle().createCheckoutSession!(checkout)).rejects.toThrow("recurring price");
    await expect(lemon().createCheckoutSession!(checkout)).rejects.toThrow("variant");
    expect(calls).toBe(0);
  });

  it("Paddle and Lemon Squeezy checkout results omit expiry when the provider supplies none", async () => {
    mockFetch(async () => Response.json({ data: { id: "txn_1", checkout: { url: "https://checkout.example" } } }));
    expect((await paddle().createCheckoutSession!({ priceId: "pri_1", successUrl: "https://app.example/success", cancelUrl: "https://app.example/cancel" })).expiresAt).toBeUndefined();
    mockFetch(async () => Response.json({ data: { id: "42", attributes: { url: "https://checkout.example", expires_at: null } } }));
    expect((await lemon().createCheckoutSession!({ priceId: "1", successUrl: "https://app.example/success", cancelUrl: "https://app.example/cancel" })).expiresAt).toBeUndefined();
  });
});
