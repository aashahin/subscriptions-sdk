// file: packages/subscriptions/src/testing/index.ts
// Testing kit: in-memory adapters, a fake payment gateway, and conformance
// suites for custom adapter implementations.

export { memoryDatabaseAdapter } from './memory-database.js';
export { memoryCacheAdapter } from './memory-cache.js';
export { fakePaymentGateway } from './fake-payment-gateway.js';
export type {
    FakeChargeOutcome,
    FakePaymentGateway,
    FakePaymentGatewayCall,
    FakePaymentGatewayOptions,
} from './fake-payment-gateway.js';
export {
    cacheAdapterConformance,
    databaseAdapterConformance,
} from './conformance.js';
