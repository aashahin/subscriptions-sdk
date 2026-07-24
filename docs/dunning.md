# Dunning

Dunning is the process of recovering failed renewal payments: retry the charge on a schedule, and if it keeps failing, take a final action on the subscription.

## Configuration

Dunning is configured per instance through `options.dunning`:

```ts
import { createSubscriptions } from "@abshahin/subscriptions";

const subs = createSubscriptions({
  database,
  features,
  payment,
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

`processDunning(now?)` accepts an optional reference time (defaults to now), which is handy for testing the schedule. The sweep is idempotent and safe to run daily (or more often):

1. Finds `past_due` subscriptions with a recorded payment failure (failures are recorded via `recordPaymentFailure`, which the webhook flow calls automatically).
2. For each, checks how many retries have already been attempted against `retryScheduleDays` and attempts the next due retry by charging the saved payment method.
3. On success, renews the subscription and clears the failure state.
4. On the final failed retry, applies `action` (`pause`, `cancel`, or `none`).

Cloudflare Workers example:

```ts
export default {
  async scheduled(event, env, ctx) {
    const subs = buildSubscriptions(env);
    ctx.waitUntil(subs.subscriptions.processDunning());
  },
};
```

Combine with `withEvents` (see `events.md`) to notify customers on each `subscription.payment_failed` and on the final pause/cancel.

## Manual Lifecycle Controls

The same building blocks dunning uses are available for support tooling and customer-facing flows.

### `pause()` / `resume()`

```ts
// Access stops immediately; billing state is preserved.
await subs.subscriptions.pause(subscriberId);

// Billing periods recalculate on resume, even if the subscription would
// have expired while paused.
await subs.subscriptions.resume(subscriberId);
```

Pause is reversible and does not create invoices or touch the gateway unless a payment adapter with `pauseSubscription`/`resumeSubscription` is configured, in which case the gateway is kept in sync.

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

`reason` is a free-form string. Record it for churn analytics — it is persisted on the subscription as `metadata.cancelReason`. Dunning uses the same field when the final action is `cancel` (`reason: "Dunning: payment retry schedule exhausted"`).
