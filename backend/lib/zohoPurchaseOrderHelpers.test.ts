import { models, resetDatabase } from '@teamkeel/testing';
import { beforeEach, describe, expect, test } from 'vitest';
import {
    LocalPurchaseOrder,
    PurchaseOrderSyncStep,
    ZohoPurchaseOrderDetail,
    ZohoPurchaseOrderSummary,
    buildPurchaseOrderLines,
    findUnmatchedOnWaySkus,
    isPlacedOrder,
    linkUnmatchedPurchaseOrders,
    planPurchaseOrders,
    runPurchaseOrderSync,
    syncPurchaseOrdersBatch,
    syncStockAndOrders,
} from './zohoPurchaseOrderHelpers';
import { ZohoApiError, ZohoGet } from './zohoInventoryApi';
import { computeStockCover } from './stockCoverHelpers';

beforeEach(resetDatabase);

// ─── Fixtures ─────────────────────────────────────────────────────────────────
// Shaped on the org's first purchase order (PO-00004, 2026-10-05): 100 micro:bit
// Gos from Premier Farnell, billed in full but not received yet. Zoho closes an
// order once it's fully billed, whatever has arrived.

function order(overrides: Partial<ZohoPurchaseOrderDetail> = {}): ZohoPurchaseOrderDetail {
    return {
        purchaseorder_id: 'zpo-4',
        purchaseorder_number: 'PO-00004',
        reference_number: '',
        vendor_id: 'v-farnell',
        vendor_name: 'Premier Farnell UK Ltd. (GBP)',
        date: '2026-09-22',
        expected_delivery_date: '',
        delivery_date: '',
        status: 'issued',
        order_status: 'closed',
        received_status: 'to_be_received',
        billed_status: 'billed',
        currency_code: 'GBP',
        total: 1248,
        is_drop_shipment: false,
        is_po_marked_as_received: false,
        line_items: [
            {
                line_item_id: 'li-1',
                sku: 'MEFV22G',
                name: 'BBC micro:bit Go',
                is_receivable: true,
                quantity: 100,
                quantity_received: 0,
                quantity_cancelled: 0,
                quantity_billed: 100,
            },
        ],
        ...overrides,
    };
}

// The order as Zoho's list gives it: what's still to receive is the sum of
// what each line still has to come.
function summaryOf(po: ZohoPurchaseOrderDetail, lastModified = '2026-10-05T04:02:06+0200'): ZohoPurchaseOrderSummary {
    const toReceive = po.line_items.reduce(
        (sum, li) => sum + (li.quantity ?? 0) - (li.quantity_received ?? 0) - (li.quantity_cancelled ?? 0),
        0
    );
    return {
        purchaseorder_id: po.purchaseorder_id,
        purchaseorder_number: po.purchaseorder_number,
        date: po.date,
        quantity_yet_to_receive: toReceive,
        last_modified_time: lastModified,
    };
}

// A fake Zoho Inventory API over in-memory orders, recording every call.
function fakeZoho(orders: ZohoPurchaseOrderDetail[], summaries = orders.map((o) => summaryOf(o))) {
    const calls: string[] = [];
    const byId = new Map(orders.map((o) => [o.purchaseorder_id, o]));
    const get: ZohoGet = async (path, query = {}) => {
        calls.push(path);
        if (path === '/purchaseorders') {
            expect(query.filter_by).toBe('Status.All');
            const page = Number(query.page);
            const perPage = Number(query.per_page);
            return {
                purchaseorders: summaries.slice((page - 1) * perPage, page * perPage),
                page_context: { has_more_page: page * perPage < summaries.length },
            };
        }
        const detail = path.match(/^\/purchaseorders\/([^/]+)$/);
        if (detail) return { purchaseorder: byId.get(detail[1]) };
        throw new Error(`Unexpected Zoho call ${path}`);
    };
    return { get, calls };
}

async function createProduct(sku: string) {
    const brand = (await models.brand.findMany({ where: { name: { equals: 'Brand' } } }))[0] ?? (await models.brand.create({ name: 'Brand' }));
    return await models.product.create({ name: `Product ${sku}`, sku, brandId: brand.id });
}

