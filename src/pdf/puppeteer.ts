// file: packages/subscriptions/src/pdf/puppeteer.ts
// Node.js PDF renderer backed by puppeteer-html-pdf (optional peer dependency)

import type { PdfRenderer } from "../templates/pdf-renderer.js";

/**
 * Options for the Node.js puppeteer PDF renderer.
 */
export interface PuppeteerPdfRendererOptions {
    /**
     * Path to the Chromium/Chrome executable. Falls back to the
     * `CHROMIUM_PATH` environment variable, then `/usr/bin/chromium`.
     */
    chromiumPath?: string;
}

/**
 * Create a {@link PdfRenderer} that renders HTML to PDF with
 * `puppeteer-html-pdf`. Node.js only — the heavy dependency is loaded via a
 * lazy dynamic import, so bundlers for other runtimes never pull it in.
 */
export function puppeteerPdfRenderer(
    options?: PuppeteerPdfRendererOptions
): PdfRenderer {
    return {
        async render(html: string): Promise<Uint8Array> {
            // Lazy import to avoid loading puppeteer unless needed
            const PuppeteerHTMLPDF = (await import("puppeteer-html-pdf"))
                .default;

            const htmlPDF = new PuppeteerHTMLPDF();
            try {
                await htmlPDF.initializeBrowser();
                await htmlPDF.setOptions({
                    format: "a4",
                    printBackground: true,
                    executablePath:
                        options?.chromiumPath ??
                        (typeof process !== "undefined"
                            ? process.env.CHROMIUM_PATH
                            : undefined) ??
                        "/usr/bin/chromium",
                });

                return await htmlPDF.create(html);
            } finally {
                await htmlPDF.closeBrowser();
            }
        },
    };
}
