# Events

The package can emit a typed event for every meaningful subscription lifecycle change. Use events to trigger emails, sync an external CRM/warehouse, feed analytics, or drive application-level side effects without subclassing the services.

Events are opt-in: a plain `createSubscriptions` instance emits nothing.

## The Contract

```ts
interface SubscriptionEvent {
  /** Unique event ID (crypto.randomUUID) */
  id: string;
  /** Event type, e.g. "subscription.created" */
  type: string;
  /** When the event occurred */
  occurredAt: Date;
  /** The subscriber the event relates to, when applicable */
  subscriberId?: string;
  /** Event-specific payload */
  data: Record<string, unknown>;
}

interface EventsAdapter {
  emit(event: SubscriptionEvent): Promise<void> | void;
}
```

An `EventsAdapter` receives every event exactly as the service layer produced it. Events are emitted only after an operation completes successfully, and delivery is fire-and-forget: `emit` failures are reported via `options.onError` (or silently swallowed) and never roll back the underlying operation. For guaranteed delivery, use the outbox adapter below.

## `withEvents`

Wrap an existing subscriptions instance to start emitting:

```ts
import { createSubscriptions, withEvents } from "@abshahin/subscriptions";
// `withEvents` and the event types are also exported from
// "@abshahin/subscriptions/core/events"

const subs = createSubscriptions({ database, features });

const subsWithEvents = withEvents(subs, {
  async emit(event) {
    await fetch("https://hooks.example.com/billing", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
  },
});
```

`withEvents(subs, adapter, options?)` accepts an optional third argument:

```ts
interface WithEventsOptions {
  /** Called when emitting an event fails (defaults to silently swallowing) */
  onError?: (error: unknown, event: SubscriptionEvent) => void;
  /**
   * Payment provider for the wrapped `handleWebhookRequest`. When provided,
   * Request-based webhooks also emit events; when omitted, the original
   * `handleWebhookRequest` is passed through unchanged.
   */
  webhookProvider?: string;
  /** Signature header used with `webhookProvider` (default "x-signature") */
  webhookSignatureHeader?: string;
}
```

The wrapper has the exact same `Subscriptions<TFeatures>` shape — services, convenience methods, and `handleWebhook` — so you can pass it anywhere the unwrapped instance goes. The original instance is left untouched; the wrapper is a shallow copy with wrapped methods attached.

## Event Types

| Type | Emitted when | `data` highlights |
| --- | --- | --- |
| `plan.created` | A plan is created | `planId`, `name` |
| `plan.updated` | A plan is updated | `planId`, `name` |
| `plan.deleted` | A plan is deleted | `planId` |
| `subscription.created` | A subscription is created | `subscriptionId`, `planId`, `status` |
| `subscription.renewed` | A renewal succeeds | `subscriptionId`, `planId`, `currentPeriodEnd` |
| `subscription.plan_changed` | An upgrade/downgrade completes | `subscriptionId`, `newPlanId` |
| `subscription.canceled` | `cancel()` runs, or a gateway `customer.subscription.deleted` webhook arrives | `subscriptionId`, `immediately` |
| `subscription.payment_failed` | A payment failure is recorded | `subscriptionId`, `message` |
| `usage.limit_reached` | `permissions.use()` consumes the last unit of a limited feature | `feature`, `used`, `limit` |
| `invoice.paid` | `invoices.markPaid()` runs, or a gateway `payment.paid` webhook arrives | `invoiceId`, `amount`, `currency` (markPaid) or `gatewayInvoiceId` (webhook) |

`SubscriptionEvent.type` is a plain `string`, so custom adapters may emit their own event names; the `SubscriptionEventType` union documents the names the SDK itself produces. `subscriberId` is set whenever the operation is subscriber-scoped.

## Outbox Adapter (Guaranteed Delivery)

In-process `emit` is fire-and-forget. If the process dies between the state change and your webhook call, the event is lost. The outbox adapter fixes this by persisting every event to a store you control — typically the same database (and ideally the same transaction) as the billing operation — and letting a separate relay deliver it.

You implement the `OutboxStore` contract against your own table:

```ts
interface OutboxStore {
  /** Persist an event for later relay (required) */
  insert(record: OutboxRecord): Promise<void>;
  /** Claim up to `limit` pending events for relay (needed for `relayOutbox`) */
  claimPending?(limit?: number): Promise<OutboxRecord[]>;
  /** Mark a claimed event as delivered */
  markSent?(id: string): Promise<void>;
}

// OutboxRecord has the same shape as SubscriptionEvent;
// your table may add bookkeeping columns (status, attempts, ...) on top.
```

Then plug the store into the event flow and run a relay on any schedule your platform offers (cron, Cron Trigger, queue consumer):

```ts
import {
  withEvents,
  createOutboxEventsAdapter,
  relayOutbox,
} from "@abshahin/subscriptions";
// Also available from "@abshahin/subscriptions/core/events" (withEvents)
// — the outbox helpers ship in the main entry point.

const subsWithEvents = withEvents(subs, createOutboxEventsAdapter(store));

// Delivers pending events to a target adapter and marks them sent.
const result = await relayOutbox(store, {
  emit: (event) => queue.publish(event.type, event),
});

console.log(result.claimed, result.sent, result.failed);
```

`relayOutbox(store, target, options?)` accepts `{ limit = 100, onError }` and returns `{ claimed, sent, failed }`.

Guidelines:

- The relay is at-least-once: make downstream consumers idempotent (key on `event.id`).
- A failed delivery leaves the event pending; it is retried on the next relay run.
- `relayOutbox` requires the store to implement `claimPending`. A store with only `insert` still records events for an external relay (a CDC pipeline, or a cron worker querying the table directly).
- Implement `claimPending` with row locking where your database supports it (e.g. `FOR UPDATE SKIP LOCKED` in Postgres) so concurrent relayers do not pick up the same events.
