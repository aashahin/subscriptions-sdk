// file: packages/subscriptions/src/core/errors.ts
// Package-specific error classes

/**
 * Base error class for all subscription-related errors
 */
export class SubscriptionError extends Error {
    constructor(
        message: string,
        public readonly code: string,
        public readonly statusCode: number = 400,
    ) {
        super(message);
        this.name = 'SubscriptionError';
    }
}

/**
 * Plan not found error
 */
export class PlanNotFoundError extends SubscriptionError {
    constructor(planId: string) {
        super(`Plan not found: ${planId}`, 'PLAN_NOT_FOUND', 404);
        this.name = 'PlanNotFoundError';
    }
}

/**
 * Subscription not found for subscriber
 */
export class SubscriptionNotFoundError extends SubscriptionError {
    constructor(subscriberId: string) {
        super(
            `Subscription not found for subscriber: ${subscriberId}`,
            'SUBSCRIPTION_NOT_FOUND',
            404,
        );
        this.name = 'SubscriptionNotFoundError';
    }
}

/**
 * Feature not available on current plan
 */
export class FeatureNotAllowedError extends SubscriptionError {
    constructor(
        public readonly feature: string,
        planName?: string,
    ) {
        super(
            `Feature "${feature}" is not available${planName ? ` on plan "${planName}"` : ''}`,
            'FEATURE_NOT_ALLOWED',
            403,
        );
        this.name = 'FeatureNotAllowedError';
    }
}

/**
 * Usage limit exceeded for feature
 */
export class UsageLimitExceededError extends SubscriptionError {
    constructor(
        public readonly feature: string,
        public readonly limit: number,
        public readonly used: number,
    ) {
        super(
            `Usage limit exceeded for "${feature}": ${used}/${limit}`,
            'USAGE_LIMIT_EXCEEDED',
            403,
        );
        this.name = 'UsageLimitExceededError';
    }
}

/**
 * Subscription has expired
 */
export class SubscriptionExpiredError extends SubscriptionError {
    constructor() {
        super('Subscription has expired', 'SUBSCRIPTION_EXPIRED', 402);
        this.name = 'SubscriptionExpiredError';
    }
}

/**
 * Subscription is inactive (canceled, paused, etc.)
 */
export class SubscriptionInactiveError extends SubscriptionError {
    constructor(status: string) {
        super(
            `Subscription is not active. Current status: ${status}`,
            'SUBSCRIPTION_INACTIVE',
            402,
        );
        this.name = 'SubscriptionInactiveError';
    }
}

/**
 * Payment gateway error
 */
export class PaymentGatewayError extends SubscriptionError {
    constructor(
        message: string,
        public readonly gatewayError?: unknown,
    ) {
        super(message, 'PAYMENT_GATEWAY_ERROR', 502);
        this.name = 'PaymentGatewayError';
    }
}

/**
 * Invalid plan configuration
 */
export class InvalidPlanError extends SubscriptionError {
    constructor(message: string) {
        super(message, 'INVALID_PLAN', 400);
        this.name = 'InvalidPlanError';
    }
}

/**
 * Duplicate subscription - subscriber already has an active subscription
 */
export class DuplicateSubscriptionError extends SubscriptionError {
    constructor(subscriberId: string) {
        super(
            `Subscriber ${subscriberId} already has an active subscription`,
            'DUPLICATE_SUBSCRIPTION',
            409,
        );
        this.name = 'DuplicateSubscriptionError';
    }
}

/**
 * Subscription is not scheduled for cancellation
 */
export class SubscriptionNotCanceledError extends SubscriptionError {
    constructor() {
        super(
            'Subscription is not scheduled for cancellation',
            'SUBSCRIPTION_NOT_CANCELED',
            400,
        );
        this.name = 'SubscriptionNotCanceledError';
    }
}

/**
 * Payment failed during subscription operation
 */
export class PaymentFailedError extends SubscriptionError {
    constructor(
        message: string,
        public readonly paymentId?: string,
        public readonly errorCode?: string,
        public readonly isRetryable?: boolean,
        public readonly userAction?: string,
    ) {
        super(message, 'PAYMENT_FAILED', 402);
        this.name = 'PaymentFailedError';
    }
}

