import { models, resetDatabase } from '@teamkeel/testing';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
    BillSyncStep,
    LocalBill,
    ZohoBillDetail,
    ZohoBillSummary,
    ZohoLandedCost,
    buildBillLines,
    findUnmatchedSkus,
    linkUnmatchedLines,
    planSupplierBills,
    runSupplierBillSync,
    syncSupplierBillsBatch,
} from './zohoBillHelpers';
import { ZohoGet, parseZohoTime } from './zohoInventoryApi';

beforeEach(resetDatabase);

const num = (v: unknown) => Number(v);

// ─── Fixtures ─────────────────────────────────────────────────────────────────
// Shaped on the org's real payloads: an import from Kuongshun with a customs fee
// on the bill itself and freight from a forwarder's bill, both allocated across
// the stock lines.

function importBill(overrides: Partial<ZohoBillDetail> = {}): ZohoBillDetail {
    return {
        bill_id: 'zb-1',
        bill_number: '8020260904',
        date: '2026-09-04',
        status: 'open',
        currency_code: 'ZAR',
        exchange_rate: 1,
        total: 5300,
        allocated_landed_costs: [{ landed_cost_id: 'lc-customs' }, { landed_cost_id: 'lc-freight' }],
        line_items: [
            { line_item_id: 'li-1', sku: 'RL-AE086', name: 'Arduino Starter Kit', account_name: 'Inventory Asset', rate: 40, quantity: 100, item_total: 4000 },
            { line_item_id: 'li-2', sku: 'RL-AE087', name: 'Mega Starter Kit', account_name: 'Inventory Asset', rate: 50, quantity: 20, item_total: 1000 },
            { line_item_id: 'li-lc', name: 'Customs fee', account_name: 'Inventory', rate: 300, quantity: 1, item_total: 300, is_landedcost: true },
        ],
        ...overrides,
    };
}

const importLandedCosts: ZohoLandedCost[] = [
    {
        landed_cost_id: 'lc-customs',
        cost_allocations: [
            { bill_item_id: 'li-1', allocated_amount: 240 },
            { bill_item_id: 'li-2', allocated_amount: 60 },
        ],
    },
    {
        landed_cost_id: 'lc-freight',
        cost_allocations: [
            { bill_item_id: 'li-1', allocated_amount: 760 },
            { bill_item_id: 'li-2', allocated_amount: 140 },
        ],
    },
];

function summaryOf(bill: ZohoBillDetail, lastModified = '2026-09-07T10:43:18+0200'): ZohoBillSummary {
    return { bill_id: bill.bill_id, bill_number: bill.bill_number, date: bill.date, status: bill.status, last_modified_time: lastModified };
}

// A fake Zoho Inventory API over in-memory bills, recording every call.
interface FakeZoho {
    lists: Record<string, ZohoBillSummary[]>;
    bills: Record<string, ZohoBillDetail>;
    landedCosts: Record<string, ZohoLandedCost>;
}

function fakeZoho(zoho: FakeZoho): { get: ZohoGet; calls: string[] } {
    const calls: string[] = [];
    const get: ZohoGet = async (path, query = {}) => {
        calls.push(path);
        if (path === '/bills') {
            const all = zoho.lists[query.vendor_id] ?? [];
            const page = Number(query.page);
            const perPage = Number(query.per_page);
            return { bills: all.slice((page - 1) * perPage, page * perPage), page_context: { has_more_page: page * perPage < all.length } };
        }
        const landedCost = path.match(/^\/bills\/[^/]+\/landedcosts\/([^/]+)$/);
        if (landedCost) return { landed_cost: zoho.landedCosts[landedCost[1]] };
        const bill = path.match(/^\/bills\/([^/]+)$/);
        if (bill) return { bill: zoho.bills[bill[1]] };
        throw new Error(`Unexpected Zoho call ${path}`);
    };
    return { get, calls };
}

