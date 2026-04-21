// file: packages/subscriptions/src/services/invoices.service.ts
// Invoices service for invoice management

import type { DatabaseAdapter } from '../adapters/database.adapter.js';
import type {
    CreateInvoiceInput,
    FeatureRegistry,
    Invoice,
    InvoiceWithDetails,
    UpdateInvoiceInput,
} from '../core/types.js';

export class InvoicesService<TFeatures extends FeatureRegistry = FeatureRegistry> {
    constructor(private readonly db: DatabaseAdapter<TFeatures>) { }

    /**
     * Get invoice by ID
     */
    async get(id: string): Promise<Invoice | null> {
        return this.db.invoices.findById(id);
    }

    /**
     * Get invoice by ID with full subscription and plan details
     */
    async getWithDetails(id: string): Promise<InvoiceWithDetails<TFeatures> | null> {
        return this.db.invoices.findByIdWithDetails(id);
    }

    /**
     * Get all invoices for a subscription
     */
    async listBySubscription(subscriptionId: string): Promise<Invoice[]> {
        return this.db.invoices.findBySubscription(subscriptionId);
    }

    /**
     * Get all invoices for a subscriber (by subscriber ID)
     */
    async listBySubscriber(subscriberId: string): Promise<Invoice[]> {
        return this.db.invoices.findBySubscriber(subscriberId);
    }

    /**
     * Create a new invoice
     */
    async create(data: CreateInvoiceInput): Promise<Invoice> {
        return this.db.invoices.create({
            ...data,
            status: data.status ?? 'draft',
        });
    }

    /**
     * Update an invoice
     */
    async update(id: string, data: UpdateInvoiceInput): Promise<Invoice> {
        return this.db.invoices.update(id, data);
    }

    /**
     * Mark invoice as paid
     */
    async markPaid(id: string): Promise<Invoice> {
        return this.db.invoices.update(id, {
            status: 'paid',
            paidAt: new Date(),
        });
    }

    /**
     * Mark invoice as void
     */
    async markVoid(id: string): Promise<Invoice> {
        return this.db.invoices.update(id, {
            status: 'void',
        });
    }

    /**
     * Mark invoice as uncollectible
     */
    async markUncollectible(id: string): Promise<Invoice> {
        return this.db.invoices.update(id, {
            status: 'uncollectible',
        });
    }

    /**
     * Finalize a draft invoice (make it open for payment)
     */
    async finalize(id: string): Promise<Invoice> {
        return this.db.invoices.update(id, {
            status: 'open',
        });
    }
}