async function stockOnWayOf(productId: string) {
    return (await models.product.findOne({ id: productId }))!.stockOnWay;
}

async function linesOf(zohoPurchaseOrderId: string) {
    const po = await models.purchaseOrder.findOne({ zohoPurchaseOrderId });
    if (!po) return [];
    const lines = await models.purchaseOrderLine.findMany({ where: { purchaseOrderId: { equals: po.id } } });
    return lines.sort((a, b) => a.position - b.position);
}

const NOW = new Date('2026-10-05T08:00:00Z');

// ─── isPlacedOrder / buildPurchaseOrderLines (pure) ──────────────────────────

describe('isPlacedOrder', () => {
    test('an issued order is placed, whatever its billing or receiving', () => {
        expect(isPlacedOrder(order())).toBe(true);
        expect(isPlacedOrder(order({ order_status: 'open', billed_status: '' }))).toBe(true);
    });

    test('an order not yet with the supplier, or called off, is not', () => {
        for (const status of ['draft', 'pending_approval', 'approved', 'rejected', 'cancelled']) {
            expect(isPlacedOrder(order({ status }))).toBe(false);
        }
        expect(isPlacedOrder(order({ order_status: 'cancelled' }))).toBe(false);
    });

    test('a drop shipment goes to the customer, not to us', () => {
        expect(isPlacedOrder(order({ is_drop_shipment: true }))).toBe(false);
    });
});

describe('buildPurchaseOrderLines', () => {
    test('counts an order billed ahead of its delivery as all on the way', () => {
        expect(buildPurchaseOrderLines(order())).toEqual([
            {
                zohoLineItemId: 'li-1',
                position: 1,
                sku: 'MEFV22G',
                name: 'BBC micro:bit Go',
                quantityOrdered: 100,
                quantityReceived: 0,
                quantityCancelled: 0,
                quantityBilled: 100,
                quantityOnWay: 100,
            },
        ]);
    });

    test('takes off what has been received and what has been cancelled', () => {
        const lines = buildPurchaseOrderLines(
            order({
                received_status: 'partially_received',
                line_items: [
                    { line_item_id: 'a', sku: 'A', quantity: 100, quantity_received: 40 },
                    { line_item_id: 'b', sku: 'B', quantity: 50, quantity_received: 10, quantity_cancelled: 15 },
                    // Over-delivered: nothing more to come, not a negative.
                    { line_item_id: 'c', sku: 'C', quantity: 10, quantity_received: 12 },
                ],
            })
        );
        expect(lines.map((l) => [l.sku, l.quantityOnWay])).toEqual([
            ['A', 60],
            ['B', 25],
            ['C', 0],
        ]);
    });

    test('puts nothing on the way on an order that is not placed, but keeps its lines', () => {
        for (const po of [order({ status: 'draft' }), order({ status: 'cancelled' }), order({ is_drop_shipment: true })]) {
            const lines = buildPurchaseOrderLines(po);
            expect(lines.map((l) => [l.sku, l.quantityOrdered, l.quantityOnWay])).toEqual([['MEFV22G', 100, 0]]);
        }
    });

    test('puts nothing on the way once Zoho has the order as received', () => {
        expect(buildPurchaseOrderLines(order({ received_status: 'received' }))[0].quantityOnWay).toBe(0);
        expect(buildPurchaseOrderLines(order({ is_po_marked_as_received: true }))[0].quantityOnWay).toBe(0);
    });

    test('puts nothing on the way for a line that is not stock', () => {
        const lines = buildPurchaseOrderLines(
            order({ line_items: [{ line_item_id: 'f', sku: 'FRT-ROAD', name: 'Road freight', is_receivable: false, quantity: 1 }] })
        );
        expect(lines[0].quantityOnWay).toBe(0);
    });

    test('trims SKUs, blanks empty ones, and falls back to the description for a name', () => {
        const lines = buildPurchaseOrderLines(
            order({
                line_items: [
                    { line_item_id: 'a', sku: '  A-1 ', name: 'Thing', quantity: 1 },
                    { line_item_id: 'b', sku: '', name: '', description: 'Packaging', quantity: 1 },
                ],
            })
        );
        expect(lines.map((l) => [l.position, l.sku, l.name])).toEqual([
            [1, 'A-1', 'Thing'],
            [2, null, 'Packaging'],
        ]);
    });
});

