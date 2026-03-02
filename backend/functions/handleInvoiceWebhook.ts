import { HandleInvoiceWebhook } from '@teamkeel/sdk';
import { ZohoInvoice, processInvoiceLineItems } from '../lib/zohoSalesHelpers';

export default HandleInvoiceWebhook(async (ctx, inputs) => {
    const payload = inputs as any;

    // Zoho may wrap the invoice in an { invoice: {...} } envelope or send it directly
    const invoice: ZohoInvoice = payload.invoice || payload;

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

    return {
        success: true,
        invoiceNumber: invoice.invoice_number,
        created: result.created,
        updated: result.updated,
        skipped: result.skipped,
        errors: result.errors,
    };
});
