// Action-level coverage for the invoice webhook, exercised through the real
// action so the function's config (dbTransaction: false) is on the execution
// path — the unit tests in lib/zohoSalesHelpers.test.ts call the helper
// directly and never see it.
//
// The second test is the one that matters: it pins the no-transaction
// semantics. Under the default write-action transaction, one failed INSERT
// aborts the whole invocation (Postgres 25P02) and every line of the delivery
// is rolled back at commit — which is what silently discarded the losing side
// of concurrent Zoho deliveries in production. With the wrapper off, earlier
// lines stay persisted and the per-line recovery in processInvoiceLineItems
// can actually run.

import { actions, models, resetDatabase } from '@teamkeel/testing';
import { beforeEach, describe, expect, test } from 'vitest';
import { partitionInvoicesByChange } from '../lib/zohoSalesHelpers';
import { daysInMonth, formatDay, monthLabelOf, monthStartOf } from '../lib/cumulativeSalesHelpers';

beforeEach(resetDatabase);

// The worm only holds the month in progress and the two before it, so its
// tests date invoices against the real clock — the action runs in the
// functions runtime, out of reach of fake timers.
const THIS_MONTH = monthStartOf(new Date());
const monthsAgo = (n: number) => new Date(Date.UTC(THIS_MONTH.getUTCFullYear(), THIS_MONTH.getUTCMonth() - n, 1));
// Closed months, so their series run to the last day.
const LAST_MONTH = monthsAgo(1);
const TWO_MONTHS_AGO = monthsAgo(2);
const monthKey = (month: Date) => formatDay(month).slice(0, 7);
const dayIn = (month: Date, day: number) =>
    formatDay(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), day)));

async function seedProduct(sku = 'RL-NA396') {
    const brand = await models.brand.create({ name: 'B' });
    return models.product.create({ name: 'Kit', sku, brandId: brand.id });
}

function lineItem(id: string, opts: { qty?: number; rate?: number } = {}) {
    return {
        line_item_id: id,
        sku: 'RL-NA396',
        name: 'Kit',
        quantity: opts.qty ?? 2,
        rate: opts.rate ?? 299,
        description: '',
        item_total: 260,
        discount_amount: 0,
    };
}

