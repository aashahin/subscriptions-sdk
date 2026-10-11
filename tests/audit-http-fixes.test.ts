import { describe, expect, it } from "bun:test";
import { Elysia, status } from "elysia";
import { createSubscriptions } from "../src/index.ts";
import { createSubscriptionsHttpHandler } from "../src/integrations/http.ts";
import { elysiaPlugin } from "../src/integrations/elysia.ts";
import { memoryDatabaseAdapter } from "../src/testing/memory-database.ts";
import type { SubscriptionInvoiceData } from "../src/templates/invoice-utils.ts";

const features = {
  products: { type: "limit", default: 1, usage: { kind: "periodic", reset: "subscription-cycle" } },
} as const;

async function fixture(limit = 1) {
  const database = memoryDatabaseAdapter<typeof features>();
  const subs = createSubscriptions({ database, features });
  const plan = await subs.plans.create({ name: "Free", price: 0, interval: "monthly", features: { products: limit } });
  const subscription = await subs.subscriptions.create("buyer", plan.id);
  return { database, subs, subscription };
}

const post = (path: string, body?: string) => new Request(`http://localhost${path}`, {
  method: "POST",
  ...(body !== undefined && { headers: { "content-type": "application/json" }, body }),
});

describe("audit HTTP input and invoice regressions", () => {
  for (const body of ["{", "null", "[]", "42"]) it(`rejects invalid cancel body ${body} before mutation`, async () => {
    const { subs, subscription } = await fixture();
    const http = createSubscriptionsHttpHandler(subs, { getSubscriberId: () => "buyer" });
    const response = await http.fetch(post("/subscriptions/cancel", body));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("INVALID_PUBLIC_INPUT");
    expect(await subs.subscriptions.get("buyer")).toMatchObject(subscription);
  });

  it("retains cancellation with an intentionally empty optional body", async () => {
    const { subs } = await fixture();
    const http = createSubscriptionsHttpHandler(subs, { getSubscriberId: () => "buyer" });
    expect((await http.fetch(post("/subscriptions/cancel"))).status).toBe(200);
    expect((await subs.subscriptions.get("buyer"))?.cancelAt).not.toBeNull();
  });

  it("returns an HTTP error response for malformed path encoding", async () => {
    const { subs } = await fixture();
    const http = createSubscriptionsHttpHandler(subs, { getSubscriberId: () => "buyer" });
    const response = await http.fetch(new Request("http://localhost/subscriptions/invoices/%ZZ"));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("INVALID_PUBLIC_INPUT");
  });

  it("passes complete invoice fields to custom renderers in both integrations", async () => {
    const { subs, subscription } = await fixture();
    const invoice = await subs.invoices.create({
      subscriptionId: subscription.id, invoiceNumber: "INV-000123", amount: 54.35, currency: "USD", status: "open",
      discountAmount: 2, creditNoteOfId: "original-invoice",
      lineItems: [
        { description: "Taxed item", quantity: 1, unitPrice: 49, amount: 49, taxRate: 15 },
        { description: "Zero values", quantity: 0, unitPrice: 0, amount: 0 },
      ],
    });
    const rendered: SubscriptionInvoiceData["invoice"][] = [];
    const template = (invoiceData: SubscriptionInvoiceData) => {
      rendered.push(invoiceData.invoice);
      return "custom invoice";
    };
    const http = createSubscriptionsHttpHandler(subs, {
      getSubscriberId: () => "buyer", invoice: { renderHtml: async (invoiceData) => template(invoiceData) },
    });
    const elysia = elysiaPlugin(subs, { getSubscriberId: () => "buyer", invoice: { template } });
    expect((await http.fetch(new Request(`http://localhost/subscriptions/invoices/${invoice.id}`))).status).toBe(200);
    expect((await elysia.handle(new Request(`http://localhost/subscriptions/invoices/${invoice.id}/download?format=html`))).status).toBe(200);
    expect(rendered).toEqual([invoice, invoice]);
    expect(rendered[0]?.lineItems[1]).toEqual({ description: "Zero values", quantity: 0, unitPrice: 0, amount: 0 });
  });

  it("forwards precompiled HTTP templates ahead of source and path", async () => {
    const { subs, subscription } = await fixture();
    const invoice = await subs.invoices.create({ subscriptionId: subscription.id, amount: 0, currency: "USD" });
    const http = createSubscriptionsHttpHandler(subs, {
      getSubscriberId: () => "buyer",
      invoice: { template: (invoiceData) => invoiceData.invoice.id, templateSource: "wrong", templatePath: "/missing-template" },
    });
    const response = await http.fetch(new Request(`http://localhost/subscriptions/invoices/${invoice.id}`));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(invoice.id);
  });
});

