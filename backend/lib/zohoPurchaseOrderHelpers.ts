import { models, useDatabase } from '@teamkeel/sdk';
import { sql } from 'kysely';
import { ZohoApiError, ZohoGet, parseZohoTime } from './zohoInventoryApi';
import { ProgressReporter } from './progress';

// Mirrors the org's purchase orders from Zoho Inventory, line by line, into
// PurchaseOrder and PurchaseOrderLine — the source of every product's stock on
// the way (see purchaseOrders.keel and docs/purchase-orders.md).
//
// A line's units are on the way from the day its order is placed until they
// are received into stock. That is deliberately not tied to billing: the org
// bills an import when the supplier invoices it, often weeks before it lands,
// and Zoho counts billed units in stock_on_hand from that day. The physical
// stock figure (actual_available_stock) only moves on a receive, so it and
// stock on the way never count the same unit twice (checked against the org on
// 2026-10-05: of 424 active items, the only one whose stock_on_hand and
// actual_available_stock differed was the one on a billed, unreceived order,
// and by exactly its quantity).
//
// Unlike bills, every order is listed in one go, not per supplier: the org
// only raises purchase orders for stock. Each order is read once, then skipped
// until Zoho's last_modified_time or quantity_yet_to_receive for it moves.

// Far more pages of 200 than the org's order history. Hitting it means the
// listing is not what we think it is, and every further page would spend the
// shared Zoho quota for nothing.
export const MAX_PURCHASE_ORDER_PAGES = 25;

// ─── Zoho types (only the fields we use) ──────────────────────────────────────

// A purchase order as GET /purchaseorders lists it.
export interface ZohoPurchaseOrderSummary {
    purchaseorder_id: string;
    purchaseorder_number: string;
    date?: string;
    quantity_yet_to_receive?: number;
    last_modified_time: string;
}

export interface ZohoPurchaseOrderLine {
    line_item_id: string;
    sku?: string;
    name?: string;
    description?: string;
    // False on a line that isn't stock (a service or a charge).
    is_receivable?: boolean;
    quantity?: number;
    quantity_received?: number;
    quantity_cancelled?: number;
    quantity_billed?: number;
}

export interface ZohoPurchaseOrderDetail {
    purchaseorder_id: string;
    purchaseorder_number: string;
    reference_number?: string;
    vendor_id?: string;
    vendor_name?: string;
    date?: string;
    expected_delivery_date?: string;
    delivery_date?: string;
    status?: string;
    order_status?: string;
    received_status?: string;
    billed_status?: string;
    currency_code?: string;
    total?: number;
    is_drop_shipment?: boolean;
    is_po_marked_as_received?: boolean;
    line_items: ZohoPurchaseOrderLine[];
}

// ─── Reading Zoho ─────────────────────────────────────────────────────────────

// Every purchase order Zoho holds, whatever its status, 200 to a page.
export async function listZohoPurchaseOrders(get: ZohoGet): Promise<ZohoPurchaseOrderSummary[]> {
    const orders: ZohoPurchaseOrderSummary[] = [];
    for (let page = 1; ; page++) {
        if (page > MAX_PURCHASE_ORDER_PAGES) {
            throw new Error(
                `Zoho's purchase order listing ran past ${MAX_PURCHASE_ORDER_PAGES} pages of 200 — stopping rather than spend more of the API quota`
            );
        }
        const data = await get('/purchaseorders', { filter_by: 'Status.All', per_page: '200', page: String(page) });
        orders.push(...(data.purchaseorders ?? []));
        if (!data.page_context?.has_more_page) return orders;
    }
}

export async function readZohoPurchaseOrder(get: ZohoGet, purchaseOrderId: string): Promise<ZohoPurchaseOrderDetail> {
    return (await get(`/purchaseorders/${purchaseOrderId}`)).purchaseorder;
}

// ─── Pure transforms ──────────────────────────────────────────────────────────

// Statuses an order has before it goes to the supplier, or once it's called
// off. Anything else has been placed. A denylist on purpose: a status Zoho adds
// later counts as placed and shows its units, rather than hiding them.
const UNPLACED_STATUSES = new Set(['draft', 'pending_approval', 'approved', 'rejected', 'cancelled']);

// Whether an order's units count as on the way: placed with the supplier, and
// coming to us rather than drop-shipped to a customer.
export function isPlacedOrder(po: ZohoPurchaseOrderDetail): boolean {
    if (UNPLACED_STATUSES.has(po.status ?? '')) return false;
    if (po.order_status === 'cancelled') return false;
    return po.is_drop_shipment !== true;
}

