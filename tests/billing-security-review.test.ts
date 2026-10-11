import { afterEach, describe, expect, it } from "bun:test";
import { createSubscriptions } from "../src/index.ts";
import { memoryDatabaseAdapter } from "../src/testing/memory-database.ts";
import { fakePaymentGateway } from "../src/testing/fake-payment-gateway.ts";
import { moyasarAdapter } from "../src/adapters/moyasar.adapter.ts";
import type { ChargePaymentInput } from "../src/adapters/payment.adapter.ts";
import { snapshotBillingPrice } from "../src/core/billing-policy.ts";
import { withEvents } from "../src/core/events.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const features = { premium: { type: "boolean", default: false } } as const;
const DAY = 86400000;

async function fixture(status: "active" | "past_due" = "active") {
  const database = memoryDatabaseAdapter<typeof features>();
  const adapter = fakePaymentGateway();
  const plan = await database.plans.create({ name: "Paid", price: 100, currency: "SAR", interval: "monthly", features: { premium: true } });
  const end = new Date(Date.now() - DAY);
  const subscription = await database.subscriptions.create({
    subscriberId: "subscriber", planId: plan.id, status,
    currentPeriodStart: new Date(Date.now() - 32 * DAY), currentPeriodEnd: end,
    billing: { providerId: "fake-test", accountId: "merchant", environment: "test", billingOwner: "sdk_managed", externalPaymentMethodId: "token" },
    metadata: { billingPolicy: "purchase", paidThrough: end.toISOString(), paidPrice: snapshotBillingPrice(plan), ...(status === "past_due" && { dunningStartedAt: new Date(Date.now() - 2 * DAY).toISOString(), dunningAttempts: 0 }) },
  });
  const sdk = createSubscriptions({
    database, features,
    providers: [{ id: "fake-test", accountId: "merchant", environment: "test", billingOwner: "sdk_managed", adapter }],
    defaultProvider: "fake-test", options: { dunning: { retryScheduleDays: [0, 1], action: "none" } },
  });
  return { database, adapter, plan, subscription, sdk };
}

function charges(adapter: ReturnType<typeof fakePaymentGateway>) {
  return adapter.calls.filter((call) => call.method === "chargePayment").map((call) => call.args[0] as ChargePaymentInput);
}

function holdCollection(adapter: ReturnType<typeof fakePaymentGateway>) {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const charge = adapter.chargePayment!.bind(adapter);
  adapter.chargePayment = async (input) => { started(); await gate; return charge(input); };
  return { release, entered };
}