// ─── planPurchaseOrders (pure) ────────────────────────────────────────────────

describe('planPurchaseOrders', () => {
    const stored = (overrides: Partial<LocalPurchaseOrder> = {}): LocalPurchaseOrder => ({
        id: 'local-4',
        zohoPurchaseOrderId: 'zpo-4',
        zohoModifiedAt: new Date('2026-10-05T02:02:06Z'),
        zohoQuantityToReceive: 100,
        ...overrides,
    });

    test('reads new orders, oldest first, and skips unchanged ones', () => {
        const older = summaryOf(order({ purchaseorder_id: 'zpo-1', date: '2026-08-01' }));
        const plan = planPurchaseOrders([summaryOf(order()), older], []);
        expect(plan.toRead.map((o) => o.purchaseorder_id)).toEqual(['zpo-1', 'zpo-4']);

        expect(planPurchaseOrders([summaryOf(order())], [stored()])).toEqual({ toRead: [], toDelete: [], unchanged: 1 });
    });

    test('reads an order again when Zoho has modified it', () => {
        const plan = planPurchaseOrders([summaryOf(order(), '2026-10-06T09:00:00+0200')], [stored()]);
        expect(plan.toRead).toHaveLength(1);
    });

    test('reads an order again when what Zoho has yet to receive moves, even if its modified time has not', () => {
        const summary = { ...summaryOf(order()), quantity_yet_to_receive: 60 };
        expect(planPurchaseOrders([summary], [stored()]).toRead).toHaveLength(1);
    });

    test('drops an order deleted from Zoho', () => {
        const plan = planPurchaseOrders([], [stored()]);
        expect(plan.toDelete.map((o) => o.id)).toEqual(['local-4']);
    });
});

// ─── Syncing ──────────────────────────────────────────────────────────────────

