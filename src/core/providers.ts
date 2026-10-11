import type { PaymentGatewayAdapter } from '../adapters/payment.adapter.js';
import type { ProviderBinding } from './types.js';
import { SubscriptionError } from './errors.js';
export interface ProviderRegistration {
    /** Stable identity for this provider account, e.g. moyasar-sa-live. */
    id: string;
    accountId: string;
    environment: 'test' | 'live';
    billingOwner: 'sdk_managed' | 'provider_managed';
    adapter: PaymentGatewayAdapter;
}
/** Existing subscriptions always route using their persisted binding. */
export class ProviderRegistry {
    private readonly entries = new Map<string, ProviderRegistration>();
    constructor(entries: ProviderRegistration[] = [], readonly defaultProvider?: string) {
        for (const entry of entries) {
            if (!entry.id?.trim() || !entry.accountId?.trim() || !['test', 'live'].includes(entry.environment) || !['sdk_managed', 'provider_managed'].includes(entry.billingOwner)) {
                throw new SubscriptionError('Invalid provider account registration', 'INVALID_PROVIDER');
            }
            if (this.entries.has(entry.id))
                throw new SubscriptionError('Duplicate provider identity', 'INVALID_PROVIDER');
            this.entries.set(entry.id, entry);
        }
        if (defaultProvider && !this.entries.has(defaultProvider))
            throw new SubscriptionError('Default provider is not registered', 'INVALID_PROVIDER');
    }
    get(id: string): ProviderRegistration {
        const entry = this.entries.get(id);
        if (!entry)
            throw new SubscriptionError(`Unknown payment provider: ${id}`, 'UNKNOWN_PROVIDER', 400);
        return entry;
    }
    resolve(binding: ProviderBinding): ProviderRegistration {
        const entry = this.get(binding.providerId);
        if (entry.accountId !== binding.accountId || entry.environment !== binding.environment || entry.billingOwner !== binding.billingOwner) {
            throw new SubscriptionError('Persisted provider binding does not match configured account', 'PROVIDER_BINDING_MISMATCH', 409);
        }
        return entry;
    }
    defaultBinding(): ProviderBinding | undefined {
        if (!this.defaultProvider)
            return undefined;
        const { id, accountId, environment, billingOwner } = this.get(this.defaultProvider);
        return { providerId: id, accountId, environment, billingOwner };
    }
}
export function scopedProviderReference(binding: ProviderBinding, resourceId: string): string {
    return JSON.stringify([binding.providerId, binding.accountId, binding.environment, resourceId]);
}
