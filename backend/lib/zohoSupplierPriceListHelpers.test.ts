import { models, resetDatabase } from '@teamkeel/testing';
import { beforeEach, describe, expect, test } from 'vitest';
import {
    LocalPriceList,
    PriceListSyncStep,
    ZohoPriceListDetail,
    ZohoPriceListSummary,
    buildPriceListItems,
    findUnmatchedPriceListSkus,
    linkUnmatchedPriceListItems,
    planPriceLists,
    priceListSyncNotes,
    runSupplierPriceListSync,
} from './zohoSupplierPriceListHelpers';
import { ZohoGet } from './zohoInventoryApi';

beforeEach(resetDatabase);

// ─── Fixtures ─────────────────────────────────────────────────────────────────
// Shaped on the org's first purchase price list (2026-10-05): Premier
// Farnell's GBP prices for two micro:bits. Zoho lists items by item_id alone;
// the SKUs come from its item catalogue.

function farnellList(overrides: Partial<ZohoPriceListDetail> = {}): ZohoPriceListDetail {
    return {
        pricebook_id: 'zpl-farnell',
        name: 'Premier Farnell UK Ltd. (GBP) price list',
        description: '',
        currency_code: 'GBP',
        status: 'active',
        pricebook_type: 'per_item',
        pricing_scheme: 'unit',
        pricebook_items: [
            { item_id: 'zi-go', name: 'BBC micro:bit Go', pricebook_rate: 12.85 },
            { item_id: 'zi-club', name: 'BBC micro:bit Club', pricebook_rate: 124.75 },
        ],
        ...overrides,
    };
}

function summaryOf(list: ZohoPriceListDetail, lastModified = '2026-10-05T05:02:13+0200', type = 'purchases'): ZohoPriceListSummary {
    return { pricebook_id: list.pricebook_id, name: list.name, sales_or_purchase_type: type, last_modified_time: lastModified };
}

const CATALOGUE = [
    { item_id: 'zi-go', sku: 'MEFV22G' },
    { item_id: 'zi-club', sku: 'MEFV22CB' },
];

// A fake Zoho Inventory API over in-memory price lists and items, recording
// every call.
function fakeZoho(lists: ZohoPriceListDetail[], summaries = lists.map((l) => summaryOf(l)), catalogue = CATALOGUE) {
    const calls: string[] = [];
    const byId = new Map(lists.map((l) => [l.pricebook_id, l]));
    const page = <T>(rows: T[], query: Record<string, string>) => {
        const n = Number(query.page);
        const size = Number(query.per_page);
        return { rows: rows.slice((n - 1) * size, n * size), page_context: { has_more_page: n * size < rows.length } };
    };
    const get: ZohoGet = async (path, query = {}) => {
        calls.push(path);
        if (path === '/pricebooks') {
            const { rows, page_context } = page(summaries, query);
            return { pricebooks: rows, page_context };
        }
        if (path === '/items') {
            expect(query.filter_by).toBe('Status.All');
            const { rows, page_context } = page(catalogue, query);
            return { items: rows, page_context };
        }
        const detail = path.match(/^\/pricebooks\/([^/]+)$/);
        if (detail) return { pricebook: byId.get(detail[1]) };
        throw new Error(`Unexpected Zoho call ${path}`);
    };
    return { get, calls };
}

// Runs each step inline, as a flow would on its first pass.
function inlineSteps() {
    const names: string[] = [];
    const step: PriceListSyncStep = async (name, _options, fn) => {
        names.push(name);
        return await fn({ progress: { set() {}, increment() {}, log() {} } });
    };
    return { step, names };
}

async function createProduct(sku: string) {
    const brand = (await models.brand.findMany({ where: { name: { equals: 'Brand' } } }))[0] ?? (await models.brand.create({ name: 'Brand' }));
    return await models.product.create({ name: `Product ${sku}`, sku, brandId: brand.id });
}

async function itemsOf(zohoPriceListId: string) {
    const list = await models.supplierPriceList.findOne({ zohoPriceListId });
    if (!list) return [];
    const items = await models.supplierPriceListItem.findMany({ where: { priceListId: { equals: list.id } } });
    return items.sort((a, b) => (a.sku ?? '').localeCompare(b.sku ?? ''));
}

