// file: packages/subscriptions/src/core/features.ts
// Type-safe feature definition system

import type { FeatureDefinition, FeatureRegistry, FeatureValue, FeatureValues } from './types.js';
import { SubscriptionError } from './errors.js';

/**
 * Define a type-safe feature registry for your application.
 *
 * @example
 * ```typescript
 * const features = defineFeatures({
 *   analytics: { type: 'boolean', default: false },
 *   maxProducts: { type: 'limit', default: 100 },
 *   transactionFeePercent: { type: 'rate', default: 2.5 },
 * });
 * ```
 */
export function defineFeatures<T extends FeatureRegistry>(features: T): T {
    getDefaultFeatures(features);
    return features;
}

/**
 * Get the default values for all features in a registry
 */
export function getDefaultFeatures<T extends FeatureRegistry>(
    registry: T,
): FeatureValues<T> {
    const defaults = {} as FeatureValues<T>;

    for (const [key, definition] of Object.entries(registry)) {
        const defaultError = featureValueError(key, definition, definition.default);
        if (defaultError) throw new SubscriptionError(defaultError, 'INVALID_FEATURE_DEFINITION');
        (defaults as Record<string, unknown>)[key] = definition.default;
    }

    return defaults;
}

/**
 * Resolve feature values by merging plan features with defaults
 */
export function resolveFeatures<T extends FeatureRegistry>(
    registry: T,
    planFeatures: Partial<FeatureValues<T>> | null | undefined,
): FeatureValues<T> {
    const defaults = getDefaultFeatures(registry);

    if (!planFeatures) {
        return defaults;
    }

    return { ...defaults, ...planFeatures };
}

/**
 * Get a specific feature value from resolved features
 */
export function getFeatureValue<T extends FeatureRegistry, K extends keyof T>(
    registry: T,
    planFeatures: Partial<FeatureValues<T>> | null | undefined,
    feature: K,
): FeatureValue<T[K]> {
    const resolved = resolveFeatures(registry, planFeatures);
    return resolved[feature] as FeatureValue<T[K]>;
}

/**
 * Check if a feature is a boolean feature
 */
export function isBooleanFeature(definition: FeatureDefinition): boolean {
    return definition.type === 'boolean';
}

/**
 * Check if a feature is a limit feature
 */
export function isLimitFeature(definition: FeatureDefinition): boolean {
    return definition.type === 'limit';
}

/**
 * Check if a feature is a rate feature
 */
export function isRateFeature(definition: FeatureDefinition): boolean {
    return definition.type === 'rate';
}

/**
 * Validate that plan features match the registry definitions
 */
export function validatePlanFeatures<T extends FeatureRegistry>(
    registry: T,
    features: Partial<FeatureValues<T>>,
): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const [key, value] of Object.entries(features)) {
        const definition = registry[key];

        if (!definition) {
            errors.push(`Unknown feature: ${key}`);
            continue;
        }

        const featureError = featureValueError(key, definition, value);
        if (featureError) errors.push(featureError);
    }

    return { valid: errors.length === 0, errors };
}

function featureValueError(key: string, definition: FeatureDefinition, featureValue: unknown): string | null {
    const expectedType = definition.type === 'boolean' ? 'boolean' : 'number';
    if (typeof featureValue !== expectedType) return `Feature "${key}" expects ${expectedType}, got ${typeof featureValue}`;
    if (typeof featureValue !== 'number') return null;
    if (definition.type === 'rate') {
        return Number.isFinite(featureValue) && featureValue >= 0 && featureValue <= 100
            ? null : `Feature "${key}" rate must be finite and between 0 and 100`;
    }
    const minimum = definition.type === 'limit' ? -1 : 0;
    return Number.isSafeInteger(featureValue) && featureValue >= minimum
        ? null : `Feature "${key}" ${definition.type} must be a safe integer >= ${minimum}`;
}
