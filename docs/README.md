# Documentation

This directory contains publishable documentation for `@abshahin/subscriptions` based on the package's current API and the tenant-based backend integration that already uses it.

The package service layer is runtime-neutral. The only Node.js-specific part documented here is invoice template and PDF generation, which depends on filesystem access and the optional `puppeteer-html-pdf` peer dependency.

## Guides

- `../CHANGELOG.md`: version-by-version release notes
- `README.md`: high-level package overview and quick start
- `adapters.md`: database, cache, and payment adapter contracts
- `integration-guide.md`: end-to-end integration patterns derived from the backend project
- `prisma-schema.md`: Prisma models required by the current Prisma adapter
- `error-handling.md`: runtime errors and recommended handling patterns

## Recommended Reading Order

1. Start with the package root `README.md`.
2. Read `../CHANGELOG.md` for the current release delta.
3. Read `prisma-schema.md` before wiring the Prisma adapter.
4. Read `integration-guide.md` if you are integrating with Elysia or using tenant-scoped subscriptions.
5. Read `adapters.md` if you need custom caching or a custom payment gateway.
6. Read `error-handling.md` before exposing the package through an API.

## Scope

These docs describe the package as it exists today.

They intentionally do not treat app-specific layers as package features. In the backend project, those app-level layers include:

- Redis-backed hot-path counters for domain entities
- renewal schedulers and cron orchestration
- tenant dashboard aggregation routes
- project-specific payment verification callbacks

Those patterns are referenced where useful, but they are documented as integration examples rather than core package responsibilities.
