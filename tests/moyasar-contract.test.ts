import { afterEach, describe, expect, it } from "bun:test";
import { moyasarAdapter } from "../src/adapters/moyasar.adapter";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const key = "a1168bd1-47a4-4b97-8a50-dd5caaccacf2";
const config = { secretKey: "sk_test_test", publishableKey: "pk_test_test", webhookSecret: "secret", callbackUrl: "https://app.test/callback" };
const payment = (status = "paid") => ({ id: key, status, amount: 10000, currency: "SAR", fee: 0, captured: 10000, refunded: 0, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", metadata: { subscriberId: "sub_internal", attemptId: key, type: "renewal" }, source: { type: "creditcard", token: "token_saved" } });
const webhook = (overrides = {}) => JSON.stringify({ id: "event_paid", type: "payment_paid", secret_token: "secret", account_name: "account", live: false, created_at: "2026-01-01T00:00:00Z", data: payment(), ...overrides });
const mockResponse = (data: unknown, status = 200) => { globalThis.fetch = async () => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } }); };

describe("Moyasar official provider contracts", () => {
  it("authenticates native body secret and normalizes payment_paid", async () => {
    const event = await moyasarAdapter(config).constructWebhookEvent(webhook(), "");
    expect(event.type).toBe("payment.paid");
    expect(event.data.id).toBe(key);
    expect(event.data.metadata).toEqual(payment().metadata);
  });

  it("fails closed for missing configuration, wrong secret, wrong environment, and mismatched settlement", async () => {
    await expect(moyasarAdapter({ ...config, webhookSecret: undefined }).constructWebhookEvent(webhook(), "")).rejects.toThrow();
    for (const fields of [{ secret_token: "wrong" }, { secret_token: undefined }, { live: true }, { data: payment("authorized") }]) {
      await expect(moyasarAdapter(config).constructWebhookEvent(webhook(fields), "")).rejects.toThrow();
    }
  });

  it("does not represent token billing as customers or native subscriptions", async () => {
    const gateway = moyasarAdapter(config);
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify(payment())); };
    await expect(gateway.createCustomer!({ email: "test@example.com" })).rejects.toThrow("does not support");
    await expect(gateway.createSubscription!({ customerId: "token_saved", priceId: "10000", trialDays: 30 })).rejects.toThrow("does not support");
    await expect(gateway.getSubscription!(key)).rejects.toThrow("does not support");
    await expect(gateway.cancelSubscription!(key, { immediately: true })).rejects.toThrow("does not support");
    expect(calls).toBe(0);
  });

  it("does not invent hosted checkout or portal sessions", async () => {
    const gateway = moyasarAdapter(config);
    await expect(gateway.createCheckoutSession!({ priceId: "price_external", successUrl: config.callbackUrl, cancelUrl: config.callbackUrl })).rejects.toThrow("does not support");
    await expect(gateway.createPortalSession!("customer", config.callbackUrl)).rejects.toThrow("does not support");
  });

  it("uses the persisted UUID given_id and keeps authorization distinct", async () => {
    let body: Record<string, unknown> = {};
    globalThis.fetch = async (_, init) => { body = JSON.parse(init!.body as string); return new Response(JSON.stringify(payment("authorized"))); };
    const result = await moyasarAdapter(config).chargePayment!({ customerId: "legacy_customer", paymentMethodId: "token_saved", amount: 10000, currency: "SAR", idempotencyKey: key });
    expect(body.given_id).toBe(key);
    expect(body.source).toEqual({ type: "token", token: "token_saved" });
    expect(result.status).toBe("authorized");
  });

  it("rejects collection before network access without a stable UUID", async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(JSON.stringify(payment())); };
    await expect(moyasarAdapter(config).chargePayment!({ customerId: "token_saved", amount: 10000, currency: "SAR" })).rejects.toThrow("idempotencyKey");
    expect(calls).toBe(0);
  });

  it("preserves unknown outcomes after transport, 5xx, and malformed successful responses", async () => {
    const gateway = moyasarAdapter(config);
    const charge = { customerId: "token_saved", amount: 10000, currency: "SAR", idempotencyKey: key };
    globalThis.fetch = async () => { throw new Error("connection dropped after acceptance"); };
    expect((await gateway.chargePayment!(charge)).status).toBe("unknown");
    mockResponse({ type: "api_error", message: "outage" }, 503);
    const result = await gateway.chargePayment!(charge);
    expect(result.status).toBe("unknown");
    expect(result.id).toBe(key);
    mockResponse({ id: key, status: "new_unrecognized_status" });
    expect((await gateway.chargePayment!(charge)).status).toBe("unknown");
  });

  it("reserves null for confirmed absence and surfaces look-up outages", async () => {
    const gateway = moyasarAdapter(config);
    mockResponse({ type: "invalid_request_error", message: "not found" }, 404);
    expect(await gateway.getPaymentSource!(key)).toBeNull();
    for (const status of [401, 429, 503]) {
      mockResponse({ type: "api_error", message: "error" }, status);
      await expect(gateway.getPaymentSource!(key)).rejects.toThrow();
    }
    globalThis.fetch = async () => { throw new Error("offline"); };
    await expect(gateway.getPaymentSource!(key)).rejects.toThrow();
  });
  it("validates initiated/active/inactive token status through real lookups", async () => {
    const gateway = moyasarAdapter(config);
    for (const [providerStatus, status] of [["initiated", "pending"], ["active", "active"], ["inactive", "inactive"]]) {
      mockResponse({ id: "token_saved", status: providerStatus, brand: "visa", last_four: "1111", month: "12", year: "2030" });
      expect((await gateway.getPaymentMethod!("token_saved"))?.status).toBe(status);
    }
    mockResponse({ id: "token_saved", status: "verified", brand: "visa", last_four: "1111" });
    await expect(gateway.getPaymentMethod!("token_saved")).rejects.toThrow("Invalid token response");
    mockResponse({}, 404);
    expect(await gateway.getPaymentMethod!("token_saved")).toBeNull();
    mockResponse({}, 503);
    await expect(gateway.getPaymentMethod!("token_saved")).rejects.toThrow();
  });

  it("returns explicit embedded checkout form settings and verifies authoritative payment lookup", async () => {
    const gateway = moyasarAdapter(config);
    expect(gateway.getEmbeddedCheckoutConfiguration!({ amount: 1200, currency: "USD", metadata: { subscriberId: "internal" } })).toEqual({ provider: "moyasar", amount: 1200, currency: "USD", publishable_api_key: "pk_test_test", callback_url: config.callbackUrl, metadata: { subscriberId: "internal" } });
    mockResponse(payment("authorized"));
    const snapshot = await gateway.getPayment!(key);
    expect(snapshot?.status).toBe("authorized");
    expect(snapshot?.metadata).toEqual(payment().metadata);
    mockResponse({}, 404);
    expect(await gateway.getPayment!(key)).toBeNull();
    mockResponse({}, 503);
    await expect(gateway.getPayment!(key)).rejects.toThrow();
  });

  it("reports actual captured amount rather than original authorization", async () => {
    const gateway = moyasarAdapter(config);
    const captured = { ...payment("captured"), captured: 3000 };
    mockResponse(captured);
    expect((await gateway.getPayment!(key))?.amount).toBe(3000);
    const event = await gateway.constructWebhookEvent(webhook({ type: "payment_captured", data: captured }), "");
    expect(event.type).toBe("payment.paid");
    expect(event.data.amount).toBe(3000);
    mockResponse(payment("verified"));
    expect((await gateway.getPayment!(key))?.status).toBe("pending");
  });

});
