import { describe, expect, it } from "bun:test";
import { createSubscriptions } from "../src/index.ts";
import { createSubscriptionsHttpHandler } from "../src/integrations/http.ts";
import { createNextHandlers } from "../src/integrations/next.ts";
import { elysiaPlugin } from "../src/integrations/elysia.ts";
import { fakePaymentGateway } from "../src/testing/fake-payment-gateway.ts";
import { memoryDatabaseAdapter } from "../src/testing/memory-database.ts";
import { Elysia } from "elysia";
import { moyasarAdapter } from "../src/adapters/moyasar.adapter.ts";
import { paddleAdapter } from "../src/adapters/paddle.adapter.ts";
import { SubscriptionInactiveError } from "../src/core/errors.ts";

const features = { premium: { type: "boolean", default: false } } as const;

async function fixture() {
  const db = memoryDatabaseAdapter<typeof features>();
  const payment = fakePaymentGateway();
  const subs = createSubscriptions({ database: db, features, payment });
  const free = await subs.plans.create({ name: "Free", price: 0, interval: "monthly" });
  const paid = await subs.plans.create({ name: "Paid", price: 100, interval: "monthly", features: { premium: true } });
  return { db, payment, subs, free, paid };
}

function request(path: string, body?: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request(`http://localhost/subscriptions/${path}`, {
    method: body ? "POST" : "GET",
    headers: { ...headers, ...(body && { "content-type": "application/json" }) },
    ...(body && { body: JSON.stringify(body) }),
  });
}