const sync = (get: ZohoGet, readAll = false) => runSupplierPriceListSync(inlineSteps().step, get, { readAll });

// ─── buildPriceListItems (pure) ───────────────────────────────────────────────

describe('buildPriceListItems', () => {
    test("gives each item its SKU from the catalogue and its rate", () => {
        const skus = new Map(CATALOGUE.map((i) => [i.item_id, i.sku]));
        expect(buildPriceListItems(farnellList(), skus)).toEqual([
            { zohoItemId: 'zi-go', sku: 'MEFV22G', name: 'BBC micro:bit Go', rate: 12.85 },
            { zohoItemId: 'zi-club', sku: 'MEFV22CB', name: 'BBC micro:bit Club', rate: 124.75 },
        ]);
    });

    test('leaves the rate unset where Zoho gives no single one, and the SKU where the catalogue has none', () => {
        const items = buildPriceListItems(
            farnellList({
                pricing_scheme: 'volume',
                pricebook_items: [
                    { item_id: 'zi-go', pricebook_rate: '' },
                    { item_id: 'zi-gone', pricebook_rate: '3.50' },
                ],
            }),
            new Map([['zi-go', 'MEFV22G']])
        );
        expect(items.map((i) => [i.sku, i.rate])).toEqual([
            ['MEFV22G', null],
            [null, 3.5],
        ]);
    });
});

// ─── planPriceLists (pure) ────────────────────────────────────────────────────

describe('planPriceLists', () => {
    const stored: LocalPriceList = { id: 'local-1', zohoPriceListId: 'zpl-farnell', zohoModifiedAt: new Date('2026-10-05T03:02:13Z') };

    test('reads a new list, and skips an unchanged one', () => {
        expect(planPriceLists([summaryOf(farnellList())], [], false).toRead).toHaveLength(1);
        expect(planPriceLists([summaryOf(farnellList())], [stored], false)).toEqual({ toRead: [], toDelete: [], unchanged: 1 });
    });

    test('reads a list Zoho has modified, or every list when told to', () => {
        expect(planPriceLists([summaryOf(farnellList(), '2026-10-06T09:00:00+0200')], [stored], false).toRead).toHaveLength(1);
        expect(planPriceLists([summaryOf(farnellList())], [stored], true).toRead).toHaveLength(1);
    });

    test('drops a list gone from Zoho', () => {
        expect(planPriceLists([], [stored], false).toDelete).toEqual([stored]);
    });
});

// ─── The whole run ────────────────────────────────────────────────────────────

