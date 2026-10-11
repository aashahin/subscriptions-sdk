import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { drizzleAdapter, subscriptionsSchema } from '../src/adapters/drizzle.adapter.ts';
import { memoryDatabaseAdapter } from '../src/testing/memory-database.ts';
import { prismaAdapter } from '../src/adapters/prisma.adapter.ts';
import { SubscriptionsService } from '../src/services/subscriptions.service.ts';
import { ProviderRegistry } from '../src/core/providers.ts';

function sqlite() {
    const connection = new Database(':memory:');
    connection.exec('PRAGMA foreign_keys = ON');
    for (const table of Object.values(subscriptionsSchema)) {
        const config = getTableConfig(table);
        const columns = config.columns.map(column => `"${column.name}" ${column.getSQLType()}${column.primary ? ' PRIMARY KEY' : ''}${column.notNull ? ' NOT NULL' : ''}${column.isUnique ? ' UNIQUE' : ''}`);
        for (const fk of config.foreignKeys) {const ref=fk.reference();columns.push(`FOREIGN KEY (${ref.columns.map(c=>`"${c.name}"`).join(',')}) REFERENCES "${getTableConfig(ref.foreignTable).name}" (${ref.foreignColumns.map(c=>`"${c.name}"`).join(',')})`);}
        connection.exec(`CREATE TABLE "${config.name}" (${columns.join(',')})`);
        for (const index of config.indexes) {const c=index.config; connection.exec(`CREATE ${c.unique?'UNIQUE ':''}INDEX "${c.name}" ON "${config.name}" (${c.columns.map(column=>`"${(column as any).name}"`).join(',')})`);}
    }
    return {connection, adapter:drizzleAdapter(drizzle(connection,{schema:subscriptionsSchema}))};
}
async function seed(adapter:ReturnType<typeof memoryDatabaseAdapter>) {
    const plan=await adapter.plans.create({name:'Paid',price:100,currency:'USD',interval:'monthly',features:{},prices:[{currency:'SAR',amount:375}]});
    const subscription=await adapter.subscriptions.create({subscriberId:'subscriber',planId:plan.id,quantity:4,addOns:['extra'],billing:{providerId:'moyasar',accountId:'acct',environment:'test',billingOwner:'sdk_managed'}});
    return {plan,subscription};
}