function withImport(bill = importBill(), lastModified?: string): FakeZoho {
    return {
        lists: { 'v-kuongshun': [summaryOf(bill, lastModified)] },
        bills: { [bill.bill_id]: bill },
        landedCosts: Object.fromEntries(importLandedCosts.map((lc) => [lc.landed_cost_id, lc])),
    };
}

async function createProduct(sku: string) {
    const brand = (await models.brand.findMany({ where: { name: { equals: 'Brand' } } }))[0] ?? (await models.brand.create({ name: 'Brand' }));
    return await models.product.create({ name: `Product ${sku}`, sku, brandId: brand.id });
}

async function createSupplier(name = 'Kuongshun Electronic Limited', zohoVendorId = 'v-kuongshun') {
    const supplier = await models.supplier.create({ name, zohoVendorId });
    return { id: supplier.id, name, zohoVendorId };
}

async function linesOf(zohoBillId: string) {
    const bill = await models.supplierBill.findOne({ zohoBillId });
    if (!bill) return [];
    const lines = await models.supplierBillLine.findMany({ where: { supplierBillId: { equals: bill.id } } });
    return lines.sort((a, b) => a.position - b.position);
}

const NOW = new Date('2026-10-04T08:00:00Z');

// ─── buildBillLines (pure) ────────────────────────────────────────────────────

describe('buildBillLines', () => {
    test('keeps every line, with the freight allocated to it summed across landed costs', () => {
        const lines = buildBillLines(importBill(), importLandedCosts);

        expect(lines.map((l) => [l.position, l.sku, l.isLandedCost])).toEqual([
            [1, 'RL-AE086', false],
            [2, 'RL-AE087', false],
            [3, null, true],
        ]);
        expect(lines[0].unitCost).toBe(40);
        expect(lines[0].freightIn).toBe(1000); // 240 customs + 760 freight
        expect(lines[1].freightIn).toBe(200);
        expect(lines[2].freightIn).toBe(0);
        expect(lines[2].name).toBe('Customs fee');
        expect(lines[0].accountName).toBe('Inventory Asset');
    });

    test('takes the unit cost excl VAT on a tax-inclusive bill, where the rate includes it', () => {
        // A real local bill: rate 347.44 incl 15% VAT, item_total 302.12 excl.
        const [line] = buildBillLines(
            importBill({ line_items: [{ line_item_id: 'li', sku: 'X', rate: 347.44, quantity: 1, item_total: 302.12 }] }),
            []
        );
        expect(line.unitCost).toBeCloseTo(302.12, 10);
    });

    test('takes the unit cost after a line discount', () => {
        const [line] = buildBillLines(
            importBill({ line_items: [{ line_item_id: 'li', sku: 'X', rate: 10, quantity: 10, item_total: 90 }] }),
            []
        );
        expect(line.unitCost).toBe(9);
    });

    test('converts a foreign-currency bill to rand', () => {
        const [line] = buildBillLines(
            importBill({
                currency_code: 'USD',
                exchange_rate: 18.5,
                line_items: [{ line_item_id: 'li', sku: 'X', rate: 10, quantity: 10, item_total: 100 }],
            }),
            []
        );
        expect(line.unitCost).toBeCloseTo(185, 10);
    });

    test('never divides by a zero quantity', () => {
        const [line] = buildBillLines(
            importBill({ line_items: [{ line_item_id: 'li', sku: 'X', rate: 12, quantity: 0, item_total: 0 }] }),
            []
        );
        expect(line.unitCost).toBe(12);
        expect(line.quantity).toBe(0);
    });

    test('trims SKUs, blanks empty ones, and names a line by its description when it has no item', () => {
        const lines = buildBillLines(
            importBill({
                line_items: [
                    { line_item_id: 'a', sku: ' RL-1 ', name: 'Kit', quantity: 1, item_total: 1 },
                    { line_item_id: 'b', sku: '', description: 'Advance payment for Nicole20220214', account_name: 'Advance to Suppliers', quantity: 1, item_total: 1 },
                ],
            }),
            []
        );
        expect(lines[0].sku).toBe('RL-1');
        expect(lines[1].sku).toBeNull();
        expect(lines[1].name).toBe('Advance payment for Nicole20220214');
    });
});

