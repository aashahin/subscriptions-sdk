// file: packages/subscriptions/src/templates/invoice-utils.ts
// Template utilities for subscription invoice rendering

import handlebars from "handlebars";
import type { Invoice } from "../core/types.js";
import { subscriptionInvoiceTemplate } from "./invoice-template.js";
import type { PdfRenderer } from "./pdf-renderer.js";

// Currency configuration map with ISO 4217 codes, symbols, and locale hints
const CURRENCY_CONFIG: Record<
    string,
    { symbol: string; locale: string; nameAr: string }
> = {
    // الخليج والعالم العربي
    SAR: { symbol: "ر.س", locale: "ar-SA", nameAr: "ريال سعودي" },
    AED: { symbol: "د.إ", locale: "ar-AE", nameAr: "درهم إماراتي" },
    KWD: { symbol: "د.ك", locale: "ar-KW", nameAr: "دينار كويتي" },
    BHD: { symbol: "د.ب", locale: "ar-BH", nameAr: "دينار بحريني" },
    OMR: { symbol: "ر.ع", locale: "ar-OM", nameAr: "ريال عماني" },
    QAR: { symbol: "ر.ق", locale: "ar-QA", nameAr: "ريال قطري" },
    EGP: { symbol: "ج.م", locale: "ar-EG", nameAr: "جنيه مصري" },
    JOD: { symbol: "د.أ", locale: "ar-JO", nameAr: "دينار أردني" },
    MAD: { symbol: "د.م.", locale: "ar-MA", nameAr: "درهم مغربي" },
    TND: { symbol: "د.ت", locale: "ar-TN", nameAr: "دينار تونسي" },
    DZD: { symbol: "د.ج", locale: "ar-DZ", nameAr: "دينار جزائري" },
    IQD: { symbol: "د.ع", locale: "ar-IQ", nameAr: "دينار عراقي" },
    LBP: { symbol: "ل.ل", locale: "ar-LB", nameAr: "ليرة لبنانية" },

    // العملات العالمية الرئيسية
    USD: { symbol: "$", locale: "en-US", nameAr: "دولار أمريكي" },
    EUR: { symbol: "€", locale: "de-DE", nameAr: "يورو" },
    GBP: { symbol: "£", locale: "en-GB", nameAr: "جنيه إسترليني" },
    CHF: { symbol: "CHF", locale: "de-CH", nameAr: "فرنك سويسري" },
    CAD: { symbol: "C$", locale: "en-CA", nameAr: "دولار كندي" },
    AUD: { symbol: "A$", locale: "en-AU", nameAr: "دولار أسترالي" },
    NZD: { symbol: "NZ$", locale: "en-NZ", nameAr: "دولار نيوزيلندي" },

    // آسيا
    TRY: { symbol: "₺", locale: "tr-TR", nameAr: "ليرة تركية" },
    JPY: { symbol: "¥", locale: "ja-JP", nameAr: "ين ياباني" },
    CNY: { symbol: "¥", locale: "zh-CN", nameAr: "يوان صيني" },
    INR: { symbol: "₹", locale: "en-IN", nameAr: "روبية هندية" },
    PKR: { symbol: "₨", locale: "ur-PK", nameAr: "روبية باكستانية" },
    KRW: { symbol: "₩", locale: "ko-KR", nameAr: "وون كوري جنوبي" },

    // أخرى شائعة في الدفع الإلكتروني
    RUB: { symbol: "₽", locale: "ru-RU", nameAr: "روبل روسي" },
    BRL: { symbol: "R$", locale: "pt-BR", nameAr: "ريال برازيلي" },
    MXN: { symbol: "$", locale: "es-MX", nameAr: "بيزو مكسيكي" },
    ZAR: { symbol: "R", locale: "en-ZA", nameAr: "راند جنوب أفريقي" },
};

/**
 * Format a date for display in the invoice
 */
export const formatDate = (
    dateInput: Date | string | null | undefined,
    format: Intl.DateTimeFormatOptions = {
        year: "numeric",
        month: "long",
        day: "numeric",
    },
    locale: string = "ar-EG"
): string => {
    if (!dateInput) return "—";

    const date = new Date(dateInput);

    if (isNaN(date.getTime())) {
        return "تاريخ غير صالح";
    }

    return date.toLocaleString(locale, format);
};

/**
 * Format a monetary amount with the specified currency and locale.
 */
