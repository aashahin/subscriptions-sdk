import { describe, expect, it, mock } from "bun:test";
import { formatCurrency, handlebars, renderSubscriptionInvoice, subscriptionInvoiceTemplate, type SubscriptionInvoiceData } from "../src/templates/invoice-utils.ts";
import { puppeteerPdfRenderer } from "../src/pdf/puppeteer.ts";

function invoiceData(overrides: Partial<SubscriptionInvoiceData["invoice"]> = {}): SubscriptionInvoiceData {
    const createdAt = new Date("2026-10-01T00:00:00Z");
    return {
        invoice: {
            id: "internal-invoice-id", subscriptionId: "subscription", subscriberId: "tenant",
            amount: 98, currency: "USD", status: "paid", invoiceNumber: "INV-000042",
            subtotal: 90, taxAmount: 18, taxRate: 20, discountAmount: 10, total: 98,
            gatewayInvoiceId: null, paidAt: createdAt, dueDate: null,
            lineItems: [{ description: "Service", quantity: 1, unitPrice: 90, amount: 90 }],
            metadata: null, createdAt, updatedAt: createdAt, ...overrides,
        },
        subscription: { id: "subscription", subscriberId: "tenant", status: "active", currentPeriodStart: createdAt, currentPeriodEnd: new Date("2026-11-01T00:00:00Z") },
        plan: { name: "Pro", description: null, price: 90, currency: "USD", interval: "monthly", intervalCount: 1 },
        platform: { name: "Example" }, locale: "en-US",
    };
}

function displayedTotal(html: string, label: string): string | undefined {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return html.match(new RegExp(`<div>${escapedLabel}</div>\\s*<div class="num">([^<]+)</div>`))?.[1];
}

describe("audited invoice rendering regressions", () => {
    it.each([
        ["KWD", 1.234, "1.234"], ["JPY", 1234, "1,234"], ["USD", 1.23, "1.23"],
        ["KWD", null, "0.000"], ["JPY", null, "0"],
    ])("preserves %s currency precision for %s", (currency, amount, expectedAmount) => {
        expect(formatCurrency(amount, currency, "en-US")).toContain(expectedAmount);
    });

    it.each([
        ["KWD", 1.234, "1.234 د.ك"], ["JPY", 1234, "1234 ¥"], ["JPY", null, "0 ¥"],
    ])("preserves %s precision when locale formatting is unavailable", (currency, amount, expected) => {
        expect(formatCurrency(amount, currency, "invalid_locale")).toBe(expected);
    });

    it("renders the stored invoice number, distinct totals and escaped subscriber input", async () => {
        const context = invoiceData();
        context.subscriber = { name: '<script>alert("x")</script>' };
        const html = await renderSubscriptionInvoice(context);
        expect(html).toContain("رقم الفاتورة: INV-000042");
        expect(displayedTotal(html, "المجموع الفرعي")).toBe("$90.00");
        expect(displayedTotal(html, "الضريبة (20%)")).toBe("$18.00");
        expect(displayedTotal(html, "الخصم")).toBe("$10.00");
        expect(displayedTotal(html, "الإجمالي")).toBe("$98.00");
        expect(html).toContain("&lt;script&gt;");
        expect(html).not.toContain('<script>alert("x")</script>');
    });

    it("preserves zero totals and identifies credit notes with their original invoice", async () => {
        const zero = await renderSubscriptionInvoice({}, invoiceData({ subtotal: 0, taxAmount: 0, taxRate: 0, discountAmount: 0, total: 0 }));
        for (const label of ["المجموع الفرعي", "الضريبة (0%)", "الخصم", "الإجمالي"]) expect(displayedTotal(zero, label)).toBe("$0.00");
        const note = await renderSubscriptionInvoice(invoiceData({ invoiceNumber: "CN-000042", creditNoteOfId: "original-invoice", amount: -98, subtotal: -90, taxAmount: -18, discountAmount: -10, total: -98 }));
        expect(note).toContain("<h1>إشعار دائن</h1>");
        expect(note).toContain("رقم الفاتورة: CN-000042");
        expect(note).toContain("مرجع الفاتورة الأصلية: original-invoice");
        expect(displayedTotal(note, "الإجمالي")).toBe("-$98.00");
    });

    it("renders built-in and custom precompiled templates when dynamic code generation is disabled", async () => {
        const custom = handlebars.template<SubscriptionInvoiceData>({
            compiler: [8, ">= 4.3.0"],
            main(_container: unknown, context: SubscriptionInvoiceData, helpers: Record<string, (...args: unknown[]) => unknown>) {
                return `Custom ${helpers.formatCurrency!(context.invoice.total, context.invoice.currency, { hash: { locale: context.locale } })}`;
            },
        });
        const originalFunction = globalThis.Function;
        globalThis.Function = new Proxy(originalFunction, {
            apply() { throw new Error("Dynamic code generation is disabled"); },
            construct() { throw new Error("Dynamic code generation is disabled"); },
        });
        try {
            expect(await renderSubscriptionInvoice(undefined, invoiceData())).toContain("INV-000042");
            expect(await renderSubscriptionInvoice({ template: custom, templateSource: "ignored" }, invoiceData())).toBe("Custom $98.00");
        } finally {
            globalThis.Function = originalFunction;
        }
    });

    it("keeps custom runtime source templates compatible with registered helpers and honors empty source", async () => {
        expect(await renderSubscriptionInvoice({ templateSource: "{{formatCurrency invoice.total invoice.currency locale=locale}}" }, invoiceData())).toBe("$98.00");
        expect(await renderSubscriptionInvoice({ templateSource: "" }, invoiceData())).toBe("");
        expect(await renderSubscriptionInvoice({ templateSource: subscriptionInvoiceTemplate }, invoiceData())).toBe(await renderSubscriptionInvoice(invoiceData()));
        expect(await renderSubscriptionInvoice(new URL("../src/templates/subscription-invoice.hbs", import.meta.url).pathname, invoiceData())).toBe(await renderSubscriptionInvoice(invoiceData()));
    });

    it("keeps caller-registered helpers and partials available to custom source templates", async () => {
        handlebars.registerHelper("auditInvoiceLabel", () => "Registered label");
        handlebars.registerPartial("auditInvoiceHeader", "{{auditInvoiceLabel}} {{invoice.invoiceNumber}}");
        try {
            expect(await renderSubscriptionInvoice({ templateSource: "{{> auditInvoiceHeader}}" }, invoiceData())).toBe("Registered label INV-000042");
        } finally {
            handlebars.unregisterHelper("auditInvoiceLabel");
            handlebars.unregisterPartial("auditInvoiceHeader");
        }
    });

    it("configures the requested Chromium executable before browser initialization", async () => {
        let launchedPath: unknown;
        let closed = false;
        const pdfBytes = new TextEncoder().encode("%PDF-1.7\nconfigured chromium");
        mock.module("puppeteer-html-pdf", () => ({
            default: class {
                options: Record<string, unknown> = {};
                setOptions(options: Record<string, unknown>) { this.options = options; }
                async initializeBrowser() { launchedPath = this.options.executablePath; }
                async create() { return pdfBytes; }
                async closeBrowser() { closed = true; }
            },
        }));
        try {
            expect(await puppeteerPdfRenderer({ chromiumPath: "/custom/chromium" }).render("<p>Invoice</p>")).toEqual(pdfBytes);
            expect(launchedPath).toBe("/custom/chromium");
            expect(closed).toBe(true);
        } finally {
            mock.restore();
        }
    });
});
