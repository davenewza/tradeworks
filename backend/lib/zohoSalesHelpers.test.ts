import { models, resetDatabase } from '@teamkeel/testing';
import { beforeEach, describe, expect, test } from 'vitest';
import {
    ZohoInvoice,
    processInvoiceLineItems,
    formatModifiedSince,
    isZohoDailyRateLimit,
    partitionInvoicesByChange,
    isUniqueViolation,
} from './zohoSalesHelpers';

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
function invoice(lineItemId: string, opts: { managed?: boolean; orderItemId?: string; qty?: number; modified?: string } = {}): ZohoInvoice {
    const custom_fields: any[] = [];
    if (opts.managed) custom_fields.push({ customfield_id: '1', label: 'ManagedByWebhook', value: 'true' });
    return {
        invoice_id: 'inv1',
        invoice_number: 'IT100',
        date: '2026-01-15',
        status: 'paid',
        last_modified_time: opts.modified,
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

    test("stores the invoice's last_modified_time for the unchanged-skip check", async () => {
        await seedProduct();
        await processInvoiceLineItems(invoice('LINE-A', { modified: '2026-01-15T09:00:00+0000' }), new Map());

        const sales = await models.sale.findMany({ where: {} });
        expect(sales[0].zohoModifiedTime).toBe('2026-01-15T09:00:00+0000');
    });

    test('recovers from a concurrent-create race by updating the row that now exists', async () => {
        // Reproduces the production webhook error: a row for (invoiceNumber,
        // lineKey) already exists (a concurrent webhook just created it), but our
        // in-memory lookup is stale, so we take the create path and hit
        // sale_invoice_number_line_key_udx. Must recover, not fail.
        const product = await seedProduct();
        const channel = await models.channel.create({ name: 'Other' });
        await models.sale.create({
            invoiceNumber: 'IT100',
            lineItemId: 'OLD',
            lineKey: 'OI-1',
            channelId: channel.id,
            date: new Date('2026-01-15'),
            productId: product.id,
            quantity: 1,
            price: 299,
        });

        // Stale (empty) existingSalesMap forces the create path deterministically.
        const r = await processInvoiceLineItems(
            invoice('LINE-NEW', { managed: true, orderItemId: 'OI-1', qty: 4 }),
            new Map(),
            { productMap: new Map([['RL-NA396', { id: product.id }]]), existingSalesMap: new Map() }
        );

        expect(r.created).toBe(0);
        expect(r.updated).toBe(1); // recovered as an update
        expect(r.skipped).toBe(0);
        expect(r.errors).toHaveLength(0);

        const sales = await models.sale.findMany({ where: {} });
        expect(sales).toHaveLength(1); // no duplicate, no constraint error
        expect(sales[0].quantity).toBe(4); // this delivery's data still landed
        expect(sales[0].lineItemId).toBe('LINE-NEW');
    });
});

describe('isUniqueViolation', () => {
    test('true for a Postgres duplicate-key error', () => {
        expect(
            isUniqueViolation(new Error('duplicate key value violates unique constraint "sale_invoice_number_line_key_udx"'))
        ).toBe(true);
    });
    test('false for unrelated errors', () => {
        expect(isUniqueViolation(new Error('connection terminated unexpectedly'))).toBe(false);
    });
});

describe('isZohoDailyRateLimit', () => {
    test('true for a 429 carrying Zoho error code 45', () => {
        expect(isZohoDailyRateLimit(429, '{"code":45,"message":"The API call for this organization has exceeded the maximum call rate limit of 10,000"}')).toBe(true);
    });
    test('true for a 429 whose message mentions the call rate limit', () => {
        expect(isZohoDailyRateLimit(429, 'exceeded the maximum call rate limit')).toBe(true);
    });
    test('false for a 429 that is a different Zoho error (e.g. burst code 4)', () => {
        expect(isZohoDailyRateLimit(429, '{"code":4,"message":"invalid token"}')).toBe(false);
    });
    test('false for non-429 statuses', () => {
        expect(isZohoDailyRateLimit(500, '{"code":45}')).toBe(false);
    });
});

describe('partitionInvoicesByChange', () => {
    const summaries = [
        { invoice_number: 'A', last_modified_time: '2026-01-01T00:00:00+0000' },
        { invoice_number: 'B', last_modified_time: '2026-01-02T00:00:00+0000' },
        { invoice_number: 'C', last_modified_time: '2026-01-03T00:00:00+0000' },
    ];

    test('skips invoices whose stored modified time matches; fetches the rest', () => {
        const stored = new Map<string, string | null>([
            ['A', '2026-01-01T00:00:00+0000'], // unchanged → skip
            ['B', '2025-12-01T00:00:00+0000'], // changed → fetch
            // C never synced → fetch
        ]);
        const { toFetch, skipped } = partitionInvoicesByChange(summaries, stored);
        expect(skipped).toBe(1);
        expect(toFetch.map((s) => s.invoice_number)).toEqual(['B', 'C']);
    });

    test('always fetches when the stored time is null or the summary has none', () => {
        const stored = new Map<string, string | null>([['A', null]]);
        const { toFetch, skipped } = partitionInvoicesByChange(
            [{ invoice_number: 'A', last_modified_time: undefined }, { invoice_number: 'A2', last_modified_time: '2026-01-01T00:00:00+0000' }],
            stored
        );
        expect(skipped).toBe(0);
        expect(toFetch).toHaveLength(2);
    });
});