describe("audit Elysia atomic usage regressions", () => {
  for (const { name, resolver, authorize, expectedStatus } of [
    { name: "missing identity", resolver: () => null, authorize: () => true, expectedStatus: 401 },
    { name: "denied authorization", resolver: () => "buyer", authorize: () => false, expectedStatus: 403 },
  ]) it(`rejects ${name} before the business handler`, async () => {
    const { subs } = await fixture();
    let businessEffects = 0;
    const app = new Elysia().use(elysiaPlugin(subs, { getSubscriberId: resolver, authorizeSubscriber: authorize }))
      .post("/products", () => { businessEffects++; return { created: true }; }, { useFeature: "products" });
    const response = await app.handle(post("/products"));
    expect(response.status).toBe(expectedStatus);
    expect(businessEffects).toBe(0);
    expect((await subs.remaining("buyer", "products")).used).toBe(0);
  });

  it("releases the guard reservation when consumption authorization is denied", async () => {
    const { subs } = await fixture();
    let businessEffects = 0;
    const app = new Elysia().use(elysiaPlugin(subs, {
      getSubscriberId: () => "buyer", authorizeSubscriber: (_ctx, _id, operation) => operation === "usage",
    })).post("/products", () => { businessEffects++; return { created: true }; }, {
      requireUsage: { feature: "products" }, useFeature: "products",
    });
    expect((await app.handle(post("/products"))).status).toBe(403);
    expect(businessEffects).toBe(0);
    expect((await subs.remaining("buyer", "products")).used).toBe(0);
  });

  for (const order of ["require-first", "use-first"] as const) it(`admits one last-slot handler with count two, ${order}`, async () => {
    const { subs } = await fixture(2);
    let businessEffects = 0;
    let identityReads = 0;
    let enterHandler!: () => void;
    let finishHandler!: () => void;
    const entered = new Promise<void>((resolve) => { enterHandler = resolve; });
    const finishing = new Promise<void>((resolve) => { finishHandler = resolve; });
    const macros = order === "require-first"
      ? { requireUsage: { feature: "products" as const, count: 2 }, useFeature: "products" as const }
      : { useFeature: "products" as const, requireUsage: { feature: "products" as const, count: 2 } };
    const app = new Elysia().use(elysiaPlugin(subs, { getSubscriberId: () => { identityReads++; return "buyer"; } }))
      .post("/products", async () => {
        businessEffects++;
        enterHandler();
        await finishing;
        return { created: true };
      }, macros);
    const accepted = app.handle(post("/products"));
    await entered;
    let denied: Response;
    try { denied = await app.handle(post("/products")); }
    finally { finishHandler(); }
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toBe("USAGE_LIMIT_EXCEEDED");
    expect((await accepted).status).toBe(200);
    expect(businessEffects).toBe(1);
    expect(identityReads).toBe(2);
    expect((await subs.remaining("buyer", "products")).used).toBe(2);
  });

  for (const failure of ["set-status", "native-response", "native-response-with-set", "custom-status", "returned-error", "throw"] as const) it(
    `releases admission after a ${failure} failure`, async () => {
      const { subs } = await fixture();
      const app = new Elysia().use(elysiaPlugin(subs, { getSubscriberId: () => "buyer" }))
        .post("/products", ({ set }) => {
          if (failure === "throw") throw new Error("Business operation failed");
          if (failure === "returned-error") return new Error("Business operation failed");
          if (failure === "native-response") return Response.json({ error: "invalid" }, { status: 400 });
          if (failure === "custom-status") return status(400, { error: "invalid" });
          set.status = 400;
          if (failure === "native-response-with-set") return Response.json({ error: "invalid" });
          return { error: "invalid" };
        }, { useFeature: "products" });
      expect((await app.handle(post("/products"))).status).toBe(failure === "throw" || failure === "returned-error" ? 500 : 400);
      expect((await subs.remaining("buyer", "products")).used).toBe(0);
      expect((await subs.use("buyer", "products")).used).toBe(1);
    },
  );

  it("releases the captured billing period after the handler rolls it forward", async () => {
    const { database, subs, subscription } = await fixture();
    const nextPeriod = {
      periodStart: new Date(subscription.currentPeriodStart.getTime() + 1000),
      periodEnd: new Date(subscription.currentPeriodEnd.getTime() + 1000),
    };
    const app = new Elysia().use(elysiaPlugin(subs, { getSubscriberId: () => "buyer" }))
      .post("/products", async ({ set }) => {
        await database.subscriptions.update(subscription.id, {
          currentPeriodStart: nextPeriod.periodStart, currentPeriodEnd: nextPeriod.periodEnd,
        });
        await subs.use("buyer", "products");
        set.status = 400;
        return { error: "Operation failed after rollover" };
      }, { useFeature: "products" });
    expect((await app.handle(post("/products"))).status).toBe(400);
    expect(await database.usage.get("buyer", "products", {
      periodStart: subscription.currentPeriodStart, periodEnd: subscription.currentPeriodEnd,
    })).toBe(0);
    expect(await database.usage.get("buyer", "products", nextPeriod)).toBe(1);
  });

  it("releases a guard-only reservation after a successful handler", async () => {
    const { subs } = await fixture();
    const app = new Elysia().use(elysiaPlugin(subs, { getSubscriberId: () => "buyer" }))
      .post("/products", () => ({ accepted: true }), { requireUsage: { feature: "products" } });
    expect((await app.handle(post("/products"))).status).toBe(200);
    expect((await subs.remaining("buyer", "products")).used).toBe(0);
  });

  it("retains successful consumption when the limit event cannot be persisted", async () => {
    const { database, subs } = await fixture();
    const transaction = database.transaction;
    // Inject failure at the storage boundary while retaining real rollback semantics.
    database.transaction = (callback) => transaction((tx) => callback({
      ...tx, outbox: { ...tx.outbox!, insert: async () => { throw new Error("Outbox unavailable"); } },
    }));
    let businessEffects = 0;
    const app = new Elysia().use(elysiaPlugin(subs, { getSubscriberId: () => "buyer" }))
      .post("/products", () => { businessEffects++; return { created: true }; }, { useFeature: "products" });
    expect((await app.handle(post("/products"))).status).toBe(500);
    expect(businessEffects).toBe(1);
    expect((await subs.remaining("buyer", "products")).used).toBe(1);
    expect((await app.handle(post("/products"))).status).toBe(403);
    expect(businessEffects).toBe(1);
  });
});