describe("public trust boundaries", () => {
  it("HTTP fails closed without an identity resolver, including caller-supplied subscriber headers", async () => {
    const { subs, free } = await fixture();
    await subs.subscriptions.create("victim", free.id);
    const handler = createSubscriptionsHttpHandler(subs);
    const read = await handler.fetch(request("current", undefined, { "x-subscriber-id": "victim" }));
    expect(read.status).toBe(401);
    const cancel = await handler.fetch(request("cancel", { immediately: true }, { "x-subscriber-id": "victim" }));
    expect(cancel.status).toBe(401);
    expect((await subs.subscriptions.get("victim"))?.status).toBe("active");
    expect((await handler.fetch(request("plans"))).status).toBe(200);
  });

  it("Next.js inherits the fail-closed identity policy", async () => {
    const { subs } = await fixture();
    const handlers = createNextHandlers(subs);
    expect((await handlers.GET(request("current", undefined, { "x-subscriber-id": "victim" }))).status).toBe(401);
  });

  it("correctly authenticated HTTP users cannot forge trusted payment decisions", async () => {
    const { subs, free, paid, payment } = await fixture();
    await subs.subscriptions.create("attacker", free.id);
    const handler = createSubscriptionsHttpHandler(subs, { getSubscriberId: () => "attacker" });
    for (const field of ["skipPayment", "verifiedTokenId", "paymentId", "gatewayInvoiceId", "paidExternally", "tokenId"]) {
      const response = await handler.fetch(request("change-plan", { planId: paid.id, quoteId: "quote", [field]: field === "skipPayment" ? true : "forged" }));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("INVALID_PUBLIC_INPUT");
      expect((await subs.subscriptions.get("attacker"))?.planId).toBe(free.id);
    }
    expect(payment.calls.filter((call) => call.method === "chargePayment")).toHaveLength(0);
  });

  it("a trusted HTTP resolver ignores another subscriber supplied in a header", async () => {
    const { subs, free } = await fixture();
    await subs.subscriptions.create("victim", free.id);
    await subs.subscriptions.create("authenticated-user", free.id);
    const handler = createSubscriptionsHttpHandler(subs, { getSubscriberId: () => "authenticated-user" });
    const response = await handler.fetch(request("current", undefined, { "x-subscriber-id": "victim" }));
    expect(response.status).toBe(200);
    expect((await response.json()).subscription.subscriberId).toBe("authenticated-user");
  });

  it("HTTP operation authorization rejects an authenticated nonmember before access or mutation", async () => {
    const { subs, free } = await fixture();
    await subs.subscriptions.create("victim-tenant", free.id);
    const seen: string[] = [];
    const handler = createSubscriptionsHttpHandler(subs, {
      getSubscriberId: () => "victim-tenant",
      authorizeSubscriber: (_request, subscriberId, operation) => {
        seen.push(`${subscriberId}:${operation}`);
        return false;
      },
    });
    expect((await handler.fetch(request("current"))).status).toBe(403);
    expect((await handler.fetch(request("cancel", { immediately: true }))).status).toBe(403);
    expect(seen).toEqual(["victim-tenant:current", "victim-tenant:cancel"]);
    expect((await subs.subscriptions.get("victim-tenant"))?.status).toBe("active");
  });

  it("HTTP rejects client trial policy and initial settlement assertions", async () => {
    const { subs, paid } = await fixture();
    const handler = createSubscriptionsHttpHandler(subs, { getSubscriberId: () => "authenticated-user" });
    for (const field of ["trialDays", "verifiedTokenId", "paymentId", "paidExternally", "gatewayCustomerId"]) {
      const response = await handler.fetch(request("subscribe", { planId: paid.id, [field]: field === "trialDays" ? 36500 : "forged" }));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("INVALID_PUBLIC_INPUT");
    }
    expect(await subs.subscriptions.get("authenticated-user")).toBeNull();
  });

  it("HTTP creates an unpaid paid subscription without granting premium entitlement", async () => {
    const { subs, paid, payment } = await fixture();
    const handler = createSubscriptionsHttpHandler(subs, { getSubscriberId: () => "buyer" });
    const response = await handler.fetch(request("subscribe", { planId: paid.id }));
    expect(response.status).toBe(201);
    expect((await response.json()).subscription.status).toBe("incomplete");
    await expect(subs.can("buyer", "premium")).rejects.toBeInstanceOf(SubscriptionInactiveError);
    expect(payment.calls.filter((call) => call.method === "chargePayment")).toHaveLength(0);
    const invoices = await handler.fetch(request("invoices"));
    expect((await invoices.json()).invoices.every((invoice: { status: string }) => invoice.status !== "paid")).toBe(true);
  });

  it("Elysia self-service creation cannot grant paid features from an unpaid row", async () => {
    const { subs, paid } = await fixture();
    const app = elysiaPlugin(subs, { getSubscriberId: () => "buyer" });
    const response = await app.handle(request("subscribe", { planId: paid.id }));
    expect(response.status).toBe(201);
    expect((await response.json()).subscription.status).toBe("incomplete");
    await expect(subs.can("buyer", "premium")).rejects.toBeInstanceOf(SubscriptionInactiveError);
  });

  it("self-service trials use trusted plan policy and cannot be repeated after cancellation", async () => {
    const { subs } = await fixture();
    const trialPlan = await subs.plans.create({
      name: "Trial", price: 100, currency: "SAR", interval: "monthly", trialDays: 7, features: { premium: true },
    });
    const handler = createSubscriptionsHttpHandler(subs, { getSubscriberId: () => "trial-user" });
    const first = await handler.fetch(request("subscribe", { planId: trialPlan.id }));
    expect(first.status).toBe(201);
    const subscription = (await first.json()).subscription;
    expect(subscription.status).toBe("trialing");
    expect(new Date(subscription.trialEnd).getTime() - new Date(subscription.trialStart).getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    expect(await subs.can("trial-user", "premium")).toBe(true);
    expect((await handler.fetch(request("cancel", { immediately: true }))).status).toBe(200);
    const repeated = await handler.fetch(request("subscribe", { planId: trialPlan.id }));
    expect(repeated.status).toBe(201);
    expect((await repeated.json()).subscription.status).toBe("incomplete");
    await expect(subs.can("trial-user", "premium")).rejects.toBeInstanceOf(SubscriptionInactiveError);
  });

  it("Elysia fails closed without an explicit identity resolver even with a user context", async () => {
    const { subs } = await fixture();
    const app = new Elysia()
      .derive(() => ({ user: { activeTenantId: "victim" } }))
      .use(elysiaPlugin(subs));
    expect((await app.handle(request("current", undefined, { "x-subscriber-id": "victim" }))).status).toBe(401);
  });

  it("Elysia operation authorization checks membership before accessing tenant data", async () => {
    const { subs, free } = await fixture();
    await subs.subscriptions.create("victim-tenant", free.id);
    const app = elysiaPlugin(subs, {
      getSubscriberId: () => "victim-tenant",
      authorizeSubscriber: (_ctx, _id, operation) => operation === "current",
    });
    expect((await app.handle(request("current"))).status).toBe(200);
    expect((await app.handle(request("cancel", { immediately: true }))).status).toBe(403);
    expect((await subs.subscriptions.get("victim-tenant"))?.status).toBe("active");
  });

  it("actual Elysia routes reject forged financial fields and client trial durations", async () => {
    const { subs, free, paid, payment } = await fixture();
    await subs.subscriptions.create("attacker", free.id);
    const app = new Elysia().use(elysiaPlugin(subs, { getSubscriberId: () => "attacker" }));
    for (const field of ["skipPayment", "verifiedTokenId", "paymentId", "tokenId", "callbackUrl"]) {
      const response = await app.handle(request("change-plan", { planId: paid.id, quoteId: "quote", [field]: field === "skipPayment" ? true : "forged" }));
      expect(response.status).toBe(400);
      expect((await subs.subscriptions.get("attacker"))?.planId).toBe(free.id);
    }
    for (const path of ["subscribe", "create"]) {
      const response = await app.handle(request(path, { planId: paid.id, trialDays: 36500 }));
      expect(response.status).toBe(400);
    }
    expect(payment.calls.filter((call) => call.method === "chargePayment")).toHaveLength(0);
  });

  it("Elysia disables administrative routes unless explicitly enabled", async () => {
    const { subs } = await fixture();
    const app = elysiaPlugin(subs);
    expect((await app.handle(request("admin/plans"))).status).toBe(404);
    expect((await app.handle(request("admin/plans", { name: "Unauthorized", price: 1, interval: "monthly" }))).status).toBe(404);
  });

  it("Elysia requires an explicit administrative authorization guard", async () => {
    const { subs } = await fixture();
    expect(() => elysiaPlugin(subs, { adminRoutes: true })).toThrow(/adminGuard/);
    const denied = elysiaPlugin(subs, { adminRoutes: true, adminGuard: () => false });
    expect((await denied.handle(request("admin/plans"))).status).toBe(403);
    expect((await denied.handle(request("admin/plans", { name: "Denied", price: 0, interval: "monthly" }))).status).toBe(403);
    const allowed = elysiaPlugin(subs, { adminRoutes: true, adminGuard: () => true });
    expect((await allowed.handle(request("admin/plans"))).status).toBe(200);
    const created = await allowed.handle(request("admin/plans", { name: "Authorized", price: 0, interval: "monthly" }));
    expect(created.status).toBe(200);
    expect((await created.json()).plan.name).toBe("Authorized");
  });
});

describe("provider webhook transports", () => {
  function moyasarFixture(secretToken = "secret") {
    const adapter = moyasarAdapter({
      secretKey: "sk_test_test",
      publishableKey: "pk_test_test",
      webhookSecret: "secret",
      accountName: "merchant",
      callbackUrl: "https://app.test/callback",
    });
    const db = memoryDatabaseAdapter<typeof features>();
    const subs = createSubscriptions({
      database: db,
      features,
      providers: [{ id: "moyasar-test", accountId: "merchant", environment: "test", billingOwner: "sdk_managed", adapter }],
      defaultProvider: "moyasar-test",
    });
    const payload = JSON.stringify({
      id: "native-webhook-event",
      type: "payment_paid",
      created_at: "2026-10-11T00:00:00.000Z",
      secret_token: secretToken,
      account_name: "merchant",
      live: false,
      data: {
        id: "b35c31b6-bba4-40aa-9d61-42865e81c292",
        status: "paid",
        amount: 10000,
        currency: "SAR",
        created_at: "2026-10-11T00:00:00.000Z",
        source: { type: "creditcard", token: "token_x" },
        metadata: { subscriberId: "unmapped-subscriber" },
      },
    });
    const webhookRequest = () => new Request("http://localhost/subscriptions/webhooks/moyasar-test", {
      method: "POST", headers: { "content-type": "application/json" }, body: payload,
    });
    return { db, subs, webhookRequest };
  }

  it("HTTP accepts a native Moyasar body-authenticated webhook with no signature header", async () => {
    const { db, subs, webhookRequest } = moyasarFixture();
    const response = await createSubscriptionsHttpHandler(subs).fetch(webhookRequest());
    expect(response.status).toBe(200);
    expect((await response.json()).received).toBe(true);
    expect(await db.invoices.findByGatewayInvoiceId("b35c31b6-bba4-40aa-9d61-42865e81c292")).toBeNull();
  });

  it("Elysia preserves the raw JSON body for native Moyasar authentication", async () => {
    const { subs, webhookRequest } = moyasarFixture();
    const response = await elysiaPlugin(subs).handle(webhookRequest());
    expect(response.status).toBe(200);
    expect((await response.json()).eventId).toBe("native-webhook-event");
  });

  it("both webhook transports reject a forged Moyasar body secret", async () => {
    const { subs, webhookRequest } = moyasarFixture("forged-secret");
    expect((await createSubscriptionsHttpHandler(subs).fetch(webhookRequest())).status).toBe(401);
    expect((await elysiaPlugin(subs).handle(webhookRequest())).status).toBe(401);
  });

  it("HTTP and Elysia forward the full provider headers and exact raw body for Paddle verification", async () => {
    const secret = "paddle-secret";
    const rawBody = JSON.stringify({
      event_id: "paddle-event", event_type: "notification.test", occurred_at: new Date().toISOString(), data: {},
    }, null, 2);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}:${rawBody}`));
    const signature = Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const adapter = paddleAdapter({ apiKey: "test_key", environment: "sandbox", webhookSecret: secret });
    const subs = createSubscriptions({
      database: memoryDatabaseAdapter<typeof features>(), features,
      providers: [{ id: "paddle-test", accountId: "paddle-account", environment: "test", billingOwner: "provider_managed", adapter }],
      defaultProvider: "paddle-test",
    });
    const makeRequest = () => new Request("http://localhost/subscriptions/webhooks/paddle-test", {
      method: "POST", headers: { "content-type": "application/json", "paddle-signature": `ts=${timestamp};h1=${signature}` }, body: rawBody,
    });
    const http = await createSubscriptionsHttpHandler(subs).fetch(makeRequest());
    expect(http.status).toBe(200);
    expect((await http.json()).eventId).toBe("paddle-event");
    const elysia = await elysiaPlugin(subs).handle(makeRequest());
    expect(elysia.status).toBe(200);
    expect((await elysia.json()).eventId).toBe("paddle-event");
  });
});
