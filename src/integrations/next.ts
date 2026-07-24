// file: packages/subscriptions/src/integrations/next.ts
// Next.js (App Router) integration for @abshahin/subscriptions.
// Thin wrapper around the shared web-standard HTTP handler — no Next.js
// imports, so this module works with any Next.js version (or any framework
// following the same route-handler convention).

import type { FeatureRegistry } from "../core/types.js";
import type { Subscriptions } from "../index.js";
import {
  createSubscriptionsHttpHandler,
  type SubscriptionsHttpOptions,
} from "./http.js";

/**
 * Next.js App Router style route handlers
 */
export interface NextRouteHandlers {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
}

/**
 * Create Next.js App Router route handlers for the subscription API.
 *
 * The handler locates its configured prefix (default `/subscriptions`)
 * anywhere in the request path, so the route file can live under any base
 * path (e.g. `app/api/subscriptions/[...slug]/route.ts`).
 *
 * @example
 * ```typescript
 * // app/api/subscriptions/[...slug]/route.ts
 * import { createNextHandlers } from '@abshahin/subscriptions/integrations/next';
 * import { subs } from '@/lib/subscriptions';
 *
 * export const { GET, POST } = createNextHandlers(subs, {
 *   getSubscriberId: (req) => req.headers.get('x-tenant-id'),
 * });
 * ```
 */
export function createNextHandlers<TFeatures extends FeatureRegistry>(
  subs: Subscriptions<TFeatures>,
  options?: SubscriptionsHttpOptions,
): NextRouteHandlers {
  const handler = createSubscriptionsHttpHandler(subs, options);
  return {
    GET: (request) => handler.fetch(request),
    POST: (request) => handler.fetch(request),
  };
}
