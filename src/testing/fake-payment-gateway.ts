// file: packages/subscriptions/src/testing/fake-payment-gateway.ts
// Fake PaymentGatewayAdapter for tests and local development

import type {
    ChargePaymentInput,
    ChargePaymentResult,
    CheckoutSession,
    CreateCheckoutInput,
    CreateCustomerInput,
    CreateGatewaySubscriptionInput,
    GatewayCustomer,
    GatewaySubscription,
    PaymentGatewayAdapter,
    PortalSession,
    UpdateGatewaySubscriptionInput,
    CancelOptions,
    WebhookEvent,
} from '../adapters/payment.adapter.js';

/**
 * Scriptable charge outcome for the fake gateway:
 * - `'paid'` / `'pending'` / `'failed'` — built-in canned results
 * - a partial {@link ChargePaymentResult} merged over a paid default
 * - a function computing the result from the charge input
 */
export type FakeChargeOutcome =
    | 'paid'
    | 'pending'
    | 'failed'
    | Partial<ChargePaymentResult>
    | ((input: ChargePaymentInput) => Partial<ChargePaymentResult>);

/**
 * Options for {@link fakePaymentGateway}
 */
export interface FakePaymentGatewayOptions {
    /**
     * Provider name reported by the adapter
     * @default 'fake'
     */
    provider?: string;

    /**
     * Queue of charge outcomes consumed one per {@link chargePayment} call.
     * When the queue is empty, charges succeed (`'paid'`).
     */
    chargeOutcomes?: FakeChargeOutcome[];

    /**
     * Optional webhook secret. When set, `constructWebhookEvent` verifies the
     * signature as `sha256=<hex HMAC-SHA256 of payload>` (plain hex accepted
     * too) and throws on mismatch. When omitted, the signature is ignored.
     */
    webhookSecret?: string;
}

/**
 * A recorded call made to the fake gateway
 */
export interface FakePaymentGatewayCall {
    method: string;
    args: unknown[];
}

/**
 * The fake gateway adapter plus test introspection helpers
 */
export interface FakePaymentGateway extends PaymentGatewayAdapter {
    /** Every call made to the adapter, in order */
    readonly calls: FakePaymentGatewayCall[];

    /** Append an outcome to the charge outcome queue */
    queueChargeOutcome(outcome: FakeChargeOutcome): void;

    /** Clear the recorded call log */
    clearCalls(): void;

    /** Clear the call log, the outcome queue, and all stored entities */
    reset(): void;
}

/**
 * Create a fake {@link PaymentGatewayAdapter} for tests.
 *
 * All operations are served from memory: customers and gateway subscriptions
 * are stored locally, charges consume a scriptable outcome queue, and every
 * call is recorded in `calls` for assertions. `constructWebhookEvent` accepts
 * a JSON payload of the shape `{ "type": string, "data": object }` and
 * optionally verifies an HMAC-SHA256 signature when `webhookSecret` is set.
 *
 * @example
 * ```typescript
 * import { fakePaymentGateway } from '@abshahin/subscriptions/testing';
 *
 * const gateway = fakePaymentGateway({ chargeOutcomes: ['failed', 'paid'] });
 * // first charge fails, second succeeds
 * expect(gateway.calls[0].method).toBe('chargePayment');
 * ```
 */