export function formatCurrency(
    amount: number | string | null,
    currencyCode: string = "USD",
    locale?: string
): string {
    const code = currencyCode?.toUpperCase() ?? "USD";
    const config = CURRENCY_CONFIG[code] ?? {
        symbol: code,
        locale: "en-US",
        nameAr: code,
    };

    const formatLocale = locale || config.locale;

    if (!amount && amount !== 0) return `0.00 ${config.symbol}`;

    const value = Number(amount);

    try {
        return new Intl.NumberFormat(formatLocale, {
            style: "currency",
            currency: code,
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        }).format(value);
    } catch {
        return `${value.toFixed(2)} ${config.symbol}`;
    }
}

/**
 * Get currency display info for templates.
 */
export function getCurrencyInfo(currencyCode = "USD") {
    const code = currencyCode.toUpperCase();
    return (
        CURRENCY_CONFIG[code] ?? { symbol: code, locale: "en-US", nameAr: code }
    );
}

/**
 * Translate invoice status to Arabic
 */
function translateInvoiceStatus(status: string): string {
    const translations: Record<string, string> = {
        draft: "مسودة",
        open: "مفتوحة",
        paid: "مدفوعة",
        uncollectible: "غير قابلة للتحصيل",
        void: "ملغاة",
    };
    return translations[status] || status;
}

/**
 * Translate subscription status to Arabic
 */
function translateSubscriptionStatus(status: string): string {
    const translations: Record<string, string> = {
        trialing: "فترة تجريبية",
        active: "نشط",
        past_due: "متأخر السداد",
        canceled: "ملغي",
        incomplete: "غير مكتمل",
        incomplete_expired: "انتهت صلاحيته",
        unpaid: "غير مدفوع",
        paused: "متوقف مؤقتاً",
    };
    return translations[status] || status;
}

/**
 * Translate billing interval to Arabic
 */
function translateBillingInterval(interval: string, intervalCount: number = 1): string {
    const translations: Record<string, { singular: string; plural: string; multi: string }> = {
        monthly: { singular: "شهري", plural: "شهرياً", multi: "شهور" },
        yearly: { singular: "سنوي", plural: "سنوياً", multi: "سنوات" },
        one_time: { singular: "دفعة واحدة", plural: "دفعة واحدة", multi: "دفعة واحدة" },
        custom: { singular: "مخصص", plural: "مخصص", multi: "فترات" },
    };

    const t = translations[interval] || { singular: interval, plural: interval, multi: interval };

    if (intervalCount === 1) {
        return t.singular;
    }

    return `كل ${intervalCount} ${t.multi}`;
}

// Register Handlebars helpers
handlebars.registerHelper(
    "formatCurrency",
    function (
        amount: number | string | null,
        currencyOrOptions: unknown,
        optionsOrLocale: unknown
    ) {
        let currencyCode = "USD";
        let locale: string | undefined;

        const isOptions = (val: unknown) =>
            typeof val === "object" && val !== null && "hash" in (val as object);

        if (typeof currencyOrOptions === "string") {
            currencyCode = currencyOrOptions;
        } else if (isOptions(currencyOrOptions)) {
            const opts = currencyOrOptions as { hash?: { locale?: string } };
            locale = opts.hash?.locale;
        }

        if (isOptions(optionsOrLocale)) {
            const opts = optionsOrLocale as { hash?: { locale?: string } };
            if (opts.hash?.locale) locale = opts.hash.locale;
        } else if (typeof optionsOrLocale === "string") {
            locale = optionsOrLocale;
        }

        return formatCurrency(amount, currencyCode, locale);
    }
);

handlebars.registerHelper(
    "formatDate",
    function (date: Date | string, options: { hash?: { locale?: string } }) {
        const locale = options?.hash?.locale || "ar-EG";
        return formatDate(date, undefined, locale);
    }
);

handlebars.registerHelper("translateInvoiceStatus", translateInvoiceStatus);
handlebars.registerHelper("translateSubscriptionStatus", translateSubscriptionStatus);
handlebars.registerHelper("translateBillingInterval", function (
    interval: string,
    intervalCountOrOptions: unknown
) {
    let intervalCount = 1;
    if (typeof intervalCountOrOptions === "number") {
        intervalCount = intervalCountOrOptions;
    }
    return translateBillingInterval(interval, intervalCount);
});

