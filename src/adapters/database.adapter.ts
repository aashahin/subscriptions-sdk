// file: packages/subscriptions/src/adapters/database.adapter.ts
// Database adapter interface for subscriptions package

import type {
    CreateInvoiceInput,
    CreatePlanInput,
    CreateSubscriptionInput,
    FeatureRegistry,
    Invoice,
    InvoiceWithDetails,
    Plan,
    Subscription,
    SubscriptionStatus,
    SubscriptionWithPlan,
    UpdateInvoiceInput,
    UpdatePlanInput,
    UpdateSubscriptionInput,
    UsageRecord,
} from '../core/types.js';

/**
 * Query options for listing subscriptions
 */
export interface SubscriptionQueryOptions {
    status?: SubscriptionStatus | SubscriptionStatus[];
    planId?: string;
    limit?: number;
    offset?: number;
}

/**
 * Query options for admin listing plans
 */
export interface PlanQueryOptions {
    /** Filter by active status (true = active only, false = inactive only, undefined = all) */
    isActive?: boolean;
    /** Filter by billing interval (monthly, yearly, etc.) */
    interval?: string;
    /** Pagination limit */
    limit?: number;
    /** Pagination offset */
    offset?: number;
}

/**
 * Database adapter interface
 *
 * Implement this interface to connect the subscriptions package to your database.
 * The package ships with a Prisma adapter, but you can implement your own.
 */
export interface DatabaseAdapter<TFeatures extends FeatureRegistry = FeatureRegistry> {
    // ==================== Plans ====================
    plans: {
        /**
         * Find a plan by ID
         */
        findById(id: string): Promise<Plan<TFeatures> | null>;

        /**
         * List all plans
         */
        findAll(options?: { activeOnly?: boolean }): Promise<Plan<TFeatures>[]>;

        /**
         * List all plans with advanced filtering for admin
         * Returns plans and total count for pagination
         */
        findAllForAdmin(options?: PlanQueryOptions): Promise<{ plans: Plan<TFeatures>[]; total: number }>;

        /**
         * Create a new plan
         */
        create(data: CreatePlanInput<TFeatures>): Promise<Plan<TFeatures>>;

        /**
         * Update an existing plan
         */
        update(id: string, data: UpdatePlanInput<TFeatures>): Promise<Plan<TFeatures>>;

        /**
         * Delete a plan (soft delete recommended)
         */
        delete(id: string): Promise<void>;

        /**
         * Check if a plan has active subscribers
         */
        hasActiveSubscribers(id: string): Promise<boolean>;

        /**
         * Check if a plan is referenced by any pending downgrade
         */
        hasPendingDowngrades(id: string): Promise<boolean>;
    };

    // ==================== Subscriptions ====================
    subscriptions: {
        /**
         * Find a subscription by ID
         */
        findById(id: string): Promise<SubscriptionWithPlan<TFeatures> | null>;

        /**
         * Find subscription by subscriber ID (returns the active subscription)
         */
        findBySubscriber(subscriberId: string): Promise<SubscriptionWithPlan<TFeatures> | null>;

        /**
         * List subscriptions with optional filters
         */
        findAll(options?: SubscriptionQueryOptions): Promise<Subscription[]>;

        /**
         * Create a new subscription
         */
        create(data: CreateSubscriptionInput): Promise<Subscription>;

        /**
         * Update an existing subscription
         */
        update(id: string, data: UpdateSubscriptionInput): Promise<Subscription>;

        /**
         * Delete a subscription
         */
        delete(id: string): Promise<void>;

        /**
         * Find subscriptions expiring within the given days
         */
        findExpiring(withinDays: number): Promise<Subscription[]>;
    };

    // ==================== Invoices ====================
    invoices: {
        /**
         * Find an invoice by ID
         */
        findById(id: string): Promise<Invoice | null>;

        /**
         * Find an invoice by ID with subscription and plan details
         */
        findByIdWithDetails(id: string): Promise<InvoiceWithDetails<TFeatures> | null>;

        /**
         * Find invoices for a subscription
         */
        findBySubscription(subscriptionId: string): Promise<Invoice[]>;

        /**
         * Find invoices for a subscriber (by subscriber ID)
         */
        findBySubscriber(subscriberId: string): Promise<Invoice[]>;

        /**
         * Create a new invoice
         */
        create(data: CreateInvoiceInput): Promise<Invoice>;

        /**
         * Update an invoice
         */
        update(id: string, data: UpdateInvoiceInput): Promise<Invoice>;
    };

    // ==================== Usage Tracking ====================
    usage: {
        /**
         * Get current usage count for a feature
         * @param subscriberId - The subscriber ID (user who owns the subscription)
         * @param feature - The feature key
         * @param options - Optional: period date and tenantId for tenant-scoped features
         */
        get(subscriberId: string, feature: string, options?: { period?: Date; tenantId?: string | null }): Promise<number>;

        /**
         * Increment usage count atomically
         * @param subscriberId - The subscriber ID
         * @param feature - The feature key
         * @param options - Optional: count and tenantId for tenant-scoped features
         * @returns The new count after increment
         */
        increment(subscriberId: string, feature: string, options?: { count?: number; tenantId?: string | null }): Promise<number>;

        /**
         * Decrement usage count atomically
         * @param subscriberId - The subscriber ID
         * @param feature - The feature key  
         * @param options - Optional: count and tenantId for tenant-scoped features
         * @returns The new count after decrement (never goes below 0)
         */
        decrement(subscriberId: string, feature: string, options?: { count?: number; tenantId?: string | null }): Promise<number>;

        /**
         * Set usage count to a specific value
         * @param subscriberId - The subscriber ID
         * @param feature - The feature key
         * @param count - The count to set
         * @param tenantId - Optional tenantId for tenant-scoped features
         */
        set(subscriberId: string, feature: string, count: number, tenantId?: string | null): Promise<void>;

        /**
         * Reset usage for a subscriber (optionally for a specific feature)
         * @param subscriberId - The subscriber ID
         * @param options - Optional: feature to reset and tenantId
         */
        reset(subscriberId: string, options?: { feature?: string; tenantId?: string | null }): Promise<void>;

        /**
         * Get all usage records for a subscriber
         * @param subscriberId - The subscriber ID
         * @param tenantId - Optional tenantId to filter by tenant
         */
        getAll(subscriberId: string, tenantId?: string | null): Promise<UsageRecord[]>;
    };

    // ==================== Transactions ====================
    /**
     * Execute operations within a transaction
     */
    transaction<T>(fn: (tx: DatabaseAdapter<TFeatures>) => Promise<T>): Promise<T>;
}
