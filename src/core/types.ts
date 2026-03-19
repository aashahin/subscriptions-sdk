// file: packages/subscriptions/src/core/types.ts
// Core type definitions for the subscriptions package

// ==================== Feature System ====================

export type FeatureType = 'boolean' | 'limit' | 'rate';

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

export interface Plan<TFeatures extends FeatureRegistry = FeatureRegistry> {
    id: string;
    name: string;
    description: string | null;
    price: number;
    currency: string;
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
    amount: number;
    currency: string;
    status: InvoiceStatus;
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
}

export interface CreateInvoiceInput {
    subscriptionId: string;
    amount: number;
    currency: string;
    status?: InvoiceStatus;
    gatewayInvoiceId?: string;
    paidAt?: Date;
    dueDate?: Date;
    lineItems?: InvoiceLineItem[];
    metadata?: Record<string, unknown>;
}

export interface UpdateInvoiceInput {
    amount?: number;
    status?: InvoiceStatus;
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
}