export function fakePaymentGateway(
    options: FakePaymentGatewayOptions = {},
): FakePaymentGateway {
    const calls: FakePaymentGatewayCall[] = [];
    const chargeOutcomes: FakeChargeOutcome[] = [...(options.chargeOutcomes ?? [])];
    const customers = new Map<string, GatewayCustomer>();
    const subscriptions = new Map<string, GatewaySubscription>();
    let idCounter = 0;

    const nextId = (prefix: string): string => `${prefix}_${++idCounter}`;

    const record = (method: string, args: unknown[]): void => {
        calls.push({ method, args });
    };

    const resolveChargeOutcome = (
        outcome: FakeChargeOutcome,
        input: ChargePaymentInput,
    ): ChargePaymentResult => {
        const base = {
            id: nextId('pay'),
            amount: input.amount,
            currency: input.currency,
        };

        const resolved = typeof outcome === 'function' ? outcome(input) : outcome;

        if (typeof resolved === 'string') {
            switch (resolved) {
                case 'paid':
                    return { ...base, status: 'paid' };
                case 'pending':
                    return {
                        ...base,
                        status: 'pending',
                        verificationUrl: `https://verify.fake.test/${base.id}`,
                    };
                case 'failed':
                    return {
                        ...base,
                        status: 'failed',
                        errorMessage: 'Card declined',
                        errorCode: 'card_declined',
                        isRetryable: false,
                        userAction: 'use_different_card',
                    };
            }
        }

        return { ...base, status: 'paid', ...resolved };
    };

    const verifySignature = async (
        payload: string,
        signature: string,
        secret: string,
    ): Promise<void> => {
        const key = await crypto.subtle.importKey(
            'raw',
            new TextEncoder().encode(secret),
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign'],
        );
        const signatureBytes = await crypto.subtle.sign(
            'HMAC',
            key,
            new TextEncoder().encode(payload),
        );
        const hex = [...new Uint8Array(signatureBytes)]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('');
        if (signature !== `sha256=${hex}` && signature !== hex) {
            throw new Error('Invalid webhook signature');
        }
    };

    return {
        provider: options.provider ?? 'fake',

        calls,

        queueChargeOutcome(outcome: FakeChargeOutcome): void {
            chargeOutcomes.push(outcome);
        },

        clearCalls(): void {
            calls.length = 0;
        },

        reset(): void {
            calls.length = 0;
            chargeOutcomes.length = 0;
            customers.clear();
            subscriptions.clear();
        },

        // ==================== Customer Management ====================
        async createCustomer(data: CreateCustomerInput): Promise<GatewayCustomer> {
            record('createCustomer', [data]);
            const customer: GatewayCustomer = {
                id: nextId('cus'),
                email: data.email,
                ...(data.name !== undefined && { name: data.name }),
                ...(data.metadata !== undefined && { metadata: data.metadata }),
            };
            customers.set(customer.id, customer);
            return customer;
        },

        async getCustomer(customerId: string): Promise<GatewayCustomer | null> {
            record('getCustomer', [customerId]);
            return customers.get(customerId) ?? null;
        },

        async updateCustomer(
            customerId: string,
            data: Partial<CreateCustomerInput>,
        ): Promise<GatewayCustomer> {
            record('updateCustomer', [customerId, data]);
            const existing = customers.get(customerId);
            if (!existing) {
                throw new Error(`Customer not found: ${customerId}`);
            }
            const updated: GatewayCustomer = {
                ...existing,
                ...(data.email !== undefined && { email: data.email }),
                ...(data.name !== undefined && { name: data.name }),
                ...(data.metadata !== undefined && { metadata: data.metadata }),
            };
            customers.set(customerId, updated);
            return updated;
        },

        // ==================== Subscription Management ====================
        async createSubscription(
            data: CreateGatewaySubscriptionInput,
        ): Promise<GatewaySubscription> {
            record('createSubscription', [data]);
            const now = new Date();
            const trialDays = data.trialDays ?? 0;
            const subscription: GatewaySubscription = {
                id: nextId('gsub'),
                customerId: data.customerId,
                status: trialDays > 0 ? 'trialing' : 'active',
                priceId: data.priceId,
                currentPeriodStart: now,
                currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
                cancelAt: null,
                canceledAt: null,
                trialStart: trialDays > 0 ? now : null,
                trialEnd:
                    trialDays > 0
                        ? new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000)
                        : null,
                ...(data.metadata !== undefined && { metadata: data.metadata }),
            };
            subscriptions.set(subscription.id, subscription);
            return subscription;
        },

        async getSubscription(
            subscriptionId: string,
        ): Promise<GatewaySubscription | null> {
            record('getSubscription', [subscriptionId]);
            return subscriptions.get(subscriptionId) ?? null;
        },

        async updateSubscription(
            subscriptionId: string,
            data: UpdateGatewaySubscriptionInput,
        ): Promise<GatewaySubscription> {
            record('updateSubscription', [subscriptionId, data]);
            const existing = subscriptions.get(subscriptionId);
            if (!existing) {
                throw new Error(`Subscription not found: ${subscriptionId}`);
            }
            const updated: GatewaySubscription = {
                ...existing,
                ...(data.priceId !== undefined && { priceId: data.priceId }),
                ...(data.metadata !== undefined && { metadata: data.metadata }),
            };
            if (data.cancelAtPeriodEnd) {
                updated.cancelAt = existing.currentPeriodEnd;
            }
            subscriptions.set(subscriptionId, updated);
            return updated;
        },

        async cancelSubscription(
            subscriptionId: string,
            cancelOptions?: CancelOptions,
        ): Promise<GatewaySubscription> {
            record('cancelSubscription', [subscriptionId, cancelOptions]);
            const existing = subscriptions.get(subscriptionId);
            if (!existing) {
                throw new Error(`Subscription not found: ${subscriptionId}`);
            }
            const now = new Date();
            const updated: GatewaySubscription = cancelOptions?.immediately
                ? { ...existing, status: 'canceled', cancelAt: now, canceledAt: now }
                : { ...existing, cancelAt: existing.currentPeriodEnd };
            subscriptions.set(subscriptionId, updated);
            return updated;
        },

        async pauseSubscription(
            subscriptionId: string,
        ): Promise<GatewaySubscription> {
            record('pauseSubscription', [subscriptionId]);
            const existing = subscriptions.get(subscriptionId);
            if (!existing) {
                throw new Error(`Subscription not found: ${subscriptionId}`);
            }
            const updated: GatewaySubscription = { ...existing, status: 'paused' };
            subscriptions.set(subscriptionId, updated);
            return updated;
        },

        async resumeSubscription(
            subscriptionId: string,
        ): Promise<GatewaySubscription> {
            record('resumeSubscription', [subscriptionId]);
            const existing = subscriptions.get(subscriptionId);
            if (!existing) {
                throw new Error(`Subscription not found: ${subscriptionId}`);
            }
            const updated: GatewaySubscription = { ...existing, status: 'active' };
            subscriptions.set(subscriptionId, updated);
            return updated;
        },

        // ==================== Checkout & Portal ====================
        async createCheckoutSession(
            data: CreateCheckoutInput,
        ): Promise<CheckoutSession> {
            record('createCheckoutSession', [data]);
            const id = nextId('chk');
            return {
                id,
                url: `https://checkout.fake.test/${id}`,
                expiresAt: new Date(Date.now() + 30 * 60 * 1000),
            };
        },

        async createPortalSession(
            customerId: string,
            returnUrl: string,
        ): Promise<PortalSession> {
            record('createPortalSession', [customerId, returnUrl]);
            const id = nextId('portal');
            return { id, url: `https://portal.fake.test/${id}` };
        },

        // ==================== Direct Payment ====================
        async chargePayment(data: ChargePaymentInput): Promise<ChargePaymentResult> {
            record('chargePayment', [data]);
            const outcome = chargeOutcomes.shift() ?? 'paid';
            return resolveChargeOutcome(outcome, data);
        },

        async getPaymentSource(paymentId: string): Promise<string | null> {
            record('getPaymentSource', [paymentId]);
            return `src_${paymentId}`;
        },

        // ==================== Webhooks ====================
        async constructWebhookEvent(
            payload: string | Uint8Array,
            signature: string,
        ): Promise<WebhookEvent> {
            record('constructWebhookEvent', [payload, signature]);
            const raw =
                typeof payload === 'string' ? payload : new TextDecoder().decode(payload);

            if (options.webhookSecret) {
                await verifySignature(raw, signature, options.webhookSecret);
            }

            const parsed = JSON.parse(raw) as { type: string; data?: Record<string, unknown> };
            return {
                id: `evt_${crypto.randomUUID()}`,
                type: parsed.type,
                data: parsed.data ?? {},
                createdAt: new Date(),
            };
        },
    };
}
