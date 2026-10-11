# Billing

This guide covers the invoicing and pricing features: invoice numbering, tax handling, credit notes, multi-currency price points, metered billing, and the per-seat/add-on data fields.

Plan and invoice amounts use major/display units (e.g. `49` = 49 USD). Payment adapter charge amounts and preview `amountDue` use integer minor units. Currency precision follows ISO currency data: JPY has zero fractional digits, USD/SAR two, and KWD three. Do not convert a preview by dividing every currency by `100`; `amountDueFormatted` already contains its major-unit value.

## Plan Changes and Billing Anchors

Preview and execution use the same billing policy. For a settled paid subscription inside its current period, an immediate prorated upgrade charges the remaining-period price difference and preserves `currentPeriodStart` and `currentPeriodEnd`. Credit uses the immutable settled price for that period, so editing the plan catalog does not change credit already purchased. A trial, free plan, complimentary entitlement, unsettled manual invoice, or expired paid period supplies no paid credit: moving immediately to a paid plan requires the full target price and starts a new period. Disabling proration also charges a full target period and starts that period when the change becomes effective.

A deferred change (`immediately: false`) costs zero now and takes effect at the next settled renewal once the current period ends. A failed renewal does not grant the target plan. It does not collect unused-period upgrade money. Downgrades default to deferred changes; the SDK does not automatically refund a voluntary immediate downgrade.

Plan changes require matching currency, billing interval, and interval count. Cross-currency or monthly/yearly migrations need an explicit separate migration policy and are rejected by this API. Additional market price points do not imply currency conversion or change the subscription's selected canonical price.

Preview returns a persisted `quoteId`; submit that ID when confirming the purchase. The quote binds the subscriber's subscription state, target price identity, payable amount, currency, and effective periods. Quotes expire after at most five minutes, or sooner at a period boundary. A stale quote or changed subscription/price requires another preview and confirmation. Public payment references and token-verification assertions do not establish settlement.

Settlements persist the current period's `metadata.paidPrice` snapshot. Legacy paid subscriptions need this field backfilled from verified historical settlement and price records before receiving proration credit; the SDK fails closed when the required evidence is absent. Do not substitute today's mutable catalog price or treat an open invoice as proof of payment. Provider ownership and payment method mappings require their own explicit migration, described in the audit remediation record.

SDK calendar periods use UTC. A month-end anchor remains at month end, so January 31 renews on February 28 (February 29 in a leap year). Other days clamp to the destination month's last day; preserve the original calendar anchor across renewals to retain January 30 after a short February. Provider-managed integrations must supply authoritative verified provider periods; the SDK does not extend those periods from local processing time and cannot collect them through local renewal/dunning. Complete provider-managed purchase and renewal synchronization remains unsupported until the owning provider integration is implemented.

## Invoice Numbering

Every invoice can carry a human-friendly sequential number in addition to its internal ID. A number is assigned automatically by `invoices.create()` whenever the database adapter implements `invoices.nextInvoiceNumber` — both the Prisma and Drizzle adapters do. The number is exposed as `invoice.invoiceNumber` and rendered on the invoice template. Legal receipts should always reference `invoiceNumber`, not the internal ID.

The number format is `<prefix><zero-padded sequence>` (e.g. `INV-000123`). The prefixes are configurable on the service constructor:

```ts
import { InvoicesService } from "@abshahin/subscriptions";

const invoices = new InvoicesService(database, {
  invoiceNumberPrefix: "INV-",  // default "INV-"
  creditNotePrefix: "CN-",      // default "CN-" (credit note sequence)
});
```

`createSubscriptions` builds its `invoices` service with the default prefixes; construct `InvoicesService` yourself (as above) when you need custom ones. With the Prisma adapter, add the `BillingSequence` model from `docs/prisma-schema.md` for strictly sequential, concurrency-safe numbering.

## Tax: Per Line Item, Inclusive or Exclusive

Tax is configured per invoice line item, not globally. Each line item carries an optional `taxRate` (percentage) and `taxInclusive` flag, and `invoices.create()` computes `subtotal`, `taxAmount`, and `total` from the line items:

```ts
await subs.invoices.create({
  subscriptionId: subscription.id,
  amount: 56.35,
  currency: "USD",
  status: "open",
  lineItems: [
    {
      description: "Pro plan (monthly)",
      quantity: 1,
      unitPrice: 49,
      amount: 49,
      taxRate: 15,          // percent
      taxInclusive: false,  // tax is added on top of the price
    },
  ],
});
// → subtotal 49.00, taxAmount 7.35, total 56.35
```

- **Exclusive** (`taxInclusive: false` or omitted): tax is added on top — a $49 line at 15% contributes $49.00 to the subtotal and $7.35 to the tax.
- **Inclusive** (`taxInclusive: true`): the line `amount` already contains the tax — a $49 line at 15% contributes $42.61 to the subtotal and $6.39 to the tax.

When every taxed line item uses the same rate, the invoice's `taxRate` is set to that rate; with mixed rates (or no tax) it is left unset. You can also compute totals yourself with `invoices.computeTotals(lineItems, discountAmount)`. Explicit `subtotal`/`taxAmount`/`total` values passed to `create()` win over the computed ones.

## Credit Notes and Voiding

Issue a credit note against an existing invoice to refund or correct it without deleting history:

```ts
const creditNote = await subs.invoices.createCreditNote(invoice.id);
```

