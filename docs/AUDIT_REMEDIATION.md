# Audit remediation

Baseline: `dc9f3f75fe704845306e5d725a938b55b9679224`, package `0.2.0`. The initial checkout exactly matched that commit and had no local changes. Implementation, tests, schemas and examples have been corrected. Nothing was deployed/published, no live charge ran, and no user database migration was executed.

All 38 IDs have a `fixed` disposition for the stated defect/minimum foundation, subject to the explicit limits below. Finding 38 does **not** claim working Polar or Creem integration. The tested financial scope is SDK-managed collection with persisted attempts, mocked provider boundaries and actual Bun SQLite atomic local settlement.

## Validation and evidence boundaries

The commands below are historical evidence from that remediation run. Current development and package validation use the Bun workflow in [testing.md](testing.md); they do not invoke the historical Node/npm commands.

Bun `1.4.2` is installed at `/workspace/.tools/node_modules/.bin/bun` in this environment. Final commands/results:

| Command | Actual result |
| --- | --- |
| `bun test` | **184 passed, 0 failed, 845 assertions across 14 files.** |
| `bun run typecheck` | Passed. |
| `bun run build` | Passed for JS/declarations at every entry. Existing tsdown external deprecation warning remains. |
| `bun run test:invoices` | Passed; three HTML fixtures. PDF/Chromium execution was not run. |
| `bun tests/workers-smoke/bundle-check.mjs` | Passed; neutral core bundle contains no Node-only imports. |
| `git diff --check` | Passed. |
| `bun run check:package` | Executed but its helper did not recognize an existing tarball because captured npm pack stdout was empty. Writable npm cache fixed an earlier packing failure. Equivalent direct tarball checks below passed. |
| `npm pack --ignore-scripts --cache /tmp/subscriptions-npm-cache --pack-destination /tmp/subscriptions-final-package --loglevel error` | Passed; local artifact only. |
| `node node_modules/publint/src/cli.js /tmp/subscriptions-final-package/abshahin-subscriptions-0.2.0.tgz` | Passed: All good! |
| `node node_modules/@arethetypeswrong/cli/dist/index.js /tmp/subscriptions-final-package/abshahin-subscriptions-0.2.0.tgz --ignore-rules no-resolution --ignore-rules cjs-resolves-to-esm` | Passed at all 21 entries, using the repository's existing ignored rules. |

Actual Bun/Elysia app.handle routes and actual bun:sqlite with shipped Drizzle schema/FKs/unique indexes are covered. SQLite ABORT triggers and real UNIQUE failures establish rollback; tests also exercise multiple adapter instances sharing one connection. Prisma metadata tests execute actual mapping with mocked storage delegates, **not live Prisma**. Other services use the production memory adapter/fake gateway. Provider tests mock fetch while executing actual adapters/authentication/normalization.

Before/after evidence:

- Initial five public regressions failed on the baseline (forged upgrade, HTTP/Next header identity, default Elysia administration and missing guard), then passed.
- Three baseline quota/metadata regressions failed in `/tmp/persistence-before` using audited adapters: concurrent Drizzle admission/result, Drizzle replacement, Prisma delegate round trip.
- Seven lifecycle cases reproduced baseline failures in `/tmp/subscriptions-lifecycle-baseline`: anchor reset, expired preview/execution, deferred charge, failed-renewal dunning enrollment, pending-plan dunning, trial resume and provider reactivation.
- Independent review regressions caught wrong failure resources/lookup IDs, unlocked retries, colliding failure IDs, stale failure changing a newer period and missing reconciliation relay. Corrections now pass.
- Final calendar/quote review added trial/incomplete renewal-anchor and explicit proration-confirmation regressions. Isolated reconstructed pre-fix source (not the audited baseline) reproduced two shortened-period failures and three confirmation/unused-credit failures; corrected production paths pass. Deferred no-proration was a passing control.

No live/sandbox provider acceptance, live Prisma/PostgreSQL/libSQL/better-sqlite3 connector, Wrangler/D1 service or Browser Rendering execution occurred. Merchant/connector credentials were unavailable. Bundling verifies portability, not live Workers financial atomicity.

## Finding dispositions

Every referenced regression below passes in the final complete suite. Shared schema/API migration steps and remaining verification follow the per-finding record.
### 01 — Public plan changes can bypass collection — fixed

