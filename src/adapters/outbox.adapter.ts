// file: packages/subscriptions/src/adapters/outbox.adapter.ts
// Transactional outbox adapter for the subscriptions event system

import type { EventsAdapter, SubscriptionEvent } from "../core/events.js";

// ==================== Outbox Store ====================

/**
 * A persisted event waiting to be relayed.
 *
 * Identical in shape to {@link SubscriptionEvent}; stores may add their own
 * bookkeeping columns (status, attempts, ...) on top of it.
 */
export type OutboxRecord = SubscriptionEvent;

/**
 * Minimal persistence contract for the transactional outbox pattern.
 *
 * Implementations typically write to the same database (and ideally the same
 * transaction) as the billing operation that produced the event, so events are
 * never lost even if the process crashes before delivery.
 *
 * Only `insert` is required — an outbox without `claimPending`/`markSent` can
 * still record events for external relay (e.g. a CDC pipeline or a cron worker
 * querying the table directly).
 */
export interface OutboxStore {
    /**
     * Persist an event for later relay.
     */
    insert(record: OutboxRecord): Promise<void>;

    /**
     * Claim up to `limit` pending events for relay.
     *
     * Implementations should mark claimed rows so concurrent relayers do not
     * pick up the same events (e.g. `FOR UPDATE SKIP LOCKED` in Postgres).
     */
    claimPending?(limit?: number): Promise<OutboxRecord[]>;

    /**
     * Mark a previously claimed event as successfully delivered.
     */
    markSent?(id: string): Promise<void>;
}

// ==================== Outbox Events Adapter ====================

/**
 * Create an {@link EventsAdapter} that persists every event to an
 * {@link OutboxStore} for later relay instead of delivering it immediately.
 *
 * Combine with {@link withEvents} and {@link relayOutbox}:
 *
 * @example
 * ```typescript
 * const subs = withEvents(createSubscriptions(config), createOutboxEventsAdapter(store));
 *
 * // Later, in a cron job / queue worker:
 * await relayOutbox(store, { emit: (e) => queue.publish(e.type, e) });
 * ```
 */
export function createOutboxEventsAdapter(store: OutboxStore): EventsAdapter {
    return {
        emit: (event) => store.insert(event),
    };
}

// ==================== Relay ====================

/**
 * Options for {@link relayOutbox}
 */
export interface RelayOutboxOptions {
    /**
     * Maximum number of events to claim and relay in this run
     * @default 100
     */
    limit?: number;

    /**
     * Called when relaying an individual event fails. The event is left
     * pending so a later relay run can retry it. Defaults to silently
     * skipping the failed event.
     */
    onError?: (error: unknown, record: OutboxRecord) => void;
}

/**
 * Result of a {@link relayOutbox} run
 */
export interface RelayOutboxResult {
    /**
     * Number of events claimed from the store
     */
    claimed: number;

    /**
     * Number of events successfully delivered to the target
     */
    sent: number;

    /**
     * Number of events that failed delivery (left pending for retry)
     */
    failed: number;
}

/**
 * Claim pending events from an outbox store and re-emit them to another
 * {@link EventsAdapter}, marking each as sent on success.
 *
 * Events whose delivery fails are left pending (and never marked sent) so a
 * later relay run retries them. This provides at-least-once delivery: the
 * target adapter must tolerate duplicate events.
 *
 * @throws If the store does not implement `claimPending`
 */
export async function relayOutbox(
    store: OutboxStore,
    target: EventsAdapter,
    options?: RelayOutboxOptions,
): Promise<RelayOutboxResult> {
    if (!store.claimPending) {
        throw new Error(
            "relayOutbox requires the store to implement claimPending(). " +
                "Either add it to your OutboxStore, or relay events with your own worker.",
        );
    }

    const limit = options?.limit ?? 100;
    const onError = options?.onError;

    const records = await store.claimPending(limit);

    let sent = 0;
    let failed = 0;

    for (const record of records) {
        try {
            // Stores may deserialize timestamps as strings — normalize so the
            // target always receives a proper Date.
            const event: SubscriptionEvent = {
                ...record,
                occurredAt:
                    record.occurredAt instanceof Date
                        ? record.occurredAt
                        : new Date(record.occurredAt),
            };
            await target.emit(event);
            await store.markSent?.(record.id);
            sent += 1;
        } catch (error) {
            failed += 1;
            onError?.(error, record);
        }
    }

    return { claimed: records.length, sent, failed };
}