describe('parseZohoTime', () => {
    test("reads Zoho's colon-less offsets", () => {
        expect(parseZohoTime('2026-09-07T10:43:18+0200').toISOString()).toBe('2026-09-07T08:43:18.000Z');
    });

    test('rejects what it cannot read', () => {
        expect(() => parseZohoTime('yesterday')).toThrow(/Unreadable/);
    });
});

// ─── planSupplierBills (pure) ─────────────────────────────────────────────────

describe('planSupplierBills', () => {
    const stored = (zohoBillId: string, modified: string, status: string | null = 'open'): LocalBill => ({
        id: `id-${zohoBillId}`,
        zohoBillId,
        zohoModifiedAt: parseZohoTime(modified),
        status,
    });
    const listed = (bill_id: string, last_modified_time: string, extra: Partial<ZohoBillSummary> = {}): ZohoBillSummary => ({
        bill_id,
        bill_number: bill_id,
        status: 'open',
        last_modified_time,
        ...extra,
    });

    test('reads new and changed bills, oldest first, and skips unchanged ones', () => {
        const plan = planSupplierBills(
            [
                listed('new', '2026-09-01T10:00:00+0200', { date: '2026-09-01' }),
                listed('same', '2026-08-01T10:00:00+0200'),
                listed('moved', '2026-09-02T10:00:00+0200', { date: '2026-03-01' }),
            ],
            [stored('same', '2026-08-01T10:00:00+0200'), stored('moved', '2026-08-01T10:00:00+0200')]
        );

        expect(plan.toRead.map((b) => b.bill_id)).toEqual(['moved', 'new']);
        expect(plan.unchanged).toBe(1);
        expect(plan.toDelete).toEqual([]);
    });

    test('treats the same instant in another offset as unchanged', () => {
        const plan = planSupplierBills([listed('a', '2026-08-01T08:00:00+0000')], [stored('a', '2026-08-01T10:00:00+0200')]);
        expect(plan.toRead).toEqual([]);
        expect(plan.unchanged).toBe(1);
    });

    test('deletes bills gone from Zoho or voided there, and never reads a void bill', () => {
        const plan = planSupplierBills(
            [listed('voided', '2026-09-01T10:00:00+0200', { status: 'void' }), listed('void-new', '2026-09-01T10:00:00+0200', { status: 'void' })],
            [stored('voided', '2026-08-01T10:00:00+0200'), stored('gone', '2026-08-01T10:00:00+0200')]
        );

        expect(plan.toRead).toEqual([]);
        expect(plan.toDelete.map((b) => b.zohoBillId).sort()).toEqual(['gone', 'voided']);
    });

    test('picks up a status change on an otherwise unchanged bill', () => {
        const plan = planSupplierBills([listed('a', '2026-08-01T10:00:00+0200', { status: 'paid' })], [stored('a', '2026-08-01T10:00:00+0200', 'open')]);
        expect(plan.statusChanges).toEqual([{ id: 'id-a', status: 'paid' }]);
        expect(plan.toRead).toEqual([]);
    });
});

// ─── syncSupplierBillsBatch (DB) ──────────────────────────────────────────────