- **Current evidence and correction:** `src/integrations/http.ts`, `elysia.ts` and `src/services/subscriptions.service.ts` reject public bypass/payment assertions before mutation, including under Elysia host normalization. Persisted attempts bind subscriber, subscription, intended purchase, provider/account/environment and exact resource, amount and currency; scoped payment mappings prevent reuse.
- **Regression/result:** `tests/public-trust-boundary.test.ts` rejects authenticated HTTP and actual Elysia forgeries with zero collection; `tests/webhook-settlement.test.ts` rejects mismatched settlement. Security review verifies Moyasar given_id even after local persistence failure. Passes.
- **Compatibility/migration and limits:** Remove skipPayment, verifiedTokenId, paymentId and client token assertions. Store verified methods server-side; preview and confirm quoteId. A token/authorization alone never proves settlement.

### 02 — Unpaid paid-plan creation activates access — fixed

- **Current evidence and correction:** Service createSelfService uses trusted purchase/trial policy. Paid purchases without a trial start incomplete, without paid entitlement or premature paid invoice. Only verified settlement applies the paid period. Server policies manual_invoice/complimentary and renewAdministrative preserve authorized grants explicitly.
- **Regression/result:** Public-boundary and `tests/billing-remediation.test.ts` deny premium on incomplete rows and verify one numbered open manual invoice versus a complimentary grant with no invented payment. Passes.
- **Compatibility/migration and limits:** Code expecting create to grant an unpaid paid plan must select a trusted administrative policy or complete collection. Public transports expose no administrative policies. Historical rows require reconciliation.

### 03 — Caller-controlled subscriber identity — fixed

- **Current evidence and correction:** HTTP/Elysia require explicit trusted getSubscriberId; absence fails 401. Caller x-subscriber-id and implicit Elysia user context are no longer defaults. Hono/Next inherit HTTP policy. Optional authorizeSubscriber permits operations only on boolean true.
- **Regression/result:** Public tests cover HTTP/Next missing resolver, victim headers, Elysia user-shaped context, and authenticated nonmember HTTP/Elysia denial before reads/mutations. Passes.
- **Compatibility/migration and limits:** Supply a verified session-to-subscriber resolver; enforce membership there or in the operation hook. Host authentication/membership remains the host's responsibility.

### 04 — Permissive Elysia administration — fixed

- **Current evidence and correction:** `src/integrations/elysia.ts` disables administration by default and refuses admin:true without explicit adminGuard.
- **Regression/result:** Actual Bun/Elysia app.handle routes return 404 by default, reject guardless configuration, deny nonadmins with 403 and permit explicitly authorized plan operations. Passes.
- **Compatibility/migration and limits:** Enabling administration now requires administrative authorization; authentication alone is insufficient. Updated integration guide shows the guard.

### 05 — Client-selected trial duration — fixed

- **Current evidence and correction:** Public subscribe accepts plan ID only. Service derives self-service duration from trusted plan/application policy, validates integer days 0–365, and suppresses repeat trial on an existing subscriber row.
- **Regression/result:** Public tests reject client trialDays through HTTP/Elysia, use trusted plan duration and prevent a repeat trial after cancellation. Passes.
- **Compatibility/migration and limits:** Move trials to trusted configuration. Retain subscriber history: deleting/recreating subscriber identities can defeat host-level eligibility.

### 06 — Inactive plans remain purchasable — fixed

- **Current evidence and correction:** Service target resolution rejects inactive plans for creation/change/renewal and checks again before settlement. `src/services/plans.service.ts` reads authoritative rows rather than cached activation/prices.
- **Regression/result:** Billing remediation rejects inactive creation; entitlement regressions show cache invalidation failure cannot return stale plan activation/pricing. Passes.
- **Compatibility/migration and limits:** Existing paid periods retain lifecycle-based eligibility. Renewal into an inactive target fails; explicitly migrate/grandfather before another collection.

### 07 — Idempotency and unknown outcomes — fixed

