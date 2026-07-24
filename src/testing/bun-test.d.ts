// file: packages/subscriptions/src/testing/bun-test.d.ts
// Minimal ambient declarations for the subset of `bun:test` used by the
// conformance suite. This keeps `tsc --noEmit` green without requiring
// @types/bun, which is an optional dev-only dependency. At runtime Bun
// resolves the real module; these declarations are compile-time only.

declare module 'bun:test' {
    export interface Matchers<T> {
        not: Matchers<T>;
        toBe(expected: unknown): void;
        toEqual(expected: unknown): void;
        toBeNull(): void;
        toBeUndefined(): void;
        toBeDefined(): void;
        toBeTruthy(): void;
        toBeFalsy(): void;
        toBeGreaterThan(expected: number): void;
        toBeGreaterThanOrEqual(expected: number): void;
        toBeLessThan(expected: number): void;
        toBeLessThanOrEqual(expected: number): void;
        toContain(expected: unknown): void;
        toHaveLength(expected: number): void;
    }

    export function describe(name: string, fn: () => void): void;
    export function it(name: string, fn: () => void | Promise<void>): void;
    export function expect<T>(value: T): Matchers<T>;
}
