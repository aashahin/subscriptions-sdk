// file: packages/subscriptions/src/core/events.ts
// Event system for the subscriptions package

import type { Subscriptions } from "../index.js";
import type { FeatureRegistry } from "./types.js";

// ==================== Event Types ====================

/**
 * Well-known event names emitted by {@link withEvents}.
 *
 * The {@link SubscriptionEvent.type} field is a plain `string` so custom
 * adapters may emit their own event names; this union documents the names the
 * SDK itself produces.
 */
export type SubscriptionEventType =
    | 'subscription.created'
    | 'subscription.renewed'
    | 'subscription.canceled'
    | 'subscription.plan_changed'
    | 'subscription.payment_failed'
    | 'usage.limit_reached'
    | 'invoice.paid'
    | 'plan.created'
    | 'plan.updated'
    | 'plan.deleted';

/**
 * A single domain event emitted after a successful mutating operation.
 */
export interface SubscriptionEvent {
    /**
     * Unique event id (UUID v4)
     */
    id: string;

    /**
     * Event name (see {@link SubscriptionEventType} for well-known names)
     */
    type: string;

    /**
     * When the event occurred
     */
    occurredAt: Date;

    /**
     * Subscriber the event relates to, when applicable
     */
    subscriberId?: string;

    /**
     * Event payload
     */
    data: Record<string, unknown>;
}

// ==================== Adapter ====================

/**
 * Sink for subscription events.
 *
 * Implementations may deliver events synchronously or asynchronously; a
 * rejected promise or thrown error is treated as an emit failure (and, inside
 * {@link withEvents}, is swallowed so it never breaks the underlying
 * operation).
 */
export interface EventsAdapter {
    emit(event: SubscriptionEvent): Promise<void> | void;
}

/**
 * No-op events adapter that silently discards all events.
 */
export const noopEventsAdapter: EventsAdapter = {
    emit: () => {},
};

// ==================== withEvents wrapper ====================

/**
 * Options for {@link withEvents}
 */
export interface WithEventsOptions {
    /**
     * Called when emitting an event fails. Defaults to silently swallowing the
     * error so event delivery never breaks billing operations.
     */
    onError?: (error: unknown, event: SubscriptionEvent) => void;

    /**
     * Payment provider name used by the wrapped `handleWebhookRequest`.
     *
     * When provided, `handleWebhookRequest` is re-implemented on top of the
     * wrapped `handleWebhook` (so Request-based webhooks also emit events),
     * mirroring the signature-header extraction of the original instance.
     * When omitted, the original `handleWebhookRequest` is passed through
     * unchanged and Request-based webhooks do NOT emit events.
     */
    webhookProvider?: string;

    /**
     * Header carrying the webhook signature for the wrapped
     * `handleWebhookRequest`. Only used together with `webhookProvider`.
     * @default 'x-signature'
     */
    webhookSignatureHeader?: string;
}

/**
 * Create an event with a fresh UUID and timestamp.
 */
function createEvent(
    type: string,
    data: Record<string, unknown>,
    subscriberId?: string,
): SubscriptionEvent {
    return {
        id: crypto.randomUUID(),
        type,
        occurredAt: new Date(),
        ...(subscriberId !== undefined && { subscriberId }),
        data,
    };
}

/**
 * Emit an event, never throwing. Emit failures are reported via `onError`
 * (if provided) and otherwise swallowed.
 */
function safeEmit(
    adapter: EventsAdapter,
    event: SubscriptionEvent,
    onError?: (error: unknown, event: SubscriptionEvent) => void,
): void {
    try {
        Promise.resolve(adapter.emit(event)).catch((error) => {
            onError?.(error, event);
        });
    } catch (error) {
        onError?.(error, event);
    }
}

/**
 * Wrap an async method so an event is emitted after it resolves successfully.
 * The event is never emitted when the method throws, and emit failures never
 * propagate to the caller.
 */
function wrapEmitting<Args extends unknown[], Result>(
    fn: (...args: Args) => Promise<Result>,
    buildEvents: (result: Result, args: Args) => SubscriptionEvent[],
    adapter: EventsAdapter,
    onError?: (error: unknown, event: SubscriptionEvent) => void,
): (...args: Args) => Promise<Result> {
    return async (...args: Args): Promise<Result> => {
        const result = await fn(...args);
        for (const event of buildEvents(result, args)) {
            safeEmit(adapter, event, onError);
        }
        return result;
    };
}

/**
 * Shallow-copy a service instance so wrapped methods can be attached as own
 * properties without mutating the original service.
 */
function cloneService<T extends object>(service: T): T {
    return Object.assign(Object.create(Object.getPrototypeOf(service)), service);
}