describe('runSupplierPriceListSync', () => {
    test("stores each purchase list with its items, linked to products by SKU, and puts them on the product", async () => {
        const go = await createProduct('MEFV22G');
        const club = await createProduct('MEFV22CB');
        const { step, names } = inlineSteps();

        const summary = await runSupplierPriceListSync(step, fakeZoho([farnellList()]).get, { readAll: false });

        expect(names).toEqual(['price-lists', 'link-price-list-items']);
        expect(summary).toEqual({
            read: [{ priceList: 'Premier Farnell UK Ltd. (GBP) price list', currencyCode: 'GBP', items: 2, change: 'Added' }],
            removed: 0,
            unchanged: 0,
            withoutRates: [],
            itemsLinked: 0,
            unmatchedSkus: [],
        });
        const list = await models.supplierPriceList.findOne({ zohoPriceListId: 'zpl-farnell' });
        expect(list).toMatchObject({
            name: 'Premier Farnell UK Ltd. (GBP) price list',
            description: null,
            currencyCode: 'GBP',
            isActive: true,
            priceListType: 'per_item',
            pricingScheme: 'unit',
            totalItems: 2,
            zohoModifiedAt: new Date('2026-10-05T03:02:13Z'),
        });
        const items = await itemsOf('zpl-farnell');
        expect(items.map((i) => [i.sku, i.productId, Number(i.rate), i.currencyCode, i.priceListName])).toEqual([
            ['MEFV22CB', club.id, 124.75, 'GBP', 'Premier Farnell UK Ltd. (GBP) price list'],
            ['MEFV22G', go.id, 12.85, 'GBP', 'Premier Farnell UK Ltd. (GBP) price list'],
        ]);
        const prices = await models.supplierPriceListItem.findMany({ where: { productId: { equals: go.id } } });
        expect(prices).toHaveLength(1);
    });

    test('skips sales price lists: what we sell at is our own PriceList', async () => {
        const sales = farnellList({ pricebook_id: 'zpl-sales', name: 'Retail' });
        const zoho = fakeZoho([sales], [summaryOf(sales, undefined, 'sales')]);

        const summary = await sync(zoho.get);

        expect(summary.read).toEqual([]);
        expect(await models.supplierPriceList.findMany({})).toHaveLength(0);
        // Nothing to read, so the item catalogue isn't fetched either.
        expect(zoho.calls).toEqual(['/pricebooks']);
    });

    test('costs one call on a night nothing changed, and reads everything when told to', async () => {
        await sync(fakeZoho([farnellList()]).get);

        const quiet = fakeZoho([farnellList()]);
        expect((await sync(quiet.get)).unchanged).toBe(1);
        expect(quiet.calls).toEqual(['/pricebooks']);

        const all = fakeZoho([farnellList()]);
        const summary = await sync(all.get, true);
        expect(summary.read.map((l) => l.change)).toEqual(['Updated']);
        expect(all.calls).toEqual(['/pricebooks', '/items', '/pricebooks/zpl-farnell']);
    });

    test("replaces a changed list's items, and removes a list deleted in Zoho", async () => {
        await sync(fakeZoho([farnellList()]).get);

        const repriced = farnellList({ pricebook_items: [{ item_id: 'zi-go', name: 'BBC micro:bit Go', pricebook_rate: 13.1 }] });
        await sync(fakeZoho([repriced], [summaryOf(repriced, '2026-10-06T09:00:00+0200')]).get);
        expect((await itemsOf('zpl-farnell')).map((i) => [i.sku, Number(i.rate)])).toEqual([['MEFV22G', 13.1]]);

        const summary = await sync(fakeZoho([]).get);
        expect(summary.removed).toBe(1);
        expect(await models.supplierPriceList.findMany({})).toHaveLength(0);
        expect(await models.supplierPriceListItem.findMany({})).toHaveLength(0);
    });

    test('keeps an inactive list, marked inactive', async () => {
        await sync(fakeZoho([farnellList({ status: 'inactive' })]).get);
        expect((await models.supplierPriceList.findOne({ zohoPriceListId: 'zpl-farnell' }))!.isActive).toBe(false);
    });

    test('names lists that have items without a rate', async () => {
        const markUp = farnellList({ pricebook_id: 'zpl-markup', name: 'Mark-up', pricebook_type: 'fixed_percentage', pricebook_items: [] });
        const volume = farnellList({ pricebook_id: 'zpl-volume', name: 'Volume', pricing_scheme: 'volume', pricebook_items: [{ item_id: 'zi-go', pricebook_rate: '' }] });

        const summary = await sync(fakeZoho([farnellList(), markUp, volume]).get);

        expect(summary.withoutRates).toEqual(['Mark-up', 'Volume']);
        expect(priceListSyncNotes(summary)[0]).toContain('2 price list(s) have items without a rate');
    });

    test('fails, rather than deleting every list, when Zoho answers without a list', async () => {
        await sync(fakeZoho([farnellList()]).get);
        const odd: ZohoGet = async () => ({ code: 0, message: 'success' });

        await expect(sync(odd)).rejects.toThrow('without a list of pricebooks');
        expect(await models.supplierPriceList.findMany({})).toHaveLength(1);
    });
});

// ─── Linking products that arrive later ───────────────────────────────────────

describe('linkUnmatchedPriceListItems', () => {
    test('links an item to a product synced after it, and lists the SKUs still unmatched', async () => {
        const summary = await sync(fakeZoho([farnellList()]).get);
        expect(summary.unmatchedSkus).toEqual(['MEFV22CB', 'MEFV22G']);
        expect(priceListSyncNotes(summary)[0]).toContain('2 SKU(s) on price lists match no product here');

        const go = await createProduct('MEFV22G');
        expect(await linkUnmatchedPriceListItems()).toBe(1);

        expect((await itemsOf('zpl-farnell')).find((i) => i.sku === 'MEFV22G')!.productId).toBe(go.id);
        expect(await findUnmatchedPriceListSkus()).toEqual(['MEFV22CB']);
    });
});
