# Audit Logging

Enterprise deployments usually need an append-only record of who changed what in the billing system: plan edits by admins, subscription changes by customers, cancellations by dunning. The package provides an audit log adapter contract and a factory that turns every subscription event into an audit record. Everything lives in the `@abshahin/subscriptions/audit` subpath.

The audit logger is an `EventsAdapter`: it plugs into the event bus from `withEvents` (see `events.md`), so anything that emits an event is audited. Operations that emit no event (e.g. `pause()`/`resume()`, which currently emit none) produce no audit record.

## The Contract

```ts
interface AuditRecord {
  id: string;
  /** Who did it (admin user ID, API key ID); omitted for system actions */
  actorId?: string;
  /** What happened, e.g. "plan.updated", "subscription.canceled" */
  action: string;
  /** Entity kind and ID, e.g. "plan" / "plan_123" */
  entityType: string;
  entityId: string;
  /** Snapshot of the entity before the action (if available) */
  before?: unknown;
  /** Snapshot of the entity after the action (if available) */
  after?: unknown;
  occurredAt: Date;
  /** Free-form extra context (request id, tenant id, ip, ...) */
  metadata?: Record<string, unknown>;
}

interface AuditLogAdapter {
  /** Append a record; the log is append-only */
  append(record: AuditRecord): Promise<void>;
  /** Optional query support (most recent first) */
  list?(filter: AuditFilter): Promise<AuditRecord[]>;
}

interface AuditFilter {
  entityType?: string;
  entityId?: string;
  limit?: number;
  offset?: number;
}
```

Implement `AuditLogAdapter` against your own storage (database table, log service, data warehouse). `list` is optional — omit it if the backing store does not support querying.

## `createAuditLogger`

Wrap any `AuditLogAdapter` to get an `EventsAdapter` you pass to `withEvents`:

```ts
import { createSubscriptions, withEvents } from "@abshahin/subscriptions";
import { createAuditLogger } from "@abshahin/subscriptions/audit";

const auditLogger = createAuditLogger({
  async append(record) {
    // Ship records wherever your compliance stack lives:
    await db.insertInto("audit_log").values(record);
  },
});

const subs = withEvents(createSubscriptions({ database, features }), auditLogger);
```

To audit *and* forward events elsewhere, compose adapters — e.g. emit to both your audit logger and a queue publisher from a single `emit`, or persist through the outbox adapter and relay to both (see `events.md`).

Every event becomes one audit record:

| `AuditRecord` field | Source |
| --- | --- |
| `id` | `event.id` |
| `actorId` | `options.actorId` (static value or derived from the event) |
| `action` | `event.type` (e.g. `subscription.created`) |
| `entityType` | prefix of `event.type` before the first `.` (e.g. `subscription`) |
| `entityId` | `event.data.id` ?? `event.subscriberId` ?? `"unknown"` |
| `after` | `event.data` |
| `occurredAt` | `event.occurredAt` |

`before` and `metadata` are left unset — events carry no prior snapshot. Append failures are swallowed and logged to `console.error`, so a broken audit sink never takes billing down.

### Actor Attribution

`createAuditLogger(adapter, { actorId })` accepts either a static string applied to every record, or a function deriving the actor from each event:

```ts
const auditLogger = createAuditLogger(adapter, {
  actorId: (event) =>
    typeof event.data.actorId === "string" ? event.data.actorId : undefined,
});
```

Pass the authenticated user through your integration layer (e.g. stash it in a `metadata` field that flows into `event.data`) so admin actions are attributed; system flows (dunning, webhooks) record no actor by default.

## `memoryAuditLogAdapter`

An in-memory adapter for tests and local development:

```ts
import { createSubscriptions, withEvents } from "@abshahin/subscriptions";
import { memoryAuditLogAdapter, createAuditLogger } from "@abshahin/subscriptions/audit";
import { memoryDatabaseAdapter } from "@abshahin/subscriptions/testing";

const auditAdapter = memoryAuditLogAdapter();
const subs = withEvents(
  createSubscriptions({ database: memoryDatabaseAdapter(), features }),
  createAuditLogger(auditAdapter),
);

await subs.subscriptions.cancel("tenant_1", { reason: "test" });

const entries = await auditAdapter.list!({ entityType: "subscription" });
expect(entries).toHaveLength(1);
expect(entries[0].action).toBe("subscription.canceled");
```

Records are kept in a plain array (newest first in `list()` results) and are lost on restart — not suitable for production.

## Custom Sinks

Because the contract is a single `append` method, common sinks are one-liners:

- **Database table**: insert into an append-only `audit_log` table (use a separate, restricted database role for write-only access).
- **Cloudflare**: write to a Queue, Workers Analytics Engine, or R2 in NDJSON form.
- **SIEM**: forward to Datadog/Splunk/Elastic via their HTTP intake.
- **Compliance**: pair with immutable storage (object-lock buckets, ledger databases) when retention rules apply.

Audit records are plain JSON — keep `after` snapshots and `metadata` free of secrets and payment credentials.