- **Current evidence and correction:** Service persists logical purchase, attempt UUID and a subscription lock before network access; CAS admits one collector. Provider calls run outside transactions. Moyasar sends given_id and Stripe its stable idempotency key. Transport/5xx/malformed success, pending and authorized outcomes remain unresolved. Only confirmed failure permits a next attempt; lookup reconciles exact resource/amount/currency.
- **Regression/result:** Actual SQLite `tests/billing-collection.test.ts` and persistence tests prove concurrent collection once and recovery after provider-accepted/lost response without recollection. Security tests cover competing target locks, in-flight retry locks, unknown dunning and wrong paid/failed lookup evidence. Passes.
- **Compatibility/migration and limits:** Add operation/outbox/resource storage. reconcilePayment never initiates collection and reports applied/failed/unknown/requires_review. A crashed collecting attempt requires authoritative reconciliation; elapsed time does not authorize another charge. Stripe unknown creation without a PaymentIntent ID cannot be looked up by idempotency UUID.

### 08 — Partial subscription/invoice persistence — fixed

- **Current evidence and correction:** Settlement application transaction owns operation CAS, resource uniqueness, subscription change, numbered invoice and outbox. Errors propagate and roll back access; verified outcomes remain saved for local replay without charging again. Unsupported awaited rollback fails before financial effects.
- **Regression/result:** Real SQLite UNIQUE and invoice/outbox ABORT failures preserve old entitlement/period and roll sequence/invoice/events back. Concurrent renewals/webhooks apply one effect. Canceled/paused/stale funded purchases remain unapplied. Passes.
- **Compatibility/migration and limits:** Existing real invoice uniqueness was retained, not misrepresented as absent. Local atomicity cannot reverse provider funds; stale paid funds need operator reconciliation. Enable financial work only on suitable storage.

### 09 — Provider webhook mismatch — fixed

- **Current evidence and correction:** HTTP/Elysia pass exact raw body/full headers with no universal signature gate. Moyasar authenticates configured body secret_token and scope, normalizing native underscore events. Paddle verifies semicolon HMAC/rotated signatures; Lemon Squeezy verifies signature/store/environment; Stripe verifies raw bytes.
- **Regression/result:** Transport tests accept native Moyasar without signature header and reject forged secret. `tests/moyasar-contract.test.ts` and `tests/provider-normalization.test.ts` cover valid/invalid native fixtures, raw UTF-8, absent verification configuration and environment/account mismatch. Passes.
- **Compatibility/migration and limits:** Configure each actual provider secret/scope and registration ID. Verification fails closed. Official sources below support contract choices; merchant sandbox acceptance is unverified.

### 10 — Subscription updates counted as settlement — fixed

- **Current evidence and correction:** `src/index.ts` dispatches payments separately from snapshots. Service snapshots can conservatively restrict state, never create paid invoices/extend periods, use mapped native subscription IDs and stale timestamp guards, and issue no commands. Failure delivery affects only the matching current purchase/cycle and lock.
- **Regression/result:** SQLite snapshot with renewal metadata creates no invoice/access; provider/lifecycle tests distinguish snapshot/payment IDs. Security review proves wrong failure resources and delayed failure cannot suspend a newer period or unlock its collector. Passes.
- **Compatibility/migration and limits:** Map native subscription separately. Full provider-managed paid-period synchronization remains unsupported; subscription snapshots alone cannot establish paid renewal.

### 11 — Lost/duplicated events and outbox — fixed

- **Current evidence and correction:** `src/core/events.ts` relays persisted events after mutation/reconciliation instead of fabricating events. Services atomically persist stable logical identities. `src/adapters/outbox.adapter.ts` retains failed identity; stores use five-minute claims and release failed delivery claims. Plan changes and last-slot quotas persist their events atomically too.
- **Regression/result:** SQLite outbox abort rolls access back; duplicate payments/markPaid emit one logical event and delivery retries reuse its ID. Security tests retain distinct failure IDs and relay reconciliation. Entitlement tests roll back plan/quota mutations on outbox failure. Passes.
- **Compatibility/migration and limits:** withEvents requires transaction-owned durable outbox. Run relayOutbox at startup/on existing scheduler for crash recovery; delivery is at least once and receivers deduplicate IDs. Delivery failure does not pretend a committed mutation failed.

### 12 — Dunning enrollment/reset — fixed

