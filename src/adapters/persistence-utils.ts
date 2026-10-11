import type { DatabaseAdapter, ProviderResourceMapping, ProviderResourceScope, UsagePeriodOptions } from './database.adapter.js';
import type { FeatureRegistry } from '../core/types.js';

export function usagePeriod(options?: UsagePeriodOptions): { periodStart: Date; periodEnd: Date } {
    if (options?.periodStart !== undefined || options?.periodEnd !== undefined) {
        const start = options.periodStart; const end = options.periodEnd;
        if (!start || !end || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
            throw new Error('Usage requires valid explicit periodStart and periodEnd');
        }
        return { periodStart: start, periodEnd: end };
    }
    const now = new Date();
    return { periodStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
        periodEnd: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - 1) };
}
export function validateUsageCount(count: number, allowZero = false): void {
    if (!Number.isSafeInteger(count) || count < (allowZero ? 0 : 1)) throw new Error('Usage count must be a finite safe integer with a valid sign');
}
export function validateUsageLimit(limit?: number | null): void {
    if (limit != null) validateUsageCount(limit, true);
}

/** Serialize every adapter operation on a synchronous connection, including operations outside a transaction. */
export function serialAdapter<T extends FeatureRegistry>(adapter: DatabaseAdapter<T>, run: <R>(fn: () => Promise<R>) => Promise<R>): DatabaseAdapter<T> {
    const wrapped: Record<string, unknown> = {};
    for (const [key, section] of Object.entries(adapter)) {
        if (key === 'capabilities') { wrapped[key] = section; continue; }
        if (typeof section === 'function') { wrapped[key] = (...args: unknown[]) => run(() => section(...args)); continue; }
        if (section && typeof section === 'object') {
            wrapped[key] = Object.fromEntries(Object.entries(section).map(([method, fn]) => [method,
                typeof fn === 'function' ? (...args: unknown[]) => run(() => fn.apply(section, args)) : fn]));
        } else wrapped[key] = section;
    }
    return wrapped as unknown as DatabaseAdapter<T>;
}
export function queue(): <R>(fn: () => Promise<R>) => Promise<R> {
    let tail = Promise.resolve();
    return <R>(fn: () => Promise<R>): Promise<R> => {
        const result = tail.then(fn); tail = result.then(() => undefined, () => undefined); return result;
    };
}

/** Prisma JSON inputs must contain JSON values, including ISO timestamps rather than Date instances. */
export function jsonData<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
export function hydrateCoupon<T extends {expiresAt: Date | null;createdAt:Date;updatedAt:Date}>(coupon:T):T {
    return {...coupon,expiresAt:coupon.expiresAt?new Date(coupon.expiresAt):null,createdAt:new Date(coupon.createdAt),updatedAt:new Date(coupon.updatedAt)};
}

export function validateProviderResource(scope: ProviderResourceScope, resourceId: string): void {
    if (!scope.providerId?.trim() || !scope.accountId?.trim() || !resourceId?.trim() ||
        !['test','live'].includes(scope.environment) ||
        !['customer','payment_method','subscription','product','price','payment'].includes(scope.kind)) {
        throw new Error('Provider resource mapping requires a valid provider/account/environment/kind and nonempty IDs');
    }
}
export function providerResourceScope(mapping:ProviderResourceMapping):ProviderResourceScope {
    return {providerId:mapping.providerId,accountId:mapping.accountId,environment:mapping.environment,kind:mapping.kind};
}
export function providerResourceKey(scope:ProviderResourceScope, resourceId:string):string {
    return JSON.stringify([scope.providerId,scope.accountId,scope.environment,scope.kind,resourceId]);
}
