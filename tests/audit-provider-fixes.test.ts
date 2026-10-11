import { mockFetch } from './helpers/fetch.ts';
import { afterEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { stripeAdapter } from '../src/adapters/stripe.adapter.ts';
import { paddleAdapter } from '../src/adapters/paddle.adapter.ts';
import { createSubscriptions, defineFeatures } from '../src/index.ts';
import { sqliteDatabase } from './helpers/sqlite.ts';

const originalFetch = globalThis.fetch;
const connections: Database[] = [];
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const connection of connections.splice(0)) connection.close();
});

describe('audited provider request contracts', () => {
  it('resumes Stripe collection by clearing the complete pause configuration', async () => {
    mockFetch(async (_url, init) => {
      const body = new URLSearchParams(String(init?.body));
      if (body.get('pause_collection') !== '' || body.has('pause_collection[behavior]')) {
        return Response.json({ error: { message: 'Pause behavior cannot be empty' } }, { status: 400 });
      }
      return Response.json({ id: 'sub_1', status: 'active', customer: 'cus_1', items: { data: [] }, current_period_start: 1, current_period_end: 2 });
    });
    expect((await stripeAdapter({ secretKey: 'sk_test_local' }).resumeSubscription!('sub_1')).status).toBe('active');
  });

  it('immediately pauses Paddle billing and can resume during the existing period', async () => {
    let remoteStatus: 'active' | 'paused' = 'active';
    mockFetch(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as { effective_from: string; on_resume?: string };
      if (String(url).endsWith('/pause')) {
        if (body.effective_from === 'immediately') remoteStatus = 'paused';
      } else if (remoteStatus !== 'paused') {
        return Response.json({ error: { code: 'subscription_invalid_effective_from', detail: 'Only paused subscriptions resume immediately' } }, { status: 400 });
      } else if (body.on_resume !== 'continue_existing_billing_period') {
        return Response.json({ error: { detail: 'Resume would charge for another billing period' } }, { status: 400 });
      } else {
        remoteStatus = 'active';
      }
      return Response.json({ data: { id: 'sub_1', status: remoteStatus, customer_id: 'ctm_1', currency_code: 'USD', current_billing_period: { starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-11-01T00:00:00Z' }, next_billed_at: '2026-11-01T00:00:00Z', scheduled_change: null, items: [], canceled_at: null, started_at: '2026-10-01T00:00:00Z' } });
    });
    const { database, connection } = sqliteDatabase();
    connections.push(connection);
    const sdk = createSubscriptions({ database, features: defineFeatures({ premium: { type: 'boolean', default: false } }), providers: [{ id: 'paddle', accountId: 'merchant', environment: 'live', billingOwner: 'provider_managed', adapter: paddleAdapter({ apiKey: 'local' }) }] });
    const plan = await sdk.plans.create({ name: 'Paid', price: 10, interval: 'monthly', features: { premium: true } });
    await sdk.subscriptions.create('subscriber', plan.id, { policy: 'complimentary', billing: { providerId: 'paddle', accountId: 'merchant', environment: 'live', billingOwner: 'provider_managed', externalSubscriptionId: 'sub_1' } });
    expect((await sdk.subscriptions.pause('subscriber')).status).toBe('paused');
    expect<string>(remoteStatus).toBe('paused');
    expect((await sdk.subscriptions.resume('subscriber')).status).toBe('active');
    expect(remoteStatus).toBe('active');
    expect(await sdk.can('subscriber', 'premium')).toBe(true);
  });

  it.each([undefined, 'https://app.example/checkout'])('opens Paddle payment page independently of the success redirect (%s)', async checkoutUrl => {
    mockFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { checkout?: { url: string } };
      const page = body.checkout?.url ?? 'https://default.example/payment';
      return Response.json({ data: { id: 'txn_1', checkout: { url: `${page}?_ptxn=txn_1` } } });
    });
    const adapter = paddleAdapter({ apiKey: 'local', ...(checkoutUrl ? { checkoutUrl } : {}) });
    const checkout = await adapter.createCheckoutSession!({ priceId: 'pri_1', successUrl: 'https://app.example/success', cancelUrl: 'https://app.example/cancel' });
    expect(checkout.url).toBe(`${checkoutUrl ?? 'https://default.example/payment'}?_ptxn=txn_1`);
    expect(checkout.url).not.toContain('/success');
  });
});
