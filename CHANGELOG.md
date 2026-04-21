# Changelog

All notable changes to this package will be documented in this file.

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