- **Current evidence and correction:** Verified renewal failure atomically enters cycle-scoped recovery/past_due; optional upgrade failure preserves paid access. All supported settlement paths clear retry/recovery/pending metadata. Failure can alter only the matching current cycle; canceled/paused states are not reactivated.
- **Regression/result:** Lifecycle tests exercise failed renewal→dunning→paid cleanup and optional upgrade failure; security tests block unknown retries and stale failure enrollment. Passes.
- **Compatibility/migration and limits:** Reconcile old exhausted recovery metadata with the actual paid cycle. Only SDK-owned subscriptions enter local dunning; payment suspension cannot resume as an unpaid grant.

### 13 — Dunning charge/invoice disagreement — fixed

- **Current evidence and correction:** Renewal saves one immutable quote resolving pending plan before collection. Dunning uses the same price, currency, period and plan; catalog edits cannot replace attempt terms.
- **Regression/result:** Lifecycle and real SQLite collection tests assert pending downgrade charge, invoice and applied plan agree, including retries after confirmed failure. Passes.
- **Compatibility/migration and limits:** Reconcile existing purchases using verified terms, not a changed catalog. Pending access applies only at settled renewal.

### 14 — Proration grants an uncharged full period — fixed

- **Current evidence and correction:** `src/core/billing-policy.ts` charges remaining-period difference for comparable paid prices and preserves original start/end. Full-price/no-proration/trial conversion starts a full new period.
- **Regression/result:** Production helper and service lifecycle tests assert payable amount and unchanged prorated anchor. Trial/incomplete initial renewal charges a full Oct25–Nov25 period and preserves day25 on subsequent renewal. Passes.
- **Compatibility/migration and limits:** Save immutable paid-period price evidence; current catalog is not historical paid credit. Cross-duration/currency proration remains unsupported.

### 15 — Expired preview/execution mismatch — fixed

- **Current evidence and correction:** Preview/execution share calculation and persisted opaque quote bound to subscriber/subscription/version/price/timing. Expired periods quote full target price. Quotes last at most five minutes and never beyond prorated period end, with inclusive expiry rejection.
- **Regression/result:** Lifecycle/helper tests cover expired active status, exact quote expiry, catalog edits, historical settled credit, matching explicit proration on trial/free conversion, deferred policy, and quoteId-only legacy full-price confirmation without demanding unused credit evidence. Passes.
- **Compatibility/migration and limits:** Payable changes require preview/quoteId and fresh confirmation when stale. Missing legacy paidPrice fails BILLING_PRICE_BACKFILL_REQUIRED before proration.

### 16 — Deferred upgrades charged immediately — fixed

- **Current evidence and correction:** Timing precedes collection; deferred change saves renewal target and charges zero now. Old access remains until settled renewal.
- **Regression/result:** Lifecycle/helper tests prove no immediate collection/invoice/target access for deferred upgrade. Passes.
- **Compatibility/migration and limits:** executePendingChanges no longer grants pending access independently; renewal settlement applies it. There is no implicit prepayment policy.

### 17 — Currency/interval/precision errors — fixed

- **Current evidence and correction:** Quotes use normalized supported ISO currency, minor units, interval/count and immutable price snapshots. Unsupported currency/duration transitions fail before collection. Invoice/coupon calculations share currency helpers rather than fixed ×100.
- **Regression/result:** Helper tests reject invented/nonfinite/unsafe money; service tests confirm JPY/KWD quote→collection→invoice agreement. Coupon tests reject fixed currency mismatch and verify precision. Passes.
- **Compatibility/migration and limits:** Use supported currency codes and integer measurement units. Cross-currency/duration migration requires a separate explicit financial flow. JS money is bounded to safe minor-unit integers.

### 18 — Trial resume manufactures paid credit — fixed

- **Current evidence and correction:** Service records pre-pause status/voluntary reason; resume restores trialing and local trial boundaries. Paid-price evidence distinguishes actual paid credit. Suspension requires settlement; provider-owned periods do not extend locally.
- **Regression/result:** Lifecycle trial conversion after pause charges full price; remediation keeps trialing; helpers credit neither trial nor complimentary access. Passes.
- **Compatibility/migration and limits:** Legacy paused rows without reliable pre-pause evidence fail closed and need reconciliation.

### 19 — Local-only reactivation — fixed

