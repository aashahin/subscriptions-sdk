// file: packages/subscriptions/src/adapters/payment.adapter.ts
// Payment gateway adapter interface for subscriptions package

/**
 * Gateway customer representation
 */
export interface GatewayCustomer {
    id: string;
    email: string;
    name?: string;
    metadata?: Record<string, string>;
}

/**
 * Gateway subscription representation
 */
export interface GatewaySubscription {
    id: string;
    customerId: string;
    status: string;
    priceId?: string;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAt: Date | null;
    canceledAt: Date | null;
    trialStart: Date | null;
    trialEnd: Date | null;
    metadata?: Record<string, string>;
}

/**
 * Checkout session for payment
 */
export interface CheckoutSession {
    id: string;
    url: string;
    expiresAt: Date;
}

/**
 * Customer portal session
 */
export interface PortalSession {
    id: string;
    url: string;
}

/**
 * Webhook event from payment gateway
 */
export interface WebhookEvent {
    id: string;
    type: string;
    data: Record<string, unknown>;
    createdAt: Date;
}

/**
 * Input for creating a customer
 */
export interface CreateCustomerInput {
    email: string;
    name?: string;
    metadata?: Record<string, string>;
}

/**
 * Input for creating a gateway subscription
 */
export interface CreateGatewaySubscriptionInput {
    customerId: string;
    priceId: string;
    trialDays?: number;
    metadata?: Record<string, string>;
}

/**
 * Input for updating a gateway subscription
 */
export interface UpdateGatewaySubscriptionInput {
    priceId?: string;
    cancelAtPeriodEnd?: boolean;
    metadata?: Record<string, string>;
}

/**
 * Options for canceling a subscription
 */
export interface CancelOptions {
    /**
     * Cancel immediately or at period end
     * @default false (cancel at period end)
     */
    immediately?: boolean;

    /**
     * Reason for cancellation
     */
    reason?: string;
}

/**
 * Input for creating a checkout session
 */
export interface CreateCheckoutInput {
    customerId?: string;
    customerEmail?: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    trialDays?: number;
    metadata?: Record<string, string>;
}

/**
 * Input for charging a one-time payment
 */
export interface ChargePaymentInput {
    /** Customer/token ID to charge */
    customerId: string;
    /** Amount in smallest currency unit (e.g., cents, halalas) */
    amount: number;
    /** Currency code (e.g., 'USD', 'SAR') */
    currency: string;
    /** Payment description */
    description?: string;
    /** Callback URL for 3DS verification */
    callbackUrl?: string;
    /** Additional metadata */
    metadata?: Record<string, string>;
}

/**
 * Result of a payment charge
 */
export interface ChargePaymentResult {
    /** Payment ID from gateway */
    id: string;
    /** Payment status */
    status: 'paid' | 'pending' | 'failed';
    /** Amount charged */
    amount: number;
    /** Currency */
    currency: string;
    /** URL for 3DS verification (if pending) */
    verificationUrl?: string;
    /** Error message if failed */
    errorMessage?: string;
    /** Machine-readable error code */
    errorCode?: string;
    /** Whether the error is retryable */
    isRetryable?: boolean;
    /** Suggested user action */
    userAction?: 'use_different_card' | 'retry_later' | 'contact_bank' | 'check_details' | 'none';
    /** Gateway-specific response code */
    gatewayCode?: string;
    /** HTTP status if applicable */
    httpStatus?: number;
}

/**
 * Payment gateway adapter interface
 *
 * Implement this interface to integrate with payment providers like Stripe, Paddle, etc.
 * This is optional - you can manage subscriptions manually without a payment gateway.
 */
export interface PaymentGatewayAdapter {
    /**
     * Provider name for logging and identification
     */
    readonly provider: string;

    // ==================== Customer Management ====================

    /**
     * Create a customer in the payment gateway
     */
    createCustomer(data: CreateCustomerInput): Promise<GatewayCustomer>;

    /**
     * Get a customer by ID
     */
    getCustomer(customerId: string): Promise<GatewayCustomer | null>;

    /**
     * Update customer details
     */
    updateCustomer?(customerId: string, data: Partial<CreateCustomerInput>): Promise<GatewayCustomer>;

    // ==================== Subscription Management ====================

    /**
     * Create a subscription in the payment gateway
     */
    createSubscription(data: CreateGatewaySubscriptionInput): Promise<GatewaySubscription>;

    /**
     * Get a subscription by ID
     */
    getSubscription(subscriptionId: string): Promise<GatewaySubscription | null>;

    /**
     * Update a subscription (e.g., change plan)
     */
    updateSubscription(
        subscriptionId: string,
        data: UpdateGatewaySubscriptionInput,
    ): Promise<GatewaySubscription>;

    /**
     * Cancel a subscription
     */
    cancelSubscription(subscriptionId: string, options?: CancelOptions): Promise<GatewaySubscription>;

    /**
     * Pause a subscription (if supported)
     */
    pauseSubscription?(subscriptionId: string): Promise<GatewaySubscription>;

    /**
     * Resume a paused subscription
     */
    resumeSubscription?(subscriptionId: string): Promise<GatewaySubscription>;

    // ==================== Checkout & Portal ====================

    /**
     * Create a checkout session for new subscriptions
     */
    createCheckoutSession(data: CreateCheckoutInput): Promise<CheckoutSession>;

    /**
     * Create a customer portal session for managing billing
     */
    createPortalSession(customerId: string, returnUrl: string): Promise<PortalSession>;

    // ==================== Webhooks ====================

    // ==================== Direct Payment ====================

    /**
     * Charge a one-time payment (for upgrades, renewals, etc.)
     * This uses a saved token/customer ID to charge directly.
     */
    chargePayment?(data: ChargePaymentInput): Promise<ChargePaymentResult>;

    /**
     * Get the reusable payment source from a completed payment.
     * Use this to save the payment method for future renewals.
     * @param paymentId - The payment ID from gateway
     * @returns Token/source ID that can be reused, or null if not applicable
     */
    getPaymentSource?(paymentId: string): Promise<string | null>;

    // ==================== Webhooks ====================

    /**
     * Construct and verify a webhook event
     * @param payload - Raw webhook payload
     * @param signature - Webhook signature header
     */
    constructWebhookEvent(payload: string | Buffer, signature: string): Promise<WebhookEvent>;
}

/**
 * No-op payment adapter for manual subscription management
 */
export const noopPaymentAdapter: PaymentGatewayAdapter = {
    provider: 'manual',
    createCustomer: async () => {
        throw new Error('Payment gateway not configured');
    },
    getCustomer: async () => null,
    createSubscription: async () => {
        throw new Error('Payment gateway not configured');
    },
    getSubscription: async () => null,
    updateSubscription: async () => {
        throw new Error('Payment gateway not configured');
    },
    cancelSubscription: async () => {
        throw new Error('Payment gateway not configured');
    },
    createCheckoutSession: async () => {
        throw new Error('Payment gateway not configured');
    },
    createPortalSession: async () => {
        throw new Error('Payment gateway not configured');
    },
    constructWebhookEvent: async () => {
        throw new Error('Payment gateway not configured');
    },
};
