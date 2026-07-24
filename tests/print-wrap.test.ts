// Tests for wrapInvoiceForPrint — the client-side print wrapper used by the
// invoice HTML routes. Pure string logic; boundary cases are a full document
// (has </body>) vs a fragment (no </body>), and the option matrix.

import { describe, expect, it } from 'bun:test';

import { wrapInvoiceForPrint } from '../src/templates/invoice-utils.ts';

const fullDocument = '<!DOCTYPE html><html><head></head><body><h1>Invoice</h1></body></html>';
const fragment = '<h1>Invoice</h1>';

describe('wrapInvoiceForPrint', () => {
    it('injects print assets before </body> in a full document', () => {
        const wrapped = wrapInvoiceForPrint(fullDocument);

        const bodyClose = wrapped.indexOf('</body>');
        expect(wrapped.indexOf('@media print')).toBeLessThan(bodyClose);
        expect(wrapped.indexOf('subs-print-toolbar')).toBeLessThan(bodyClose);
        // Document structure stays intact
        expect(wrapped.endsWith('</html>')).toBe(true);
    });

    it('appends print assets to fragments without a </body> tag', () => {
        const wrapped = wrapInvoiceForPrint(fragment);

        expect(wrapped.startsWith(fragment)).toBe(true);
        expect(wrapped).toContain('@media print');
    });

    it('omits the auto-print script unless autoPrint is set', () => {
        const manual = wrapInvoiceForPrint(fullDocument);
        const auto = wrapInvoiceForPrint(fullDocument, { autoPrint: true });

        expect(manual).not.toContain('window.print();');
        expect(auto).toContain('window.print();');
        // autoPrint still includes the toolbar for manual re-printing
        expect(auto).toContain('subs-print-toolbar');
    });

    it('omits the toolbar when toolbar is false', () => {
        const wrapped = wrapInvoiceForPrint(fullDocument, { toolbar: false });

        expect(wrapped).not.toContain('subs-print-toolbar');
        // page-level print CSS still applies
        expect(wrapped).toContain('@page');
    });
});
