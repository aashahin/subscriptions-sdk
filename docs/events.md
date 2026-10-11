# Events and durable delivery

Business services persist billing events in `database.outbox` in the same awaited
local transaction as the subscription, invoice, operation, and numbering changes.
An outbox insert failure rolls the business effect back. Network collection occurs
outside the transaction; a saved settlement can be applied again without collecting
again after a local persistence failure.

`withEvents` delivers these persisted records after operations. It requires an
atomic adapter with `claimPending` and `markSent`; it does not manufacture events
from webhook envelopes. Two authenticated deliveries describing the same payment
produce one logical invoice-paid event. `invoices.markPaid` also deduplicates its
already-paid transition.

```ts
import { createSubscriptions, withEvents, relayOutbox } from '@abshahin/subscriptions';

const subscriptions = createSubscriptions({ database, features });
const target = {
  async emit(event) {
    // Persist your consumer's deduplication of event.id with its own effect.
    await queue.publish(event.type, event);
  },
};
const emittingSubscriptions = withEvents(subscriptions, target, {
  onError(error, event) { logger.error({ error, eventId: event.id }); },
});

// Invoke on startup and through an existing scheduler to recover after crashes.
const result = await relayOutbox(subscriptions.eventOutbox!, target, { limit: 100 });
```

The relay provides **at-least-once delivery**, not exactly-once external side
effects. A crash after the consumer accepts an event but before `markSent` can
redeliver the same identity. Shipped stores reclaim a claim after five minutes;
failed deliveries release their claim immediately. Consumers must deduplicate by
`event.id`. There is no new scheduler infrastructure inside the SDK.

Events include `plan.created/updated/deleted`, subscription creation, renewal,
plan changes, cancellation, pause/resume/reactivation, payment failure/suspension,
`usage.limit_reached`, and `invoice.paid`. Payment event identities use scoped
actual payment resources; each confirmed failure uses its persisted attempt key.
A scheduled plan change's event describes its effective date, rather than claiming
that entitlement has already changed.

`SubscriptionEvent` contains `id`, `type`, `occurredAt`, optional `subscriberId`,
and `data`. `EventsAdapter.emit` accepts that record. `OutboxStore` supports
`insert`, optional `claimPending`, `markSent`, and `releaseClaim`. Implement `insert`
with a unique identity and use the transaction's store, not a separate connection.
Claims require lease/locking behavior appropriate to your database.

`createOutboxEventsAdapter(store)` remains a low-level sink for host-owned events.
It does not make a separately committed business mutation atomic with its insert.
Use the SDK's transaction-owned outbox for billing. The old fire-and-forget wrapper
and its envelope-derived webhook events are removed; the wrapper's legacy webhook
options are deprecated because the underlying Request handler already preserves
raw payload and full provider headers.

D1 and unknown Drizzle transaction modes do not support the SDK's durable billing
mutations or `withEvents`. Ordinary driver reads and single-statement quota
operations remain available. See the schema guides for the required migrations.
