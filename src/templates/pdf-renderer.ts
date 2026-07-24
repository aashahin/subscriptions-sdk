// file: packages/subscriptions/src/templates/pdf-renderer.ts
// Runtime-agnostic PDF renderer contract for invoice PDF generation

/**
 * A runtime-agnostic PDF renderer: turns rendered invoice HTML into PDF bytes.
 *
 * Implementations:
 * - `puppeteerPdfRenderer` (Node.js) from `@abshahin/subscriptions/pdf/puppeteer`
 * - `cloudflarePdfRenderer` (Cloudflare Workers Browser Rendering) from
 *   `@abshahin/subscriptions/pdf/cloudflare`
 */
export interface PdfRenderer {
    /**
     * Render an HTML document to PDF bytes.
     */
    render(html: string): Promise<Uint8Array>;
}

/**
 * Fallback renderer used when no PDF renderer has been configured.
 * Always throws a helpful error telling the integrator to pick a renderer.
 */
export const noopPdfRenderer: PdfRenderer = {
    render(): Promise<Uint8Array> {
        throw new Error(
            "No PDF renderer configured. Choose a PDF renderer for your runtime: " +
                "use `puppeteerPdfRenderer` from '@abshahin/subscriptions/pdf/puppeteer' (Node.js) " +
                "or `cloudflarePdfRenderer` from '@abshahin/subscriptions/pdf/cloudflare' (Cloudflare Workers), " +
                "or provide a custom `PdfRenderer` implementation."
        );
    },
};
