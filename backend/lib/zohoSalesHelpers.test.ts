import { models, resetDatabase } from '@teamkeel/testing';
import { beforeEach, describe, expect, test } from 'vitest';
import { ZohoInvoice, processInvoiceLineItems, formatModifiedSince } from './zohoSalesHelpers';

beforeEach(resetDatabase);

describe('formatModifiedSince', () => {
    test('formats UTC with a colon-free offset for the Zoho last_modified_time filter', () => {
        expect(formatModifiedSince(new Date('2026-08-13T06:30:00.000Z'))).toBe('2026-08-13T06:30:00+0000');
    });
});

async function seedProduct(sku = 'RL-NA396') {
    const brand = await models.brand.create({ name: 'B' });
    return models.product.create({ name: 'Kit', sku, brandId: brand.id });
}

// Build a one-line invoice; `lineItemId` is the (volatile) Zoho id, `orderItemId`
// the stable source id carried in the line description.
function invoice(lineItemId: string, opts: { managed?: boolean; orderItemId?: string; qty?: number } = {}): ZohoInvoice {
    const custom_fields: any[] = [];
    if (opts.managed) custom_fields.push({ customfield_id: '1', label: 'ManagedByWebhook', value: 'true' });
    return {
        invoice_id: 'inv1',
        invoice_number: 'IT100',
        date: '2026-01-15',
        status: 'paid',
        custom_fields,
        line_items: [
            {
                line_item_id: lineItemId,
                sku: 'RL-NA396',
                name: 'Kit',
                quantity: opts.qty ?? 1,
                rate: 299,
                description: opts.orderItemId ?? 'OI-1',
                item_total: 260,
                discount_amount: 0,
            },
        ],
    } as ZohoInvoice;
}

describe('processInvoiceLineItems dedup', () => {
    test('managed invoice: line_item_id churn does NOT duplicate (keyed on orderItemId)', async () => {
        await seedProduct();
        const cache = new Map();

        // Initial ingestion (e.g. webhook) with Zoho line id A.
        let r = await processInvoiceLineItems(invoice('LINE-A', { managed: true, orderItemId: 'OI-1' }), cache);
        expect(r.created).toBe(1);

        // Zoho re-saves the invoice → brand-new line_item_id B, same orderItemId.
        r = await processInvoiceLineItems(invoice('LINE-B', { managed: true, orderItemId: 'OI-1' }), cache);
        expect(r.created).toBe(0);
        expect(r.updated).toBe(1);

        const sales = await models.sale.findMany({ where: {} });
        expect(sales).toHaveLength(1); // no duplicate
        expect(sales[0].orderItemId).toBe('OI-1');
        expect(sales[0].lineKey).toBe('OI-1');
        expect(sales[0].lineItemId).toBe('LINE-B'); // refreshed to the current Zoho id
    });

    test('managed invoice: an edit (qty change) updates the same row', async () => {
        await seedProduct();
        const cache = new Map();
        await processInvoiceLineItems(invoice('LINE-A', { managed: true, orderItemId: 'OI-1', qty: 1 }), cache);
        await processInvoiceLineItems(invoice('LINE-C', { managed: true, orderItemId: 'OI-1', qty: 5 }), cache);

        const sales = await models.sale.findMany({ where: {} });
        expect(sales).toHaveLength(1);
        expect(sales[0].quantity).toBe(5);
    });

    test('non-managed invoice falls back to line_item_id', async () => {
        await seedProduct();
        const cache = new Map();
        let r = await processInvoiceLineItems(invoice('LINE-A', { managed: false }), cache);
        expect(r.created).toBe(1);
        // Same line id re-processed → updates, not duplicates.
        r = await processInvoiceLineItems(invoice('LINE-A', { managed: false }), cache);
        expect(r.updated).toBe(1);

        const sales = await models.sale.findMany({ where: {} });
        expect(sales).toHaveLength(1);
        expect(sales[0].lineKey).toBe('LINE-A');
        expect(sales[0].orderItemId).toBeNull();
    });
});
