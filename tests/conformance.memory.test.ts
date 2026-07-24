// Runs the adapter conformance suites against the in-memory implementations.
// The suites register bun:test describe/it blocks; registration is async
// because `bun:test` is imported lazily, hence the top-level awaits.

import {
    cacheAdapterConformance,
    databaseAdapterConformance,
    memoryCacheAdapter,
    memoryDatabaseAdapter,
} from '../src/testing/index.ts';

await databaseAdapterConformance('memoryDatabaseAdapter', () =>
    memoryDatabaseAdapter(),
);
await cacheAdapterConformance('memoryCacheAdapter', () => memoryCacheAdapter());