- **Current evidence and correction:** Owning native provider receives supported cancelAtPeriodEnd:false before local cancellation clears. Unsupported capabilities fail explicitly; Moyasar local scheduling invents no native command; snapshot reducers never command providers.
- **Regression/result:** Lifecycle tests verify provider update, unsupported failure preserving cancellation, and no incoming-event command. Paddle fixture verifies scheduled_change:null. Passes.
- **Compatibility/migration and limits:** Persist native subscription/ownership separately. Provider rejection preserves cancellation; uncertain remote command results require reconciliation.

### 20 — Calendar overflow — fixed

- **Current evidence and correction:** Billing policy uses UTC, clamps destination day and preserves original day/end-of-month anchor across renewals.
- **Regression/result:** Helper tests cover Jan31→February, leap-year yearly boundaries and Jan30→Feb28→Mar30; production renewal retains anchor. Passes.
- **Compatibility/migration and limits:** Already drifted historical anchors require authoritative backfill. Provider-owned periods are not extended from webhook receipt time; authoritative synchronization is a remaining integration requirement.

### 21 — Metadata erases reserved fields — fixed

- **Current evidence and correction:** Prisma/Drizzle preserve current-row _billing during public metadata replacement and reject caller _billing. Drizzle uses atomic JSON/JSONB update; Prisma serializable transactions/retry. Binding/prices/quantity/add-ons and invoice numbering/tax/credit links round trip independently.
- **Regression/result:** Actual SQLite concurrent replacement preserves fields; actual Prisma mapping with mocked delegates retains reserved fields. Both baseline regressions failed. Passes.
- **Compatibility/migration and limits:** Preserve reserved JSON during migration; already lost values need verified backfill. Mocked delegate coverage does not establish live Prisma semantics. Dedicated columns shadowing metadata require host coherence.

### 22 — Resetting counters for persistent resources — fixed

- **Current evidence and correction:** FeatureDefinition.usage selects persistent gauge or periodic UTC month/subscription-cycle consumption. Permissions pass explicit bounds for every read/mutation; bulk reset skips persistent inventory.
- **Regression/result:** Entitlement and SQLite tests prove inventory survives rollover, calendar reset and cycle counters spanning months until authoritative period changes. Passes.
- **Compatibility/migration and limits:** Omitted policy retains calendar month. Declare products/seats/inventory persistent and backfill from authoritative resources; historical counters cannot prove current inventory. Provider cycle must first be synchronized.

### 23 — Invalid usage quantities — fixed

- **Current evidence and correction:** Permissions permit limit/metered accounting only; use/release/canUse require positive safe integers, set nonnegative safe integers. Caps/counts and cumulative adapter arithmetic are validated.
- **Regression/result:** Entitlement suite rejects negative/zero/fractional/nonfinite/string/unsafe values and non-usage features without accounting changes; zero absolute set is valid. Passes.
- **Compatibility/migration and limits:** Choose integer units for fractional measures; release positive quantities instead of negative consumption. Custom adapters retain overflow protection.

### 24 — Cache failure corrupts accounting — fixed

- **Current evidence and correction:** Capped usage uses atomic reserve, failing closed without support. Rejected admission never increments; no compensation decrement exists. Cache failures are best effort, independent of durable accounting; genuine outbox failure rolls transaction back.
- **Regression/result:** Throwing all cache boundaries preserves 9 after rejected +2, commits accepted +1 once and releases once. Concurrent last slot admits one; failed outbox rolls reservation back. Passes.
- **Compatibility/migration and limits:** Custom capped adapters need conditional reservation. canUse previews, use determines admission. Uncapped legacy increment does not imply stronger financial transaction support.

### 25 — Stale cached entitlement — fixed

- **Current evidence and correction:** Permissions validate authoritative subscription/plan before cache; envelopes fingerprint lifecycle/features with hard expiration and bounded TTL. Plan reads bypass stale cached activation/prices.
- **Regression/result:** Expiry works even with cache ignoring TTL; same-timestamp feature changes invalidate access/caps, and failed invalidation cannot preserve purchase policy. Passes.
- **Compatibility/migration and limits:** Entitlement reads now perform DB reads. Future optimization needs durable revisions rather than trusting TTL. Configured grace remains explicit policy.

### 26 — Shared-cache project leakage — fixed

- **Current evidence and correction:** SDK/direct plan and permissions constructors require nonempty cacheNamespace with real cache and prefix every used service key.
- **Regression/result:** Two independent databases sharing cache/subscriber IDs keep distinct entitlement; omitted namespace rejects configuration. Passes.
- **Compatibility/migration and limits:** Choose stable application/database/environment namespace. Old unprefixed entries can expire. Isolated/noop deployments were not universally affected.