A credit note is a full, negative-amount invoice that references the original via `creditNoteOfId` and gets its own number from the credit-note sequence (`creditNotePrefix`, default `CN-`). The original invoice is left untouched — its status does not change — so the credit note acts as a standalone settlement document. `createCreditNote` throws `InvoiceVoidError` when the invoice is void, is itself a credit note, or already has a credit note.

To invalidate a non-paid invoice instead, void it:

```ts
await subs.invoices.voidInvoice(invoice.id);
```

Only `draft`, `open`, and `uncollectible` invoices can be voided; voiding a `paid` invoice is rejected (create a credit note instead), as is voiding an already-void invoice.

## Plan Price Points (Multi-Currency)

A plan can carry additional price points — one per currency — alongside its canonical `price`/`currency`:

```ts
const plan = await subs.plans.create({
  name: "Pro",
  interval: "monthly",
  price: 49,            // canonical price
  currency: "USD",      // canonical currency
  prices: [
    { currency: "EUR", amount: 45 },
    { currency: "SAR", amount: 189 },
  ],
});
```

Look up the price for a market with `plans.getPrice(plan, currency)`. It returns the canonical price when the currency matches `plan.currency`, the matching price point otherwise, and `null` when the plan has no price in that currency (currency matching is case-insensitive):

```ts
const price = subs.plans.getPrice(plan, "EUR");
// → { currency: "EUR", amount: 45 }

const missing = subs.plans.getPrice(plan, "GBP");
// → null — decide how to handle markets without a price point
```

Invoice rendering uses the locale-aware `formatCurrency` helper for whichever currency you bill in.

## Metered Features

The `metered` feature type permits overage for an eligible subscription: `remaining` may go negative so you can bill for the overage. An inactive or expired subscription still fails entitlement checks, and invalid usage quantities are rejected. (`limit` features, by contrast, reject consumption exceeding their cap.)

```ts
const features = defineFeatures({
  apiCalls: { type: "metered", default: 100_000 },
});

await subs.use(subscriberId, "apiCalls", 1);              // overage allowed; eligibility still required
const status = await subs.remaining(subscriberId, "apiCalls");
```

Usage defaults to calendar-month periods (UTC boundaries). Configure `usage: { kind: "periodic", reset: "subscription-cycle" }` for subscription periods, or `usage: { kind: "persistent" }` for resources such as stored products that survive renewal. Usage is available for billing reports:

```ts
const usage = await subs.permissions.getAllUsage(subscriberId);
// Bill overages in your own renewal flow, or use the reported usage
// to construct a usage-based invoice:
await subs.invoices.create({
  subscriptionId: subscription.id,
  amount: overageAmount,
  currency: "USD",
  status: "open",
  lineItems: [
    {
      description: `API calls overage (${usage.apiCalls.used - 100_000} calls)`,
      quantity: usage.apiCalls.used - 100_000,
      unitPrice: 0.001,
      amount: overageAmount,
    },
  ],
});
```

Usage increments/decrements go through the adapter's atomic counter operations and never drop below zero.

## Per-Seat Quantity and Add-On Fields

The `Subscription` model carries two optional data fields for hosts that bill per seat or attach extras:

- `quantity?: number` — seat/unit count for per-seat billing (default 1).
- `addOns?: string[]` — IDs of add-ons attached to the subscription.

These are stored data fields, not billing behaviors: the SDK does not multiply invoice amounts by `quantity` and does not price or renew add-ons for you, and there are no `updateQuantity`/`addAddOn`/`removeAddOn` methods. Persist them through your database adapter (both fields are part of the adapter's `CreateSubscriptionInput`/`UpdateSubscriptionInput`), then use them in your own invoicing flow — e.g. read `subscription.quantity` when building renewal invoice line items (`quantity`, `unitPrice`, `amount`) so the per-seat math and the rendered invoice stay consistent.

## Printing Invoices: Server PDF vs Client-Side Print

Invoices can be delivered two ways — pick per deployment, or per request:

**1. Server-generated PDF** (`?format=pdf`) — the server renders the invoice HTML and converts it with a configured `PdfRenderer`:

```ts
import { puppeteerPdfRenderer } from "@abshahin/subscriptions/pdf/puppeteer";       // Node/Bun
import { cloudflarePdfRenderer } from "@abshahin/subscriptions/pdf/cloudflare";     // Workers

const handler = createSubscriptionsHttpHandler(subs, {
  invoice: { pdfRenderer: puppeteerPdfRenderer() },
});
// GET /subscriptions/invoices/:id?format=pdf → application/pdf
```

**2. Client-side print** (default, zero server cost) — return printable HTML and let the browser print or "Save as PDF". No Chromium, no puppeteer cost, works in every runtime:

- `GET /subscriptions/invoices/:id` — plain invoice HTML.
- `?print=1` — adds print CSS (`@page` margins) and a floating "Print / Save as PDF" toolbar (hidden when printing).
- `?autoPrint=1` — same, plus opens the browser print dialog automatically on load.

```ts
// Link users straight to the print dialog:
<a href="/subscriptions/invoices/inv_123?autoPrint=1">Download invoice</a>
```

The same modes exist on the Elysia plugin's `GET /invoices/:id/download` route (`?format=pdf` default, `?format=html&print=1` for client-side printing) and accept the same `invoice.pdfRenderer` option.

For programmatic use, `wrapInvoiceForPrint(html, { autoPrint })` (exported from the main entry) wraps any rendered invoice HTML with the same print CSS/toolbar — pure string manipulation, edge-safe.

Custom templates on any runtime: pass `invoice.templateSource` (inline Handlebars string) instead of `templatePath` (Node filesystem only). With neither, the built-in inlined template is used — no filesystem needed.
