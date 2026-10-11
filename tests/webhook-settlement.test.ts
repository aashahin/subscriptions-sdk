import { describe, test, expect } from 'bun:test';
import { createSubscriptions, defineFeatures, withEvents, relayOutbox } from '../src/index.ts';
import { fakePaymentGateway } from '../src/testing/fake-payment-gateway.ts';
import { sqliteDatabase } from './helpers/sqlite.ts';
const features = defineFeatures({ premium: { type: 'boolean', default: false } });
async function fixture() {
    const { connection, database } = sqliteDatabase();
    const gateway = fakePaymentGateway({ chargeOutcomes: ['pending'] });
    const sdk = createSubscriptions({ database, features, providers: [{ id: 'fake', accountId: 'account', environment: 'test', billingOwner: 'sdk_managed', adapter: gateway }], defaultProvider: 'fake' });
    const plan = await sdk.plans.create({ name: 'Paid', price: 100, currency: 'SAR', interval: 'monthly', features: { premium: true } });
    await sdk.subscriptions.create('s', plan.id, { billing: { providerId: 'fake', accountId: 'account', environment: 'test', billingOwner: 'sdk_managed', externalPaymentMethodId: 'method' } });
    await expect(sdk.subscriptions.renew('s')).rejects.toThrow();
    const charge = gateway.calls.find(call => call.method === 'chargePayment')!.args[0] as any;
    const attempt = await database.billingOperations!.find(charge.metadata.paymentAttemptKey);
    const paymentId = (attempt!.payload.result as any).id;
    const data = { id: paymentId, amount: charge.amount, currency: charge.currency, metadata: charge.metadata };
    return { connection, database, gateway, sdk, charge, data, paymentId };
}
describe('real SQLite webhook settlement and durable delivery', () => {
    test('distinct and concurrent events for one actual payment apply one invoice, period and outbox effect', async () => {
        const f = await fixture();
        const event = JSON.stringify({ id: 'event-one', type: 'payment.paid', data: f.data });
        await Promise.all(Array.from({ length: 8 }, (_, i) => f.sdk.handleWebhook('fake', i % 2 ? event : JSON.stringify({ id: 'event-two', type: 'payment.paid', data: f.data }), '')));
        const invoices = await f.database.invoices.findBySubscriber('s');
        expect(invoices).toHaveLength(1);
        expect(invoices[0]!.invoiceNumber).toBe('INV-000001');
        expect(await f.sdk.can('s', 'premium')).toBe(true);
        const emitted: string[] = [];
        const result = await relayOutbox(f.database.outbox!, { emit: e => { emitted.push(e.type); } });
        expect(result.failed).toBe(0);
        expect(emitted.filter(type => type === 'invoice.paid')).toHaveLength(1);
        expect(emitted.filter(type => type === 'subscription.renewed')).toHaveLength(1);
        expect(f.gateway.calls.filter(c => c.method === 'chargePayment')).toHaveLength(1);
        f.connection.close();
    });
    test('settlement refuses underpayment, wrong currency, subscriber, account and resource reuse', async () => {
        const f = await fixture();
        for (const data of [{ ...f.data, amount: 1 }, { ...f.data, currency: 'USD' }, { ...f.data, metadata: { ...f.data.metadata, subscriberId: 'other' } }, { ...f.data, metadata: { ...f.data.metadata, accountId: 'other' } }, { ...f.data, id: 'another-payment' }])
            await expect(f.sdk.handleWebhook('fake', JSON.stringify({ type: 'payment.paid', data }), '')).rejects.toThrow();
        expect(await f.database.invoices.findBySubscriber('s')).toHaveLength(0);
        expect((await f.sdk.subscriptions.get('s'))!.status).toBe('incomplete');
        f.connection.close();
    });
    test('subscription snapshots with renewal metadata never count as settlement', async () => {
        const f = await fixture();
        await expect(f.sdk.handleWebhook('fake', JSON.stringify({ type: 'customer.subscription.updated', data: { ...f.data, id: 'provider-subscription', status: 'past_due' } }), '')).rejects.toThrow();
        expect(await f.database.invoices.findBySubscriber('s')).toHaveLength(0);
        expect((await f.sdk.subscriptions.get('s'))!.status).toBe('incomplete');
        f.connection.close();
    });
    test('outbox failure rolls back webhook effects; replay commits saved settlement without recollection', async () => {
        const f = await fixture();
        f.connection.exec("CREATE TRIGGER fail_outbox BEFORE INSERT ON billing_outbox BEGIN SELECT RAISE(ABORT,'outbox unavailable'); END");
        const body = JSON.stringify({ id: 'evt', type: 'payment.paid', data: f.data });
        await expect(f.sdk.handleWebhook('fake', body, '')).rejects.toThrow();
        expect(await f.database.invoices.findBySubscriber('s')).toHaveLength(0);
        expect((await f.sdk.subscriptions.get('s'))!.status).toBe('incomplete');
        f.connection.exec('DROP TRIGGER fail_outbox');
        await f.sdk.handleWebhook('fake', body, '');
        expect(await f.database.invoices.findBySubscriber('s')).toHaveLength(1);
        expect(f.gateway.calls.filter(c => c.method === 'chargePayment')).toHaveLength(1);
        f.connection.close();
    });
    test('withEvents relays persisted payment identity and failed delivery retries that same event', async () => {
        const f = await fixture();
        await relayOutbox(f.database.outbox!, { emit: () => { } });
        const delivered: string[] = [];
        let failOnce = true;
        const wrapped = withEvents(f.sdk, { emit: async (event) => { if (event.type === 'invoice.paid' && failOnce) {
                failOnce = false;
                throw new Error('delivery unavailable');
            } delivered.push(event.id); } });
        const body = JSON.stringify({ type: 'payment.paid', data: f.data });
        await wrapped.handleWebhook('fake', body, '', { headers: {} });
        const invoice = (await f.database.invoices.findBySubscriber('s'))[0]!;
        const expected = `invoice.paid:${invoice.gatewayInvoiceId}`;
        expect(delivered).not.toContain(expected);
        await wrapped.handleWebhook('fake', body, '', { headers: {} });
        expect(delivered.filter(id => id === expected)).toHaveLength(1);
        await wrapped.handleWebhook('fake', body, '', { headers: {} });
        expect(delivered.filter(id => id === expected)).toHaveLength(1);
        f.connection.close();
    });
    test('markPaid and its outbox are atomic and repeated marks emit one logical event', async () => {
        const f = await fixture();
        const invoice = await f.sdk.invoices.create({ subscriptionId: (await f.sdk.subscriptions.get('s'))!.id, amount: 100, currency: 'SAR', status: 'open' });
        await Promise.all([f.sdk.invoices.markPaid(invoice.id), f.sdk.invoices.markPaid(invoice.id)]);
        const events = await f.database.outbox!.claimPending!();
        expect(events.filter(e => e.id === `invoice.paid:${invoice.id}`)).toHaveLength(1);
        f.connection.close();
    });
    test('credit-note numbering and linkage roll back on invoice failure and preserve currency precision', async () => {
        const f = await fixture();
        const original = await f.sdk.invoices.create({ subscriptionId: (await f.sdk.subscriptions.get('s'))!.id, amount: 1.234, currency: 'KWD', status: 'open', lineItems: [{ description: 'Item', quantity: 1, unitPrice: 1.234, amount: 1.234 }] });
        f.connection.exec("CREATE TRIGGER fail_credit BEFORE INSERT ON invoices BEGIN SELECT RAISE(ABORT,'invoice unavailable'); END");
        await expect(f.sdk.invoices.createCreditNote(original.id)).rejects.toThrow();
        expect(await f.database.invoices.findBySubscriber('s')).toHaveLength(1);
        f.connection.exec('DROP TRIGGER fail_credit');
        const note = await f.sdk.invoices.createCreditNote(original.id);
        expect(note.invoiceNumber).toBe('CN-000001');
        expect(note.creditNoteOfId).toBe(original.id);
        expect(note.amount).toBe(-1.234);
        expect(note.lineItems[0]!.amount).toBe(-1.234);
        await expect(f.sdk.invoices.createCreditNote(original.id)).rejects.toThrow();
        expect((await f.sdk.invoices.get(original.id))!.status).toBe('open');
        f.connection.close();
    });
});