### 27 — Metered eligibility bypass — fixed

- **Current evidence and correction:** Permissions resolve subscription validity before permitting overage/unlimited admission. Missing metered subscriber previews false and cannot consume; expired metered access fails consistently.
- **Regression/result:** Entitlement regressions cover expired can/canUse/use and absent/trial/canceled/paused states through caches. Passes.
- **Compatibility/migration and limits:** Billable overage now requires an eligible subscription. Explicit default non-subscriber boolean/limit policies remain available.

### 28 — Drizzle later-result admission race — fixed

- **Current evidence and correction:** Drizzle mutation returns its own RETURNING count; capped admission is one conditional mutation, not increment followed by SELECT.
- **Regression/result:** Actual SQLite increments return [1,2]; ten callers competing for one slot admit one and persist cap. Baseline failed result/admission test. Passes.
- **Compatibility/migration and limits:** Original increments were atomic; this fixes admission/result semantics, not lost increments. Drivers need RETURNING and custom adapters atomic reservation.

### 29 — Driver transaction overstatement — fixed

- **Current evidence and correction:** Database advertises asyncTransactions. Bun SQLite queues all calls across shared-connection adapters and uses explicit BEGIN IMMEDIATE/await/COMMIT/ROLLBACK. better-sqlite3 requires explicit connection mode; async connectors explicit awaited mode. D1/unknown reject callbacks before effects. Memory rollback uses serialized deep snapshots.
- **Regression/result:** Actual SQLite commit/rollback/UNIQUE/ABORT and cross-instance isolation pass. D1/unknown boundary tests prove callback not invoked; memory restores in-place usage/coupon mutations. Passes.
- **Compatibility/migration and limits:** D1 ordinary persistence/single-statement quotas remain portable but SDK financial transactions are unsupported. Only Bun SQLite was actually driver-tested. Direct driver access bypasses the queue; retried callbacks must contain local effects only.

### 30 — Coupon cap race — fixed

- **Current evidence and correction:** Coupon apply requires purchase ID; adapters atomically check eligibility/cap and persist unique redemption with immutable snapshot. Replay returns original discount; release decrements once with tombstone. Unsafe unbound incrementRedemptions rejects.
- **Regression/result:** Actual SQLite and service tests admit one last-slot purchase, preserve original snapshot after edits, replay/release once, reject inactive/expired and cross-coupon/released identity reuse. Passes.
- **Compatibility/migration and limits:** Add redemption tables/stable server intended-purchase ID. Release only confirmed failed/abandoned purchases, never unknown or settled. Discount orchestration and recurring attachment remain host responsibility.

### 31 — Invoice numbering bypass/duplicate examples — fixed

- **Current evidence and correction:** Settlement calls transaction-owned InvoicesService: invoice, sequence, credit link and paid outbox share persistence. Prisma count and Drizzle later-read sequence fallbacks are removed. Guide uses operation invoice/settled amount rather than creating a second full-price invoice.
- **Regression/result:** SQLite uses INV-000001 and rolls sequence back after invoice abort without recollection. Credit-note abort rolls numbering/linkage back, preserves KWD and rejects repeat. Concurrent markPaid emits once. Passes.
- **Compatibility/migration and limits:** Prisma needs BillingSequence; service invoice creation requires awaited transactions. Unique numbers do not promise gap-free standalone sequence commits. Remove manual post-upgrade invoice creation.

### 32 — Fabricated Moyasar native subscriptions — fixed

- **Current evidence and correction:** Moyasar advertises direct token payment/embedded form. Exported customer/native subscription methods fail unsupported before network access; no priceId-as-money, invented periods or subscriber/token overload remains. Local SDK scheduling uses distinct identities.
- **Regression/result:** Moyasar contract suite executes unsupported exported methods with zero requests and real adapter charge/lookup production paths. Passes.
- **Compatibility/migration and limits:** Stop calling Moyasar native subscription APIs; use SDK scheduling and server-verified reusable tokens. Host scheduler must invoke due renewals.

### 33 — Cancellation implicitly voids Moyasar funds — fixed

