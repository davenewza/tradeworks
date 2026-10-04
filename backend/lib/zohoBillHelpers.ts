import { models, useDatabase } from '@teamkeel/sdk';
import { sql } from 'kysely';
import { ZohoFeeCtx, getZohoAccessToken } from './zohoChannelFeeHelpers';
import { ProgressReporter } from './progress';

// Mirrors our suppliers' bills from Zoho Inventory, line by line, into
// SupplierBill and SupplierBillLine — the source of every product's cost of
// goods and freight-in (see costs.keel).
//
// Bills are fetched per supplier, by its Zoho vendor id, so the expense bills
// from everyone else (shops, utilities, the courier) are never read. Freight,
// duties and fees are Zoho landed costs: recorded on the goods bill itself or
// on a forwarder's or courier's bill, and allocated by Zoho across the goods
// bill's stock lines. That allocation is read from the goods bill, so the
// forwarders needn't be suppliers.
//
// The shared Zoho quota sets the shape. Reading a bill costs a call, plus one
// per landed cost on it, and there is no "list landed costs" endpoint. So each
// bill is read once and then skipped until Zoho's last_modified_time for it
// moves, which the bill list carries for free. Allocating a landed cost to a
// bill moves it too (checked against the org on 2026-10-04: 142 of 142 bills
// allocated freight after they were last saved had moved past the freight
// bill's creation). The token endpoint rate-limits hard, so a run fetches one
// token and reuses it.

// Inventory scope for the bills + landed-cost endpoints. The self-client is
// already authorised for it (verified against the org).
const INVENTORY_SCOPE = 'ZohoInventory.FullAccess.READ';
const INVENTORY_BASE = 'https://www.zohoapis.com/inventory/v1';

// Spacing between Zoho API calls, to stay under the per-minute cap.
const CALL_SPACING_MS = 350;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Far more pages of 200 than any supplier's bill history. Hitting it means the
// listing is not what we think it is, and every further page would spend the
// shared Zoho quota for nothing.
export const MAX_BILL_PAGES = 25;

export async function getZohoInventoryToken(ctx: ZohoFeeCtx): Promise<string> {
    return getZohoAccessToken(ctx, INVENTORY_SCOPE);
}

// ─── Zoho types (only the fields we use) ──────────────────────────────────────

// A bill as GET /bills lists it.
export interface ZohoBillSummary {
    bill_id: string;
    bill_number: string;
    date?: string;
    status?: string;
    last_modified_time: string;
}

export interface ZohoBillLine {
    line_item_id: string;
    sku?: string;
    name?: string;
    description?: string;
    account_name?: string;
    quantity?: number;
    rate?: number;
    item_total?: number;
    is_landedcost?: boolean;
}

interface ZohoAllocatedLandedCost {
    landed_cost_id: string;
}

export interface ZohoBillDetail {
    bill_id: string;
    bill_number: string;
    date?: string;
    status?: string;
    currency_code?: string;
    exchange_rate?: number;
    total?: number;
    line_items: ZohoBillLine[];
    allocated_landed_costs?: ZohoAllocatedLandedCost[];
}

interface ZohoCostAllocation {
    bill_item_id: string;
    allocated_amount?: number;
}

export interface ZohoLandedCost {
    landed_cost_id: string;
    cost_allocations?: ZohoCostAllocation[];
}

// ─── Reading Zoho ─────────────────────────────────────────────────────────────

// A GET against the Zoho Inventory API: a path under /inventory/v1 and its
// query, resolving to the parsed body. Injected so the sync can be tested
// against captured payloads without the network.
export type ZohoGet = (path: string, query?: Record<string, string>) => Promise<any>;

export function zohoInventoryGet(ctx: ZohoFeeCtx, accessToken: string): ZohoGet {
    return async (path, query = {}) => {
        await sleep(CALL_SPACING_MS);
        const params = new URLSearchParams({ organization_id: ctx.env.ZOHO_BOOKS_ORG_ID, ...query });
        const url = `${INVENTORY_BASE}${path}?${params}`;
        const res = await fetch(url, {
            method: 'GET',
            headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Zoho GET ${path} failed: ${res.status} - ${text.slice(0, 300)}`);
        }
        return res.json();
    };
}

// Every bill Zoho holds for one vendor, 200 to a page.
export async function listZohoBills(get: ZohoGet, vendorId: string): Promise<ZohoBillSummary[]> {
    const bills: ZohoBillSummary[] = [];
    for (let page = 1; ; page++) {
        if (page > MAX_BILL_PAGES) {
            throw new Error(
                `Zoho's bill listing for vendor ${vendorId} ran past ${MAX_BILL_PAGES} pages of 200 — stopping rather than spend more of the API quota`
            );
        }
        const data = await get('/bills', { vendor_id: vendorId, per_page: '200', page: String(page) });
        bills.push(...(data.bills ?? []));
        if (!data.page_context?.has_more_page) return bills;
    }
}

