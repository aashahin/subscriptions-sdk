// file: packages/subscriptions/tests/workers-smoke/bundle-check.mjs
// Bundle check: proves the package core can be bundled for edge runtimes
// (Cloudflare Workers, Deno, Bun) with no Node-only imports reachable.
//
// Bundles src/index.ts with esbuild in --platform=neutral mode. Any
// top-level `node:*` import would fail the build, because neutral platform
// has no Node builtin shims. Optional peer dependencies are kept external
// (they are lazy `await import()` calls behind explicit opt-ins).
//
// Usage (from the package root):
//   node tests/workers-smoke/bundle-check.mjs
//
// Exits 0 on success, 1 on failure (printing the esbuild diagnostics).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const args = [
  "esbuild",
  "src/index.ts",
  "--bundle",
  "--format=esm",
  "--platform=neutral",
  "--target=es2022",
  // Handlebars ships its edge-safe build under the "browser" field.
  "--main-fields=browser,module,main",
  // Optional peer / integration dependencies — lazy-loaded by design.
  "--external:elysia",
  "--external:@prisma/client",
  "--external:puppeteer-html-pdf",
  "--external:ioredis",
  "--external:drizzle-orm",
  "--external:@cloudflare/puppeteer",
  "--external:hono",
  "--outfile=/dev/null",
  "--log-level=warning",
];

const result = spawnSync("npx", args, {
  cwd: packageRoot,
  stdio: "pipe",
  encoding: "utf8",
});

if (result.error) {
  console.error("bundle-check: failed to launch esbuild:", result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  console.error("bundle-check: FAILED — core bundle is not edge-safe.");
  if (result.stdout) console.error(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.status ?? 1);
}

if (result.stderr) process.stderr.write(result.stderr);
console.log("bundle-check: OK — src/index.ts bundles for platform=neutral with no Node-only imports.");
