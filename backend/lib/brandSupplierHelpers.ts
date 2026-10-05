import { useDatabase } from '@teamkeel/sdk';
import { sql } from 'kysely';
import { ZohoGet } from './zohoInventoryApi';
import { ProgressReporter } from './progress';

// AssignSuppliersByBrand: give products their supplier in bulk, brand by
// brand. Products went without suppliers when lead time moved from brands to
// suppliers (#84) and the flow that seeded a supplier per brand was dropped
// (#91), so most went ungraded. An operator maps each Zoho brand to the
// supplier its products come from, and every product of the brand gets that
// supplier.
//
// The brand is Zoho's: the item's "Brand" custom field, which the Inventory
// item list carries as cf_brand — one call per 200 items, no detail reads.

// Far more pages of 200 than the org has items.
export const MAX_ITEM_PAGES = 25;

// The group for items with no brand in Zoho.
export const NO_BRAND = '(No brand)';

// ─── Reading Zoho ─────────────────────────────────────────────────────────────

interface ZohoBrandedItem {
    item_id: string;
    sku?: string;
    cf_brand?: string;
    cf_brand_unformatted?: string;
}

export interface ItemBrand {
    sku: string;
    brand: string;
}

// An item's brand as the operator knows it, or NO_BRAND.
export function zohoBrandOf(item: ZohoBrandedItem): string {
    return (item.cf_brand_unformatted ?? item.cf_brand ?? '').trim() || NO_BRAND;
}

// Every item in Zoho with a SKU, active or not, and its brand.
export async function fetchZohoItemBrands(get: ZohoGet, progress?: ProgressReporter): Promise<ItemBrand[]> {
    const items: ItemBrand[] = [];
    progress?.set({ message: 'Reading item brands from Zoho…' });
    for (let page = 1; ; page++) {
        if (page > MAX_ITEM_PAGES) {
            throw new Error(`Zoho's item listing ran past ${MAX_ITEM_PAGES} pages of 200 — stopping rather than spend more of the API quota`);
        }
        const data = await get('/items', { filter_by: 'Status.All', per_page: '200', page: String(page) });
        if (!Array.isArray(data?.items)) {
            throw new Error(`Zoho's item listing came back without a list of items: ${JSON.stringify(data).slice(0, 300)}`);
        }
        for (const item of data.items as ZohoBrandedItem[]) {
            const sku = item.sku?.trim();
            if (sku) items.push({ sku, brand: zohoBrandOf(item) });
        }
        progress?.set({ message: `Read ${items.length} items…` });
        if (!data.page_context?.has_more_page) return items;
    }
}

// ─── Grouping and suggesting (pure) ───────────────────────────────────────────

export interface LocalProduct {
    id: string;
    sku: string;
    supplierId: string | null;
}

export interface BrandGroup {
    brand: string;
    productIds: string[];
    // Of those, how many already have a supplier.
    withSupplier: number;
}

// Our products, grouped by their brand in Zoho, by name. A product not in
// Zoho's listing has no brand to go by and is left out.
export function groupProductsByBrand(items: ItemBrand[], products: LocalProduct[]): BrandGroup[] {
    const brandBySku = new Map(items.map((i) => [i.sku, i.brand]));
    const groups = new Map<string, BrandGroup>();
    for (const product of products) {
        const brand = brandBySku.get(product.sku);
        if (brand === undefined) continue;
        const group = groups.get(brand) ?? { brand, productIds: [], withSupplier: 0 };
        group.productIds.push(product.id);
        if (product.supplierId) group.withSupplier++;
        groups.set(brand, group);
    }
    return [...groups.values()].sort((a, b) => a.brand.localeCompare(b.brand));
}

// How often a supplier has billed one product.
export interface BilledBy {
    productId: string;
    supplierId: string;
    lines: number;
    lastBilled: Date | null;
}

export interface Suggestion {
    supplierId: string;
    // How many of the brand's products that supplier has billed, of how many
    // were billed at all.
    productsBilled: number;
    productsWithBills: number;
}