describe('syncSupplierBillsBatch', () => {
    test('stores a new bill under its supplier, every line, and the freight on each', async () => {
        const kit = await createProduct('RL-AE086');
        const mega = await createProduct('RL-AE087');
        const supplier = await createSupplier();
        const zoho = fakeZoho(withImport());

        const result = await syncSupplierBillsBatch(zoho.get, supplier, 100, NOW);

        expect(result).toEqual({ created: 1, updated: 0, deleted: 0, unchanged: 0, remaining: 0 });
        // The list, the bill, and its two landed costs.
        expect(zoho.calls).toEqual(['/bills', '/bills/zb-1', '/bills/zb-1/landedcosts/lc-customs', '/bills/zb-1/landedcosts/lc-freight']);

        const bill = await models.supplierBill.findOne({ zohoBillId: 'zb-1' });
        expect(bill!.supplierId).toBe(supplier.id);
        expect(bill!.supplierName).toBe('Kuongshun Electronic Limited');
        expect(bill!.billNumber).toBe('8020260904');
        expect([bill!.date!.getFullYear(), bill!.date!.getMonth() + 1, bill!.date!.getDate()]).toEqual([2026, 9, 4]);
        expect(bill!.zohoModifiedAt.toISOString()).toBe('2026-09-07T08:43:18.000Z');

        const lines = await linesOf('zb-1');
        expect(lines.map((l) => l.productId)).toEqual([kit.id, mega.id, null]);
        expect(lines.every((l) => l.freightAllocated)).toBe(true);
        expect(num(lines[0].unitCost)).toBe(40);
        expect(num(lines[0].freightIn)).toBe(1000);
        expect(num(lines[0].unitFreightIn)).toBe(10);
        expect(num(lines[0].landedUnitCost)).toBe(50);
        expect(lines[2].isLandedCost).toBe(true);

        // What the product prices off: 40 + 1000/100.
        const product = await models.product.findOne({ id: kit.id });
        expect(num(product!.weightedUnitCost)).toBe(40);
        expect(num(product!.weightedFreightIn)).toBe(10);
        expect(num(product!.weightedLandedCost)).toBe(50);
        expect(num(product!.totalUnitsPurchased)).toBe(100);
    });

    test('reads nothing beyond the list on a second run when Zoho has not changed', async () => {
        await createProduct('RL-AE086');
        const supplier = await createSupplier();
        await syncSupplierBillsBatch(fakeZoho(withImport()).get, supplier, 100, NOW);
        const before = await models.supplierBill.findOne({ zohoBillId: 'zb-1' });

        const zoho = fakeZoho(withImport());
        const result = await syncSupplierBillsBatch(zoho.get, supplier, 100, new Date('2026-10-05T08:00:00Z'));

        expect(result).toEqual({ created: 0, updated: 0, deleted: 0, unchanged: 1, remaining: 0 });
        expect(zoho.calls).toEqual(['/bills']);
        const after = await models.supplierBill.findOne({ zohoBillId: 'zb-1' });
        expect(after!.synchronisedAt).toEqual(before!.synchronisedAt);
        expect(await linesOf('zb-1')).toHaveLength(3);
    });

    test('replaces the lines of a bill changed in Zoho, re-pricing its products', async () => {
        const kit = await createProduct('RL-AE086');
        const supplier = await createSupplier();
        await syncSupplierBillsBatch(fakeZoho(withImport()).get, supplier, 100, NOW);

        // Re-saved in Zoho: new line ids, a corrected quantity, and the freight
        // allocation redone to match.
        const resaved = importBill({
            line_items: [{ line_item_id: 'li-9', sku: 'RL-AE086', rate: 40, quantity: 80, item_total: 3200 }],
            allocated_landed_costs: [{ landed_cost_id: 'lc-redone' }],
        });
        const zoho = fakeZoho({
            lists: { 'v-kuongshun': [summaryOf(resaved, '2026-10-01T09:00:00+0200')] },
            bills: { 'zb-1': resaved },
            landedCosts: { 'lc-redone': { landed_cost_id: 'lc-redone', cost_allocations: [{ bill_item_id: 'li-9', allocated_amount: 1200 }] } },
        });
        const result = await syncSupplierBillsBatch(zoho.get, supplier, 100, NOW);

        expect(result.updated).toBe(1);
        const lines = await linesOf('zb-1');
        expect(lines).toHaveLength(1);
        expect(lines[0].zohoLineItemId).toBe('li-9');
        expect(num(lines[0].quantity)).toBe(80);

        const product = await models.product.findOne({ id: kit.id });
        expect(num(product!.totalUnitsPurchased)).toBe(80);
        expect(num(product!.weightedFreightIn)).toBe(15); // 1200 / 80
    });

    test('removes a bill deleted in Zoho, and its lines with it', async () => {
        const kit = await createProduct('RL-AE086');
        const supplier = await createSupplier();
        await syncSupplierBillsBatch(fakeZoho(withImport()).get, supplier, 100, NOW);

        const zoho = fakeZoho({ lists: { 'v-kuongshun': [] }, bills: {}, landedCosts: {} });
        const result = await syncSupplierBillsBatch(zoho.get, supplier, 100, NOW);

        expect(result.deleted).toBe(1);
        expect(await models.supplierBill.findOne({ zohoBillId: 'zb-1' })).toBeNull();
        expect(await models.supplierBillLine.findMany({})).toHaveLength(0);
        const product = await models.product.findOne({ id: kit.id });
        expect(num(product!.weightedLandedCost)).toBe(0);
        expect(num(product!.totalSupplierBills)).toBe(0);
    });

    test('marks a bill with no landed costs yet as not freight-allocated', async () => {
        await createProduct('RL-AE086');
        const supplier = await createSupplier();
        const pending = importBill({ allocated_landed_costs: [] });

        await syncSupplierBillsBatch(fakeZoho(withImport(pending)).get, supplier, 100, NOW);

        const lines = await linesOf('zb-1');
        expect(lines.some((l) => l.freightAllocated)).toBe(false);
        expect(num(lines[0].freightIn)).toBe(0);
    });

    test('reads at most maxReads bills, leaving the rest for the next batch', async () => {
        const supplier = await createSupplier();
        const bills = ['a', 'b', 'c'].map((id, i) => importBill({ bill_id: id, bill_number: id, date: `2026-0${i + 1}-01`, allocated_landed_costs: [] }));
        const zohoData: FakeZoho = {
            lists: { 'v-kuongshun': bills.map((b) => summaryOf(b)) },
            bills: Object.fromEntries(bills.map((b) => [b.bill_id, b])),
            landedCosts: {},
        };

        const first = await syncSupplierBillsBatch(fakeZoho(zohoData).get, supplier, 2, NOW);
        expect(first).toEqual({ created: 2, updated: 0, deleted: 0, unchanged: 0, remaining: 1 });
        // Oldest first.
        expect(await models.supplierBill.findOne({ zohoBillId: 'c' })).toBeNull();

        const second = await syncSupplierBillsBatch(fakeZoho(zohoData).get, supplier, 2, NOW);
        expect(second).toEqual({ created: 1, updated: 0, deleted: 0, unchanged: 2, remaining: 0 });
    });

    test('takes over a bill stored under another supplier when Zoho lists it under this one', async () => {
        const other = await createSupplier('Other Vendor', 'v-other');
        await syncSupplierBillsBatch(fakeZoho({ ...withImport(), lists: { 'v-other': [summaryOf(importBill())] } }).get, other, 100, NOW);

        const supplier = await createSupplier();
        await syncSupplierBillsBatch(fakeZoho(withImport(importBill(), '2026-10-01T09:00:00+0200')).get, supplier, 100, NOW);

        const bills = await models.supplierBill.findMany({});
        expect(bills).toHaveLength(1);
        expect(bills[0].supplierId).toBe(supplier.id);
        expect(await linesOf('zb-1')).toHaveLength(3);
    });
});

