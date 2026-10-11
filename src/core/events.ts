import type { Subscriptions } from '../index.js';
import type { FeatureRegistry } from './types.js';
import { relayOutbox } from '../adapters/outbox.adapter.js';
export type SubscriptionEventType = 'subscription.created' | 'subscription.renewed' | 'subscription.canceled' | 'subscription.plan_changed' | 'subscription.payment_failed' | 'subscription.paused' | 'subscription.resumed' | 'subscription.reactivated' | 'subscription.suspended' | 'subscription.updated' | 'usage.limit_reached' | 'invoice.paid' | 'plan.created' | 'plan.updated' | 'plan.deleted';
export interface SubscriptionEvent {
    /** Stable logical identity. Consumers must deduplicate at-least-once delivery by this ID. */
    id: string;
    type: string;
    occurredAt: Date;
    subscriberId?: string;
    data: Record<string, unknown>;
}
export interface EventsAdapter {
    emit(event: SubscriptionEvent): Promise<void> | void;
}
export const noopEventsAdapter: EventsAdapter = { emit: () => { } };
export interface WithEventsOptions {
    onError?: (error: unknown, event: SubscriptionEvent) => void;
    /** Deprecated: the underlying Request handler already uses the configured provider and raw headers. */
    webhookProvider?: string;
    webhookSignatureHeader?: string;
}
/**
 * Deliver already persisted events after mutations. Business methods write the
 * outbox inside their local transaction; this wrapper never invents events from
 * incoming webhook types. A failed delivery retains the same durable identity.
 * Run relayOutbox on startup/on your existing scheduler to recover after crashes.
 */
export function withEvents<TFeatures extends FeatureRegistry>(subs: Subscriptions<TFeatures>, adapter: EventsAdapter, options?: WithEventsOptions): Subscriptions<TFeatures> {
    const outbox = subs.eventOutbox;
    if (!outbox?.claimPending || !outbox.markSent)
        throw new Error('withEvents requires a transaction-owned durable outbox with claimPending and markSent; migrate your database adapter');
    const deliver = async () => { await relayOutbox(outbox, adapter, { ...(options?.onError ? { onError: options.onError } : {}) }); };
    const wrapService = <T extends object>(service: T, methods: string[]): T => {
        const copy = Object.assign(Object.create(Object.getPrototypeOf(service)), service);
        for (const name of methods) {
            const original = (service as Record<string, unknown>)[name];
            if (typeof original !== 'function')
                continue;
            copy[name] = async (...args: unknown[]) => { const result = await original.apply(service, args); await deliver(); return result; };
        }
        return copy;
    };
    const plans = wrapService(subs.plans, ['create', 'update', 'delete', 'duplicate']);
    const subscriptions = wrapService(subs.subscriptions, ['create', 'createSelfService', 'changePlan', 'renew', 'renewAdministrative', 'reconcilePayment', 'cancel', 'pause', 'resume', 'reactivate', 'recordPaymentFailure', 'startTrial', 'extendTrial', 'processDunning']);
    const permissions = wrapService(subs.permissions, ['use']);
    const invoices = wrapService(subs.invoices, ['create', 'markPaid']);
    return { ...subs, plans, subscriptions, permissions, invoices,
        can: (id, feature) => permissions.can(id, feature), remaining: (id, feature) => permissions.remaining(id, feature),
        use: (id, feature, count) => permissions.use(id, feature, count), release: (id, feature, count) => permissions.release(id, feature, count),
        handleWebhook: async (...args) => { const event = await subs.handleWebhook(...args); await deliver(); return event; },
        handleWebhookRequest: async (request) => { const response = await subs.handleWebhookRequest(request); if (response.ok)
            await deliver(); return response; },
    };
}