/**
 * Wrap a subscriptions instance so its key mutating operations emit events.
 *
 * The returned instance is a shallow copy: the original instance and its
 * services are left untouched. Events are emitted only after an operation
 * completes successfully — never when it throws — and event delivery failures
 * never break the operation itself.
 *
 * Emitted events:
 * - `plan.created` / `plan.updated` / `plan.deleted` — plans service
 * - `subscription.created` / `subscription.canceled` / `subscription.renewed` /
 *   `subscription.plan_changed` / `subscription.payment_failed` — subscriptions service
 * - `usage.limit_reached` — when `permissions.use()` consumes the last unit of a limited feature
 * - `invoice.paid` — `invoices.markPaid()` and paid webhook events
 *
 * @example
 * ```typescript
 * const subs = withEvents(createSubscriptions(config), {
 *   emit: (event) => queue.publish(event.type, event),
 * });
 * ```
 */
export function withEvents<TFeatures extends FeatureRegistry>(
    subs: Subscriptions<TFeatures>,
    adapter: EventsAdapter,
    options?: WithEventsOptions,
): Subscriptions<TFeatures> {
    const onError = options?.onError;

    const plans = cloneService(subs.plans);
    const subscriptions = cloneService(subs.subscriptions);
    const permissions = cloneService(subs.permissions);
    const invoices = cloneService(subs.invoices);

    // ---- Plans ----

    const createPlan = subs.plans.create.bind(subs.plans);
    plans.create = wrapEmitting(
        createPlan,
        (plan) => [
            createEvent('plan.created', { planId: plan.id, name: plan.name }),
        ],
        adapter,
        onError,
    );

    const updatePlan = subs.plans.update.bind(subs.plans);
    plans.update = wrapEmitting(
        updatePlan,
        (plan) => [
            createEvent('plan.updated', { planId: plan.id, name: plan.name }),
        ],
        adapter,
        onError,
    );

    const deletePlan = subs.plans.delete.bind(subs.plans);
    plans.delete = wrapEmitting(
        deletePlan,
        (_result, [id]) => [createEvent('plan.deleted', { planId: id })],
        adapter,
        onError,
    );

    // ---- Subscriptions ----

    const createSubscription = subs.subscriptions.create.bind(subs.subscriptions);
    subscriptions.create = wrapEmitting(
        createSubscription,
        (subscription, [subscriberId, planId]) => [
            createEvent(
                'subscription.created',
                {
                    subscriptionId: subscription.id,
                    planId,
                    status: subscription.status,
                },
                subscriberId,
            ),
        ],
        adapter,
        onError,
    );

    const cancelSubscription = subs.subscriptions.cancel.bind(subs.subscriptions);
    subscriptions.cancel = wrapEmitting(
        cancelSubscription,
        (subscription, [subscriberId, cancelOptions]) => [
            createEvent(
                'subscription.canceled',
                {
                    subscriptionId: subscription.id,
                    immediately: cancelOptions?.immediately === true,
                },
                subscriberId,
            ),
        ],
        adapter,
        onError,
    );

    const renewSubscription = subs.subscriptions.renew.bind(subs.subscriptions);
    subscriptions.renew = wrapEmitting(
        renewSubscription,
        (subscription, [subscriberId]) => [
            createEvent(
                'subscription.renewed',
                {
                    subscriptionId: subscription.id,
                    planId: subscription.planId,
                    currentPeriodEnd: subscription.currentPeriodEnd,
                },
                subscriberId,
            ),
        ],
        adapter,
        onError,
    );

    const changePlan = subs.subscriptions.changePlan.bind(subs.subscriptions);
    subscriptions.changePlan = wrapEmitting(
        changePlan,
        (result, [subscriberId, newPlanId]) => [
            createEvent(
                'subscription.plan_changed',
                {
                    subscriptionId: result.subscription.id,
                    newPlanId,
                },
                subscriberId,
            ),
        ],
        adapter,
        onError,
    );

    const recordPaymentFailure = subs.subscriptions.recordPaymentFailure.bind(
        subs.subscriptions,
    );
    subscriptions.recordPaymentFailure = wrapEmitting(
        recordPaymentFailure,
        (subscription, [subscriberId, message]) =>
            subscription
                ? [
                      createEvent(
                          'subscription.payment_failed',
                          {
                              subscriptionId: subscription.id,
                              message,
                          },
                          subscriberId,
                      ),
                  ]
                : [],
        adapter,
        onError,
    );

    // ---- Permissions ----

    const use = subs.permissions.use.bind(subs.permissions);
    permissions.use = wrapEmitting(
        use,
        (status, [subscriberId]) =>
            !status.unlimited && status.remaining === 0
                ? [
                      createEvent(
                          'usage.limit_reached',
                          {
                              feature: status.feature,
                              used: status.used,
                              limit: status.limit,
                          },
                          subscriberId,
                      ),
                  ]
                : [],
        adapter,
        onError,
    );

    // ---- Invoices ----

    const markPaid = subs.invoices.markPaid.bind(subs.invoices);
    invoices.markPaid = wrapEmitting(
        markPaid,
        (invoice) => [
            createEvent(
                'invoice.paid',
                {
                    invoiceId: invoice.id,
                    amount: invoice.amount,
                    currency: invoice.currency,
                },
                invoice.subscriberId,
            ),
        ],
        adapter,
        onError,
    );

    // ---- Instance ----

    const handleWebhook = subs.handleWebhook.bind(subs);
    const wrappedHandleWebhook: Subscriptions<TFeatures>['handleWebhook'] = async (
        provider,
        payload,
        signature,
    ) => {
        const event = await handleWebhook(provider, payload, signature);
        const data = event.data as Record<string, unknown>;
        const metadata = data.metadata as Record<string, string> | undefined;
        const subscriberId = metadata?.subscriberId ?? metadata?.tenantId;

        switch (event.type) {
            case 'payment.paid':
                safeEmit(
                    adapter,
                    createEvent(
                        'invoice.paid',
                        {
                            gatewayEventType: event.type,
                            ...(typeof data.id === 'string' && {
                                gatewayInvoiceId: data.id,
                            }),
                        },
                        subscriberId,
                    ),
                    onError,
                );
                break;

            case 'payment.failed':
            case 'invoice.payment_failed':
                safeEmit(
                    adapter,
                    createEvent(
                        'subscription.payment_failed',
                        {
                            gatewayEventType: event.type,
                            ...(typeof data.message === 'string' && {
                                message: data.message,
                            }),
                        },
                        subscriberId,
                    ),
                    onError,
                );
                break;

            case 'customer.subscription.deleted':
                safeEmit(
                    adapter,
                    createEvent(
                        'subscription.canceled',
                        { gatewayEventType: event.type, immediately: true },
                        subscriberId,
                    ),
                    onError,
                );
                break;
        }

        return event;
    };

    // When a provider is configured, re-implement the web-standard webhook
    // handler on top of the wrapped handleWebhook so Request-based webhooks
    // emit the same events. Otherwise pass the original through unchanged.
    const wrappedHandleWebhookRequest: Subscriptions<TFeatures>['handleWebhookRequest'] =
        options?.webhookProvider
            ? async (request) => {
                  const json = (data: unknown, status: number): Response =>
                      new Response(JSON.stringify(data), {
                          status,
                          headers: { 'Content-Type': 'application/json' },
                      });

                  const body = await request.text();
                  const signatureHeader =
                      options.webhookSignatureHeader ?? 'x-signature';
                  const signature =
                      request.headers.get(signatureHeader) ??
                      request.headers.get('x-moyasar-signature') ??
                      request.headers.get('stripe-signature') ??
                      request.headers.get('x-webhook-signature');

                  if (!signature) {
                      return json({ error: 'Missing webhook signature' }, 400);
                  }

                  try {
                      const event = await wrappedHandleWebhook(
                          options.webhookProvider as string,
                          body,
                          signature,
                      );
                      return json({ received: true, eventId: event.id }, 200);
                  } catch (error) {
                      const message =
                          error instanceof Error
                              ? error.message
                              : 'Webhook handling failed';
                      const isVerificationFailure =
                          /signature|verification|invalid (webhook|payload)|unknown payment provider/i.test(
                              message,
                          );
                      return json(
                          { error: message },
                          isVerificationFailure ? 400 : 500,
                      );
                  }
              }
            : subs.handleWebhookRequest.bind(subs);

    return {
        plans,
        subscriptions,
        permissions,
        invoices,
        // Coupons pass through unwrapped (no coupon events are emitted yet)
        coupons: subs.coupons,

        // Convenience methods delegate to the wrapped services
        can: (subscriberId, feature) => permissions.can(subscriberId, feature),
        remaining: (subscriberId, feature) =>
            permissions.remaining(subscriberId, feature),
        use: (subscriberId, feature, count) =>
            permissions.use(subscriberId, feature, count),
        release: (subscriberId, feature, count) =>
            permissions.release(subscriberId, feature, count),

        handleWebhook: wrappedHandleWebhook,
        handleWebhookRequest: wrappedHandleWebhookRequest,
    };
}
