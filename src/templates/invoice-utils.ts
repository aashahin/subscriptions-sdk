// file: packages/subscriptions/src/templates/invoice-utils.ts
// Template utilities for subscription invoice rendering

import handlebars from "handlebars";
import type { Invoice } from "../core/types.js";

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
 * Render the subscription invoice HTML
 */
export async function renderSubscriptionInvoice(
    templatePath: string,
    data: SubscriptionInvoiceData
): Promise<string> {
    const { readFile } = await import("node:fs/promises");
    const templateSource = await readFile(templatePath, "utf-8");
    const template = handlebars.compile(templateSource);
    return template(data);
}

/**
 * Generate a PDF buffer from invoice data
 */
export async function generateSubscriptionInvoicePdf(
    templatePath: string,
    data: SubscriptionInvoiceData,
    options?: {
        chromiumPath?: string;
    }
): Promise<Uint8Array> {
    // Dynamic import to avoid loading puppeteer unless needed
    const PuppeteerHTMLPDF = (await import("puppeteer-html-pdf")).default;

    // Render HTML first
    const html = await renderSubscriptionInvoice(templatePath, data);

    // Generate PDF using PuppeteerHTMLPDF
    const htmlPDF = new PuppeteerHTMLPDF();
    await htmlPDF.initializeBrowser();
    await htmlPDF.setOptions({
        format: "a4",
        printBackground: true,
        executablePath:
            options?.chromiumPath ??
            (typeof process !== "undefined" ? process.env.CHROMIUM_PATH : undefined) ??
            "/usr/bin/chromium",
    });

    const pdfBuffer = await htmlPDF.create(html);
    await htmlPDF.closeBrowser();

    return pdfBuffer;
}

export { handlebars };
