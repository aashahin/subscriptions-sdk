// Ambient type declaration for the optional `@cloudflare/puppeteer` peer
// dependency.
//
// This package is an OPTIONAL peer dependency used only for Cloudflare Workers
// invoice PDF generation via Browser Rendering. Declaring the (small) surface
// we use here keeps the build self-contained for consumers that never install
// it, while the real module resolves at runtime inside a Worker.
declare module "@cloudflare/puppeteer" {
  export interface CloudflarePdfOptions {
    format?: string;
    printBackground?: boolean;
    [key: string]: unknown;
  }

  export interface CloudflareBrowserPage {
    setContent(
      html: string,
      options?: Record<string, unknown>
    ): Promise<void>;
    pdf(options?: CloudflarePdfOptions): Promise<Uint8Array>;
    close(): Promise<void>;
  }

  export interface CloudflareBrowser {
    newPage(): Promise<CloudflareBrowserPage>;
    close(): Promise<void>;
  }

  const puppeteer: {
    launch(
      binding: unknown,
      options?: Record<string, unknown>
    ): Promise<CloudflareBrowser>;
  };

  export default puppeteer;
}