// Helper for greater than comparison
handlebars.registerHelper("gt", function (a: unknown, b: unknown) {
    return parseFloat(String(a)) > parseFloat(String(b));
});

// Helper for logical OR
handlebars.registerHelper("or", function (a: unknown, b: unknown) {
    return a || b;
});

// Helper for equality check
handlebars.registerHelper("eq", function (a: unknown, b: unknown) {
    return a === b;
});

/**
 * Invoice data structure for template rendering
 */
export interface SubscriptionInvoiceData {
    invoice: Invoice;
    subscription: {
        id: string;
        status: string;
        currentPeriodStart: Date;
        currentPeriodEnd: Date;
        subscriberId: string;
    };
    plan: {
        name: string;
        description: string | null;
        price: number;
        currency: string;
        interval: string;
        intervalCount: number;
    };
    platform: {
        name: string;
        logo?: string;
        website?: string;
        supportEmail?: string;
        address?: string;
    };
    subscriber?: {
        name?: string;
        email?: string;
        phone?: string;
        address?: string;
    } | undefined;
    locale?: string;
}

/**
 * How to resolve the Handlebars template used for invoice rendering.
 * Provide either `templatePath` (Node.js filesystem) or an inline
 * `templateSource` string (works in every runtime). When neither is given,
 * the built-in {@link subscriptionInvoiceTemplate} is used.
 */
export interface RenderSubscriptionInvoiceOptions {
    /** Path to a `.hbs` template file (requires a filesystem; Node.js only). */
    templatePath?: string;
    /** Inline Handlebars template source (universal, no filesystem). */
    templateSource?: string;
}

/**
 * Render the subscription invoice HTML.
 *
 * Backward compatible: the first argument may still be a template path
 * string. Prefer the options form — with `templateSource` or no arguments at
 * all the built-in template is used and no filesystem is touched.
 */
export async function renderSubscriptionInvoice(
    templatePath: string,
    data: SubscriptionInvoiceData
): Promise<string>;
export async function renderSubscriptionInvoice(
    options: RenderSubscriptionInvoiceOptions | undefined,
    data: SubscriptionInvoiceData
): Promise<string>;
export async function renderSubscriptionInvoice(
    data: SubscriptionInvoiceData
): Promise<string>;
export async function renderSubscriptionInvoice(
    source:
        | string
        | RenderSubscriptionInvoiceOptions
        | SubscriptionInvoiceData
        | undefined,
    data?: SubscriptionInvoiceData
): Promise<string> {
    let templatePath: string | undefined;
    let templateSource: string | undefined;

    if (typeof source === "string") {
        templatePath = source;
    } else if (
        source !== undefined &&
        ("templatePath" in source || "templateSource" in source)
    ) {
        templatePath = source.templatePath;
        templateSource = source.templateSource;
    } else if (data === undefined) {
        // Called as renderSubscriptionInvoice(data) — use the built-in default
        data = source as SubscriptionInvoiceData;
    }
    // else: source is undefined and data is set — use the built-in default

    if (!templateSource) {
        if (templatePath) {
            // Lazy import so Workers never execute Node APIs. The specifier is
            // intentionally non-static so bundlers (wrangler/esbuild) leave it
            // as a runtime-only import instead of failing at bundle time.
            const fsSpecifier = "node:fs/promises";
            const { readFile } = (await import(fsSpecifier)) as typeof import("node:fs/promises");
            templateSource = await readFile(templatePath, "utf-8");
        } else {
            templateSource = subscriptionInvoiceTemplate;
        }
    }

    const template = handlebars.compile(templateSource);
    return template(data!);
}

/**
 * Generate PDF bytes from rendered HTML using the given renderer.
 */
export async function generatePdfWith(
    renderer: PdfRenderer,
    html: string
): Promise<Uint8Array> {
    return renderer.render(html);
}

/**
 * Options for {@link wrapInvoiceForPrint}.
 */
export interface PrintWrapOptions {
    /**
     * Automatically open the browser print dialog once the page loads.
     * The user can then print or "Save as PDF" client-side — no server-side
     * Chromium needed.
     * @default false
     */
    autoPrint?: boolean;

    /**
     * Show a small floating "Print / Save as PDF" toolbar on screen.
     * The toolbar is hidden when printing (`@media print`).
     * @default true
     */
    toolbar?: boolean;
}