describe('handleInvoiceWebhook', () => {
    test('persists a sale end-to-end, and a re-delivery updates instead of duplicating', async () => {
        const product = await seedProduct();

        // Zoho's enveloped shape.
        const first = await actions.handleInvoiceWebhook({
            invoice: {
                invoice_id: 'zoho-1',
                invoice_number: 'INV-100',
                date: '2026-01-15',
                status: 'paid',
                line_items: [lineItem('LINE-A')],
            },
        });
        expect(first.success).toBe(true);
        expect(first.created).toBe(1);
        expect(first.errors).toHaveLength(0);

        // Same delivery again (Zoho re-send): must take the update path.
        const second = await actions.handleInvoiceWebhook({
            invoice: {
                invoice_id: 'zoho-1',
                invoice_number: 'INV-100',
                date: '2026-01-15',
                status: 'paid',
                line_items: [lineItem('LINE-A', { qty: 5 })],
            },
        });
        expect(second.created).toBe(0);
        expect(second.updated).toBe(1);

        const sales = await models.sale.findMany({ where: {} });
        expect(sales).toHaveLength(1);
        expect(sales[0].productId).toBe(product.id);
        expect(sales[0].quantity).toBe(5);
    });

    test('a line item that fails at the database does not roll back earlier lines', async () => {
        await seedProduct();

        // Line 2's quantity overflows any Postgres integer type, so its INSERT
        // fails as a statement error inside the loop. Under the old wrapping
        // transaction this aborted the invocation and rolled back line 1 too;
        // with dbTransaction: false, line 1 must survive.
        const result = await actions.handleInvoiceWebhook({
            invoice_id: 'zoho-2',
            invoice_number: 'INV-200',
            date: '2026-01-16',
            status: 'paid',
            line_items: [
                lineItem('LINE-OK'),
                lineItem('LINE-BAD', { qty: 1e19 }),
            ],
        });

        expect(result.success).toBe(true);
        expect(result.created).toBe(1);
        expect(result.skipped).toBe(1);
        expect(result.errors).toHaveLength(1);

        const sales = await models.sale.findMany({ where: {} });
        expect(sales).toHaveLength(1);
        expect(sales[0].lineItemId).toBe('LINE-OK');
    });

    // The worm used to trail the webhook by up to six and a half hours, waiting
    // on the scheduled rebuild. Each delivery now rebuilds the months it touched.
    test('brings the cumulative sales for the invoice month up to date', async () => {
        await seedProduct();

        const result = await actions.handleInvoiceWebhook({
            invoice: {
                invoice_id: 'zoho-3',
                invoice_number: 'INV-300',
                date: dayIn(LAST_MONTH, 15),
                status: 'paid',
                line_items: [lineItem('LINE-A')],
            },
        });
        expect(result.cumulativeMonthsRebuilt).toEqual([monthKey(LAST_MONTH)]);

        const rows = await models.cumulativeSales.findMany({});
        const lastDay = daysInMonth(LAST_MONTH);
        // A closed month, so the series runs to its last day.
        expect(rows).toHaveLength(lastDay);
        expect(Number(rows.find((r) => r.dayOfMonth === 14)!.cumulativeSales)).toBe(0);
        expect(Number(rows.find((r) => r.dayOfMonth === 15)!.cumulativeSales)).toBe(260);
        expect(Number(rows.find((r) => r.dayOfMonth === lastDay)!.cumulativeSales)).toBe(260);
    });

    // Invoices from long ago still get edited in Zoho. Rebuilding their month
    // would put it back on the worm beside the current three.
    test('an invoice dated before the worm window leaves the worm alone', async () => {
        await seedProduct();

        const result = await actions.handleInvoiceWebhook({
            invoice: {
                invoice_id: 'zoho-7',
                invoice_number: 'INV-700',
                date: dayIn(monthsAgo(3), 15),
                status: 'paid',
                line_items: [lineItem('LINE-A')],
            },
        });

        // The sale itself is still recorded.
        expect(result.created).toBe(1);
        expect(result.cumulativeMonthsRebuilt).toEqual([]);
        expect(await models.cumulativeSales.findMany({})).toHaveLength(0);
    });

    test('an invoice re-dated into another month moves its revenue across', async () => {
        await seedProduct();

        const deliver = (date: string) =>
            actions.handleInvoiceWebhook({
                invoice: {
                    invoice_id: 'zoho-4',
                    invoice_number: 'INV-400',
                    date,
                    status: 'paid',
                    line_items: [lineItem('LINE-A')],
                },
            });

        await deliver(dayIn(TWO_MONTHS_AGO, daysInMonth(TWO_MONTHS_AGO)));
        const moved = await deliver(dayIn(LAST_MONTH, 1));
        expect(moved.cumulativeMonthsRebuilt).toEqual([monthKey(TWO_MONTHS_AGO), monthKey(LAST_MONTH)]);

        const rows = await models.cumulativeSales.findMany({});
        // The month it left is emptied out entirely, not left holding stale revenue.
        expect(rows.filter((r) => r.monthLabel === monthLabelOf(TWO_MONTHS_AGO))).toHaveLength(0);
        const lastDay = daysInMonth(LAST_MONTH);
        const landedIn = rows.filter((r) => r.monthLabel === monthLabelOf(LAST_MONTH));
        expect(landedIn).toHaveLength(lastDay);
        expect(Number(landedIn.find((r) => r.dayOfMonth === lastDay)!.cumulativeSales)).toBe(260);
    });

    // Zoho often sends the same invoice twice within ~100ms; both deliveries
    // rebuild the same month at once and both must succeed.
    test('simultaneous deliveries of one invoice both rebuild cleanly', async () => {
        await seedProduct();

        const delivery = () =>
            actions.handleInvoiceWebhook({
                invoice: {
                    invoice_id: 'zoho-5',
                    invoice_number: 'INV-500',
                    date: dayIn(LAST_MONTH, 15),
                    status: 'paid',
                    line_items: [lineItem('LINE-A')],
                },
            });

        const results = await Promise.all([delivery(), delivery(), delivery()]);
        for (const result of results) {
            expect(result.cumulativeMonthsRebuilt).toEqual([monthKey(LAST_MONTH)]);
        }

        const rows = await models.cumulativeSales.findMany({});
        const lastDay = daysInMonth(LAST_MONTH);
        expect(rows).toHaveLength(lastDay);
        expect(Number(rows.find((r) => r.dayOfMonth === lastDay)!.cumulativeSales)).toBe(260);
    });

    // Keel parses the payload's last_modified_time into a Date before the
    // function sees it, so what gets stored is no longer Zoho's own spelling.
    // The scheduled sync must still recognise the invoice as unchanged when the
    // list API reports that same time, or it re-fetches the invoice's detail
    // after every webhook delivery.
    test('an invoice the webhook wrote is skipped by the next sync while unchanged', async () => {
        await seedProduct();

        await actions.handleInvoiceWebhook({
            invoice: {
                invoice_id: 'zoho-6',
                invoice_number: 'INV-600',
                date: '2026-01-15',
                status: 'paid',
                last_modified_time: '2026-01-15T11:00:00+0200',
                line_items: [lineItem('LINE-A')],
            },
        });

        const [sale] = await models.sale.findMany({});
        const { skipped } = partitionInvoicesByChange(
            [{ invoice_number: 'INV-600', last_modified_time: '2026-01-15T11:00:00+0200' }],
            new Map([['INV-600', sale.zohoModifiedTime]])
        );
        expect(skipped).toBe(1);
    });
});
