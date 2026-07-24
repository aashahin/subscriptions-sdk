// file: packages/subscriptions/src/audit/index.ts
// Audit log module for subscriptions package
//
// Maps every subscription event to an audit record so hosts can keep a
// durable, queryable trail of what happened (and to whom).

import type { EventsAdapter, SubscriptionEvent } from "../core/events.js";

export type { EventsAdapter, SubscriptionEvent } from "../core/events.js";

/**
 * A single audit trail entry.
 *
 * Audit records are append-only: they describe an action performed on an
 * entity at a point in time, optionally with before/after snapshots.
 */
export interface AuditRecord {
    /** Unique identifier for this audit entry */
    id: string;
    /** Identifier of the actor who triggered the action (user, admin, API key, system, ...) */
    actorId?: string;
    /** The action performed, e.g. 'subscription.created' */
    action: string;
    /** Kind of entity the action targeted, e.g. 'subscription', 'plan', 'invoice' */
    entityType: string;
    /** Identifier of the entity the action targeted */
    entityId: string;
    /** Snapshot of the entity before the action (if available) */
    before?: unknown;
    /** Snapshot of the entity after the action (if available) */
    after?: unknown;
    /** When the action occurred */
    occurredAt: Date;
    /** Free-form extra context (request id, tenant id, ip, ...) */
    metadata?: Record<string, unknown>;
}

/**
 * Filter for listing audit records.
 */
export interface AuditFilter {
    /** Only records for this entity type */
    entityType?: string;
    /** Only records for this entity id */
    entityId?: string;
    /** Maximum number of records to return */
    limit?: number;
    /** Number of records to skip (for pagination) */
    offset?: number;
}

/**
 * Audit log adapter interface.
 *
 * Implement this interface to persist audit records to your own storage
 * (database table, log service, data warehouse, ...). Append-only by design.
 */
export interface AuditLogAdapter {
    /**
     * Append a record to the audit log. Implementations must not mutate
     * the passed record and should treat the log as append-only.
     */
    append(record: AuditRecord): Promise<void>;

    /**
     * List audit records matching a filter (most recent first).
     * Optional — omit if the backing store does not support querying.
     */
    list?(filter: AuditFilter): Promise<AuditRecord[]>;
}

/**
 * In-memory audit log adapter, for tests and development.
 *
 * Keeps records in a plain array (newest first in `list()` results).
 * Not suitable for production: records are lost on restart and grow
 * unbounded in memory.
 */
export function memoryAuditLogAdapter(): AuditLogAdapter {
    const records: AuditRecord[] = [];
    return {
        async append(record: AuditRecord): Promise<void> {
            records.push(record);
        },
        async list(filter: AuditFilter): Promise<AuditRecord[]> {
            let result = records;
            if (filter.entityType !== undefined) {
                result = result.filter((r) => r.entityType === filter.entityType);
            }
            if (filter.entityId !== undefined) {
                result = result.filter((r) => r.entityId === filter.entityId);
            }
            // Most recent first
            result = [...result].reverse();
            const offset = filter.offset ?? 0;
            const limit = filter.limit ?? result.length;
            return result.slice(offset, offset + limit);
        },
    };
}

/**
 * Options for {@link createAuditLogger}.
 */
export interface AuditLoggerOptions {
    /**
     * Actor attribution for generated audit records:
     * - a static string applied to every record, or
     * - a function deriving the actor id from each event (e.g. from
     *   `event.data.actorId` or a header captured in the event payload).
     *
     * Omit to leave `actorId` unset.
     */
    actorId?: string | ((event: SubscriptionEvent) => string | undefined);
}

/**
 * Create an {@link EventsAdapter} that writes every subscription event to an
 * {@link AuditLogAdapter}. Plug it into the events bus alongside (or instead
 * of) your other listeners.
 *
 * Event → audit record mapping:
 *
 * | AuditRecord field | Source                                                        |
 * |-------------------|---------------------------------------------------------------|
 * | `id`              | `event.id`                                                    |
 * | `actorId`         | `options.actorId` (static value or derived from the event)    |
 * | `action`          | `event.type` (e.g. 'subscription.created')                    |
 * | `entityType`      | prefix of `event.type` before the first '.' (e.g. 'subscription'); falls back to 'unknown' |
 * | `entityId`        | `event.data.id` (stringified) ?? `event.subscriberId` ?? 'unknown' |
 * | `before`          | (unset — events carry no prior snapshot)                      |
 * | `after`           | `event.data`                                                  |
 * | `occurredAt`      | `event.occurredAt`                                            |
 * | `metadata`        | (unset)                                                       |
 *
 * Append failures are swallowed and logged to `console.error` so a broken
 * audit sink never breaks the subscription flow itself.
 */
export function createAuditLogger(
    adapter: AuditLogAdapter,
    options?: AuditLoggerOptions,
): EventsAdapter {
    const resolveActorId = (event: SubscriptionEvent): string | undefined => {
        if (options?.actorId === undefined) return undefined;
        if (typeof options.actorId === 'function') return options.actorId(event);
        return options.actorId;
    };

    return {
        async emit(event: SubscriptionEvent): Promise<void> {
            const actorId = resolveActorId(event);
            const record: AuditRecord = {
                id: event.id,
                ...(actorId !== undefined && { actorId }),
                action: event.type,
                entityType: entityTypeFromEventType(event.type),
                entityId: entityIdFromEvent(event),
                after: event.data,
                occurredAt: event.occurredAt,
            };
            try {
                await adapter.append(record);
            } catch (error) {
                console.error('[subscriptions] failed to append audit record:', error);
            }
        },
    };
}

/**
 * Derive the entity type from an event type like 'subscription.created'.
 * Returns 'unknown' when the type has no usable prefix.
 */
function entityTypeFromEventType(type: string): string {
    const dot = type.indexOf('.');
    const prefix = dot === -1 ? type : type.slice(0, dot);
    return prefix.length > 0 ? prefix : 'unknown';
}

/**
 * Derive the entity id from the event payload, falling back to the
 * subscriber id and finally to 'unknown'.
 */
function entityIdFromEvent(event: SubscriptionEvent): string {
    const id = event.data?.['id'];
    if (typeof id === 'string' && id.length > 0) return id;
    if (typeof id === 'number') return String(id);
    return event.subscriberId ?? 'unknown';
}
