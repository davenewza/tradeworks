import { models, resetDatabase } from '@teamkeel/testing';
import { beforeEach, describe, expect, test } from 'vitest';
import {
    ZohoInvoice,
    processInvoiceLineItems,
    formatModifiedSince,
    isZohoDailyRateLimit,
    partitionInvoicesByChange,
    isUniqueViolation,
    isSameModifiedTime,
    normalizeWebhookInvoice,
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
function invoice(lineItemId: string, opts: { managed?: boolean; orderItemId?: string; qty?: number; modified?: string; date?: string; sku?: string } = {}): ZohoInvoice {
    const custom_fields: any[] = [];
    if (opts.managed) custom_fields.push({ customfield_id: '1', label: 'ManagedByWebhook', value: 'true' });
    return {
        invoice_id: 'inv1',
        invoice_number: 'IT100',
        date: opts.date ?? '2026-01-15',
        status: 'paid',
        last_modified_time: opts.modified,
        custom_fields,
        line_items: [
            {
                line_item_id: lineItemId,
                sku: opts.sku ?? 'RL-NA396',
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

// The days a write touched decide which cumulative sales months get rebuilt, so
// a sale that moves to another month must report the day it left as well —
// otherwise its old month keeps showing revenue that is no longer there.
describe('processInvoiceLineItems touched days', () => {
    test('reports the invoice date for a newly created sale', async () => {
        await seedProduct();
        const r = await processInvoiceLineItems(invoice('LINE-A'), new Map());

        expect(r.touchedDays).toEqual(['2026-01-15']);
    });

    test('reports both the old and the new day when an invoice date moves', async () => {
        await seedProduct();
        await processInvoiceLineItems(invoice('LINE-A', { date: '2026-01-31' }), new Map());

        const r = await processInvoiceLineItems(invoice('LINE-A', { date: '2026-02-01' }), new Map());

        expect(r.updated).toBe(1);
        expect([...r.touchedDays].sort()).toEqual(['2026-01-31', '2026-02-01']);
    });

    // The batch syncs hand in existing sales pre-fetched through the models API,
    // whose Date fields come back at local midnight — the old day must still be
    // read as the stored calendar day, not shifted by the host's UTC offset.
    test('reads the old day correctly from a pre-fetched existing sale', async () => {
        const product = await seedProduct();
        await processInvoiceLineItems(invoice('LINE-A', { date: '2026-03-01' }), new Map());

        const [stored] = await models.sale.findMany({ where: {} });
        const existingSalesMap = new Map([
            [`IT100-${stored.lineKey}`, { id: stored.id, quantity: stored.quantity, price: stored.price, productId: stored.productId, date: stored.date }],
        ]);

        const r = await processInvoiceLineItems(invoice('LINE-A', { date: '2026-04-10' }), new Map(), {
            productMap: new Map([['RL-NA396', { id: product.id }]]),
            existingSalesMap,
        });

        expect([...r.touchedDays].sort()).toEqual(['2026-03-01', '2026-04-10']);
    });

    test('reports nothing for a line that was not persisted', async () => {
        await seedProduct();
        const r = await processInvoiceLineItems(invoice('LINE-A', { sku: 'NO-SUCH-SKU' }), new Map());

        expect(r.skipped).toBe(1);
        expect(r.touchedDays).toEqual([]);
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

    // A webhook delivery stores the modified time in ISO form; the list API
    // spells the same instant Zoho's way. Comparing strings made every invoice
    // the webhook had written look changed, so the scheduled sync re-fetched
    // its detail and spent shared Zoho quota on data it already held.
    test('skips an invoice whose stored time is the same instant spelled differently', () => {
        const stored = new Map<string, string | null>([['A', '2026-01-01T02:00:00.000Z']]);
        const { toFetch, skipped } = partitionInvoicesByChange(
            [{ invoice_number: 'A', last_modified_time: '2026-01-01T04:00:00+0200' }],
            stored
        );
        expect(skipped).toBe(1);
        expect(toFetch).toHaveLength(0);
    });
});

describe('isSameModifiedTime', () => {
    test('matches identical strings, and the same instant in different spellings', () => {
        expect(isSameModifiedTime('2026-10-07T06:20:37+0200', '2026-10-07T06:20:37+0200')).toBe(true);
        expect(isSameModifiedTime('2026-10-07T04:20:37.000Z', '2026-10-07T06:20:37+0200')).toBe(true);
        expect(isSameModifiedTime('2026-10-07T06:20:37.000+02:00', '2026-10-07T06:20:37+0200')).toBe(true);
    });

    test('does not match a different instant, or an unparseable stored value', () => {
        expect(isSameModifiedTime('2026-10-07T04:20:38.000Z', '2026-10-07T06:20:37+0200')).toBe(false);
        expect(isSameModifiedTime('not a time', '2026-10-07T06:20:37+0200')).toBe(false);
    });
});

describe('normalizeWebhookInvoice', () => {
    test('turns the Dates Keel parsed out of the payload back into strings', () => {
        // What Keel's input parser makes of "2026-01-15" and "2026-01-15T11:00:00+0200".
        const parsed = {
            ...invoice('LINE-A'),
            date: new Date('2026-01-15'),
            last_modified_time: new Date('2026-01-15T11:00:00+0200'),
        } as unknown as ZohoInvoice;

        const normalized = normalizeWebhookInvoice(parsed);

        expect(normalized.date).toBe('2026-01-15');
        expect(normalized.last_modified_time).toBe('2026-01-15T09:00:00.000Z');
        expect(normalized.line_items).toBe(parsed.line_items);
    });

    test('leaves string values as they are', () => {
        const raw = invoice('LINE-A', { modified: '2026-01-15T11:00:00+0200' });
        const normalized = normalizeWebhookInvoice(raw);

        expect(normalized.date).toBe('2026-01-15');
        expect(normalized.last_modified_time).toBe('2026-01-15T11:00:00+0200');
    });
});
