import { models, resetDatabase } from '@teamkeel/testing';
import { StockCoverStatus } from '@teamkeel/sdk';
import { beforeEach, describe, expect, test } from 'vitest';
import {
    BilledBy,
    LocalProduct,
    NO_BRAND,
    applyAssignments,
    fetchZohoItemBrands,
    groupProductsByBrand,
    loadBilledBy,
    loadProducts,
    planAssignments,
    suggestSupplier,
    zohoBrandOf,
} from './brandSupplierHelpers';
import { ZohoGet } from './zohoInventoryApi';

// ─── Reading Zoho ─────────────────────────────────────────────────────────────

describe('zohoBrandOf', () => {
    test("reads the item's Brand custom field, as the list carries it", () => {
        expect(zohoBrandOf({ item_id: '1', cf_brand: 'Makerzoid', cf_brand_unformatted: 'Makerzoid' })).toBe('Makerzoid');
        expect(zohoBrandOf({ item_id: '1', cf_brand: ' Robotico (kits) ' })).toBe('Robotico (kits)');
    });

    test('puts an item with no brand in its own group', () => {
        expect(zohoBrandOf({ item_id: '1' })).toBe(NO_BRAND);
        expect(zohoBrandOf({ item_id: '1', cf_brand: '  ' })).toBe(NO_BRAND);
    });
});

describe('fetchZohoItemBrands', () => {
    test('pages through every item, active or not, keeping those with a SKU', async () => {
        const queries: Record<string, string>[] = [];
        const get: ZohoGet = async (path, query = {}) => {
            expect(path).toBe('/items');
            queries.push(query);
            return query.page === '1'
                ? { items: [{ item_id: '1', sku: 'MZ-1', cf_brand: 'Makerzoid' }, { item_id: '2', cf_brand: 'Makerzoid' }], page_context: { has_more_page: true } }
                : { items: [{ item_id: '3', sku: ' EQ-1 ', cf_brand: 'Equibrand' }], page_context: { has_more_page: false } };
        };

        expect(await fetchZohoItemBrands(get)).toEqual([
            { sku: 'MZ-1', brand: 'Makerzoid' },
            { sku: 'EQ-1', brand: 'Equibrand' },
        ]);
        expect(queries.map((q) => [q.filter_by, q.page])).toEqual([
            ['Status.All', '1'],
            ['Status.All', '2'],
        ]);
    });

    test('fails when Zoho answers without a list of items', async () => {
        await expect(fetchZohoItemBrands(async () => ({ code: 0 }))).rejects.toThrow('without a list of items');
    });
});

// ─── Grouping, suggesting and planning (pure) ─────────────────────────────────

const products: LocalProduct[] = [
    { id: 'p-mz1', sku: 'MZ-1', supplierId: null },
    { id: 'p-mz2', sku: 'MZ-2', supplierId: 's-other' },
    { id: 'p-eq1', sku: 'EQ-1', supplierId: null },
    // Not in Zoho's listing any more: no brand to go by.
    { id: 'p-gone', sku: 'GONE', supplierId: null },
];
const items = [
    { sku: 'MZ-1', brand: 'Makerzoid' },
    { sku: 'MZ-2', brand: 'Makerzoid' },
    { sku: 'EQ-1', brand: 'Equibrand' },
];

describe('groupProductsByBrand', () => {
    test("groups our products by their brand in Zoho, counting those that already have a supplier", () => {
        expect(groupProductsByBrand(items, products)).toEqual([
            { brand: 'Equibrand', productIds: ['p-eq1'], withSupplier: 0 },
            { brand: 'Makerzoid', productIds: ['p-mz1', 'p-mz2'], withSupplier: 1 },
        ]);
    });
});

describe('suggestSupplier', () => {
    const billed = (productId: string, supplierId: string, lines: number, last: string): BilledBy => ({
        productId,
        supplierId,
        lines,
        lastBilled: new Date(last),
    });

    test('suggests the supplier that has billed the most of the brand’s products', () => {
        const rows = [
            billed('a', 'kuongshun', 1, '2026-01-01'),
            billed('b', 'kuongshun', 1, '2026-01-01'),
            // More lines, but for one product only.
            billed('c', 'local', 9, '2026-09-01'),
            // Not one of the brand's products.
            billed('x', 'local', 50, '2026-09-01'),
        ];
        expect(suggestSupplier(['a', 'b', 'c', 'd'], rows)).toEqual({ supplierId: 'kuongshun', productsBilled: 2, productsWithBills: 3 });
    });

    test('breaks a tie on bill lines, then on the most recent bill', () => {
        expect(suggestSupplier(['a', 'b'], [billed('a', 'one', 1, '2026-01-01'), billed('b', 'two', 3, '2025-01-01')])!.supplierId).toBe('two');
        expect(suggestSupplier(['a', 'b'], [billed('a', 'one', 1, '2026-01-01'), billed('b', 'two', 1, '2025-01-01')])!.supplierId).toBe('one');
    });

    test('suggests nothing for a brand never billed', () => {
        expect(suggestSupplier(['a'], [billed('x', 'one', 1, '2026-01-01')])).toBeNull();
    });
});