/**
 * Wrap a rendered invoice HTML document for client-side printing.
 *
 * Injects print-friendly CSS (`@page` margins, screen-only toolbar hiding)
 * and, optionally, an auto-print script so the browser's print dialog opens
 * on load. This is the zero-cost alternative to server-side PDF generation:
 * return the HTML and let the client print or "Save as PDF".
 *
 * Pure string manipulation — works in every runtime (Node, Bun, Deno,
 * Cloudflare Workers).
 */
export function wrapInvoiceForPrint(
    html: string,
    options?: PrintWrapOptions
): string {
    const toolbar = options?.toolbar ?? true;

    const pageStyles = `<style>
@page { margin: 12mm; }
</style>`;

    const toolbarAssets = toolbar
        ? `<style>
@media print {
  .subs-print-toolbar { display: none !important; }
}
.subs-print-toolbar {
  position: fixed; top: 16px; right: 16px; z-index: 9999;
  font-family: system-ui, -apple-system, sans-serif;
}
.subs-print-toolbar button {
  padding: 10px 18px; font-size: 14px; font-weight: 600; cursor: pointer;
  color: #fff; background: #111827; border: none; border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0,0,0,.25);
}
.subs-print-toolbar button:hover { background: #1f2937; }
</style>
<div class="subs-print-toolbar"><button type="button" onclick="window.print()">Print / Save as PDF</button></div>`
        : "";

    const script = options?.autoPrint
        ? `<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},0);});</script>`
        : "";

    const injection = `${pageStyles}${toolbarAssets}${script}`;

    // Inject before </body> when present so the document stays valid;
    // otherwise append to the end of the fragment.
    const bodyClose = /<\/body\s*>/i;
    if (bodyClose.test(html)) {
        return html.replace(bodyClose, `${injection}</body>`);
    }
    return `${html}${injection}`;
}

/**
 * Generate a PDF buffer from invoice data.
 *
 * Backward compatible: still accepts a template path and renders with
 * puppeteer under Node.js by default. Pass `options.renderer` to use any
 * {@link PdfRenderer} (e.g. Cloudflare Browser Rendering in Workers), and/or
 * the options form of the first argument to render without a filesystem.
 */
export async function generateSubscriptionInvoicePdf(
    templatePath: string,
    data: SubscriptionInvoiceData,
    options?: GenerateSubscriptionInvoicePdfOptions
): Promise<Uint8Array>;
export async function generateSubscriptionInvoicePdf(
    templateOptions: RenderSubscriptionInvoiceOptions | undefined,
    data: SubscriptionInvoiceData,
    options?: GenerateSubscriptionInvoicePdfOptions
): Promise<Uint8Array>;
export async function generateSubscriptionInvoicePdf(
    source: string | RenderSubscriptionInvoiceOptions | undefined,
    data: SubscriptionInvoiceData,
    options?: GenerateSubscriptionInvoicePdfOptions
): Promise<Uint8Array> {
    // Render HTML first (delegates template resolution)
    const html =
        typeof source === "string"
            ? await renderSubscriptionInvoice(source, data)
            : await renderSubscriptionInvoice(
                  source as RenderSubscriptionInvoiceOptions | undefined,
                  data
              );

    // Delegate PDF rendering — default keeps the legacy Node.js behavior
    const renderer =
        options?.renderer ??
        (await defaultNodePdfRenderer(options?.chromiumPath));

    return generatePdfWith(renderer, html);
}

/**
 * Options for {@link generateSubscriptionInvoicePdf}.
 */
export interface GenerateSubscriptionInvoicePdfOptions {
    /**
     * Path to the Chromium/Chrome executable (Node.js default renderer only).
     */
    chromiumPath?: string;
    /**
     * PDF renderer to use. Defaults to the Node.js puppeteer renderer.
     */
    renderer?: PdfRenderer;
}

/**
 * Lazily build the default Node.js puppeteer renderer so Workers bundles
 * never reach the puppeteer code path.
 */
async function defaultNodePdfRenderer(
    chromiumPath?: string
): Promise<PdfRenderer> {
    const { puppeteerPdfRenderer } = await import("../pdf/puppeteer.js");
    return puppeteerPdfRenderer(
        chromiumPath !== undefined ? { chromiumPath } : undefined
    );
}

export { handlebars };
export { subscriptionInvoiceTemplate } from "./invoice-template.js";
export { noopPdfRenderer } from "./pdf-renderer.js";
export type { PdfRenderer } from "./pdf-renderer.js";