describe('syncPurchaseOrdersBatch', () => {
    test("stores the order and its lines, linked to the supplier and product, and adds them to the product's stock on the way", async () => {
        const microbit = await createProduct('MEFV22G');
        const farnell = await models.supplier.create({ name: 'Premier Farnell', zohoVendorId: 'v-farnell' });

        const result = await syncPurchaseOrdersBatch(fakeZoho([order()]).get, 100, NOW);

        expect(result).toEqual({ created: 1, updated: 0, deleted: 0, unchanged: 0, remaining: 0 });
        const po = await models.purchaseOrder.findOne({ zohoPurchaseOrderId: 'zpo-4' });
        expect(po).toMatchObject({
            purchaseOrderNumber: 'PO-00004',
            supplierId: farnell.id,
            zohoVendorId: 'v-farnell',
            vendorName: 'Premier Farnell UK Ltd. (GBP)',
            referenceNumber: null,
            expectedDeliveryDate: null,
            status: 'issued',
            receivedStatus: 'to_be_received',
            billedStatus: 'billed',
            currencyCode: 'GBP',
            isPlaced: true,
            unitsOrdered: 100,
            unitsOnWay: 100,
            zohoQuantityToReceive: 100,
            synchronisedAt: NOW,
        });
        expect([po!.date!.getFullYear(), po!.date!.getMonth() + 1, po!.date!.getDate()]).toEqual([2026, 9, 22]);
        const [line] = await linesOf('zpo-4');
        expect(line).toMatchObject({ productId: microbit.id, quantityOrdered: 100, quantityBilled: 100, quantityOnWay: 100, purchaseOrderNumber: 'PO-00004' });
        expect(await stockOnWayOf(microbit.id)).toBe(100);
    });

    test('costs nothing but the list call when nothing has changed', async () => {
        await syncPurchaseOrdersBatch(fakeZoho([order()]).get, 100, NOW);

        const zoho = fakeZoho([order()]);
        const result = await syncPurchaseOrdersBatch(zoho.get, 100, NOW);

        expect(result).toEqual({ created: 0, updated: 0, deleted: 0, unchanged: 1, remaining: 0 });
        expect(zoho.calls).toEqual(['/purchaseorders']);
    });

    test('moves units off the way as they are received', async () => {
        const microbit = await createProduct('MEFV22G');
        await syncPurchaseOrdersBatch(fakeZoho([order()]).get, 100, NOW);

        const partly = order({
            received_status: 'partially_received',
            line_items: [{ ...order().line_items[0], quantity_received: 40 }],
        });
        // Same modified time: the receive is caught by what's left to receive.
        const result = await syncPurchaseOrdersBatch(fakeZoho([partly]).get, 100, NOW);

        expect(result).toMatchObject({ created: 0, updated: 1 });
        expect(await linesOf('zpo-4')).toHaveLength(1);
        expect(await stockOnWayOf(microbit.id)).toBe(60);

        const received = order({
            received_status: 'received',
            line_items: [{ ...order().line_items[0], quantity_received: 100 }],
        });
        await syncPurchaseOrdersBatch(fakeZoho([received], [summaryOf(received, '2026-10-20T10:00:00+0200')]).get, 100, NOW);
        expect(await stockOnWayOf(microbit.id)).toBe(0);
    });

    test('sums every order a product is on, and leaves out drafts and cancelled orders', async () => {
        const microbit = await createProduct('MEFV22G');
        const orders = [
            order(),
            order({ purchaseorder_id: 'zpo-5', purchaseorder_number: 'PO-00005', line_items: [{ ...order().line_items[0], line_item_id: 'li-5', quantity: 50, quantity_billed: 0 }] }),
            order({ purchaseorder_id: 'zpo-6', purchaseorder_number: 'PO-00006', status: 'draft' }),
            order({ purchaseorder_id: 'zpo-7', purchaseorder_number: 'PO-00007', status: 'cancelled' }),
        ];

        await syncPurchaseOrdersBatch(fakeZoho(orders).get, 100, NOW);

        expect(await models.purchaseOrder.findMany({})).toHaveLength(4);
        expect(await stockOnWayOf(microbit.id)).toBe(150);
    });

    test('removes an order deleted in Zoho, and its units with it', async () => {
        const microbit = await createProduct('MEFV22G');
        await syncPurchaseOrdersBatch(fakeZoho([order()]).get, 100, NOW);

        const result = await syncPurchaseOrdersBatch(fakeZoho([]).get, 100, NOW);

        expect(result.deleted).toBe(1);
        expect(await models.purchaseOrder.findMany({})).toHaveLength(0);
        expect(await models.purchaseOrderLine.findMany({})).toHaveLength(0);
        expect(await stockOnWayOf(microbit.id)).toBe(0);
    });

    test('fails, rather than deleting every order, when Zoho answers without a list', async () => {
        await syncPurchaseOrdersBatch(fakeZoho([order()]).get, 100, NOW);
        const odd: ZohoGet = async () => ({ code: 0, message: 'success' });

        await expect(syncPurchaseOrdersBatch(odd, 100, NOW)).rejects.toThrow('without a list of orders');
        expect(await models.purchaseOrder.findMany({})).toHaveLength(1);
    });

    test('reads at most maxReads orders, leaving the rest for the next batch', async () => {
        const orders = ['1', '2', '3'].map((n) => order({ purchaseorder_id: `zpo-${n}`, purchaseorder_number: `PO-${n}`, date: `2026-0${n}-01` }));

        expect(await syncPurchaseOrdersBatch(fakeZoho(orders).get, 2, NOW)).toEqual({ created: 2, updated: 0, deleted: 0, unchanged: 0, remaining: 1 });
        // Oldest first.
        expect(await models.purchaseOrder.findOne({ zohoPurchaseOrderId: 'zpo-3' })).toBeNull();
        expect(await syncPurchaseOrdersBatch(fakeZoho(orders).get, 2, NOW)).toEqual({ created: 1, updated: 0, deleted: 0, unchanged: 2, remaining: 0 });
    });
});

// ─── Linking what arrives later ───────────────────────────────────────────────

