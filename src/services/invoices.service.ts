// file: packages/subscriptions/src/services/invoices.service.ts
// Invoices service for invoice management
import type { DatabaseAdapter } from '../adapters/database.adapter.js';
import { InvoiceVoidError, SubscriptionError } from '../core/errors.js';
import { majorToMinor, minorToMajor } from '../core/billing-policy.js';
import type { CreateInvoiceInput, FeatureRegistry, Invoice, InvoiceLineItem, InvoiceWithDetails, UpdateInvoiceInput, } from '../core/types.js';
export interface InvoicesServiceOptions {
    /**
     * Prefix for generated sequential invoice numbers
     * @default 'INV-'
     */
    invoiceNumberPrefix?: string;
    /**
     * Prefix for generated credit note numbers
     * @default 'CN-'
     */
    creditNotePrefix?: string;
}
export interface InvoiceTotals {
    subtotal: number;
    taxAmount: number;
    total: number;
    /**
     * The uniform tax rate across all taxed line items, or undefined when
     * line items use different rates (or no tax at all).
     */
    taxRate?: number;
}
export class InvoicesService<TFeatures extends FeatureRegistry = FeatureRegistry> {
    private readonly invoiceNumberPrefix: string;
    private readonly creditNotePrefix: string;
    constructor(private readonly db: DatabaseAdapter<TFeatures>, options?: InvoicesServiceOptions) {
        this.invoiceNumberPrefix = options?.invoiceNumberPrefix ?? 'INV-';
        this.creditNotePrefix = options?.creditNotePrefix ?? 'CN-';
    }
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
     *
     * When line items are provided, `subtotal`/`taxAmount`/`total` are computed
     * from them (see {@link computeTotals}); explicit values in `data` win.
     * When the database adapter implements `invoices.nextInvoiceNumber`, a
     * sequential `invoiceNumber` is assigned automatically.
     */
    async create(data: CreateInvoiceInput): Promise<Invoice> {
        if (!this.db.capabilities?.asyncTransactions)
            throw new SubscriptionError("Invoice creation requires an awaited atomic transaction", "BILLING_STORAGE_UNSUPPORTED", 501);
        return this.db.transaction(tx => new InvoicesService(tx, { invoiceNumberPrefix: this.invoiceNumberPrefix, creditNotePrefix: this.creditNotePrefix }).createInTransaction(data));
    }
    private async createInTransaction(data: CreateInvoiceInput): Promise<Invoice> {
        majorToMinor(data.amount, data.currency);
        const computed: Partial<CreateInvoiceInput> = {};
        if (data.lineItems && data.lineItems.length > 0) {
            const totals = this.computeTotals(data.lineItems, data.discountAmount ?? 0, data.currency);
            computed.subtotal = totals.subtotal;
            computed.taxAmount = totals.taxAmount;
            computed.total = totals.total;
            if (totals.taxRate !== undefined) {
                computed.taxRate = totals.taxRate;
            }
        }
        if (!data.invoiceNumber && this.db.invoices.nextInvoiceNumber) {
            computed.invoiceNumber = await this.db.invoices.nextInvoiceNumber(this.invoiceNumberPrefix);
        }
        const invoice = await this.db.invoices.create({
            ...computed,
            ...data,
            status: data.status ?? 'draft',
        });
        if (invoice.status === 'paid' && this.db.outbox)
            await this.db.outbox.insert({ id: `invoice.paid:${invoice.gatewayInvoiceId ?? invoice.id}`, type: 'invoice.paid', occurredAt: invoice.paidAt ?? new Date(), subscriberId: invoice.subscriberId, data: { invoiceId: invoice.id, amount: invoice.amount, currency: invoice.currency } });
        return invoice;
    }
    /**
     * Update an invoice
     */
    async update(id: string, data: UpdateInvoiceInput): Promise<Invoice> {
        return this.db.invoices.update(id, data);
    }
    /**
     * Compute subtotal, tax, and total from line items.
     *
     * Tax is exclusive by default: `tax = amount * taxRate / 100` is added on
     * top of the line item amount. When a line item carries the
     * `taxInclusive` flag, its `amount` already contains the tax and the tax
     * portion is extracted instead (`tax = amount - amount / (1 + rate)`).
     */
    computeTotals(lineItems: InvoiceLineItem[], discountAmount: number = 0, currency: string = "USD"): InvoiceTotals {
        let inclusiveGross = 0;
        let inclusiveTax = 0;
        let exclusiveSubtotal = 0;
        let exclusiveTax = 0;
        const taxRates = new Set<number>();
        for (const item of lineItems) {
            const rate = item.taxRate ?? 0;
            if (rate > 0) {
                taxRates.add(rate);
            }
            if (rate > 0 && item.taxInclusive) {
                const net = item.amount / (1 + rate / 100);
                inclusiveGross += item.amount;
                inclusiveTax += item.amount - net;
            }
            else {
                exclusiveSubtotal += item.amount;
                exclusiveTax += (item.amount * rate) / 100;
            }
        }
        // Inclusive gross is authoritative; rounding both extracted parts can add a minor unit.
        const inclusiveTaxMinor = majorToMinor(inclusiveTax, currency);
        const subtotalMinor = majorToMinor(inclusiveGross, currency) - inclusiveTaxMinor + majorToMinor(exclusiveSubtotal, currency);
        const taxMinor = inclusiveTaxMinor + majorToMinor(exclusiveTax, currency);
        const subtotal = minorToMajor(subtotalMinor, currency);
        const taxAmount = minorToMajor(taxMinor, currency);
        const total = minorToMajor(Math.max(0, subtotalMinor + taxMinor - majorToMinor(discountAmount, currency)), currency);
        return {
            subtotal,
            taxAmount,
            total,
            ...(taxRates.size === 1 ? { taxRate: [...taxRates][0]! } : {}),
        };
    }
    /**
     * Create a credit note for an invoice: a negative-amount invoice linked
     * to the original via `creditNoteOfId`.
     *
     * The original invoice is left untouched (its status is NOT changed) so
     * the credit note acts as a standalone settlement document. Credit notes
     * get their own number sequence (`creditNotePrefix`, default `CN-`).
     *
     * @throws InvoiceVoidError when the invoice is void, is itself a credit
     *   note, or already has a credit note
     */
    async createCreditNote(invoiceId: string): Promise<Invoice> {
        if (!this.db.capabilities?.asyncTransactions)
            throw new SubscriptionError("Credit notes require an awaited atomic transaction", "BILLING_STORAGE_UNSUPPORTED", 501);
        return this.db.transaction(tx => new InvoicesService(tx, { invoiceNumberPrefix: this.invoiceNumberPrefix, creditNotePrefix: this.creditNotePrefix }).createCreditNoteInTransaction(invoiceId));
    }
    private async createCreditNoteInTransaction(invoiceId: string): Promise<Invoice> {
        const original = await this.db.invoices.findById(invoiceId);
        if (!original) {
            throw new SubscriptionError(`Invoice not found: ${invoiceId}`, 'INVOICE_NOT_FOUND', 404);
        }
        if (original.status === 'void') {
            throw new InvoiceVoidError(`Cannot create a credit note for a void invoice: ${invoiceId}`);
        }
        if (original.creditNoteOfId) {
            throw new InvoiceVoidError(`Cannot create a credit note for another credit note: ${invoiceId}`);
        }
        const existing = await this.db.invoices.findBySubscription(original.subscriptionId);
        if (existing.some((inv) => inv.creditNoteOfId === invoiceId)) {
            throw new InvoiceVoidError(`Invoice ${invoiceId} already has a credit note`);
        }
        let invoiceNumber: string | undefined;
        if (this.db.invoices.nextInvoiceNumber) {
            invoiceNumber = await this.db.invoices.nextInvoiceNumber(this.creditNotePrefix);
        }
        const negate = (value: number | undefined): number | undefined => value === undefined ? undefined : roundMoney(-value, original.currency);
        const subtotal = negate(original.subtotal);
        const taxAmount = negate(original.taxAmount);
        const discountAmount = negate(original.discountAmount);
        const total = negate(original.total);
        return this.createInTransaction({
            subscriptionId: original.subscriptionId,
            amount: roundMoney(-original.amount, original.currency),
            currency: original.currency,
            status: 'open',
            ...(invoiceNumber !== undefined && { invoiceNumber }),
            ...(subtotal !== undefined && { subtotal }),
            ...(original.taxRate !== undefined && { taxRate: original.taxRate }),
            ...(taxAmount !== undefined && { taxAmount }),
            ...(discountAmount !== undefined && { discountAmount }),
            ...(total !== undefined && { total }),
            creditNoteOfId: invoiceId,
            lineItems: original.lineItems.map((item) => ({
                ...item,
                amount: roundMoney(-item.amount, original.currency),
                unitPrice: roundMoney(-item.unitPrice, original.currency),
            })),
            metadata: { creditNoteFor: invoiceId },
        });
    }
    /**
     * Void an invoice with safety checks.
     *
     * Only `draft`, `open`, and `uncollectible` invoices can be voided.
     * Voiding a `paid` invoice is rejected (create a credit note instead);
     * voiding an already-void invoice is rejected as well.
     *
     * @throws InvoiceVoidError when the invoice cannot be voided
     */
    async voidInvoice(id: string): Promise<Invoice> {
        const invoice = await this.db.invoices.findById(id);
        if (!invoice) {
            throw new SubscriptionError(`Invoice not found: ${id}`, 'INVOICE_NOT_FOUND', 404);
        }
        if (invoice.status === 'void') {
            throw new InvoiceVoidError(`Invoice is already void: ${id}`);
        }
        if (invoice.status === 'paid') {
            throw new InvoiceVoidError(`Cannot void a paid invoice: ${id}. Create a credit note instead.`);
        }
        return this.db.invoices.update(id, { status: 'void' });
    }
    /**
     * Mark invoice as paid
     */
    async markPaid(id: string): Promise<Invoice> {
        if (!this.db.capabilities?.asyncTransactions || !this.db.outbox)
            throw new SubscriptionError('markPaid requires atomic outbox persistence', 'BILLING_STORAGE_UNSUPPORTED', 501);
        return this.db.transaction(async (tx) => {
            const current = await tx.invoices.findById(id);
            if (!current)
                throw new SubscriptionError('Invoice not found', 'INVOICE_NOT_FOUND', 404);
            if (current.status === 'paid')
                return current;
            const invoice = await tx.invoices.update(id, { status: 'paid', paidAt: new Date() });
            await tx.outbox!.insert({ id: `invoice.paid:${invoice.gatewayInvoiceId ?? invoice.id}`, type: 'invoice.paid', occurredAt: invoice.paidAt!, subscriberId: invoice.subscriberId, data: { invoiceId: id, amount: invoice.amount, currency: invoice.currency } });
            return invoice;
        });
    }
    /**
     * Mark invoice as void
     *
     * Prefer {@link voidInvoice}, which refuses to void paid or already-void
     * invoices. This method performs the raw status update without checks.
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
/**
 * Round a money amount using the currency minor-unit precision
 */
function roundMoney(amount: number, currency: string): number {
    return minorToMajor(majorToMinor(amount, currency), currency);
}
