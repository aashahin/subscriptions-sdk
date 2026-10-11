/** Install a local HTTP boundary double with Bun's fetch function shape. */
export function mockFetch(handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): void {
    globalThis.fetch = Object.assign(handler, { preconnect: () => {} });
}
