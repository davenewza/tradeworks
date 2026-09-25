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

beforeEach(resetDatabase);

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
});
