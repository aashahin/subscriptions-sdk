// file: packages/subscriptions/src/core/types.ts
// Core type definitions for the subscriptions package

// ==================== Feature System ====================

export type FeatureType = 'boolean' | 'limit' | 'rate' | 'metered';

export interface FeatureDefinition<T extends FeatureType = FeatureType> {
    type: T;
    default: T extends 'boolean' ? boolean : number;
    description?: string;
}

export type FeatureRegistry = Record<string, FeatureDefinition>;

/**
 * Infer the value type for a feature based on its definition
 */
export type FeatureValue<T extends FeatureDefinition> =
    T['type'] extends 'boolean' ? boolean : number;

/**
 * Infer all feature values from a registry
 */
export type FeatureValues<T extends FeatureRegistry> = {
    [K in keyof T]: FeatureValue<T[K]>;
};

/**
 * Partial feature values for plan creation/update
 */
export type PartialFeatureValues<T extends FeatureRegistry> = Partial<FeatureValues<T>>;

// ==================== Billing ====================

export type BillingInterval = 'monthly' | 'yearly' | 'one_time' | 'custom';

export interface BillingConfig {
    interval: BillingInterval;
    intervalCount?: number; // For custom intervals (e.g., every 3 months)
}

// ==================== Plan ====================

/**
 * An additional price point for a plan in another currency
 */
export interface PlanPrice {
    currency: string;
    amount: number;
}

