# Documentation

This directory contains publishable documentation for `@abshahin/subscriptions` based on the package's current API and the tenant-based backend integration that already uses it.

The service layer uses web-standard primitives and bundles for server and Workers environments. Storage capabilities determine which financial operations are available; D1 and unverified async driver modes fail closed for interactive financial transactions. Runtime-specific capabilities (filesystem invoice templates, `puppeteer-html-pdf`) are optional and loaded lazily — see `runtime-support.md`.

## Guides

- `../CHANGELOG.md`: version-by-version release notes
- `../README.md`: high-level package overview and quick start
- `runtime-support.md`: runtime support matrix and per-runtime setup recipes (Node, Bun, Deno, Cloudflare Workers)
- `adapters.md`: database, cache, and payment adapter contracts
- `billing.md`: invoice numbering, tax, credit notes, price points, metered billing, per-seat/add-on data fields
- `coupons.md`: coupon model and `CouponsService`
- `dunning.md`: failed-payment retries, final actions, and pause/resume/trial/cancel controls
- `events.md`: transaction-owned domain events, `withEvents` outbox relay, and at-least-once delivery
- `audit.md`: audit logging with `AuditLogAdapter` and `createAuditLogger`
- `testing.md`: in-memory adapters, fake payment gateway, and adapter conformance suites
- `integration-guide.md`: end-to-end integration patterns derived from the backend project
- `prisma-schema.md`: Prisma models required by the current Prisma adapter
- `error-handling.md`: runtime errors and recommended handling patterns
- `AUDIT_REMEDIATION.md`: finding-specific evidence, regression results, breaking migrations, and remaining external verification

## Recommended Reading Order

1. Start with the package root `README.md`.
2. Read `AUDIT_REMEDIATION.md` and `../CHANGELOG.md` for security migrations and the current release delta.
3. Read `runtime-support.md` to pick adapters for your runtime.
4. Read `prisma-schema.md` before wiring the Prisma adapter (or `runtime-support.md` for Drizzle).
5. Read `integration-guide.md` if you are integrating with Elysia or using tenant-scoped subscriptions.
6. Read `billing.md`, `coupons.md`, and `dunning.md` for the invoicing and lifecycle features you plan to use.
7. Read `events.md` and `audit.md` for durable event delivery, consumer deduplication, and an audit trail.
8. Read `adapters.md` if you need custom caching or a custom payment gateway, and `testing.md` for the conformance suites that validate them.
9. Read `error-handling.md` before exposing the package through an API.

## Scope

These docs describe the package as it exists today.

They intentionally do not treat app-specific layers as package features. In the backend project, those app-level layers include:

- renewal schedulers and cron orchestration
- tenant dashboard aggregation routes
- authentication, tenant membership, and server verification of resource ownership

Those patterns are referenced where useful, but they are documented as integration examples rather than core package responsibilities.

Moyasar is a token-payment provider with SDK-managed scheduling. Provider registrations persist account/environment and billing ownership independently of external customer, payment-method, and subscription IDs. Polar and Creem adapters are not implemented; the registry is the foundation for future integrations. Supported database transactions persist subscription effects, invoices, and outbox events together; event delivery remains at least once. Memory conformance and neutral bundle checks do not prove live database/provider integrations.
