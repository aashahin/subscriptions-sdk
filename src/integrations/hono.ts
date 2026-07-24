// file: packages/subscriptions/src/integrations/hono.ts
// Hono integration for @abshahin/subscriptions.
// Thin wrapper around the shared web-standard HTTP handler. The `hono`
// package is an optional peer dependency, imported lazily so consumers who
// do not use Hono never load it.

import type { FeatureRegistry } from "../core/types.js";
import type { Subscriptions } from "../index.js";
import {
  createSubscriptionsHttpHandler,
  type SubscriptionsHttpOptions,
} from "./http.js";

/**
 * Minimal structural shape of a Hono context (avoids requiring hono types)
 */
export interface HonoLikeContext {
  req: { raw: Request };
}

/**
 * Minimal structural shape of a Hono app/sub-router (avoids requiring hono
 * types at build time). The real `Hono` instance satisfies this interface.
 */
export interface HonoLikeApp {
  fetch(
    request: Request,
    ...args: unknown[]
  ): Response | Promise<Response>;
  all(
    path: string,
    handler: (c: HonoLikeContext) => unknown,
  ): HonoLikeApp;
  route(path: string, app: unknown): HonoLikeApp;
}

/**
 * Create a Hono sub-router serving the subscription API.
 *
 * All requests reaching the sub-router are forwarded to the shared
 * web-standard handler, which locates its configured prefix (default
 * `/subscriptions`) anywhere in the request path — so the router can be
 * mounted under any base path.
 *
 * `hono` is an optional peer dependency and is imported lazily.
 *
 * @example
 * ```typescript
 * import { Hono } from 'hono';
 * import { honoPlugin } from '@abshahin/subscriptions/integrations/hono';
 *
 * const app = new Hono();
 * app.route('/api', await honoPlugin(subs));
 * ```
 */
export async function honoPlugin<TFeatures extends FeatureRegistry>(
  subs: Subscriptions<TFeatures>,
  options?: SubscriptionsHttpOptions,
): Promise<HonoLikeApp> {
  let HonoCtor: new () => HonoLikeApp;
  try {
    // Optional peer dependency — resolved at runtime only
    // @ts-ignore -- hono may not be installed in this workspace
    const mod = await import("hono");
    HonoCtor = mod.Hono as unknown as typeof HonoCtor;
  } catch {
    throw new Error(
      "honoPlugin: the 'hono' package is required. " +
        "Install it with `npm install hono`.",
    );
  }

  const handler = createSubscriptionsHttpHandler(subs, options);
  const app = new HonoCtor();
  app.all("*", (c) => handler.fetch(c.req.raw));
  return app;
}