describe('real bun:sqlite adapter regressions',()=> {
    test('awaited transaction commits and rolls back real invoice uniqueness failures, ledger, numbering and outbox',async()=> {
        const {connection,adapter}=sqlite(); const {subscription}=await seed(adapter);
        await adapter.invoices.create({subscriptionId:subscription.id,amount:100,currency:'USD',status:'paid',gatewayInvoiceId:'paid-1'});
        await expect(adapter.transaction(async tx=> {
            await tx.subscriptions.update(subscription.id,{status:'past_due'});
            await Promise.resolve();
            await tx.billingOperations!.reserve('event-1',{amount:100});
            await tx.outbox!.insert({id:'event-1',type:'invoice.paid',occurredAt:new Date(),data:{}} as any);
            await tx.invoices.nextInvoiceNumber!('INV-');
            await tx.invoices.create({subscriptionId:subscription.id,amount:100,currency:'USD',status:'paid',gatewayInvoiceId:'paid-1'});
        })).rejects.toThrow();
        expect((await adapter.subscriptions.findById(subscription.id))!.status).toBe('active');
        expect(await adapter.billingOperations!.find('event-1')).toBeNull();
        expect(await adapter.outbox!.claimPending!()).toEqual([]);
        expect(await adapter.invoices.nextInvoiceNumber!('INV-')).toBe('INV-000001');
        await adapter.transaction(async tx=>{await Promise.resolve();await tx.subscriptions.update(subscription.id,{status:'past_due'});});
        expect((await adapter.subscriptions.findById(subscription.id))!.status).toBe('past_due');
        connection.close();
    });
    test('concurrent quota admissions return each mutation value and admit exactly the remaining slots',async()=> {
        const {connection,adapter}=sqlite();
        const results=await Promise.all([adapter.usage.increment('s','products'),adapter.usage.increment('s','products')]);
        expect(results.sort()).toEqual([1,2]);
        const admitted=await Promise.all(Array.from({length:10},()=>adapter.usage.reserve!('s','products',{count:1,limit:3})));
        expect(admitted.filter(r=>r.accepted).map(r=>r.count)).toEqual([3]);
        expect(await adapter.usage.get('s','products')).toBe(3);
        connection.close();
    });
    test('metadata replacement preserves all hidden billing fields and concurrent updates',async()=> {
        const {connection,adapter}=sqlite();const {plan,subscription}=await seed(adapter);
        const invoice=await adapter.invoices.create({subscriptionId:subscription.id,amount:100,currency:'USD',invoiceNumber:'INV-123',subtotal:80,taxRate:25,taxAmount:20,discountAmount:0,total:100,creditNoteOfId:'original'});
        await Promise.all([adapter.subscriptions.update(subscription.id,{metadata:{public:true}}),adapter.subscriptions.update(subscription.id,{quantity:9})]);
        await adapter.plans.update(plan.id,{metadata:{label:'new'}});
        await adapter.invoices.update(invoice.id,{metadata:{note:'new'}});
        const persisted=await adapter.subscriptions.findById(subscription.id);
        expect(persisted!.quantity).toBe(9);expect(persisted!.addOns).toEqual(['extra']);expect(persisted!.billing!.accountId).toBe('acct');expect(persisted!.metadata).toEqual({public:true});
        expect((await adapter.plans.findById(plan.id))!.prices).toEqual([{currency:'SAR',amount:375}]);
        const result=await adapter.invoices.findById(invoice.id);for(const key of ['invoiceNumber','subtotal','taxRate','taxAmount','discountAmount','total','creditNoteOfId'] as const)expect(result![key]).toEqual(invoice[key]);
        connection.close();
    });
    test('concurrent coupon purchases respect the cap and release once, preserving purchase tombstones',async()=> {
        const {connection,adapter}=sqlite();const coupon=await adapter.coupons!.create({code:'LAST',type:'percent',value:10,maxRedemptions:1});
        const attempts=await Promise.all(['purchase-a','purchase-b'].map(p=>adapter.coupons!.redeem!(coupon.id,p)));
        expect(attempts.filter(Boolean)).toHaveLength(1);
        await adapter.coupons!.update(coupon.id,{value:90});
        const replay=await adapter.coupons!.redeem!(coupon.id,'purchase-a');expect(replay!.timesRedeemed).toBe(1);expect(replay!.value).toBe(10);
        await adapter.coupons!.releaseRedemption!(coupon.id,'purchase-a');await adapter.coupons!.releaseRedemption!(coupon.id,'purchase-a');
        expect((await adapter.coupons!.findById(coupon.id))!.timesRedeemed).toBe(0);
        expect(await adapter.coupons!.redeem!(coupon.id,'purchase-a')).toBeNull();
        expect(await adapter.coupons!.redeem!(coupon.id,'purchase-b')).not.toBeNull();connection.close();
    });
    test('billing command reservation and state CAS admit one worker; outbox deduplicates and survives retries',async()=> {
        const {connection,adapter}=sqlite();const results=await Promise.all(Array.from({length:6},()=>adapter.billingOperations!.reserve('renewal:cycle',{amount:100})));
        expect(results.filter(r=>r.created)).toHaveLength(1);
        const claimed=await Promise.all(Array.from({length:6},()=>adapter.billingOperations!.compareAndSet('renewal:cycle','reserved',{status:'collecting'})));
        expect(claimed.filter(Boolean)).toHaveLength(1);
        const event={id:'invoice:paid-1',type:'invoice.paid',occurredAt:new Date(),data:{}} as any;
        await Promise.all([adapter.outbox!.insert(event),adapter.outbox!.insert(event)]);
        expect(await adapter.outbox!.claimPending!()).toHaveLength(1);expect(await adapter.outbox!.claimPending!()).toHaveLength(0);
        await adapter.outbox!.releaseClaim!(event.id);expect(await adapter.outbox!.claimPending!()).toHaveLength(1);
        await adapter.outbox!.markSent!(event.id);expect(await adapter.outbox!.claimPending!()).toHaveLength(0);connection.close();
    });
    test('two SDK adapters sharing a synchronous connection cannot leak unrelated calls into a rollback',async()=> {
        const {connection,adapter}=sqlite();const other=drizzleAdapter(drizzle(connection,{schema:subscriptionsSchema}));
        const results=await Promise.allSettled([
            adapter.transaction(async tx=>{await tx.usage.increment('s','f');await Promise.resolve();throw new Error('rollback');}),
            other.usage.increment('s','f'),
        ]);
        expect(results[0]!.status).toBe('rejected');expect(results[1]!.status).toBe('fulfilled');
        expect(await adapter.usage.get('s','f')).toBe(1);connection.close();
    });
    test('concurrent real SQLite-backed renewals persist one payment, invoice and entitlement transition',async()=> {
        const {connection,adapter}=sqlite();const {subscription}=await seed(adapter);let charges=0;
        const billing={...subscription.billing!,externalPaymentMethodId:'token'};
        const end=new Date(Date.now()-1000);await adapter.subscriptions.update(subscription.id,{billing,currentPeriodStart:new Date(end.getTime()-30*86400000),currentPeriodEnd:end});
        const gateway:any={capabilities:{idempotentCharges:true},chargePayment:async(input:any)=>{charges++;await Promise.resolve();return{id:'payment-1',status:'paid',amount:input.amount,currency:input.currency};},getPayment:async()=>null};
        const service=new SubscriptionsService(adapter,undefined,undefined,{providers:new ProviderRegistry([{id:'moyasar',accountId:'acct',environment:'test',billingOwner:'sdk_managed',adapter:gateway}])});
        const results=await Promise.allSettled(Array.from({length:6},()=>service.renew('subscriber')));
        expect(results.filter(row=>row.status==='fulfilled').length).toBeGreaterThan(0);expect(charges).toBe(1);
        const invoices=await adapter.invoices.findBySubscription(subscription.id);expect(invoices).toHaveLength(1);expect(invoices[0]!.invoiceNumber).toBe('INV-000001');
        expect((await adapter.subscriptions.findById(subscription.id))!.currentPeriodEnd.getTime()).toBeGreaterThan(end.getTime());
        const events=await adapter.outbox!.claimPending!();expect(events.filter(row=>row.type==='invoice.paid')).toHaveLength(1);expect(events.filter(row=>row.type==='subscription.renewed')).toHaveLength(1);connection.close();
    });
    for(const failure of ['invoice','outbox'] as const) test(`real SQLite ${failure} persistence abort rolls back entitlement and replay never recollects`,async()=> {
        const {connection,adapter}=sqlite();const {subscription}=await seed(adapter);let charges=0;
        const billing={...subscription.billing!,externalPaymentMethodId:'token'};const end=new Date(Date.now()-1000);
        await adapter.subscriptions.update(subscription.id,{billing,currentPeriodStart:new Date(end.getTime()-30*86400000),currentPeriodEnd:end});
        const gateway:any={capabilities:{idempotentCharges:true},chargePayment:async(input:any)=>{charges++;return{id:'payment-abort',status:'paid',amount:input.amount,currency:input.currency};}};
        const service=new SubscriptionsService(adapter,undefined,undefined,{providers:new ProviderRegistry([{id:'moyasar',accountId:'acct',environment:'test',billingOwner:'sdk_managed',adapter:gateway}])});
        connection.exec(failure==='invoice'?"CREATE TRIGGER persistence_abort BEFORE INSERT ON invoices BEGIN SELECT RAISE(ABORT,'invoice persistence failed'); END":"CREATE TRIGGER persistence_abort BEFORE INSERT ON billing_outbox BEGIN SELECT RAISE(ABORT,'outbox persistence failed'); END");
        await expect(service.renew('subscriber')).rejects.toThrow('persistence failed');expect(charges).toBe(1);
        expect((await adapter.subscriptions.findById(subscription.id))!.currentPeriodEnd.getTime()).toBe(end.getTime());
        expect(await adapter.invoices.findBySubscription(subscription.id)).toHaveLength(0);expect(await adapter.outbox!.claimPending!()).toHaveLength(0);
        expect((await adapter.billingOperations!.find(`renewal:${subscription.id}:${end.toISOString()}`))!.status).toBe('succeeded');
        connection.exec('DROP TRIGGER persistence_abort');await service.renew('subscriber');expect(charges).toBe(1);
        const invoices=await adapter.invoices.findBySubscription(subscription.id);expect(invoices).toHaveLength(1);expect(invoices[0]!.invoiceNumber).toBe('INV-000001');
        expect((await adapter.subscriptions.findById(subscription.id))!.currentPeriodEnd.getTime()).toBeGreaterThan(end.getTime());connection.close();
    });
    test('provider resources are immutable, idempotent and scoped by kind, provider, account and environment',async()=> {
        const {connection,adapter}=sqlite();const store=adapter.providerResources!;
        const base={providerId:'moyasar',accountId:'acct',environment:'test' as const,kind:'payment_method' as const,localId:'subscriber-a',externalId:'token-1'};
        const replay=await Promise.all(Array.from({length:6},()=>store.bind(base)));expect(replay).toHaveLength(6);expect(replay.every(row=>row.localId==='subscriber-a')).toBe(true);
        await expect(store.bind({...base,localId:'subscriber-b'})).rejects.toThrow('already bound');
        await expect(store.bind({...base,externalId:'token-2'})).rejects.toThrow('already bound');
        for(const difference of [{accountId:'other-account'},{environment:'live' as const},{providerId:'polar'},{kind:'customer' as const}]) {
            const scoped={...base,...difference,localId:'subscriber-b'};await store.bind(scoped);expect((await store.findByExternal(scoped,'token-1'))!.localId).toBe('subscriber-b');
        }
        expect(await store.findByLocal(base,'subscriber-a')).toEqual(base);expect(await store.findByExternal(base,'token-1')).toEqual(base);
        for(const kind of ['customer','payment_method','subscription','product','price','payment'] as const)await store.bind({...base,kind,localId:'local-'+kind,externalId:'external-'+kind});
        await expect(adapter.transaction(async tx=>{await tx.providerResources!.bind({...base,externalId:'token-rollback',localId:'subscriber-rollback'});throw new Error('rollback');})).rejects.toThrow('rollback');
        expect(await store.findByExternal(base,'token-rollback')).toBeNull();connection.close();
    });
    test('D1 and unknown driver transaction callbacks fail before invoking business operations',async()=> {
        let invoked=false; const adapter=drizzleAdapter({select(){},insert(){},update(){},delete(){},transaction(){throw new Error('D1 transactions unsupported');}} as any);
        expect(adapter.capabilities!.asyncTransactions).toBe(false);
        await expect(adapter.transaction(async()=>{invoked=true;})).rejects.toThrow('does not support');expect(invoked).toBe(false);
    });
    test('explicit persistent and cycle usage periods remain isolated',async()=> {
        const {connection,adapter}=sqlite();const persistent={periodStart:new Date(0),periodEnd:new Date('9999-12-31T00:00:00Z')};
        await adapter.usage.reserve!('s','products',{...persistent,count:4,limit:5});
        expect(await adapter.usage.get('s','products',{...persistent,period:new Date('2030-01-01')})).toBe(4);
        const cycle={periodStart:new Date('2026-10-15'),periodEnd:new Date('2026-11-15')};
        await adapter.usage.reserve!('s','requests',{...cycle,count:2,limit:3});expect(await adapter.usage.get('s','requests',{...cycle,period:new Date('2026-11-01')})).toBe(2);connection.close();
    });
});