describe('planAssignments', () => {
    const groups = groupProductsByBrand(items, products);

    test('gives a mapped brand’s products without a supplier that supplier, and leaves the rest', () => {
        const plan = planAssignments(groups, { Makerzoid: 's-mz', Equibrand: null }, products, false);
        expect(plan.bySupplier).toEqual({ 's-mz': ['p-mz1'] });
        expect(plan.brands).toEqual([
            { brand: 'Equibrand', supplierId: null, assigned: 0, replaced: 0, unchanged: 1 },
            { brand: 'Makerzoid', supplierId: 's-mz', assigned: 1, replaced: 0, unchanged: 1 },
        ]);
    });

    test('moves products off another supplier only when told to', () => {
        const plan = planAssignments(groups, { Makerzoid: 's-mz', Equibrand: 's-eq' }, products, true);
        expect(plan.bySupplier).toEqual({ 's-mz': ['p-mz1', 'p-mz2'], 's-eq': ['p-eq1'] });
        expect(plan.brands.find((b) => b.brand === 'Makerzoid')).toMatchObject({ assigned: 1, replaced: 1, unchanged: 0 });
    });

    test('leaves a product already on the mapped supplier unchanged', () => {
        const plan = planAssignments(groups, { Makerzoid: 's-other' }, products, true);
        expect(plan.bySupplier).toEqual({ 's-other': ['p-mz1'] });
        expect(plan.brands.find((b) => b.brand === 'Makerzoid')).toMatchObject({ assigned: 1, replaced: 0, unchanged: 1 });
    });
});

// ─── Reading and writing here ─────────────────────────────────────────────────

describe('loading and applying', () => {
    beforeEach(resetDatabase);

    test('tallies who has billed each product, per supplier', async () => {
        const brand = await models.brand.create({ name: 'Makerzoid' });
        const product = await models.product.create({ name: 'Kit', sku: 'MZ-1', brandId: brand.id });
        const supplier = await models.supplier.create({ name: 'Kuongshun' });
        let n = 0;
        for (const date of ['2026-01-01', '2026-06-01']) {
            const bill = await models.supplierBill.create({ zohoBillId: `zb-${date}`, billNumber: date, date: new Date(date), supplierId: supplier.id, zohoModifiedAt: new Date() });
            await models.supplierBillLine.create({ supplierBillId: bill.id, productId: product.id, quantity: 10, unitCost: 1, zohoLineItemId: `li-${++n}`, position: 1 });
        }
        // A bill whose supplier was deleted counts for nobody.
        const orphan = await models.supplierBill.create({ zohoBillId: 'zb-orphan', billNumber: 'X', zohoModifiedAt: new Date() });
        await models.supplierBillLine.create({ supplierBillId: orphan.id, productId: product.id, quantity: 1, unitCost: 1, zohoLineItemId: 'li-x', position: 1 });

        const rows = await loadBilledBy();

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ productId: product.id, supplierId: supplier.id, lines: 2 });
        expect([rows[0].lastBilled!.getFullYear(), rows[0].lastBilled!.getMonth() + 1]).toEqual([2026, 6]);
    });

    test('sets the planned suppliers, and the products are graded straight away', async () => {
        const brand = await models.brand.create({ name: 'Makerzoid' });
        const supplier = await models.supplier.create({ name: 'Kuongshun', leadTimeInDays: 60 });
        // 1 month of cover against a 2-month lead time: a shortfall, once graded.
        const kit = await models.product.create({ name: 'Kit', sku: 'MZ-1', brandId: brand.id, currentStockCover: 1 });
        const other = await models.product.create({ name: 'Other', sku: 'MZ-2', brandId: brand.id, currentStockCover: 1 });
        expect((await models.product.findOne({ id: kit.id }))!.stockCoverStatus).toBeNull();

        const changed = await applyAssignments({ bySupplier: { [supplier.id]: [kit.id] }, brands: [] }, new Date());

        expect(changed).toBe(1);
        expect(await models.product.findOne({ id: kit.id })).toMatchObject({ supplierId: supplier.id, stockCoverStatus: StockCoverStatus.InsufficientSupply });
        expect((await models.product.findOne({ id: other.id }))!.supplierId).toBeNull();
        expect((await loadProducts()).find((p) => p.id === kit.id)).toEqual({ id: kit.id, sku: 'MZ-1', supplierId: supplier.id });
    });
});