// A bill's detail, and each landed cost allocated to it.
export async function readZohoBill(
    get: ZohoGet,
    billId: string
): Promise<{ bill: ZohoBillDetail; landedCosts: ZohoLandedCost[] }> {
    const bill: ZohoBillDetail = (await get(`/bills/${billId}`)).bill;
    const landedCosts: ZohoLandedCost[] = [];
    for (const allocated of bill.allocated_landed_costs ?? []) {
        landedCosts.push((await get(`/bills/${billId}/landedcosts/${allocated.landed_cost_id}`)).landed_cost);
    }
    return { bill, landedCosts };
}

// Zoho writes offsets without a colon ("2026-09-07T10:43:18+0200"), which ISO
// 8601 parsers needn't accept.
export function parseZohoTime(value: string): Date {
    const parsed = new Date(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    if (Number.isNaN(parsed.getTime())) throw new Error(`Unreadable Zoho timestamp "${value}"`);
    return parsed;
}

// ─── Pure transforms ──────────────────────────────────────────────────────────

// A bill line as stored: every amount excl VAT and in rand.
export interface BillLine {
    zohoLineItemId: string;
    position: number;
    sku: string | null;
    name: string | null;
    accountName: string | null;
    quantity: number;
    unitCost: number;
    freightIn: number;
    isLandedCost: boolean;
}

function trimmedOrNull(value: string | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

// Every line on a bill, each with the freight Zoho allocated to it summed
// across the bill's landed costs (freight, customs and fees, possibly from
// several source bills).
//
// The unit cost comes from item_total, not rate. item_total is the line after
// any discount and excl VAT, where rate includes VAT on a tax-inclusive bill
// (seen on the org's local bills: rate 347.44, item_total 302.12 at 15%). Both
// are in the bill's currency, so the exchange rate brings it to rand. Landed-
// cost allocations are taken to be in rand already, as Zoho values stock in
// the base currency; every bill seen in the org so far (2026-10-04) is in
// rand, so a foreign-currency bill hasn't tested that. Pure so it can be
// tested against captured Zoho payloads.
export function buildBillLines(bill: ZohoBillDetail, landedCosts: ZohoLandedCost[]): BillLine[] {
    const freightByLineId = new Map<string, number>();
    for (const lc of landedCosts) {
        for (const alloc of lc.cost_allocations ?? []) {
            freightByLineId.set(alloc.bill_item_id, (freightByLineId.get(alloc.bill_item_id) ?? 0) + Number(alloc.allocated_amount ?? 0));
        }
    }

    const exchangeRate = Number(bill.exchange_rate ?? 1);
    return (bill.line_items ?? []).map((li, index) => {
        const quantity = Number(li.quantity ?? 0);
        const unitCost =
            quantity !== 0 && li.item_total !== undefined
                ? (Number(li.item_total) * exchangeRate) / quantity
                : Number(li.rate ?? 0) * exchangeRate;
        return {
            zohoLineItemId: li.line_item_id,
            position: index + 1,
            sku: trimmedOrNull(li.sku),
            name: trimmedOrNull(li.name) ?? trimmedOrNull(li.description),
            accountName: trimmedOrNull(li.account_name),
            quantity,
            unitCost,
            freightIn: freightByLineId.get(li.line_item_id) ?? 0,
            isLandedCost: li.is_landedcost === true,
        };
    });
}

// A supplier bill as already stored here.
export interface LocalBill {
    id: string;
    zohoBillId: string;
    zohoModifiedAt: Date;
    status: string | null;
}

export interface BillPlan {
    // New to us, or changed in Zoho since we last read them. Oldest first.
    toRead: ZohoBillSummary[];
    // Here but gone from the supplier in Zoho: deleted, voided, or moved to
    // another vendor.
    toDelete: LocalBill[];
    // Unchanged bills whose status has moved on anyway (a payment, say).
    statusChanges: { id: string; status: string | null }[];
    unchanged: number;
}

// Works out what one supplier's sync has to do, from Zoho's bill list against
// the bills stored for that supplier. A void bill counts as gone.
export function planSupplierBills(zohoBills: ZohoBillSummary[], local: LocalBill[]): BillPlan {
    const kept = zohoBills.filter((b) => b.status !== 'void');
    const keptIds = new Set(kept.map((b) => b.bill_id));
    const localByZohoId = new Map(local.map((b) => [b.zohoBillId, b]));

    const toRead: ZohoBillSummary[] = [];
    const statusChanges: { id: string; status: string | null }[] = [];
    let unchanged = 0;
    for (const bill of kept) {
        const stored = localByZohoId.get(bill.bill_id);
        if (!stored || stored.zohoModifiedAt.getTime() !== parseZohoTime(bill.last_modified_time).getTime()) {
            toRead.push(bill);
            continue;
        }
        unchanged++;
        if ((bill.status ?? null) !== stored.status) statusChanges.push({ id: stored.id, status: bill.status ?? null });
    }

    toRead.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
    return { toRead, toDelete: local.filter((b) => !keptIds.has(b.zohoBillId)), statusChanges, unchanged };
}

// ─── Writing ──────────────────────────────────────────────────────────────────

async function loadLocalBills(supplierId: string): Promise<LocalBill[]> {
    const bills = await models.supplierBill.findMany({ where: { supplierId: { equals: supplierId } } });
    return bills.map((b) => ({ id: b.id, zohoBillId: b.zohoBillId, zohoModifiedAt: b.zohoModifiedAt, status: b.status ?? null }));
}

async function loadProductIdsBySku(): Promise<Map<string, string>> {
    const rows = await useDatabase().selectFrom('product').select(['id', 'sku']).execute();
    return new Map(rows.map((r) => [r.sku, r.id]));
}

// Stores a bill read from Zoho, under the given supplier: the bill upserted
// on its Zoho id, its lines replaced outright (Zoho's line ids aren't stable
// across saves, so there is nothing to match them on). One transaction, so
// the bill is never seen without its lines, nor marked current with stale
// ones. Returns whether the bill is new here.
export async function saveBill(
    supplierId: string,
    summary: ZohoBillSummary,
    bill: ZohoBillDetail,
    lines: BillLine[],
    productIdBySku: Map<string, string>,
    now: Date
): Promise<boolean> {
    const values = {
        supplierId,
        billNumber: bill.bill_number,
        // A calendar date, bound as text: node-postgres would render a Date
        // in the host's timezone and could shift the day.
        date: (bill.date ?? null) as unknown as Date | null,
        status: bill.status ?? null,
        currencyCode: bill.currency_code ?? null,
        total: bill.total ?? null,
        // The list's timestamp, not the detail's: it's what the next run
        // compares against.
        zohoModifiedAt: parseZohoTime(summary.last_modified_time),
        synchronisedAt: now,
    };
    const freightAllocated = (bill.allocated_landed_costs ?? []).length > 0;

    return await useDatabase()
        .transaction()
        .execute(async (trx) => {
            const existing = await trx.selectFrom('supplier_bill').select('id').where('zohoBillId', '=', bill.bill_id).executeTakeFirst();

            let billId: string;
            if (existing) {
                billId = existing.id;
                await trx.updateTable('supplier_bill').set({ ...values, updatedAt: now }).where('id', '=', billId).execute();
                await trx.deleteFrom('supplier_bill_line').where('supplierBillId', '=', billId).execute();
            } else {
                const inserted = await trx
                    .insertInto('supplier_bill')
                    .values({ ...values, zohoBillId: bill.bill_id })
                    .returning('id')
                    .executeTakeFirstOrThrow();
                billId = inserted.id;
            }

            if (lines.length > 0) {
                await trx
                    .insertInto('supplier_bill_line')
                    .values(
                        lines.map((line) => ({
                            supplierBillId: billId,
                            // A landed cost is never stock, whatever it's coded as.
                            productId: !line.isLandedCost && line.sku ? (productIdBySku.get(line.sku) ?? null) : null,
                            sku: line.sku,
                            name: line.name,
                            accountName: line.accountName,
                            quantity: line.quantity,
                            unitCost: line.unitCost,
                            freightIn: line.freightIn,
                            freightAllocated,
                            isLandedCost: line.isLandedCost,
                            zohoLineItemId: line.zohoLineItemId,
                            position: line.position,
                        }))
                    )
                    .execute();
            }
            return !existing;
        });
}

// Deleting a bill takes its lines with it (a required relation cascades).
async function deleteBills(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await useDatabase().deleteFrom('supplier_bill').where('id', 'in', ids).execute();
}

async function updateStatuses(changes: { id: string; status: string | null }[], now: Date): Promise<void> {
    for (const change of changes) {
        await useDatabase().updateTable('supplier_bill').set({ status: change.status, updatedAt: now }).where('id', '=', change.id).execute();
    }
}

// Links stock lines to products that have arrived since the line was stored
// — a bill isn't read again until it changes in Zoho, so this is what picks
// up a product Sync Products brings in later. Returns the lines linked.
export async function linkUnmatchedLines(): Promise<number> {
    const result = await sql`
        update supplier_bill_line l
        set product_id = p.id, updated_at = now()
        from product p
        where l.product_id is null
          and not l.is_landed_cost
          and l.sku = p.sku
    `.execute(useDatabase());
    return Number(result.numAffectedRows ?? 0);
}

// SKUs on stock lines that match no product here.
export async function findUnmatchedSkus(): Promise<string[]> {
    const result = await sql<{ sku: string }>`
        select distinct sku
        from supplier_bill_line
        where product_id is null
          and sku is not null
          and not is_landed_cost
        order by sku
    `.execute(useDatabase());
    return result.rows.map((r) => r.sku);
}

// ─── One supplier ─────────────────────────────────────────────────────────────

export interface SyncSupplier {
    id: string;
    name: string;
    zohoVendorId: string;
}

export interface SupplierBatchResult {
    created: number;
    updated: number;
    deleted: number;
    unchanged: number;
    // Changed bills left for the next batch.
    remaining: number;
}

// One batch of a supplier's sync: list its bills in Zoho, drop the ones gone
// from there, and read up to `maxReads` of the new or changed ones. Re-running
// it picks up where it left off, since a bill read is a bill now unchanged —
// which is what lets a long first import span several flow steps.
export async function syncSupplierBillsBatch(
    get: ZohoGet,
    supplier: SyncSupplier,
    maxReads: number,
    now: Date,
    progress?: ProgressReporter
): Promise<SupplierBatchResult> {
    progress?.set({ message: `Listing ${supplier.name}’s bills in Zoho…` });
    const plan = planSupplierBills(await listZohoBills(get, supplier.zohoVendorId), await loadLocalBills(supplier.id));

    await deleteBills(plan.toDelete.map((b) => b.id));
    await updateStatuses(plan.statusChanges, now);

    const batch = plan.toRead.slice(0, maxReads);
    const productIdBySku = batch.length > 0 ? await loadProductIdsBySku() : new Map<string, string>();
    progress?.set({
        message: `Reading ${supplier.name}’s new and changed bills…`,
        current: 0,
        total: batch.length,
        unit: 'bills',
        counter: 'count',
    });

    let created = 0;
    for (const summary of batch) {
        const { bill, landedCosts } = await readZohoBill(get, summary.bill_id);
        const lines = buildBillLines(bill, landedCosts);
        if (await saveBill(supplier.id, summary, bill, lines, productIdBySku, now)) created++;
        progress?.increment();
        progress?.log(`${bill.bill_number}: ${lines.length} line${lines.length === 1 ? '' : 's'}`);
    }

    return {
        created,
        updated: batch.length - created,
        deleted: plan.toDelete.length,
        unchanged: plan.unchanged,
        remaining: plan.toRead.length - batch.length,
    };
}

// ─── The whole run ────────────────────────────────────────────────────────────

// A flow's ctx.step, which is all the run needs of the flow. Loosely typed:
// each flow's ctx is generic over its own config.
export type BillSyncStep = <R>(
    name: string,
    options: { timeout?: number; retries?: number; loadingMessage?: string },
    fn: (args: { progress: ProgressReporter }) => Promise<R>
) => Promise<R>;

// Bills read per step. A bill takes a call plus one per landed cost (an
// import carries several), at ~0.7s a call, so 100 bills fit comfortably in
// the 14-minute step limit.
const BILLS_PER_STEP = 100;
const STEP_TIMEOUT = 14 * 60 * 1000;

export interface SupplierBillSyncResult {
    supplier: string;
    added: number;
    updated: number;
    removed: number;
    unchanged: number;
}

export interface BillSyncSummary {
    suppliers: SupplierBillSyncResult[];
    // Suppliers made before suppliers came from Zoho, with no vendor to read.
    suppliersWithoutVendor: string[];
    linesLinked: number;
    unmatchedSkus: string[];
}

// Syncs every supplier linked to a Zoho vendor, a step (or a few, on a first
// import) per supplier, so one supplier's failure leaves the others' bills
// stored, and a retried run skips everything already read.
export async function runSupplierBillSync(
    step: BillSyncStep,
    ctx: ZohoFeeCtx,
    billsPerStep = BILLS_PER_STEP
): Promise<BillSyncSummary> {
    const accessToken = await step('authenticate', { loadingMessage: 'Signing in to Zoho…', retries: 1 }, async () => {
        return await getZohoInventoryToken(ctx);
    });

    const suppliers = await step('load-suppliers', {}, async () => {
        const all = await models.supplier.findMany({ orderBy: { name: 'asc' } });
        return {
            linked: all
                .filter((s) => s.zohoVendorId)
                .map((s) => ({ id: s.id, name: s.name, zohoVendorId: s.zohoVendorId! })),
            withoutVendor: all.filter((s) => !s.zohoVendorId).map((s) => s.name),
        };
    });

    const get = zohoInventoryGet(ctx, accessToken);
    const now = new Date();
    const results: SupplierBillSyncResult[] = [];
    for (const supplier of suppliers.linked) {
        const total: SupplierBillSyncResult = { supplier: supplier.name, added: 0, updated: 0, removed: 0, unchanged: 0 };
        let previousRemaining = Infinity;
        for (let batch = 0; ; batch++) {
            const readBefore = total.added + total.updated;
            // One retry, not the default four: each attempt re-lists the
            // supplier's bills against the shared quota.
            const result = await step(
                `bills-${supplier.id}-${batch}`,
                { timeout: STEP_TIMEOUT, retries: 1 },
                async ({ progress }) => await syncSupplierBillsBatch(get, supplier, billsPerStep, now, progress)
            );
            total.added += result.created;
            total.updated += result.updated;
            total.removed += result.deleted;
            // A batch counts the bills earlier batches read as unchanged.
            total.unchanged = result.unchanged - readBefore;
            if (result.remaining === 0) break;
            if (result.remaining >= previousRemaining) {
                throw new Error(`Syncing ${supplier.name}’s bills stopped making progress with ${result.remaining} left to read`);
            }
            previousRemaining = result.remaining;
        }
        results.push(total);
    }

    const linking = await step('link-lines', {}, async () => ({
        linked: await linkUnmatchedLines(),
        unmatchedSkus: await findUnmatchedSkus(),
    }));

    return {
        suppliers: results,
        suppliersWithoutVendor: suppliers.withoutVendor,
        linesLinked: linking.linked,
        unmatchedSkus: linking.unmatchedSkus,
    };
}

// The run summary's notes, in markdown, for both flows to show.
export function billSyncNotes(summary: BillSyncSummary): string[] {
    const notes: string[] = [];
    if (summary.suppliersWithoutVendor.length > 0) {
        notes.push(
            `**${summary.suppliersWithoutVendor.length} supplier(s) have no Zoho vendor**, so their bills weren't read: ${summary.suppliersWithoutVendor.join(', ')}. Import the vendor with *Import suppliers from Zoho* — a vendor of the same name links to the existing supplier.`
        );
    }
    if (summary.unmatchedSkus.length > 0) {
        const shown = summary.unmatchedSkus.slice(0, 20).join(', ');
        const more = summary.unmatchedSkus.length > 20 ? `, … (${summary.unmatchedSkus.length - 20} more)` : '';
        notes.push(
            `**${summary.unmatchedSkus.length} SKU(s) on supplier bills match no product here**, so they don't count towards any product's cost: ${shown}${more}. Once *Sync Products* brings a product in, the next bill sync links its lines.`
        );
    }
    return notes;
}