describe('linkUnmatchedPurchaseOrders', () => {
    test('links an order line to a product synced after it, and an order to a vendor imported after it', async () => {
        await syncPurchaseOrdersBatch(fakeZoho([order()]).get, 100, NOW);
        expect(await findUnmatchedOnWaySkus()).toEqual(['MEFV22G']);

        const microbit = await createProduct('MEFV22G');
        const farnell = await models.supplier.create({ name: 'Premier Farnell', zohoVendorId: 'v-farnell' });
        expect(await linkUnmatchedPurchaseOrders()).toBe(1);

        expect((await models.purchaseOrder.findOne({ zohoPurchaseOrderId: 'zpo-4' }))!.supplierId).toBe(farnell.id);
        expect((await linesOf('zpo-4'))[0].productId).toBe(microbit.id);
        expect(await stockOnWayOf(microbit.id)).toBe(100);
        expect(await findUnmatchedOnWaySkus()).toEqual([]);
    });

    test('only lists unmatched SKUs that have units on the way', async () => {
        await syncPurchaseOrdersBatch(fakeZoho([order({ status: 'draft' })]).get, 100, NOW);
        expect(await findUnmatchedOnWaySkus()).toEqual([]);
    });
});

// ─── The whole sync ───────────────────────────────────────────────────────────

describe('runPurchaseOrderSync', () => {
    // Runs each step inline, as a flow would on its first pass.
    function inlineSteps() {
        const names: string[] = [];
        const step: PurchaseOrderSyncStep = async (name, _options, fn) => {
            names.push(name);
            return await fn({ progress: { set() {}, increment() {}, log() {} } });
        };
        return { step, names };
    }

    test('spreads a long first import over several steps, totals them, and links what it can', async () => {
        await createProduct('MEFV22G');
        const orders = ['1', '2', '3'].map((n) => order({ purchaseorder_id: `zpo-${n}`, purchaseorder_number: `PO-${n}`, date: `2026-0${n}-01` }));
        const unmatched = order({ purchaseorder_id: 'zpo-9', purchaseorder_number: 'PO-9', date: '2026-04-01', line_items: [{ line_item_id: 'x', sku: 'NEW-SKU', quantity: 5 }] });

        const { step, names } = inlineSteps();
        const summary = await runPurchaseOrderSync(step, fakeZoho([...orders, unmatched]).get, 2);

        expect(names).toEqual(['purchase-orders-0', 'purchase-orders-1', 'link-purchase-orders']);
        expect(summary).toEqual({ added: 4, updated: 0, removed: 0, unchanged: 0, linesLinked: 0, unmatchedSkus: ['NEW-SKU'], rateLimited: false });
    });

    test("pauses at Zoho's daily limit, keeping what it has", async () => {
        await syncPurchaseOrdersBatch(fakeZoho([order()]).get, 100, NOW);
        const limited: ZohoGet = async (path) => {
            throw new ZohoApiError(path, 429, '{"code":45,"message":"You have reached the maximum number of API calls for the day."}');
        };

        const { step, names } = inlineSteps();
        const summary = await runPurchaseOrderSync(step, limited);

        expect(names).toEqual(['purchase-orders-0', 'link-purchase-orders']);
        expect(summary.rateLimited).toBe(true);
        expect(await models.purchaseOrder.findMany({})).toHaveLength(1);
    });

    test('fails on any other Zoho error', async () => {
        const broken: ZohoGet = async (path) => {
            throw new ZohoApiError(path, 500, 'Internal error');
        };
        const { step } = inlineSteps();
        await expect(runPurchaseOrderSync(step, broken)).rejects.toThrow('Zoho GET /purchaseorders failed: 500');
    });
});

// ─── With stock on hand ───────────────────────────────────────────────────────