- **Current evidence and correction:** Unsupported native cancellation no longer voids. SDK cancellation stops future local billing; explicit adapter void/refund remain distinct financial operations and propagate failures.
- **Regression/result:** Moyasar exported cancellation makes no request; lifecycle cancellation/reducer boundaries issue no implicit financial reversal. Passes.
- **Compatibility/migration and limits:** A separately authorized flow must decide void/refund. Canceling future service does not automatically repay settled funds.

### 34 — Invented checkout/portal sessions — fixed

- **Current evidence and correction:** Moyasar hosted checkout/portal fail unsupported. Embedded configuration returns actual form settings without fake URL/session/expiry. Hosted adapters omit provider-unsupplied expiry.
- **Regression/result:** Moyasar tests verify unsupported sessions and amount/currency form settings; provider tests reject unsupported trials and invented expiry. Passes.
- **Compatibility/migration and limits:** Use official embedded form; callbacks must resolve verified payment, not assert settlement. Moyasar portal remains unsupported.

### 35 — Authorization conflated with settlement — fixed

- **Current evidence and correction:** Payment contract preserves authorized/pending/unknown separately. Authorization cannot activate access, create paid invoice or permit another attempt. Actual captured amount, not authorization total, proves settlement.
- **Regression/result:** Moyasar/Stripe fixtures preserve authorization/partial capture; SQLite collection tests block authorized/pending retries. Passes.
- **Compatibility/migration and limits:** Default access requires full matching settlement. Capture is distinct; partial mismatches require review instead of granting full access.

### 36 — Outages disguised as absence — fixed

- **Current evidence and correction:** Moyasar lookup returns null only for 404; credentials/rate-limit/5xx/network/malformed responses surface classified errors. Collection uncertainty remains unresolved.
- **Regression/result:** Moyasar tests exercise 404 versus 401/429/500/transport/malformed boundaries through actual adapter with mocked fetch. Passes.
- **Compatibility/migration and limits:** Handle lookup errors explicitly; unavailable provider does not imply rejected collection or permission to recharge.

### 37 — Token status contract drift — fixed

- **Current evidence and correction:** Moyasar types/runtime accept documented initiated/active/inactive; reusable methods require active. Initiation remains pending with no invented verification/access.
- **Regression/result:** Moyasar fixtures execute real lookups for all three values and reject unknown statuses. Passes.
- **Compatibility/migration and limits:** Replace verified/failed token-state assumptions. Fixtures verify local contract handling; merchant acceptance remains unverified.

### 38 — Persistent routing and ownership foundation — fixed

- **Current evidence and correction:** `src/core/providers.ts` resolves stable configured identities against protected persisted billing binding. All adapters provide immutable scoped mappings for customer/method/subscription/product/price/payment with uniqueness in both directions. Server bindProviderResource checks scope. Capabilities, provider-specific raw-body/header verification, normalized events and reconcilePayment form the shared foundation. Default affects new purchases only; local renewal/dunning rejects provider ownership.
- **Regression/result:** SQLite tests preserve old account/method routing after default change; provider-managed billing makes no local collection. Mapping tests cover six kinds, both uniqueness directions, account/environment/provider separation, idempotence and rollback. Lifecycle/security tests exercise ownership, stale state and reconciliation. Passes.
- **Compatibility/migration and limits:** Backfill verified ownership and maps; do not reinterpret generic IDs or default-reroute existing rows. No Polar/Creem financial adapter, checkout, verified webhook contract or paid-period synchronizer is shipped. The requested minimum foundation is fixed; the actual three-provider combination remains unsupported.

## Migration instructions