// The supplier that has billed the most of a brand's products, as a starting
// point for the operator — then the one with the most bill lines, then the
// most recent. Null when none of the brand's products have been billed.
export function suggestSupplier(productIds: string[], billedBy: BilledBy[]): Suggestion | null {
    const inBrand = new Set(productIds);
    const tally = new Map<string, { products: number; lines: number; last: number }>();
    const billed = new Set<string>();
    for (const row of billedBy) {
        if (!inBrand.has(row.productId)) continue;
        billed.add(row.productId);
        const t = tally.get(row.supplierId) ?? { products: 0, lines: 0, last: 0 };
        t.products++;
        t.lines += row.lines;
        t.last = Math.max(t.last, row.lastBilled?.getTime() ?? 0);
        tally.set(row.supplierId, t);
    }
    const ranked = [...tally.entries()].sort(
        ([idA, a], [idB, b]) => b.products - a.products || b.lines - a.lines || b.last - a.last || idA.localeCompare(idB)
    );
    if (ranked.length === 0) return null;
    return { supplierId: ranked[0][0], productsBilled: ranked[0][1].products, productsWithBills: billed.size };
}

// ─── Planning the assignment (pure) ───────────────────────────────────────────

export interface BrandOutcome {
    brand: string;
    supplierId: string | null;
    // Products getting the supplier, having none before.
    assigned: number;
    // Products moving to it from another supplier.
    replaced: number;
    // Products already with it, or with another left alone.
    unchanged: number;
}

export interface AssignmentPlan {
    // Product ids to set, by supplier id.
    bySupplier: Record<string, string[]>;
    brands: BrandOutcome[];
}

// What mapping each brand to a supplier does to its products. A brand mapped
// to no supplier is left as it is. A product that already has a supplier keeps
// it unless `replaceExisting`.
export function planAssignments(
    groups: BrandGroup[],
    mapping: Record<string, string | null>,
    products: LocalProduct[],
    replaceExisting: boolean
): AssignmentPlan {
    const productById = new Map(products.map((p) => [p.id, p]));
    const bySupplier: Record<string, string[]> = {};
    const brands = groups.map((group) => {
        const supplierId = mapping[group.brand] ?? null;
        const outcome: BrandOutcome = { brand: group.brand, supplierId, assigned: 0, replaced: 0, unchanged: 0 };
        for (const productId of group.productIds) {
            const current = productById.get(productId)?.supplierId ?? null;
            if (supplierId === null || current === supplierId || (current !== null && !replaceExisting)) {
                outcome.unchanged++;
                continue;
            }
            if (current === null) outcome.assigned++;
            else outcome.replaced++;
            (bySupplier[supplierId] ??= []).push(productId);
        }
        return outcome;
    });
    return { bySupplier, brands };
}

// ─── Reading and writing here ─────────────────────────────────────────────────

export async function loadProducts(): Promise<LocalProduct[]> {
    const rows = await useDatabase().selectFrom('product').select(['id', 'sku', 'supplierId']).execute();
    return rows.map((r) => ({ id: r.id, sku: r.sku, supplierId: r.supplierId ?? null }));
}

// Which supplier has billed each product, and how often.
export async function loadBilledBy(): Promise<BilledBy[]> {
    const result = await sql<{ productId: string; supplierId: string; lines: string | number; lastBilled: Date | null }>`
        select l.product_id, b.supplier_id, count(*) as lines, max(b.date) as last_billed
        from supplier_bill_line l
        join supplier_bill b on b.id = l.supplier_bill_id
        where l.product_id is not null and b.supplier_id is not null
        group by l.product_id, b.supplier_id
    `.execute(useDatabase());
    return result.rows.map((r) => ({ productId: r.productId, supplierId: r.supplierId, lines: Number(r.lines), lastBilled: r.lastBilled }));
}

// Sets the planned suppliers, a statement per supplier. An ordinary update, so
// each product's stock cover status re-grades against its new supplier's lead
// time straight away. Returns the products changed.
export async function applyAssignments(plan: AssignmentPlan, now: Date): Promise<number> {
    let changed = 0;
    for (const [supplierId, productIds] of Object.entries(plan.bySupplier)) {
        if (productIds.length === 0) continue;
        const result = await useDatabase()
            .updateTable('product')
            .set({ supplierId, updatedAt: now })
            .where('id', 'in', productIds)
            .executeTakeFirst();
        changed += Number(result.numUpdatedRows ?? 0);
    }
    return changed;
}
