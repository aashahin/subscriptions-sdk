// Ambient type declaration for the optional `puppeteer-html-pdf` peer dependency.
//
// This package is an OPTIONAL peer dependency used only for Node.js invoice PDF
// generation. It ships no TypeScript types, so without this declaration the
// dynamic `import("puppeteer-html-pdf")` in `pdf/puppeteer.ts` breaks
// `tsc` for every consumer that hasn't installed the (heavy) puppeteer dep.
//
// Declaring it here keeps the build self-contained while still resolving the
// real module at runtime when it is installed.
declare module "puppeteer-html-pdf" {
  export interface PuppeteerHTMLPDFOptions {
    format?: string;
    printBackground?: boolean;
    executablePath?: string;
    [key: string]: unknown;
  }

  export default class PuppeteerHTMLPDF {
    initializeBrowser(): Promise<void>;
    setOptions(options: PuppeteerHTMLPDFOptions): void | Promise<void>;
    create(html: string): Promise<Uint8Array>;
    closeBrowser(): Promise<void>;
  }
}
