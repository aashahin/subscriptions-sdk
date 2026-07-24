import { defineConfig } from 'tsdown';
import pkg from './package.json' with { type: 'json' };

/**
 * Dependencies and optional peer dependencies are never bundled — consumers
 * install them themselves. Node builtins stay external too so the runtime
 * (Node, Bun, Deno, Workers) resolves them at run time.
 */
const external: Array<string | RegExp> = [
	...Object.keys(pkg.dependencies ?? {}),
	...Object.keys(pkg.peerDependencies ?? {}),
	/^node:/,
	// Loaded lazily inside the conformance suites; only resolvable under Bun
	'bun:test',
];

export default defineConfig({
	entry: {
		index: 'src/index.ts',
		'integrations/elysia': 'src/integrations/elysia.ts',
		'integrations/http': 'src/integrations/http.ts',
		'integrations/hono': 'src/integrations/hono.ts',
		'integrations/next': 'src/integrations/next.ts',
		'adapters/prisma.adapter': 'src/adapters/prisma.adapter.ts',
		'adapters/moyasar.adapter': 'src/adapters/moyasar.adapter.ts',
		'adapters/cache.adapter': 'src/adapters/cache.adapter.ts',
		'adapters/redis.adapter': 'src/adapters/redis.adapter.ts',
		'adapters/upstash.adapter': 'src/adapters/upstash.adapter.ts',
		'adapters/cloudflare-kv.adapter': 'src/adapters/cloudflare-kv.adapter.ts',
		'adapters/drizzle.adapter': 'src/adapters/drizzle.adapter.ts',
		'adapters/stripe.adapter': 'src/adapters/stripe.adapter.ts',
		'adapters/paddle.adapter': 'src/adapters/paddle.adapter.ts',
		'adapters/lemonsqueezy.adapter': 'src/adapters/lemonsqueezy.adapter.ts',
		'pdf/puppeteer': 'src/pdf/puppeteer.ts',
		'pdf/cloudflare': 'src/pdf/cloudflare.ts',
		'templates/invoice-utils': 'src/templates/invoice-utils.ts',
		'testing/index': 'src/testing/index.ts',
		'audit/index': 'src/audit/index.ts',
		'core/events': 'src/core/events.ts',
	},
	format: 'esm',
	dts: true,
	clean: true,
	sourcemap: true,
	minify: false,
	external,
	// Keep .js/.d.ts output paths stable (package is "type": "module")
	outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
});