1. Apply additive schemas before paid operations. Drizzle adds billing_operations, provider_resources, billing_outbox, coupons and coupon_redemptions alongside existing billing_sequences; DDL/driver recipes are in [drizzle-schema.md](./drizzle-schema.md). Prisma requires BillingOperation, ProviderResource, BillingOutbox, BillingSequence and optional Coupon/CouponRedemption; see [prisma-schema.md](./prisma-schema.md). Generate the client after application-reviewed migration. No external migration was run.
2. Preserve existing _billing JSON. Backfill each subscription's verified provider/account/environment/owner and distinct customer/method/native subscription/catalog/payment associations. Keep historical invoice references unless a verified application-specific mapping supports conversion; new references serialize provider/account/environment scope. Do not infer history from global default or overloaded gateway ID.
3. Backfill metadata.paidPrice using actual settled price, currency, interval/count and paid-through period before legacy proration. Catalog values cannot prove paid credit. Reconcile historical status, lost metadata and partial baseline writes against authoritative records.
4. Replace client payment/trial assertions with trusted identity/membership and quote confirmation. Admin routes require explicit guards. Deliberate grants use server-only manual_invoice/complimentary policies; initial paid purchase stays incomplete until settlement. Verify reusable method ownership server-side.
5. Configure a cache namespace unique to app/database/environment. Mark inventories persistent and backfill from actual resources. Normalize historical null usage tenant IDs and resolve collisions before relying on composite uniqueness. Custom adapters must honor periods and atomic validated admission.
6. Use declared/verified awaited transactions with operation CAS, scoped mapping uniqueness, numbering and transaction-owned outbox. D1/unknown default modes fail closed for SDK financial mutations. Bun SQLite shared connections must use queued adapter access; async connectors require actual driver isolation/rollback acceptance.
7. Coupon apply requires stable server purchaseId and immutable discounted financial terms. Release only confirmed failed/abandoned reservations. Consumers deduplicate outbox IDs; relay at startup/existing scheduled work. No new background service was introduced.
8. Consumers must handle optional provider capabilities, unknown/authorized results, unsupported sessions and lookup errors. Use ChangePlanResult.invoice; remove duplicate post-upgrade invoices and independent pending-access activation jobs.

Updated examples: [integration-guide.md](./integration-guide.md), [runtime-support.md](./runtime-support.md), [billing.md](./billing.md), [events.md](./events.md), [dunning.md](./dunning.md), [coupons.md](./coupons.md).

## Official provider contracts

Contract decisions use official sources also linked in [adapters.md](./adapters.md):

- Moyasar: [idempotency/given_id](https://docs.moyasar.com/api/idempotency), [webhook reference](https://docs.moyasar.com/api/other/webhooks/webhook-reference), [available events](https://docs.moyasar.com/api/other/webhooks/available-webhooks), [token statuses](https://docs.moyasar.com/api/other/tokens/token-status-reference), [embedded form](https://docs.moyasar.com/guides/card-payments/basic-integration).
- Paddle: [signatures](https://developer.paddle.com/webhooks/signature-verification), [completed transaction](https://developer.paddle.com/webhooks/transactions/transaction-completed), [reactivation/update](https://developer.paddle.com/api-reference/subscriptions/update-subscription).
- Lemon Squeezy: [signing](https://docs.lemonsqueezy.com/help/webhooks/signing-requests), [events](https://docs.lemonsqueezy.com/help/webhooks/event-types), [subscription invoice](https://docs.lemonsqueezy.com/api/subscription-invoices/the-subscription-invoice-object).
- Stripe: [webhooks](https://docs.stripe.com/webhooks), [idempotency](https://docs.stripe.com/api/idempotent_requests).

## Readiness and outstanding verification

The tested SDK-managed scope now enforces trusted public input, immutable quotes, one collection admission, uncertain-outcome reconciliation, atomic local settlement/outbox, actual SQLite uniqueness/rollback and durable entitlement/usage rules. These checks support those specific guarantees; passing them does not establish production readiness.

**Moyasar + Polar + Creem operation is not ready.** Polar/Creem adapters and native checkout/payment/paid-period reconciliation are absent. Provider snapshots deliberately cannot manufacture paid renewal access. Implement and verify those actual integrations before enabling the combination; product/price mappings are preparation rather than checkout implementation.

Moyasar still requires merchant sandbox acceptance for active-token reuse, given_id replay after lost response, body-secret webhooks, partial capture and account/environment scope. Stripe/Paddle/Lemon Squeezy changes likewise need configured sandbox acceptance. Live suites are still required for Prisma/PostgreSQL/libSQL/better-sqlite3. D1 financial transactions remain unsupported by this shipped adapter. No configured credentials/bindings were available for these external checks.

Funds received after cancellation/pause/conflicting purchase, partial or mismatched settlement and missing historical ownership/price evidence require operator reconciliation. SDK preserves evidence and reports requires_review rather than silently granting access or reversing funds. At-least-once consumer idempotency and existing scheduler invocation remain application responsibilities.