test('memory rollback restores in-place usage and coupon updates',async()=> {
    const adapter=memoryDatabaseAdapter();await adapter.usage.increment('s','f',{count:5});const coupon=await adapter.coupons!.create({code:'ONE',type:'percent',value:10,maxRedemptions:1});
    await expect(adapter.transaction(async tx=>{await tx.usage.increment('s','f');await tx.coupons!.redeem!(coupon.id,'purchase');throw new Error('rollback');})).rejects.toThrow();
    expect(await adapter.usage.get('s','f')).toBe(5);expect((await adapter.coupons!.findById(coupon.id))!.timesRedeemed).toBe(0);
});

// Actual Prisma adapter mappings, mocked delegate/storage boundary only. This is not live Prisma coverage.
test('Prisma metadata replacements round-trip reserved state through actual mapping methods',async()=> {
    let stored:any={id:'s',tenantId:'tenant',planId:'p',status:'active',metadata:{old:true,_billing:{quantity:4,addOns:['extra'],binding:{providerId:'moyasar',accountId:'acct',environment:'test',billingOwner:'sdk_managed'}}}};
    const delegate={findUnique:async()=>({...stored}),update:async({data}:any)=>(stored={...stored,...data})};
    const client:any={subscription:delegate,$transaction:async(fn:any)=>fn(client)};const adapter=prismaAdapter(client);
    const row=await adapter.subscriptions.update('s',{metadata:{new:true}});expect(row.quantity).toBe(4);expect(row.addOns).toEqual(['extra']);expect(row.billing!.accountId).toBe('acct');expect(row.metadata).toEqual({new:true});
});
