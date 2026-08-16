import { models } from '@teamkeel/sdk';
import { ZohoFeeCtx, getZohoAccessToken } from './zohoChannelFeeHelpers';
import { ProgressReporter } from './progress';

// Sources product cost of goods (unit cost + freight-in per supplier bill) from
// Zoho Inventory's landed-cost feature. Freight/duties/fees are recorded as
// landed costs on the (import) bills and allocated by Zoho across each bill's
// product lines; that per-line allocation is exactly the per-(product, bill)
// freight-in the pricing calculator needs.
//
// There is no "list landed costs" endpoint — they're discovered by reading each
// bill's detail (`allocated_landed_costs`) — and the token endpoint rate-limits
// hard, so callers fetch ONE token per run (below) and the fetch paces its calls.
// Only bills that actually carry landed costs produce cost lines.

// Inventory scope for the bills + landed-cost endpoints. The self-client is
// already authorised for it (verified against the org).
const INVENTORY_SCOPE = 'ZohoInventory.FullAccess.READ';
const INVENTORY_BASE = 'https://www.zohoapis.com/inventory/v1';

// Spacing between Zoho API calls, to stay under the per-minute cap on a backfill.
const CALL_SPACING_MS = 350;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getZohoInventoryToken(ctx: ZohoFeeCtx): Promise<string> {
    return getZohoAccessToken(ctx, INVENTORY_SCOPE);
}

// ─── Zoho types (only the fields we use) ──────────────────────────────────────

interface ZohoBillListItem {
    bill_id: string;
}

interface ZohoBillLine {
    line_item_id: string;
    sku?: string;
    name?: string;
    rate?: number;
    quantity?: number;
    is_landedcost?: boolean;
}

interface ZohoAllocatedLandedCost {
    landed_cost_id: string;
}