// A purchase order line as stored.
export interface PurchaseOrderLineValues {
    zohoLineItemId: string;
    position: number;
    sku: string | null;
    name: string | null;
    quantityOrdered: number;
    quantityReceived: number;
    quantityCancelled: number;
    quantityBilled: number;
    quantityOnWay: number;
}

function trimmedOrNull(value: string | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

// Every line on an order, with the units it still has on the way: ordered,
// less received and cancelled. Billing doesn't enter into it. Nothing is on
// the way on an order that isn't placed, on one Zoho has marked as received
// outright, or on a line that isn't stock. Pure so the rules can be tested
// against captured Zoho payloads.
export function buildPurchaseOrderLines(po: ZohoPurchaseOrderDetail): PurchaseOrderLineValues[] {
    const expecting = isPlacedOrder(po) && po.received_status !== 'received' && po.is_po_marked_as_received !== true;
    return (po.line_items ?? []).map((li, index) => {
        const quantityOrdered = Number(li.quantity ?? 0);
        const quantityReceived = Number(li.quantity_received ?? 0);
        const quantityCancelled = Number(li.quantity_cancelled ?? 0);
        const outstanding = Math.max(0, quantityOrdered - quantityReceived - quantityCancelled);
        return {
            zohoLineItemId: li.line_item_id,
            position: index + 1,
            sku: trimmedOrNull(li.sku),
            name: trimmedOrNull(li.name) ?? trimmedOrNull(li.description),
            quantityOrdered,
            quantityReceived,
            quantityCancelled,
            quantityBilled: Number(li.quantity_billed ?? 0),
            quantityOnWay: expecting && li.is_receivable !== false ? outstanding : 0,
        };
    });
}

// A purchase order as already stored here.
export interface LocalPurchaseOrder {
    id: string;
    zohoPurchaseOrderId: string;
    zohoModifiedAt: Date;
    zohoQuantityToReceive: number | null;
}

export interface PurchaseOrderPlan {
    // New to us, or changed in Zoho since we last read them. Oldest first.
    toRead: ZohoPurchaseOrderSummary[];
    // Here but gone from Zoho: deleted there.
    toDelete: LocalPurchaseOrder[];
    unchanged: number;
}

function quantityToReceive(summary: ZohoPurchaseOrderSummary): number | null {
    return summary.quantity_yet_to_receive == null ? null : Number(summary.quantity_yet_to_receive);
}

// Works out what a sync has to do, from Zoho's order list against the orders
// stored here. An order is read again when its modified time or the quantity
// Zoho has yet to receive on it has moved.
export function planPurchaseOrders(zohoOrders: ZohoPurchaseOrderSummary[], local: LocalPurchaseOrder[]): PurchaseOrderPlan {
    const zohoIds = new Set(zohoOrders.map((o) => o.purchaseorder_id));
    const localByZohoId = new Map(local.map((o) => [o.zohoPurchaseOrderId, o]));

    const toRead: ZohoPurchaseOrderSummary[] = [];
    let unchanged = 0;
    for (const order of zohoOrders) {
        const stored = localByZohoId.get(order.purchaseorder_id);
        const changed =
            !stored ||
            stored.zohoModifiedAt.getTime() !== parseZohoTime(order.last_modified_time).getTime() ||
            stored.zohoQuantityToReceive !== quantityToReceive(order);
        if (changed) toRead.push(order);
        else unchanged++;
    }

    toRead.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
    return { toRead, toDelete: local.filter((o) => !zohoIds.has(o.zohoPurchaseOrderId)), unchanged };
}

// ─── Writing ──────────────────────────────────────────────────────────────────

async function loadLocalPurchaseOrders(): Promise<LocalPurchaseOrder[]> {
    const rows = await useDatabase()
        .selectFrom('purchase_order')
        .select(['id', 'zohoPurchaseOrderId', 'zohoModifiedAt', 'zohoQuantityToReceive'])
        .execute();
    return rows.map((r) => ({
        id: r.id,
        zohoPurchaseOrderId: r.zohoPurchaseOrderId,
        zohoModifiedAt: r.zohoModifiedAt,
        zohoQuantityToReceive: r.zohoQuantityToReceive ?? null,
    }));
}

// Lookups the saved orders are linked through: products by SKU, suppliers by
// their Zoho vendor id.
export interface PurchaseOrderLinks {
    productIdBySku: Map<string, string>;
    supplierIdByVendorId: Map<string, string>;
}

async function loadLinks(): Promise<PurchaseOrderLinks> {
    const db = useDatabase();
    const products = await db.selectFrom('product').select(['id', 'sku']).execute();
    const suppliers = await db.selectFrom('supplier').select(['id', 'zohoVendorId']).where('zohoVendorId', 'is not', null).execute();
    return {
        productIdBySku: new Map(products.map((p) => [p.sku, p.id])),
        supplierIdByVendorId: new Map(suppliers.map((s) => [s.zohoVendorId!, s.id])),
    };
}

// Stores an order read from Zoho: the order upserted on its Zoho id, its lines
// replaced outright. One transaction, so the order is never seen without its
// lines, nor marked current with stale ones. Returns whether it is new here.
export async function savePurchaseOrder(
    summary: ZohoPurchaseOrderSummary,
    po: ZohoPurchaseOrderDetail,
    lines: PurchaseOrderLineValues[],
    links: PurchaseOrderLinks,
    now: Date
): Promise<boolean> {
    const vendorId = trimmedOrNull(po.vendor_id);
    const values = {
        zohoVendorId: vendorId,
        supplierId: vendorId ? (links.supplierIdByVendorId.get(vendorId) ?? null) : null,
        vendorName: trimmedOrNull(po.vendor_name),
        purchaseOrderNumber: po.purchaseorder_number,
        referenceNumber: trimmedOrNull(po.reference_number),
        // Calendar dates, bound as text: node-postgres would render a Date in
        // the host's timezone and could shift the day. Zoho sends "" for unset.
        date: trimmedOrNull(po.date) as unknown as Date | null,
        expectedDeliveryDate: (trimmedOrNull(po.expected_delivery_date) ?? trimmedOrNull(po.delivery_date)) as unknown as Date | null,
        status: trimmedOrNull(po.status),
        receivedStatus: trimmedOrNull(po.received_status),
        billedStatus: trimmedOrNull(po.billed_status),
        currencyCode: trimmedOrNull(po.currency_code),
        total: po.total ?? null,
        isPlaced: isPlacedOrder(po),
        // The list's values, not the detail's: they're what the next run
        // compares against.
        zohoModifiedAt: parseZohoTime(summary.last_modified_time),
        zohoQuantityToReceive: quantityToReceive(summary),
        synchronisedAt: now,
    };

    return await useDatabase()
        .transaction()
        .execute(async (trx) => {
            const existing = await trx
                .selectFrom('purchase_order')
                .select('id')
                .where('zohoPurchaseOrderId', '=', po.purchaseorder_id)
                .executeTakeFirst();

            let orderId: string;
            if (existing) {
                orderId = existing.id;
                await trx.updateTable('purchase_order').set({ ...values, updatedAt: now }).where('id', '=', orderId).execute();
                await trx.deleteFrom('purchase_order_line').where('purchaseOrderId', '=', orderId).execute();
            } else {
                const inserted = await trx
                    .insertInto('purchase_order')
                    .values({ ...values, zohoPurchaseOrderId: po.purchaseorder_id })
                    .returning('id')
                    .executeTakeFirstOrThrow();
                orderId = inserted.id;
            }

            if (lines.length > 0) {
                await trx
                    .insertInto('purchase_order_line')
                    .values(
                        lines.map((line) => ({
                            purchaseOrderId: orderId,
                            productId: line.sku ? (links.productIdBySku.get(line.sku) ?? null) : null,
                            ...line,
                        }))
                    )
                    .execute();
            }
            return !existing;
        });
}

// Deleting an order takes its lines with it (a required relation cascades).
async function deletePurchaseOrders(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await useDatabase().deleteFrom('purchase_order').where('id', 'in', ids).execute();
}

// Links what arrived after the order was stored — an order isn't read again
// until it changes in Zoho, so this is what picks up a product Sync Products
// brings in later, or a vendor imported as a supplier later. Returns the lines
// linked.
export async function linkUnmatchedPurchaseOrders(): Promise<number> {
    await sql`
        update purchase_order o
        set supplier_id = s.id, updated_at = now()
        from supplier s
        where o.supplier_id is null
          and o.zoho_vendor_id = s.zoho_vendor_id
    `.execute(useDatabase());
    const lines = await sql`
        update purchase_order_line l
        set product_id = p.id, updated_at = now()
        from product p
        where l.product_id is null
          and l.sku = p.sku
    `.execute(useDatabase());
    return Number(lines.numAffectedRows ?? 0);
}

// SKUs with units on the way that match no product here, so they count
// towards no product's stock on the way.
export async function findUnmatchedOnWaySkus(): Promise<string[]> {
    const result = await sql<{ sku: string }>`
        select distinct sku
        from purchase_order_line
        where product_id is null
          and sku is not null
          and quantity_on_way > 0
        order by sku
    `.execute(useDatabase());
    return result.rows.map((r) => r.sku);
}

// ─── One batch ────────────────────────────────────────────────────────────────

export interface PurchaseOrderBatchResult {
    created: number;
    updated: number;
    deleted: number;
    unchanged: number;
    // Changed orders left for the next batch.
    remaining: number;
}

// One batch of the sync: list the orders in Zoho, drop the ones gone from
// there, and read up to `maxReads` of the new or changed ones. Re-running it
// picks up where it left off, since an order read is an order now unchanged —
// which is what lets a long first import span several flow steps.
export async function syncPurchaseOrdersBatch(
    get: ZohoGet,
    maxReads: number,
    now: Date,
    progress?: ProgressReporter
): Promise<PurchaseOrderBatchResult> {
    progress?.set({ message: 'Listing purchase orders in Zoho…' });
    const plan = planPurchaseOrders(await listZohoPurchaseOrders(get), await loadLocalPurchaseOrders());

    await deletePurchaseOrders(plan.toDelete.map((o) => o.id));

    const batch = plan.toRead.slice(0, maxReads);
    const links = batch.length > 0 ? await loadLinks() : { productIdBySku: new Map(), supplierIdByVendorId: new Map() };
    progress?.set({
        message: 'Reading new and changed purchase orders…',
        current: 0,
        total: batch.length,
        unit: 'orders',
        counter: 'count',
    });

    let created = 0;
    for (const summary of batch) {
        const po = await readZohoPurchaseOrder(get, summary.purchaseorder_id);
        const lines = buildPurchaseOrderLines(po);
        if (await savePurchaseOrder(summary, po, lines, links, now)) created++;
        progress?.increment();
        progress?.log(`${po.purchaseorder_number}: ${lines.length} line${lines.length === 1 ? '' : 's'}`);
    }

    return {
        created,
        updated: batch.length - created,
        deleted: plan.toDelete.length,
        unchanged: plan.unchanged,
        remaining: plan.toRead.length - batch.length,
    };
}

// ─── The whole sync ───────────────────────────────────────────────────────────

// A flow's ctx.step, which is all the sync needs of the flow. Loosely typed:
// each flow's ctx is generic over its own config.
export type PurchaseOrderSyncStep = <R>(
    name: string,
    options: { timeout?: number; retries?: number; loadingMessage?: string },
    fn: (args: { progress: ProgressReporter }) => Promise<R>
) => Promise<R>;

// Orders read per step: a call each at ~0.7s, so 100 fit comfortably in the
// 14-minute step limit.
const ORDERS_PER_STEP = 100;
const STEP_TIMEOUT = 14 * 60 * 1000;

export interface PurchaseOrderSyncSummary {
    added: number;
    updated: number;
    removed: number;
    unchanged: number;
    linesLinked: number;
    unmatchedSkus: string[];
    // True when Zoho's daily quota ran out partway. Orders read before it are
    // stored; the rest keep what was read last time, and catch up next run.
    rateLimited: boolean;
}

// Mirrors every purchase order, a step per batch, so a long first import is
// spread over several steps and a retried run skips everything already read.
export async function runPurchaseOrderSync(
    step: PurchaseOrderSyncStep,
    get: ZohoGet,
    ordersPerStep = ORDERS_PER_STEP
): Promise<PurchaseOrderSyncSummary> {
    const now = new Date();
    const total = { added: 0, updated: 0, removed: 0, unchanged: 0 };
    let rateLimited = false;
    let previousRemaining = Infinity;
    for (let batch = 0; ; batch++) {
        const readBefore = total.added + total.updated;
        // One retry, not the default four: each attempt re-lists the orders
        // against the shared quota. A daily rate limit isn't retried at all —
        // it won't lift today.
        const result = await step(`purchase-orders-${batch}`, { timeout: STEP_TIMEOUT, retries: 1 }, async ({ progress }) => {
            try {
                return await syncPurchaseOrdersBatch(get, ordersPerStep, now, progress);
            } catch (error) {
                if (error instanceof ZohoApiError && error.isDailyRateLimit) return null;
                throw error;
            }
        });
        if (result === null) {
            rateLimited = true;
            break;
        }
        total.added += result.created;
        total.updated += result.updated;
        total.removed += result.deleted;
        // A batch counts the orders earlier batches read as unchanged.
        total.unchanged = result.unchanged - readBefore;
        if (result.remaining === 0) break;
        if (result.remaining >= previousRemaining) {
            throw new Error(`Syncing purchase orders stopped making progress with ${result.remaining} left to read`);
        }
        previousRemaining = result.remaining;
    }

    const linking = await step('link-purchase-orders', {}, async () => ({
        linked: await linkUnmatchedPurchaseOrders(),
        unmatchedSkus: await findUnmatchedOnWaySkus(),
    }));

    return { ...total, linesLinked: linking.linked, unmatchedSkus: linking.unmatchedSkus, rateLimited };
}