// ─── Linking lines to products that arrive later ──────────────────────────────

describe('linkUnmatchedLines', () => {
    test("links a stored line to a product synced after it, and prices the product from it", async () => {
        const supplier = await createSupplier();
        await syncSupplierBillsBatch(fakeZoho(withImport()).get, supplier, 100, NOW);
        expect(await findUnmatchedSkus()).toEqual(['RL-AE086', 'RL-AE087']);

        const kit = await createProduct('RL-AE086');
        expect(await linkUnmatchedLines()).toBe(1);

        const [line] = await linesOf('zb-1');
        expect(line.productId).toBe(kit.id);
        expect(line.productName).toBe('Product RL-AE086');
        const product = await models.product.findOne({ id: kit.id });
        expect(num(product!.weightedLandedCost)).toBe(50);
        // The landed-cost line has no SKU and is never offered as unmatched.
        expect(await findUnmatchedSkus()).toEqual(['RL-AE087']);
    });
});

// ─── The whole run ────────────────────────────────────────────────────────────

describe('runSupplierBillSync', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // Runs each step inline, as a flow would on its first pass, apart from
    // signing in to Zoho.
    function inlineSteps() {
        const names: string[] = [];
        const step: BillSyncStep = async (name, _options, fn) => {
            names.push(name);
            if (name === 'authenticate') return 'token' as never;
            return await fn({ progress: { set() {}, increment() {}, log() {} } });
        };
        return { step, names };
    }

    const ctx = {
        env: { ZOHO_ACCOUNTS_BASE_URL: '', ZOHO_CLIENT_ID: '', ZOHO_BOOKS_BASE_URL: '', ZOHO_BOOKS_ORG_ID: 'org-1' },
        secrets: { ZOHO_CLIENT_SECRET: '' },
    };

    test('syncs every supplier with a Zoho vendor over the Inventory API, and reports those without one', async () => {
        await createProduct('RL-AE086');
        const supplier = await createSupplier();
        await models.supplier.create({ name: 'Legacy Supplier' });
        const zoho = fakeZoho(withImport());
        const urls: string[] = [];
        vi.stubGlobal('fetch', async (url: string) => {
            urls.push(url);
            const parsed = new URL(url);
            const path = parsed.pathname.replace('/inventory/v1', '');
            const body = await zoho.get(path, Object.fromEntries(parsed.searchParams));
            return new Response(JSON.stringify(body), { status: 200 });
        });

        const { step, names } = inlineSteps();
        const summary = await runSupplierBillSync(step, ctx);

        expect(names).toEqual(['authenticate', 'load-suppliers', `bills-${supplier.id}-0`, 'link-lines']);
        expect(summary.suppliers).toEqual([{ supplier: 'Kuongshun Electronic Limited', added: 1, updated: 0, removed: 0, unchanged: 0 }]);
        expect(summary.suppliersWithoutVendor).toEqual(['Legacy Supplier']);
        expect(summary.unmatchedSkus).toEqual(['RL-AE087']);
        expect(urls[0]).toBe('https://www.zohoapis.com/inventory/v1/bills?organization_id=org-1&vendor_id=v-kuongshun&per_page=200&page=1');
    });

    test('spreads a long first import over several steps, and totals them', async () => {
        const supplier = await createSupplier();
        const bills = ['a', 'b', 'c'].map((id, i) => importBill({ bill_id: id, bill_number: id, date: `2026-0${i + 1}-01`, allocated_landed_costs: [] }));
        const zoho = fakeZoho({
            lists: { 'v-kuongshun': bills.map((b) => summaryOf(b)) },
            bills: Object.fromEntries(bills.map((b) => [b.bill_id, b])),
            landedCosts: {},
        });
        vi.stubGlobal('fetch', async (url: string) => {
            const parsed = new URL(url);
            const body = await zoho.get(parsed.pathname.replace('/inventory/v1', ''), Object.fromEntries(parsed.searchParams));
            return new Response(JSON.stringify(body), { status: 200 });
        });

        const { step, names } = inlineSteps();
        const summary = await runSupplierBillSync(step, ctx, 2);

        expect(names).toEqual(['authenticate', 'load-suppliers', `bills-${supplier.id}-0`, `bills-${supplier.id}-1`, 'link-lines']);
        // The second step sees the first step's two bills as unchanged; they
        // were added this run, not unchanged.
        expect(summary.suppliers).toEqual([{ supplier: 'Kuongshun Electronic Limited', added: 3, updated: 0, removed: 0, unchanged: 0 }]);
    });
});