export interface ZohoBillDetail {
    bill_id: string;
    bill_number: string;
    date?: string;
    vendor_name?: string;
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

// ─── Pure transform: bill + its landed costs → per-line cost data ─────────────

// A cost-of-goods line as sourced from Zoho, normalised to what a ProductCostLine
// needs. `zohoRecordId` is the bill line item id — unique per product per bill.
export interface ZohoCostLine {
    zohoRecordId: string;
    sku: string;
    billNumber: string;
    billDate: string | null;
    vendorName: string | null;
    unitCost: number;
    unitFreightIn: number;
    quantity: number | null;
}

// Build one cost line per product line on a bill, summing every landed cost
// allocated to that line and spreading it per unit. Landed-cost expense lines
// (`is_landedcost`) and lines without a SKU are excluded — they aren't products.
// Pure so it can be tested against captured Zoho payloads without the network.
export function buildCostLinesForBill(bill: ZohoBillDetail, landedCosts: ZohoLandedCost[]): ZohoCostLine[] {
    // Total freight allocated to each bill line, summed across all landed costs
    // on the bill (freight + customs + fees, possibly from several source bills).
    const freightByLineId = new Map<string, number>();
    for (const lc of landedCosts) {
        for (const alloc of lc.cost_allocations ?? []) {
            const prev = freightByLineId.get(alloc.bill_item_id) ?? 0;
            freightByLineId.set(alloc.bill_item_id, prev + (alloc.allocated_amount ?? 0));
        }
    }

    const lines: ZohoCostLine[] = [];
    for (const li of bill.line_items ?? []) {
        if (li.is_landedcost) continue; // a landed-cost expense line, not a product
        const sku = (li.sku ?? '').trim();
        if (!sku) continue;

        const quantity = typeof li.quantity === 'number' ? li.quantity : null;
        const freightTotal = freightByLineId.get(li.line_item_id) ?? 0;
        const unitFreightIn = quantity && quantity > 0 ? freightTotal / quantity : 0;

        lines.push({
            zohoRecordId: li.line_item_id,
            sku,
            billNumber: bill.bill_number,
            billDate: bill.date ?? null,
            vendorName: bill.vendor_name ?? null,
            unitCost: li.rate ?? 0,
            unitFreightIn,
            quantity,
        });
    }
    return lines;
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function getJson(url: string, accessToken: string): Promise<any> {
    const res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Zoho GET ${url} failed: ${res.status} - ${text.slice(0, 300)}`);
    }
    return res.json();
}

// Walk the bills dated within [dateFrom, dateTo], and for each bill that carries
// landed costs, fetch those costs and build its per-product cost lines. Only
// bills with landed costs contribute. Calls are paced to respect the rate limit.
export async function fetchLandedCostLines(
    ctx: ZohoFeeCtx,
    accessToken: string,
    dateFrom: string,
    dateTo: string,
    progress?: ProgressReporter
): Promise<ZohoCostLine[]> {
    const org = ctx.env.ZOHO_BOOKS_ORG_ID;
    const costLines: ZohoCostLine[] = [];
    let page = 1;
    let hasMore = true;
    let billsWalked = 0;
    let billsWithCosts = 0;

    progress?.set({ message: 'Walking Zoho bills…', unit: 'bills', counter: 'count' });

    while (hasMore) {
        const listUrl = `${INVENTORY_BASE}/bills?organization_id=${org}&date_start=${dateFrom}&date_end=${dateTo}&per_page=100&page=${page}&sort_column=date&sort_order=A`;
        const list = await getJson(listUrl, accessToken);
        const bills: ZohoBillListItem[] = list.bills ?? [];

        for (const summary of bills) {
            await sleep(CALL_SPACING_MS);
            const detail: ZohoBillDetail = (await getJson(`${INVENTORY_BASE}/bills/${summary.bill_id}?organization_id=${org}`, accessToken)).bill;
            billsWalked++;
            progress?.set({
                current: billsWalked,
                message: `Walked ${billsWalked} bill${billsWalked === 1 ? '' : 's'} · ${billsWithCosts} with landed costs`,
            });
            const allocated = detail.allocated_landed_costs ?? [];
            if (allocated.length === 0) continue; // no freight → skip

            const landedCosts: ZohoLandedCost[] = [];
            for (const alc of allocated) {
                await sleep(CALL_SPACING_MS);
                const lc: ZohoLandedCost = (await getJson(`${INVENTORY_BASE}/bills/${detail.bill_id}/landedcosts/${alc.landed_cost_id}?organization_id=${org}`, accessToken)).landed_cost;
                landedCosts.push(lc);
            }

            billsWithCosts++;
            progress?.log(`${detail.bill_number}: ${allocated.length} landed cost${allocated.length === 1 ? '' : 's'}`);
            costLines.push(...buildCostLinesForBill(detail, landedCosts));
        }

        hasMore = list.page_context?.has_more_page ?? false;
        page++;
    }

    return costLines;
}

// ─── Read-only diff pass ──────────────────────────────────────────────────────

// A cost line to add or update. The first columns are the human-facing table;
// the rest is carried through to the apply pass.
export interface CostLineChange {
    sku: string;
    product: string;
    billNumber: string;
    unitCost: string;
    freightIn: string;
    landed: string;
    change: 'New' | 'Update';
    zohoRecordId: string;
    productId: string;
    billDate: string | null;
    vendorName: string | null;
    unitCostValue: number;
    unitFreightInValue: number;
    quantityValue: number | null;
}

export interface CostSyncPlan {
    costLines: CostLineChange[];
    unchangedCostLines: number;
    // Distinct supplier bills that will be created or updated.
    billCount: number;
    // Zoho cost records whose SKU has no matching product here.
    unmatchedSkus: string[];
    warnings: string[];
}

function toNumberOrNull(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    return Number(value);
}

// Work out what needs to change to bring cost lines in line with Zoho. Performs
// NO writes — everything is applied later in applyCostSync(), after the user
// confirms. Cost lines are matched on their Zoho record id (the bill line item).
export async function computeCostSyncPlan(zohoLines: ZohoCostLine[]): Promise<CostSyncPlan> {
    const warnings: string[] = [];

    const usable: ZohoCostLine[] = [];
    for (const line of zohoLines) {
        if (!line.sku) {
            warnings.push(`Skipping cost record ${line.zohoRecordId}: no SKU`);
            continue;
        }
        if (!line.billNumber) {
            warnings.push(`Skipping cost record ${line.zohoRecordId} (${line.sku}): no bill number`);
            continue;
        }
        usable.push(line);
    }

    // Match products by SKU.
    const skus = [...new Set(usable.map((l) => l.sku))];
    const existingProducts =
        skus.length > 0 ? await models.product.findMany({ where: { sku: { oneOf: skus } } }) : [];
    const productBySku = new Map(existingProducts.map((p) => [p.sku, p]));

    // Existing cost lines, matched on Zoho record id.
    const zohoRecordIds = usable.map((l) => l.zohoRecordId);
    const existingLines =
        zohoRecordIds.length > 0
            ? await models.productCostLine.findMany({ where: { zohoRecordId: { oneOf: zohoRecordIds } } })
            : [];
    const existingByZohoId = new Map(existingLines.map((l) => [l.zohoRecordId, l]));

    const costLines: CostLineChange[] = [];
    const unmatchedSkus = new Set<string>();
    const billNumbers = new Set<string>();
    let unchangedCostLines = 0;

    for (const line of usable) {
        const product = productBySku.get(line.sku);
        if (!product) {
            unmatchedSkus.add(line.sku);
            continue;
        }

        const existing = existingByZohoId.get(line.zohoRecordId);
        const needsUpdate =
            !existing ||
            toNumberOrNull(existing.unitCost) !== line.unitCost ||
            toNumberOrNull(existing.unitFreightIn) !== line.unitFreightIn ||
            toNumberOrNull(existing.quantity) !== line.quantity ||
            existing.productId !== product.id;

        if (!needsUpdate) {
            unchangedCostLines++;
            billNumbers.add(line.billNumber);
            continue;
        }

        billNumbers.add(line.billNumber);
        const landed = line.unitCost + line.unitFreightIn;
        costLines.push({
            sku: line.sku,
            product: product.name,
            billNumber: line.billNumber,
            unitCost: line.unitCost.toFixed(2),
            freightIn: line.unitFreightIn.toFixed(2),
            landed: landed.toFixed(2),
            change: existing ? 'Update' : 'New',
            zohoRecordId: line.zohoRecordId,
            productId: product.id,
            billDate: line.billDate,
            vendorName: line.vendorName,
            unitCostValue: line.unitCost,
            unitFreightInValue: line.unitFreightIn,
            quantityValue: line.quantity,
        });
    }

    return {
        costLines,
        unchangedCostLines,
        billCount: billNumbers.size,
        unmatchedSkus: [...unmatchedSkus],
        warnings,
    };
}

// ─── Apply pass ───────────────────────────────────────────────────────────────

export interface CostApplyResult {
    costLinesCreated: number;
    costLinesUpdated: number;
    billsCreated: number;
}

// Find a supplier bill by its number, creating it on first sight. Bills carry no
// separate Zoho id here — the bill number is the natural key. `created` reports
// whether this call created the bill (for the run summary).
async function getOrCreateSupplierBill(
    billNumber: string,
    billDate: string | null,
    vendorName: string | null,
    cache: Map<string, string>
): Promise<{ id: string; created: boolean }> {
    const cachedId = cache.get(billNumber);
    if (cachedId) return { id: cachedId, created: false };

    const existing = await models.supplierBill.findOne({ billNumber });
    if (existing) {
        cache.set(billNumber, existing.id);
        return { id: existing.id, created: false };
    }

    const created = await models.supplierBill.create({
        billNumber,
        date: billDate ? new Date(billDate) : null,
        vendorName: vendorName ?? null,
        synchronisedAt: new Date(),
    });
    cache.set(billNumber, created.id);
    return { id: created.id, created: true };
}

// Apply a cost sync plan: upsert each supplier bill (by number), then upsert each
// cost line (by Zoho record id). Idempotent — a step retry re-derives the same
// result rather than duplicating records. Cost lines absent from Zoho are left in
// place (cost history is cumulative, not reconciled away).
export async function applyCostSync(plan: CostSyncPlan, progress?: ProgressReporter): Promise<CostApplyResult> {
    const now = new Date();
    const billCache = new Map<string, string>();

    let costLinesCreated = 0;
    let costLinesUpdated = 0;
    let billsCreated = 0;

    progress?.set({ current: 0, total: plan.costLines.length, unit: 'cost lines', counter: 'count' });

    for (const line of plan.costLines) {
        const bill = await getOrCreateSupplierBill(line.billNumber, line.billDate, line.vendorName, billCache);
        if (bill.created) billsCreated++;

        const values = {
            productId: line.productId,
            supplierBillId: bill.id,
            unitCost: line.unitCostValue,
            unitFreightIn: line.unitFreightInValue,
            quantity: line.quantityValue,
            synchronisedAt: now,
        };

        const existing = await models.productCostLine.findOne({ zohoRecordId: line.zohoRecordId });
        if (existing) {
            await models.productCostLine.update({ id: existing.id }, values);
            costLinesUpdated++;
        } else {
            await models.productCostLine.create({ ...values, zohoRecordId: line.zohoRecordId });
            costLinesCreated++;
        }

        progress?.increment();
        progress?.log(`${existing ? 'Updated' : 'Added'} ${line.sku} · bill ${line.billNumber}`);
    }

    return { costLinesCreated, costLinesUpdated, billsCreated };
}
