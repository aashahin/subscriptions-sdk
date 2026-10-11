# Deep audit fixes

All 21 findings from the package audit are addressed in the implementation. The regression suite now contains 267 passing cases, including 83 added cases covering the audit and the concurrency problems found during independent review.

| Audit finding | Correction | Regression coverage |
| --- | --- | --- |
| 1 Elysia authorization and quota run after business effects | Authorize and atomically admit before execution; commit only successful consumption and release failed handlers | `tests/audit-http-fixes.test.ts` |
| 2 Dunning can overwrite paid recovery | Guard failure accounting and suspension by the live failed cycle and purchase state | `tests/audit-billing-fixes.test.ts` |
| 3 Current usage reset deletes history and tenant buckets | Apply explicit period and default tenant scope; retain the adapter's explicit legacy unbounded reset | `tests/audit-persistence-fixes.test.ts` |
| 4 Recreated subscription retains cancellation | Clear cancellation timestamps when starting the new subscription | `tests/audit-billing-fixes.test.ts` |
| 5 Repeated plan transitions reuse a completed operation | Include a durable billing revision in transition identity and settlement guards; return the actual applied plan | `tests/audit-billing-fixes.test.ts` |
| 6 Grace and extended cycles report zero consumption | Resolve explicitly selected usage by its period key; update stored period ends on mutations | `tests/audit-persistence-fixes.test.ts` |
| 7 Inclusive tax rounding changes gross money | Preserve gross minor units and derive rounded subtotal from gross less tax | `tests/audit-billing-fixes.test.ts` |
| 8 Currency rendering loses precision | Use currency-specific precision, including fallback and zero formatting | `tests/audit-template-fixes.test.ts` |
| 9 Renderer projections omit invoice details | Preserve persisted fields and display invoice number, subtotal, tax, discount, total and credit-note references | `tests/audit-http-fixes.test.ts`, `tests/audit-template-fixes.test.ts` |
| 10 Stripe resume clears the wrong field | Clear the parent `pause_collection` field | `tests/audit-provider-fixes.test.ts` |
| 11 Paddle pause and local state disagree | Pause immediately and resume the existing billing period | `tests/audit-provider-fixes.test.ts` |
| 12 Paddle checkout opens the success page | Use the configured default payment page or the adapter's distinct `checkoutUrl` | `tests/audit-provider-fixes.test.ts` |
| 13 Chromium launch ignores configuration | Apply browser options before initialization | `tests/audit-template-fixes.test.ts` |
| 14 Workers invoice rendering compiles forbidden dynamic code | Precompile the built-in template; use the Handlebars runtime and a portable custom renderer option | `tests/audit-template-fixes.test.ts`, neutral bundle/policy simulation |
| 15 Usage reports repeat complete entitlement reads | One entitlement snapshot and one bounded batch usage query for built-in adapters; compatible custom-adapter fallback | `tests/audit-persistence-fixes.test.ts` |
| 16 Outbox polling scans sent history | Add the status/claim-time index to the shipped schema and migration instructions | `tests/audit-persistence-fixes.test.ts` |
| 17 Plan duplication loses configuration | Copy trial days, alternate prices and metadata before overrides | `tests/audit-persistence-fixes.test.ts` |
| 18 Invalid numeric feature settings persist | Validate finite rates, safe integral limits/metered values, and registry defaults | `tests/audit-persistence-fixes.test.ts` |
| 19 Unlimited comparisons reverse direction | Treat the unlimited limit sentinel as greater than finite limits | `tests/audit-persistence-fixes.test.ts` |
| 20 Malformed JSON performs cancellation | Reject malformed/non-object bodies before mutation; preserve deliberately empty optional bodies | `tests/audit-http-fixes.test.ts` |
| 21 Malformed path encoding escapes error handling | Decode inside the protected request path and return HTTP 400 | `tests/audit-http-fixes.test.ts` |

Independent review also verified that overlapping dunning sweeps share one durable scheduled retry, Paddle resume cannot silently restart billing, and old quota receipts cannot change or emit limit events for a counter replaced by reset or an absolute setter. Billing/provider and persistence changes were reviewed by agents that did not implement those changes.

## Validation

Verified with Bun 1.4.3:

| Command | Result |
| --- | --- |
| `bun run --bun typecheck` | Native Bun checks pass: 43 source files and 68 files in the complete source/test/tooling project |
| `bun run --bun test` | 267 passed, 0 failed, 1127 assertions across 19 files |
| `bun run --bun check:templates` | Generated raw/precompiled artifacts match the canonical Handlebars source |
| `bun run --bun build` | JavaScript and declarations build at every package entry |
| `bun run --bun check:package` | Package lint and resolution checks pass at all 21 exports, retaining the existing resolution-rule exclusions |
| `bun run --bun check:edge` | Core bundles for the neutral platform |
| `git diff --check` | Passes |

The actual neutral core bundle also imported and rendered built-in/custom invoice HTML with dynamic function construction disabled. This is a Bun policy simulation; it does not claim a live Workers deployment. Provider tests mock HTTP while executing the real adapters; PDF tests mock the optional browser dependency. Persistence regressions use memory and actual Bun SQLite with the shipped schema. Live provider acceptance, live Prisma/PostgreSQL and real browser execution remain separate checks.

## Adoption

- Existing SQLite installations should add `billing_outbox_status_claimed_at_idx`; see [Drizzle schema](drizzle-schema.md).
- Custom adapters using handler admission must implement the guarded record-incarnation contract documented there. Ordinary `permissions.use()` retains its existing contract. Admission receipts remain local to the running process; a crash can leave conservatively held capacity, so a host needing crash recovery must reconcile usage from its durable business records.
- Workers custom invoices use `invoice.template`, a precompiled renderer function. `templateSource` and filesystem templates retain lazy compilation on compatible server runtimes. The exported Handlebars helper registry uses `handlebars/runtime`; compile templates during the application build or through the server rendering options.
- Paddle's `checkoutUrl` identifies an approved payment page hosting Paddle.js. Configure post-payment redirects in Paddle.js; resume continues the current paid period and fails if it can no longer be continued.

The Bun lockfile and validation scripts now select Bun explicitly. Full test checking replaces the old ambient test shim and fixes the broad feature-registry type inference without removing any existing regression scenario.