describe("independent financial security review", () => {
  it("dunning cannot create a new retry while an earlier collection outcome remains unknown", async () => {
    const { sdk, adapter } = await fixture("past_due");
    adapter.queueChargeOutcome("unknown");
    await expect(sdk.subscriptions.renew("subscriber")).rejects.toThrow();
    expect(charges(adapter)).toHaveLength(1);
    await sdk.subscriptions.processDunning();
    expect(charges(adapter)).toHaveLength(1);
  });

  it("a failed event for another payment resource cannot suspend the attempted purchase", async () => {
    const { sdk, adapter, database, subscription } = await fixture();
    adapter.queueChargeOutcome("pending");
    await expect(sdk.subscriptions.renew("subscriber")).rejects.toThrow();
    const charge = charges(adapter)[0]!;
    await expect(sdk.handleWebhook("fake-test", JSON.stringify({
      type: "payment.failed", data: { id: "unrelated-payment", amount: 1, currency: "USD", metadata: charge.metadata, message: "Unrelated card declined" },
    }), "")).rejects.toThrow();
    expect((await database.subscriptions.findById(subscription.id))!.status).toBe("active");
  });

  it("Moyasar settlements remain bound to given_id when local attempt persistence fails after collection", async () => {
    const database = memoryDatabaseAdapter<typeof features>();
    const adapter = moyasarAdapter({ secretKey: "sk_test_test", publishableKey: "pk_test_test", webhookSecret: "secret", accountName: "merchant", callbackUrl: "https://app.test/callback" });
    const plan = await database.plans.create({ name: "Paid", price: 100, currency: "SAR", interval: "monthly" });
    const end = new Date(Date.now() - DAY);
    const subscription = await database.subscriptions.create({
      subscriberId: "subscriber", planId: plan.id, status: "active", currentPeriodStart: new Date(Date.now() - 32 * DAY), currentPeriodEnd: end,
      billing: { providerId: "moyasar-test", accountId: "merchant", environment: "test", billingOwner: "sdk_managed", externalPaymentMethodId: "token" },
      metadata: { billingPolicy: "purchase", paidThrough: end.toISOString() },
    });
    const sdk = createSubscriptions({ database, features, providers: [{ id: "moyasar-test", accountId: "merchant", environment: "test", billingOwner: "sdk_managed", adapter }], defaultProvider: "moyasar-test" });
    let outbound: Record<string, any> = {};
    const payment = (id: string) => ({ id, status: "paid", amount: 10000, currency: "SAR", created_at: new Date().toISOString(), source: { type: "creditcard", token: "token" }, metadata: outbound.metadata });
    globalThis.fetch = async (_request, init) => {
      outbound = JSON.parse(init!.body as string);
      return new Response(JSON.stringify(payment(outbound.given_id)), { status: 200, headers: { "content-type": "application/json" } });
    };
    const originalTransaction = database.transaction.bind(database);
    let failPersistence = true;
    database.transaction = async (fn) => originalTransaction(async (tx) => {
      const update = tx.billingOperations!.update.bind(tx.billingOperations);
      const guarded = { ...tx, billingOperations: { ...tx.billingOperations!, update: async (key: string, data: Parameters<typeof update>[1]) => {
        if (failPersistence && key.includes(":attempt:") && data.status === "succeeded") { failPersistence = false; throw new Error("Attempt persistence unavailable after provider acceptance"); }
        return update(key, data);
      } } };
      return fn(guarded);
    });
    await expect(sdk.subscriptions.renew("subscriber")).rejects.toThrow();
    expect(typeof outbound.given_id).toBe("string");
    const unrelatedId = "ecec218e-98e7-4f0a-a01a-b3f15a5d613b";
    await expect(sdk.handleWebhook("moyasar-test", JSON.stringify({
      id: "event", type: "payment_paid", created_at: new Date().toISOString(), secret_token: "secret", account_name: "merchant", live: false, data: payment(unrelatedId),
    }), "")).rejects.toThrow();
    expect((await database.subscriptions.findById(subscription.id))!.currentPeriodEnd).toEqual(end);
  });

  it("outbox-enabled subscription mutation fails before writes without atomic rollback", async () => {
    const database = memoryDatabaseAdapter<typeof features>();
    const plan = await database.plans.create({ name: "Trial", price: 100, interval: "monthly", trialDays: 7 });
    database.capabilities = { asyncTransactions: false };
    database.outbox = { ...database.outbox!, insert: async () => { throw new Error("Outbox persistence unavailable"); } };
    const sdk = createSubscriptions({ database, features });
    await expect(sdk.subscriptions.createSelfService("subscriber", plan.id)).rejects.toThrow();
    expect(await database.subscriptions.findBySubscriber("subscriber")).toBeNull();
  });

  it("settlement after immediate cancellation cannot reactivate the canceled subscription", async () => {
    const { sdk, adapter, database, subscription } = await fixture();
    const { release, entered } = holdCollection(adapter);
    const collection = sdk.subscriptions.renew("subscriber");
    await entered;
    await sdk.subscriptions.cancel("subscriber", { immediately: true });
    release();
    await expect(collection).rejects.toThrow("Stale settlement");
    const current = await database.subscriptions.findById(subscription.id);
    expect(current!.status).toBe("canceled");
    expect(current!.currentPeriodEnd).toEqual(subscription.currentPeriodEnd);
    expect(await database.invoices.findBySubscription(subscription.id)).toHaveLength(0);
    expect(charges(adapter)).toHaveLength(1);
    const purchaseKey = charges(adapter)[0]!.metadata!.purchaseKey!;
    const recovery = await sdk.subscriptions.reconcilePayment("subscriber", purchaseKey);
    expect(recovery.state).toBe("requires_review");
    expect((await database.subscriptions.findById(subscription.id))!.status).toBe("canceled");
    expect(charges(adapter)).toHaveLength(1);
  });

  it("settlement after a voluntary pause cannot remove the pause or grant an upgrade", async () => {
    const { sdk, adapter, database, subscription, plan } = await fixture();
    const target = await database.plans.create({ name: "Upgrade", price: 200, currency: "SAR", interval: "monthly" });
    const quote = await sdk.subscriptions.previewChangePlan("subscriber", target.id);
    const { release, entered } = holdCollection(adapter);
    const collection = sdk.subscriptions.changePlan("subscriber", target.id, { quoteId: quote.quoteId });
    await entered;
    await sdk.subscriptions.pause("subscriber");
    release();
    await expect(collection).rejects.toThrow("Stale settlement");
    const current = await database.subscriptions.findById(subscription.id);
    expect(current!.status).toBe("paused");
    expect(current!.planId).toBe(plan.id);
    expect(await database.invoices.findBySubscription(subscription.id)).toHaveLength(0);
  });

  it("different-target simultaneous plan changes share a subscription collection lock", async () => {
    const { sdk, adapter, database, subscription } = await fixture();
    const first = await database.plans.create({ name: "First", price: 200, currency: "SAR", interval: "monthly" });
    const second = await database.plans.create({ name: "Second", price: 300, currency: "SAR", interval: "monthly" });
    const firstQuote = await sdk.subscriptions.previewChangePlan("subscriber", first.id);
    const secondQuote = await sdk.subscriptions.previewChangePlan("subscriber", second.id);
    const { release, entered } = holdCollection(adapter);
    const collection = sdk.subscriptions.changePlan("subscriber", first.id, { quoteId: firstQuote.quoteId });
    await entered;
    await expect(sdk.subscriptions.changePlan("subscriber", second.id, { quoteId: secondQuote.quoteId })).rejects.toThrow("unresolved");
    release();
    await collection;
    expect(charges(adapter)).toHaveLength(1);
    expect((await database.subscriptions.findById(subscription.id))!.planId).toBe(first.id);
    expect(await database.invoices.findBySubscription(subscription.id)).toHaveLength(1);
  });

  it("reconciliation cannot settle a different provider payment resource returned by lookup", async () => {
    const { sdk, adapter, database, subscription } = await fixture();
    adapter.queueChargeOutcome("unknown");
    await expect(sdk.subscriptions.renew("subscriber")).rejects.toThrow();
    adapter.getPayment = async () => ({ id: "another-payment", status: "paid", amount: 10000, currency: "SAR" });
    await expect(sdk.subscriptions.renew("subscriber")).rejects.toThrow();
    expect((await database.subscriptions.findById(subscription.id))!.currentPeriodEnd).toEqual(subscription.currentPeriodEnd);
    expect(await database.invoices.findBySubscription(subscription.id)).toHaveLength(0);
    expect(charges(adapter)).toHaveLength(1);
  });

  it("a confirmed-failure retry holds the subscription lock while its provider call is in flight", async () => {
    const { sdk, adapter, database, subscription } = await fixture();
    adapter.queueChargeOutcome("failed");
    await expect(sdk.subscriptions.renew("subscriber")).rejects.toThrow();
    const { release, entered } = holdCollection(adapter);
    const retry = sdk.subscriptions.renew("subscriber", { retryAttempt: 1 });
    await entered;
    const lock = await database.billingOperations!.find(`billing-lock:${subscription.id}`);
    release();
    await retry;
    expect(lock!.status).toBe("collecting");
  });

  it("distinct confirmed failures retain distinct durable outbox identities", async () => {
    const { sdk, adapter, database } = await fixture();
    adapter.queueChargeOutcome("failed");
    adapter.queueChargeOutcome("failed");
    await expect(sdk.subscriptions.renew("subscriber")).rejects.toThrow();
    await sdk.subscriptions.processDunning();
    const events = await database.outbox!.claimPending!(100);
    const failures = events.filter((event) => event.type === "subscription.payment_failed");
    expect(charges(adapter)).toHaveLength(2);
    expect(failures).toHaveLength(2);
    expect(new Set(failures.map((event) => event.id)).size).toBe(2);
  });

  it("delayed failure of an older purchase cannot revoke a newer period or release its collection lock", async () => {
    const { sdk, adapter, database, subscription } = await fixture();
    adapter.queueChargeOutcome("failed");
    await expect(sdk.subscriptions.renew("subscriber")).rejects.toThrow();
    const oldCharge = charges(adapter)[0]!;
    const oldAttempt = await database.billingOperations!.find(oldCharge.metadata!.paymentAttemptKey!);
    const oldPayment = oldAttempt!.payload.result as { id: string };
    await sdk.subscriptions.renewAdministrative("subscriber", { policy: "complimentary" });
    const target = await database.plans.create({ name: "New purchase", price: 200, currency: "SAR", interval: "monthly" });
    const quote = await sdk.subscriptions.previewChangePlan("subscriber", target.id);
    const { release, entered } = holdCollection(adapter);
    const collection = sdk.subscriptions.changePlan("subscriber", target.id, { quoteId: quote.quoteId });
    await entered;
    try {
      await sdk.handleWebhook("fake-test", JSON.stringify({ type: "payment.failed", data: {
        id: oldPayment.id, amount: oldCharge.amount, currency: oldCharge.currency, metadata: oldCharge.metadata,
      } }), "");
    } catch { /* Rejecting a stale provider event is also safe. */ }
    const current = await database.subscriptions.findById(subscription.id);
    const lock = await database.billingOperations!.find(`billing-lock:${subscription.id}`);
    release();
    const completed = await Promise.allSettled([collection]);
    expect(current!.status).toBe("active");
    expect(lock!.status).toBe("collecting");
    expect(completed[0]!.status).toBe("fulfilled");
  });

  it("server reconciliation verifies ownership, applies one paid resource, and relays its durable invoice event", async () => {
    const { sdk, adapter, database, subscription } = await fixture();
    adapter.queueChargeOutcome("unknown");
    await expect(sdk.subscriptions.renew("subscriber")).rejects.toThrow();
    const charge = charges(adapter)[0]!;
    const attempt = await database.billingOperations!.find(charge.metadata!.paymentAttemptKey!);
    const paymentId = (attempt!.payload.result as { id: string }).id;
    adapter.setPayment({ id: paymentId, status: "paid", amount: charge.amount, currency: charge.currency, metadata: charge.metadata });
    const events: { id: string; type: string }[] = [];
    const wrapped = withEvents(sdk, { emit: (event) => { events.push(event); } });
    await expect(wrapped.subscriptions.reconcilePayment("another-subscriber", charge.metadata!.purchaseKey!)).rejects.toThrow("does not belong");
    const reconciled = await wrapped.subscriptions.reconcilePayment("subscriber", charge.metadata!.purchaseKey!);
    expect(reconciled.state).toBe("applied");
    expect(reconciled.paymentId).toBe(paymentId);
    expect(typeof reconciled.invoiceId).toBe("string");
    expect(charges(adapter)).toHaveLength(1);
    expect(await database.invoices.findBySubscription(subscription.id)).toHaveLength(1);
    expect(events.filter((event) => event.type === "invoice.paid")).toHaveLength(1);
    const repeated = await wrapped.subscriptions.reconcilePayment("subscriber", charge.metadata!.purchaseKey!);
    expect(repeated.state).toBe("applied");
    expect(events.filter((event) => event.type === "invoice.paid")).toHaveLength(1);
    expect(charges(adapter)).toHaveLength(1);
  });

  it("reconciliation of a failed resource with mismatched money does not authorize another collection", async () => {
    const { sdk, adapter, database } = await fixture("past_due");
    adapter.queueChargeOutcome("unknown");
    await expect(sdk.subscriptions.renew("subscriber")).rejects.toThrow();
    const charge = charges(adapter)[0]!;
    const attemptKey = charge.metadata!.paymentAttemptKey!;
    const attempt = await database.billingOperations!.find(attemptKey);
    const paymentId = (attempt!.payload.result as { id: string }).id;
    adapter.getPayment = async () => ({ id: paymentId, status: "failed", amount: 1, currency: "USD" });
    const recovery = await sdk.subscriptions.reconcilePayment("subscriber", charge.metadata!.purchaseKey!);
    expect(recovery.state).toBe("requires_review");
    expect((await database.billingOperations!.find(attemptKey))!.status).toBe("unknown");
    await sdk.subscriptions.processDunning();
    expect(charges(adapter)).toHaveLength(1);
  });
});
