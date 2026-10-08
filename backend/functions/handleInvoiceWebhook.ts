import { HandleInvoiceWebhook } from '@teamkeel/sdk';
import { ZohoInvoice, normalizeWebhookInvoice, processInvoiceLineItems } from '../lib/zohoSalesHelpers';
import { rebuildMonthsForDays } from '../lib/cumulativeSalesHelpers';

const fn = HandleInvoiceWebhook(async (ctx, inputs) => {
    const payload = inputs as any;

    // Zoho may wrap the invoice in an { invoice: {...} } envelope or send it directly
    const invoice: ZohoInvoice = normalizeWebhookInvoice(payload.invoice || payload);

    if (!invoice.invoice_number) {
        throw new Error('Invalid webhook payload: missing invoice_number');
    }
    if (!invoice.line_items || !Array.isArray(invoice.line_items)) {
        throw new Error('Invalid webhook payload: missing or invalid line_items');
    }

    console.log(
        `Processing webhook for invoice ${invoice.invoice_number} with ${invoice.line_items.length} line items`
    );

    const channelCache = new Map<string, { id: string }>();
    const result = await processInvoiceLineItems(invoice, channelCache);

    if (result.errors.length > 0) {
        console.error(
            `Webhook for ${invoice.invoice_number}: ${result.errors.length} errors`,
            result.errors
        );
    }

    console.log(
        `Webhook for ${invoice.invoice_number}: created=${result.created}, updated=${result.updated}, skipped=${result.skipped}`
    );

    // Bring the sales worm up to date with this invoice now, rather than leaving
    // it for the scheduled refresh. Pure local SQL, no Zoho calls. A failure here
    // doesn't fail the delivery: the sales above are already committed, and the
    // scheduled refresh rebuilds the current and previous month regardless.
    let cumulativeMonthsRebuilt: string[] = [];
    try {
        const rebuilt = await rebuildMonthsForDays(result.touchedDays, new Date());
        cumulativeMonthsRebuilt = rebuilt.map((r) => r.month);
    } catch (error) {
        console.error(`Webhook for ${invoice.invoice_number}: cumulative sales rebuild failed`, error);
    }

    return {
        success: true,
        invoiceNumber: invoice.invoice_number,
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
        errors: result.errors,
        cumulativeMonthsRebuilt,
    };
}) as any;

// Run without the write-action transaction wrapper. Inside it, the concurrent-
// delivery recovery in processInvoiceLineItems cannot work: the raced INSERT
// aborts the transaction (Postgres 25P02), so the recovery SELECT/UPDATE fails
// and the losing delivery's writes are all rolled back at commit. With the
// wrapper off, each statement commits on its own and the recovery lands —
// the same semantics this helper already has under the sync flow and in tests.
// The config must sit on the default export; the runtime reads it from there.
fn.config = { dbTransaction: false };

export default fn;