export interface Plan<TFeatures extends FeatureRegistry = FeatureRegistry> {
    id: string;
    name: string;
    description: string | null;
    price: number;
    currency: string;
    /**
     * Optional additional price points in other currencies.
     * The canonical price remains `price`/`currency`.
     */
    prices?: PlanPrice[];
    interval: BillingInterval;
    intervalCount: number;
    trialDays: number;
    features: PartialFeatureValues<TFeatures>;
    isActive: boolean;
    sortOrder: number;
    metadata: Record<string, unknown> | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface CreatePlanInput<TFeatures extends FeatureRegistry = FeatureRegistry> {
    name: string;
    description?: string | null;
    price: number;
    currency?: string;
    interval: BillingInterval;
    intervalCount?: number;
    trialDays?: number;
    features?: PartialFeatureValues<TFeatures>;
    prices?: PlanPrice[];
    isActive?: boolean;
    sortOrder?: number;
    metadata?: Record<string, unknown>;
}

export interface UpdatePlanInput<TFeatures extends FeatureRegistry = FeatureRegistry> {
    name?: string;
    description?: string | null;
    price?: number;
    currency?: string;
    interval?: BillingInterval;
    intervalCount?: number;
    trialDays?: number;
    features?: PartialFeatureValues<TFeatures>;
    prices?: PlanPrice[];
    isActive?: boolean;
    sortOrder?: number;
    metadata?: Record<string, unknown>;
}

// ==================== Subscription ====================

export type SubscriptionStatus =
    | 'trialing'
    | 'active'
    | 'past_due'
    | 'canceled'
    | 'incomplete'
    | 'incomplete_expired'
    | 'unpaid'
    | 'paused';

export type SubscriberType = 'tenant' | 'user';

export interface Subscription {
    id: string;
    subscriberId: string;
    subscriberType: SubscriberType;
    planId: string;
    status: SubscriptionStatus;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAt: Date | null;
    canceledAt: Date | null;
    trialStart: Date | null;
    trialEnd: Date | null;
    gatewaySubscriptionId: string | null;
    gatewayCustomerId: string | null;
    /**
     * Seat/unit quantity for per-seat billing.
     * @default 1
     */
    quantity?: number;
    /**
     * IDs of add-ons attached to this subscription.
     */
    addOns?: string[];
    metadata: Record<string, unknown> | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface SubscriptionWithPlan<TFeatures extends FeatureRegistry = FeatureRegistry>
    extends Subscription {
    plan: Plan<TFeatures>;
}

export interface CreateSubscriptionInput {
    subscriberId: string;
    subscriberType?: SubscriberType | undefined;
    planId: string;
    status?: SubscriptionStatus | undefined;
    currentPeriodStart?: Date | undefined;
    currentPeriodEnd?: Date | undefined;
    trialStart?: Date | null | undefined;
    trialEnd?: Date | null | undefined;
    gatewaySubscriptionId?: string | undefined;
    gatewayCustomerId?: string | undefined;
    quantity?: number | undefined;
    addOns?: string[] | undefined;
    metadata?: Record<string, unknown> | undefined;
}

export interface UpdateSubscriptionInput {
    planId?: string;
    status?: SubscriptionStatus;
    currentPeriodStart?: Date;
    currentPeriodEnd?: Date;
    cancelAt?: Date | null;
    canceledAt?: Date | null;
    trialStart?: Date | null;
    trialEnd?: Date | null;
    gatewaySubscriptionId?: string;
    gatewayCustomerId?: string;
    quantity?: number;
    addOns?: string[];
    metadata?: Record<string, unknown>;
}

// ==================== Usage Tracking ====================

export interface UsageRecord {
    id: string;
    subscriberId: string;
    feature: string;
    count: number;
    periodStart: Date;
    periodEnd: Date;
    createdAt: Date;
    updatedAt: Date;
}

export interface UsageStatus {
    feature: string;
    used: number;
    limit: number;
    remaining: number;
    percentage: number;
    unlimited: boolean;
}

// ==================== Invoice ====================

export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'uncollectible' | 'void';

export interface Invoice {
    id: string;
    subscriptionId: string;
    subscriberId: string;
    amount: number;
    currency: string;
    status: InvoiceStatus;
    /**
     * Sequential human-readable invoice number (e.g. `INV-000123`).
     * Generated when the database adapter implements `invoices.nextInvoiceNumber`.
     */
    invoiceNumber?: string | null;
    /**
     * Sum of line item amounts before tax and discounts.
     */
    subtotal?: number;
    /**
     * Tax rate applied (percentage), when uniform across line items.
     */
    taxRate?: number;
    /**
     * Total tax amount.
     */
    taxAmount?: number;
    /**
     * Total discount amount (e.g. from a coupon).
     */
    discountAmount?: number;
    /**
     * Final amount: `subtotal + taxAmount - discountAmount`.
     */
    total?: number;
    /**
     * When this invoice is a credit note, the ID of the invoice it credits.
     */
    creditNoteOfId?: string | null;
    gatewayInvoiceId: string | null;
    paidAt: Date | null;
    dueDate: Date | null;
    lineItems: InvoiceLineItem[];
    metadata: Record<string, unknown> | null;
    createdAt: Date;
    updatedAt: Date;
}

export interface InvoiceLineItem {
    description: string;
    quantity: number;
    unitPrice: number;
    amount: number;
    /**
     * Tax rate for this line item (percentage).
     */
    taxRate?: number;
    /**
     * When true, `amount` already includes tax (tax-inclusive pricing).
     * Defaults to false (tax-exclusive: tax is added on top of `amount`).
     */
    taxInclusive?: boolean;
}

export interface CreateInvoiceInput {
    subscriptionId: string;
    amount: number;
    currency: string;
    status?: InvoiceStatus;
    invoiceNumber?: string;
    subtotal?: number;
    taxRate?: number;
    taxAmount?: number;
    discountAmount?: number;
    total?: number;
    creditNoteOfId?: string;
    gatewayInvoiceId?: string;
    paidAt?: Date;
    dueDate?: Date;
    lineItems?: InvoiceLineItem[];
    metadata?: Record<string, unknown>;
}

export interface UpdateInvoiceInput {
    amount?: number;
    status?: InvoiceStatus;
    invoiceNumber?: string;
    subtotal?: number;
    taxRate?: number;
    taxAmount?: number;
    discountAmount?: number;
    total?: number;
    creditNoteOfId?: string;
    gatewayInvoiceId?: string;
    paidAt?: Date | null;
    dueDate?: Date | null;
    lineItems?: InvoiceLineItem[];
    metadata?: Record<string, unknown>;
}

/**
 * Invoice with full subscription and plan details for rendering
 */
export interface InvoiceWithDetails<TFeatures extends FeatureRegistry = FeatureRegistry> extends Invoice {
    subscription: Subscription;
    plan: Plan<TFeatures>;
}

// ==================== Logger ====================

export interface SubscriptionsLogger {
    debug?(message: string, ...args: unknown[]): void;
    info?(message: string, ...args: unknown[]): void;
    warn?(message: string, ...args: unknown[]): void;
    error?(message: string, ...args: unknown[]): void;
}

/** No-op logger that silently discards all messages */
export const noopLogger: SubscriptionsLogger = {};

// ==================== Config ====================

export interface SubscriptionsOptions {
    /**
     * Default subscriber type for new subscriptions
     * @default 'tenant'
     */
    subscriberType?: SubscriberType;

    /**
     * Default trial period in days
     * @default 0
     */
    trialDays?: number;

    /**
     * Grace period in days after subscription expires before access is revoked
     * @default 0
     */
    gracePeriodDays?: number;

    /**
     * Default currency for plans
     * @default 'USD'
     */
    defaultCurrency?: string;

    /**
     * Cache TTL in seconds for subscription/permission lookups
     * @default 300 (5 minutes)
     */
    cacheTtlSeconds?: number;

    /**
     * Optional logger. Defaults to no-op (silent).
     * Pass `console` for basic logging, or a structured logger.
     */
    logger?: SubscriptionsLogger;
}

// ==================== Coupons ====================

// Coupon types live in their own module and are re-exported here so that
// existing `import { ... } from './types.js'` call sites keep working.
export * from './coupons.js';
