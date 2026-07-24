// file: packages/subscriptions/src/pdf/cloudflare.ts
// Cloudflare Workers PDF renderer backed by Browser Rendering (@cloudflare/puppeteer)

import type { PdfRenderer } from "../templates/pdf-renderer.js";

/**
 * Structurally-typed Cloudflare Browser Rendering binding (e.g. `env.MYBROWSER`
 * from a `[browser]` binding in wrangler config). Deliberately not imported
 * from wrangler/`@cloudflare/workers-types` so this SDK stays self-contained.
 */
export interface CloudflareBrowserBinding {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/**
 * Options for the Cloudflare Workers PDF renderer.
 */
export interface CloudflarePdfRendererOptions {
    /**
     * Extra options forwarded to `page.pdf()` (merged over the A4 defaults).
     */
    pdfOptions?: Record<string, unknown>;
}

/**
 * Create a {@link PdfRenderer} that renders HTML to PDF with Cloudflare
 * Browser Rendering. The `@cloudflare/puppeteer` package is loaded via a lazy
 * dynamic import and only ever resolves inside a Worker.
 */
export function cloudflarePdfRenderer(
    browserBinding: CloudflareBrowserBinding,
    options?: CloudflarePdfRendererOptions
): PdfRenderer {
    return {
        async render(html: string): Promise<Uint8Array> {
            if (!browserBinding) {
                throw new Error(
                    "cloudflarePdfRenderer requires a Browser Rendering binding " +
                        "(e.g. `env.MYBROWSER` from a `[browser]` binding in your wrangler config)."
                );
            }

            const { default: puppeteer } = await import(
                "@cloudflare/puppeteer"
            );

            const browser = await puppeteer.launch(browserBinding);
            try {
                const page = await browser.newPage();
                await page.setContent(html);
                const pdf = await page.pdf({
                    format: "a4",
                    printBackground: true,
                    ...options?.pdfOptions,
                });
                // Normalize Buffer/ArrayBuffer results to plain Uint8Array
                return pdf instanceof Uint8Array
                    ? pdf
                    : new Uint8Array(pdf as unknown as ArrayBuffer);
            } finally {
                await browser.close();
            }
        },
    };
}