describe('syncStockAndOrders', () => {
    // A fake Zoho serving both the items feed and the orders, as MEFV22G stood
    // on 2026-10-05: 100 on the shelf, and PO-00004 for 100 more billed but not
    // received. stock_on_hand already counts the billed 100; physical stock
    // doesn't. receive() books the order in, as a purchase receive would.
    function zohoWithOrder() {
        const calls: string[] = [];
        let shelf = 100;
        let po = order();
        const receive = () => {
            shelf += 100;
            po = order({ received_status: 'received', line_items: [{ ...order().line_items[0], quantity_received: 100 }] });
        };
        let onFirstOrderList: (() => void) | null = null;
        const get: ZohoGet = async (path, query = {}) => {
            calls.push(path);
            if (path === '/items') {
                return {
                    items: [{ item_id: 'i-1', sku: 'MEFV22G', stock_on_hand: 200, actual_available_stock: shelf }],
                    page_context: { has_more_page: false },
                };
            }
            if (path === '/purchaseorders' && onFirstOrderList) {
                onFirstOrderList();
                onFirstOrderList = null;
            }
            return fakeZoho([po]).get(path, query);
        };
        return { get, calls, receive, receiveBeforeOrders: () => (onFirstOrderList = receive) };
    }

    function inlineSteps() {
        const names: string[] = [];
        const step: PurchaseOrderSyncStep = async (name, _options, fn) => {
            names.push(name);
            return await fn({ progress: { set() {}, increment() {}, log() {} } });
        };
        return { step, names };
    }

    async function onHandAndOnWay(productId: string, stock: { sku: string; stockAvailable: number }[]) {
        return [stock.find((s) => s.sku === 'MEFV22G')?.stockAvailable ?? null, await stockOnWayOf(productId)];
    }

    test('counts an order billed ahead of its delivery once: on the way, not on hand', async () => {
        const microbit = await createProduct('MEFV22G');
        const zoho = zohoWithOrder();
        const { step, names } = inlineSteps();

        const result = await syncStockAndOrders(step, zoho.get);

        expect(names).toEqual(['fetch-stock', 'purchase-orders-0', 'link-purchase-orders']);
        expect(result.rateLimited).toBe(false);
        expect(await onHandAndOnWay(microbit.id, result.stock)).toEqual([100, 100]);
        // 20 a month: 5 months on the shelf, 10 with the order in.
        expect(computeStockCover(100, 100, 20)).toEqual({ current: 5, total: 10 });
    });

    test('reads stock before the orders, so a receive between the two reads is never counted twice', async () => {
        const microbit = await createProduct('MEFV22G');
        const zoho = zohoWithOrder();
        zoho.receiveBeforeOrders();

        const result = await syncStockAndOrders(inlineSteps().step, zoho.get);

        expect(zoho.calls.slice(0, 2)).toEqual(['/items', '/purchaseorders']);
        // The 100 received in between are in neither figure until the next
        // run, which is the safe way round: 300 would have them in both.
        expect(await onHandAndOnWay(microbit.id, result.stock)).toEqual([100, 0]);

        const next = await syncStockAndOrders(inlineSteps().step, zoho.get);
        expect(await onHandAndOnWay(microbit.id, next.stock)).toEqual([200, 0]);
    });

    test("keeps last-known stock when the orders hit Zoho's daily limit partway", async () => {
        const microbit = await createProduct('MEFV22G');
        const zoho = zohoWithOrder();
        await syncStockAndOrders(inlineSteps().step, zoho.get);
        zoho.receive();

        // The stock read goes through, then the quota runs out on the orders.
        const limited: ZohoGet = async (path, query) => {
            if (path === '/items') return zoho.get(path, query);
            throw new ZohoApiError(path, 429, '{"code":45,"message":"You have reached the maximum number of API calls for the day."}');
        };
        const result = await syncStockAndOrders(inlineSteps().step, limited);

        // Writing the fresh 200 beside the order's stale 100 on the way would
        // count the received units twice.
        expect(result).toMatchObject({ stock: [], rateLimited: true });
        expect(result.orders?.rateLimited).toBe(true);
        expect(await stockOnWayOf(microbit.id)).toBe(100);
    });

    test("doesn't try the orders when the stock read hits Zoho's daily limit", async () => {
        const calls: string[] = [];
        const limited: ZohoGet = async (path) => {
            calls.push(path);
            throw new ZohoApiError(path, 429, '{"code":45,"message":"You have reached the maximum number of API calls for the day."}');
        };
        const { step, names } = inlineSteps();

        expect(await syncStockAndOrders(step, limited)).toEqual({ stock: [], orders: null, rateLimited: true });
        expect(names).toEqual(['fetch-stock']);
        expect(calls).toEqual(['/items']);
    });
});
