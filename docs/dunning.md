# Dunning

Dunning is the process of recovering failed renewal payments: retry the charge on a schedule, and if it keeps failing, take a final action on the subscription.

## Configuration

Dunning is configured per instance through `options.dunning`:

```ts
import { createSubscriptions } from "@abshahin/subscriptions";

const subs = createSubscriptions({
  database,
  features,
  providers: [{
    id: "moyasar-sa-test",
    accountId: "your-account-identity",
    environment: "test",
    billingOwner: "sdk_managed",
    adapter: payment,
  }],
  defaultProvider: "moyasar-sa-test",
  options: {
    gracePeriodDays: 3,
    dunning: {
      /**
       * Days after the first failure on which to retry the saved payment
       * method. Length = number of retries. Example: retry on day 1, 3, and 7.
       */
      retryScheduleDays: [1, 3, 7],

      /**
       * What to do when all retries are exhausted:
       * - "pause": pause the subscription (access stops, state is preserved)
       * - "cancel": cancel the subscription immediately
       * - "none": leave the subscription past-due (you handle it yourself)
       */
      action: "pause",
    },
  },
});
```

If `options.dunning` is omitted, the defaults are `{ retryScheduleDays: [1, 3, 5, 7], action: "none" }` — retries still run when you call `processDunning()`, but no terminal action is applied when the schedule is exhausted (the subscription stays `past_due`). Nothing runs on its own either way: dunning is driven externally via `processDunning()`.

Local collection requires an adapter with real awaited transactions, durable billing-operation records, and a transaction-owned outbox, plus a gateway supporting idempotent direct payment charges. Each subscription must persist its provider/account/environment association, `billingOwner: "sdk_managed"`, and a separate reusable payment method ID. Legacy generic customer/subscription IDs are insufficient and require an explicit backfill. Provider-managed subscriptions (including a future Polar/Creem integration) are excluded from local renewal collection and dunning.

## `processDunning()`

`processDunning()` is the sweep that executes the schedule. Call it from whatever scheduler your platform provides — node-cron, a Bun cron, `setInterval`, or a Cloudflare Workers `scheduled()` handler:

```ts
const results = await subs.subscriptions.processDunning();
// DunningProcessResult[] — one entry per past-due subscription processed:
// {
//   subscriberId: string,
//   subscriptionId: string,
//   attempts: number,        // total retry attempts recorded after this run
//   exhausted: boolean,      // retry schedule exhausted
//   recovered: boolean,      // a retry charge succeeded (subscription renewed)
//   actionApplied: "pause" | "cancel" | "none",
// }
```

`processDunning(now?)` accepts an optional reference time (defaults to now), which is handy for testing the schedule:

1. Finds SDK-managed `past_due` subscriptions with a recorded renewal failure. A confirmed failure from `renew()` or a verified payment event enrolls the failed period in a recovery cycle; a failed optional upgrade preserves the already paid current period.
2. Checks confirmed failed retries against `retryScheduleDays`. Collection uses a durable attempt and stable provider idempotency key. A pending, authorized, or unknown payment does not consume a confirmed failed retry and must be reconciled before further collection.
3. Uses one persisted renewal quote for the charged amount, selected plan (including a pending downgrade), currency, period, and invoice. Settlement clears the failed cycle and retry metadata through direct collection and verified external completion alike.
4. On the final confirmed failed retry, applies `action` (`pause`, `cancel`, or `none`). A payment suspension revokes access; it supplies no paid pause credit and cannot be cleared with ordinary `resume()`.

Cloudflare Workers example:

```ts
export default {
  async scheduled(event, env, ctx) {
    const subs = buildSubscriptions(env);
    ctx.waitUntil(subs.subscriptions.processDunning());
  },
};
```

Deliver the transactionally persisted outbox events to notify customers on `subscription.payment_failed` and `subscription.suspended`. Notification delivery must not recollect the payment or replay the business mutation.

## Manual Lifecycle Controls

The same building blocks dunning uses are available for support tooling and customer-facing flows.

### `pause()` / `resume()`

```ts
// Access stops immediately; billing state is preserved.
await subs.subscriptions.pause(subscriberId);

// Restore the prior active/trialing state after a voluntary pause.
await subs.subscriptions.resume(subscriberId);
```

Voluntary SDK-managed pauses preserve the previous state. Resume extends the existing period by the voluntary pause duration; a paused trial remains `trialing`, and its trial end moves with the period. It does not create paid credit for an unpaid trial or manufacture a new paid period when pause metadata is absent. A suspension caused by payment failure requires settlement and cannot use this path.

For provider-managed subscriptions, pause, resume, cancellation, and reactivation issue the command to the owning provider first. Unsupported commands fail explicitly. Provider periods remain authoritative and are not extended from local processing time. Incoming verified provider snapshots update local state without issuing another outgoing provider command.

### `extendTrial()`

```ts
// Give a trialing subscriber 7 more days.
await subs.subscriptions.extendTrial(subscriberId, 7);
```

### `cancel()` with a reason

```ts
await subs.subscriptions.cancel(subscriberId, {
  immediately: false,          // cancel at period end
  reason: "too_expensive",     // stored on the subscription and emitted
});
```

`reason` is a free-form string, persisted as `metadata.cancelReason` for support reporting. To undo a scheduled cancellation while the period is still eligible, call `reactivate()`; provider-managed subscriptions must support remote reactivation before the SDK clears the local cancellation.

`executePendingChanges()` no longer grants a scheduled target plan before payment: the pending change is applied by renewal together with its persisted quote and settlement. It returns no standalone changes. Replace schedulers that depended on that method with the due-renewal flow.
