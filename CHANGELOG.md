# Changelog

All notable changes to this package will be documented in this file.

## 0.1.4 - 2026-06-21

### Fixed

- **Payments: stopped a double-charge on renewal webhooks.** `handleWebhook` previously called `renew()` (which charges the saved token) while handling a `payment.paid` event, charging the customer a second time for a payment that already succeeded. Renewals triggered from a successful-payment webhook now skip the charge and are recorded as paid externally.
- **Invoices: standardized stored amounts on major/display units everywhere.** The Elysia `/subscribe` and `/change-plan` routes stored amounts in the smallest unit (`× 100`) while the service layer and documented API used major units, and the invoice download endpoint always divided by 100 — so service-created invoices (e.g. cron renewals) rendered as `0.49` instead of `49`. All invoice creation and rendering now use major units consistently.
- **Webhooks: idempotent payment processing.** A successful-payment webhook is now skipped when an invoice for the same gateway payment already exists, preventing duplicate renewals/invoices when both a cron job and a webhook observe the same charge. Backed by an optional `invoices.findByGatewayInvoiceId` adapter method.
- **Webhooks: resolve subscriber from `subscriberId` (falling back to `tenantId`).** Charges issued by the SDK attach `subscriberId`; the handler previously only read `tenantId`, so renewal/cancel branches never fired for SDK-initiated charges.
- **Security: Moyasar webhook verification now fails closed.** When a `webhookSecret` is configured, a missing or empty signature is rejected instead of being silently accepted.
- **Security: Elysia webhook route now reads the `x-moyasar-signature` header**, so Moyasar signatures are actually verified (previously only `stripe-signature` / `x-webhook-signature` were checked, silently skipping verification for Moyasar).
- **Usage: atomic, floor-safe decrement in the Prisma adapter.** Replaced the read-then-write decrement (which lost concurrent updates despite the interface promising atomicity) with a single guarded atomic update that never drops below zero.
- **Usage: deterministic monthly periods in UTC.** Usage period boundaries were computed in the server's local timezone, shifting the billing window by region/DST; they are now computed in UTC.
- **Proration: guarded against divide-by-zero** for zero-length billing periods and centralized the proration math used by `changePlan` (removing three divergent copies).
- **Build: the package now type-checks and builds without the optional `puppeteer-html-pdf` dependency installed**, via an ambient type declaration for the dynamically imported module.

### Added

- `SubscriptionsService.recordPaymentFailure(subscriberId, message)` to record payment failures through the service (keeping caches consistent) instead of writing to the database directly.
- Optional `DatabaseAdapter.invoices.findByGatewayInvoiceId` for idempotent webhook handling.
- `RenewSubscriptionOptions.paidExternally` and `gatewayInvoiceId` so a renewal can be recorded as already paid by an external flow.

## 0.1.2 - 2026-05-06

### Added

- Rebuilt `src/templates/subscription-invoice.hbs` with a simple black-and-white invoice layout.
- Added `tests/generate-test-invoices.ts` for generating sample invoice HTML fixtures.
- Added `test:invoices` script to `package.json` for easy invoice fixture generation.

## 0.1.1 - 2026-04-04

### Added

- Added invoice HTML rendering helpers and Node.js PDF generation support from the package root.
- Added Elysia invoice download support using the bundled Handlebars template and optional `puppeteer-html-pdf` dependency.

### Fixed

- Corrected webhook invoice amount handling to avoid double-division of gateway values before invoice creation.
- Hardened webhook signature validation with a timing-safe verification flow and malformed hex rejection.
- Rehydrated cached subscription and plan `Date` fields so cached reads preserve `Date` behavior.
- Made permission usage increments rollback safely when post-increment validation fails.
- Tightened plan deletion rules so plans with active subscribers or pending downgrades cannot be removed.
- Updated subscription renewal, resume, and lifecycle flows to handle paused subscriptions, expired trials, pending downgrades, and invoice creation consistently.
- Fixed resumed subscriptions so billing periods recalculate correctly after paused subscriptions expire.
- Fixed same-plan previews and preserved generic typing in plan change result APIs.
- Validated numeric feature limits as finite integers and preserved calendar-month billing interval calculations.
- Hardened subscription lifecycle cache invalidation and Redis cron locking so usage state updates cannot be skipped or cause concurrent scheduler execution.

### Changed

- Replaced public `Buffer` webhook payload types with `Uint8Array` to keep the public API runtime-neutral.
- Updated the Moyasar adapter to accept `string | Uint8Array` webhook payloads and decode binary payloads with `TextDecoder`.
- Changed PDF generation helpers to return `Uint8Array` instead of `Buffer`.
- Moved `puppeteer-html-pdf` to an optional peer dependency and documented invoice PDF generation as Node.js-only.
- Added `elysia` as a development dependency so the optional integration typechecks cleanly in this workspace.
- Switched package exports to compiled `dist` output, added `main`/`types` entrypoints, and kept the invoice template bundled in publish output.
- Standardized package internals on explicit `.js` import paths and expanded public entrypoint exports for services, adapters, and invoice helpers.
- Moved invoice template loading to `node:fs/promises`.
- Added cache rehydration for `Date` fields on cached subscriptions and plans so deserialized reads preserve date behavior.
- Expanded Prisma adapter capabilities to detect active subscribers, detect pending downgrades, and query invoices by subscriber.
- Tightened plan deletion rules so plans with active or pending subscribers cannot be removed.
- Updated subscription lifecycle flows to create invoices for new paid subscriptions and upgrades, preserve pending downgrade metadata, and keep same-plan previews stable.
- Changed usage increments to increment first, validate after, and roll back safely when limits are exceeded or validation fails.
- Expanded the database adapter and core types for plan filtering, invoice lookups, tenant-scoped usage tracking, and pending downgrade awareness.
- Updated subscription plan changes to support proration, verified payment tokens, pending 3DS flows, and upgrade invoices.
- Refreshed the README and adapter/integration docs to match the current service and runtime behavior.

### Notes

- Existing Node.js callers that pass `Buffer` continue to work because `Buffer` extends `Uint8Array`.
- Core subscription services remain runtime-neutral, while invoice template and PDF generation continue to require a Node.js runtime.