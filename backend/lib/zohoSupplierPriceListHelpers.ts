import { useDatabase } from '@teamkeel/sdk';
import { sql } from 'kysely';
import { ZohoGet, parseZohoTime } from './zohoInventoryApi';
import { ProgressReporter } from './progress';

// Mirrors the purchase price lists in Zoho Inventory ("price books" in its
// API), item by item, into SupplierPriceList and SupplierPriceListItem — where
// every product's supplier price comes from (see supplierPriceLists.keel).
//
// Sales price lists are skipped: what we sell at is our own PriceList.
//
// Zoho lists a price list's items by item_id alone, with no SKU, so a run that
// reads any list first pages through the item catalogue to match ids to SKUs
// (a call per 200 items). The list of price lists carries each one's
// last_modified_time, so the nightly run reads only the lists that moved, and
// an unchanged night costs that one call. Whether editing a single rate moves
// the list's time hasn't been checked against the org, so the on-demand run
// reads every list regardless.

// Far more pages of 200 than the org has price lists or items. Hitting it
// means the listing is not what we think it is, and every further page would
// spend the shared Zoho quota for nothing.
export const MAX_PAGES = 25;

// ─── Zoho types (only the fields we use) ──────────────────────────────────────

// A price list as GET /pricebooks lists it.
export interface ZohoPriceListSummary {
    pricebook_id: string;
    name: string;
    sales_or_purchase_type?: string;
    last_modified_time: string;
}

export interface ZohoPriceListItem {
    item_id: string;
    name?: string;
    // Blank on a volume-priced list, whose rates are in price_brackets.
    pricebook_rate?: number | string | null;
}

export interface ZohoPriceListDetail {
    pricebook_id: string;
    name: string;
    description?: string;
    currency_code?: string;
    status?: string;
    pricebook_type?: string;
    pricing_scheme?: string;
    pricebook_items?: ZohoPriceListItem[];
}

interface ZohoCatalogueItem {
    item_id: string;
    sku?: string;
}

// ─── Reading Zoho ─────────────────────────────────────────────────────────────

// Every page of a Zoho listing, as one array. A page without the array is an
// error, not an empty listing: anything missing from a listing is deleted
// here.
async function listAll<T>(get: ZohoGet, path: string, key: string, query: Record<string, string>): Promise<T[]> {
    const rows: T[] = [];
    for (let page = 1; ; page++) {
        if (page > MAX_PAGES) {
            throw new Error(`Zoho's ${path} listing ran past ${MAX_PAGES} pages of 200 — stopping rather than spend more of the API quota`);
        }
        const data = await get(path, { ...query, per_page: '200', page: String(page) });
        if (!Array.isArray(data?.[key])) {
            throw new Error(`Zoho's ${path} listing came back without a list of ${key}: ${JSON.stringify(data).slice(0, 300)}`);
        }
        rows.push(...data[key]);
        if (!data.page_context?.has_more_page) return rows;
    }
}

// Every purchase price list in Zoho, active or not.
export async function listZohoPurchasePriceLists(get: ZohoGet): Promise<ZohoPriceListSummary[]> {
    const lists = await listAll<ZohoPriceListSummary>(get, '/pricebooks', 'pricebooks', {});
    return lists.filter((l) => l.sales_or_purchase_type === 'purchases');
}

export async function readZohoPriceList(get: ZohoGet, priceListId: string): Promise<ZohoPriceListDetail> {
    return (await get(`/pricebooks/${priceListId}`)).pricebook;
}

// Every item's SKU by its Zoho item id, active or not: a price list can still
// carry an item since made inactive.
export async function fetchSkusByItemId(get: ZohoGet): Promise<Map<string, string>> {
    const items = await listAll<ZohoCatalogueItem>(get, '/items', 'items', { filter_by: 'Status.All' });
    const skus = new Map<string, string>();
    for (const item of items) {
        const sku = item.sku?.trim();
        if (sku) skus.set(item.item_id, sku);
    }
    return skus;
}

// ─── Pure transforms ──────────────────────────────────────────────────────────

// A price list item as stored.
export interface PriceListItemValues {
    zohoItemId: string;
    sku: string | null;
    name: string | null;
    rate: number | null;
}

function trimmedOrNull(value: string | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

// A price list's items, each with its SKU from the catalogue and its rate.
// The rate is left unset rather than guessed where Zoho gives no single one:
// a volume-priced list's rates are by quantity bracket. Pure so it can be
// tested against captured Zoho payloads.
export function buildPriceListItems(list: ZohoPriceListDetail, skusByItemId: Map<string, string>): PriceListItemValues[] {
    return (list.pricebook_items ?? []).map((item) => {
        const raw = item.pricebook_rate;
        const rate = raw === null || raw === undefined || raw === '' ? null : Number(raw);
        return {
            zohoItemId: item.item_id,
            sku: skusByItemId.get(item.item_id) ?? null,
            name: trimmedOrNull(item.name),
            rate: rate !== null && Number.isFinite(rate) ? rate : null,
        };
    });
}

// A price list as already stored here.
export interface LocalPriceList {
    id: string;
    zohoPriceListId: string;
    zohoModifiedAt: Date;
}

export interface PriceListPlan {
    toRead: ZohoPriceListSummary[];
    // Here but gone from Zoho's purchase price lists: deleted there, or
    // turned into a sales list.
    toDelete: LocalPriceList[];
    unchanged: number;
}

// Works out what a sync has to do, from Zoho's purchase price lists against
// the lists stored here. Unless told to read every list, a list is read only
// when it is new or Zoho's modified time for it has moved.
export function planPriceLists(zohoLists: ZohoPriceListSummary[], local: LocalPriceList[], readAll: boolean): PriceListPlan {
    const zohoIds = new Set(zohoLists.map((l) => l.pricebook_id));
    const localByZohoId = new Map(local.map((l) => [l.zohoPriceListId, l]));

    const toRead: ZohoPriceListSummary[] = [];
    let unchanged = 0;
    for (const list of zohoLists) {
        const stored = localByZohoId.get(list.pricebook_id);
        const changed = !stored || stored.zohoModifiedAt.getTime() !== parseZohoTime(list.last_modified_time).getTime();
        if (readAll || changed) toRead.push(list);
        else unchanged++;
    }
    return { toRead, toDelete: local.filter((l) => !zohoIds.has(l.zohoPriceListId)), unchanged };
}

// ─── Writing ──────────────────────────────────────────────────────────────────

async function loadLocalPriceLists(): Promise<LocalPriceList[]> {
    return await useDatabase().selectFrom('supplier_price_list').select(['id', 'zohoPriceListId', 'zohoModifiedAt']).execute();
}

async function loadProductIdsBySku(): Promise<Map<string, string>> {
    const rows = await useDatabase().selectFrom('product').select(['id', 'sku']).execute();
    return new Map(rows.map((r) => [r.sku, r.id]));
}

// Stores a price list read from Zoho: the list upserted on its Zoho id, its
// items replaced outright. One transaction, so the list is never seen without
// its items, nor marked current with stale ones. Returns whether it is new.
export async function savePriceList(
    summary: ZohoPriceListSummary,
    list: ZohoPriceListDetail,
    items: PriceListItemValues[],
    productIdBySku: Map<string, string>,
    now: Date
): Promise<boolean> {
    const currencyCode = trimmedOrNull(list.currency_code);
    if (!currencyCode) throw new Error(`Zoho's price list "${list.name}" has no currency`);
    const values = {
        name: list.name,
        description: trimmedOrNull(list.description),
        currencyCode,
        isActive: list.status !== 'inactive',
        priceListType: trimmedOrNull(list.pricebook_type),
        pricingScheme: trimmedOrNull(list.pricing_scheme),
        // The list's time, not the detail's: it's what the next run compares
        // against.
        zohoModifiedAt: parseZohoTime(summary.last_modified_time),
        synchronisedAt: now,
    };

    return await useDatabase()
        .transaction()
        .execute(async (trx) => {
            const existing = await trx
                .selectFrom('supplier_price_list')
                .select('id')
                .where('zohoPriceListId', '=', list.pricebook_id)
                .executeTakeFirst();

            let listId: string;
            if (existing) {
                listId = existing.id;
                await trx.updateTable('supplier_price_list').set({ ...values, updatedAt: now }).where('id', '=', listId).execute();
                await trx.deleteFrom('supplier_price_list_item').where('priceListId', '=', listId).execute();
            } else {
                const inserted = await trx
                    .insertInto('supplier_price_list')
                    .values({ ...values, zohoPriceListId: list.pricebook_id })
                    .returning('id')
                    .executeTakeFirstOrThrow();
                listId = inserted.id;
            }

            if (items.length > 0) {
                await trx
                    .insertInto('supplier_price_list_item')
                    .values(
                        items.map((item) => ({
                            priceListId: listId,
                            productId: item.sku ? (productIdBySku.get(item.sku) ?? null) : null,
                            ...item,
                        }))
                    )
                    .execute();
            }
            return !existing;
        });
}

// Deleting a list takes its items with it (a required relation cascades).
async function deletePriceLists(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await useDatabase().deleteFrom('supplier_price_list').where('id', 'in', ids).execute();
}

// Links items to products that have arrived since the item was stored — a
// list isn't read again until it changes in Zoho, so this is what picks up a
// product Sync Products brings in later. Returns the items linked.
export async function linkUnmatchedPriceListItems(): Promise<number> {
    const result = await sql`
        update supplier_price_list_item i
        set product_id = p.id, updated_at = now()
        from product p
        where i.product_id is null
          and i.sku = p.sku
    `.execute(useDatabase());
    return Number(result.numAffectedRows ?? 0);
}

// SKUs on price lists that match no product here.
export async function findUnmatchedPriceListSkus(): Promise<string[]> {
    const result = await sql<{ sku: string }>`
        select distinct sku
        from supplier_price_list_item
        where product_id is null
          and sku is not null
        order by sku
    `.execute(useDatabase());
    return result.rows.map((r) => r.sku);
}

// ─── The whole run ────────────────────────────────────────────────────────────

// A flow's ctx.step, which is all the run needs of the flow. Loosely typed:
// each flow's ctx is generic over its own config.
export type PriceListSyncStep = <R>(
    name: string,
    options: { timeout?: number; retries?: number; loadingMessage?: string },
    fn: (args: { progress: ProgressReporter }) => Promise<R>
) => Promise<R>;

const STEP_TIMEOUT = 14 * 60 * 1000;

export interface PriceListSyncResult {
    priceList: string;
    currencyCode: string;
    items: number;
    change: 'Added' | 'Updated';
}

export interface PriceListSyncSummary {
    read: PriceListSyncResult[];
    removed: number;
    unchanged: number;
    // Lists that sync with no usable rates: mark-up/mark-down lists (no items)
    // and volume-priced ones (items with no single rate).
    withoutRates: string[];
    itemsLinked: number;
    unmatchedSkus: string[];
}

// Syncs every purchase price list: one step to list, read and store them —
// there are few, and an unchanged one is skipped on a retry — and one to link
// items to products that arrived since.
export async function runSupplierPriceListSync(
    step: PriceListSyncStep,
    get: ZohoGet,
    options: { readAll: boolean }
): Promise<PriceListSyncSummary> {
    const now = new Date();
    const synced = await step('price-lists', { timeout: STEP_TIMEOUT, retries: 1 }, async ({ progress }) => {
        progress.set({ message: 'Listing purchase price lists in Zoho…' });
        const plan = planPriceLists(await listZohoPurchasePriceLists(get), await loadLocalPriceLists(), options.readAll);
        await deletePriceLists(plan.toDelete.map((l) => l.id));

        const read: PriceListSyncResult[] = [];
        const withoutRates: string[] = [];
        if (plan.toRead.length > 0) {
            progress.set({ message: 'Matching Zoho items to SKUs…' });
            const skusByItemId = await fetchSkusByItemId(get);
            const productIdBySku = await loadProductIdsBySku();
            progress.set({ message: 'Reading price lists…', current: 0, total: plan.toRead.length, unit: 'lists', counter: 'count' });
            for (const summary of plan.toRead) {
                const list = await readZohoPriceList(get, summary.pricebook_id);
                const items = buildPriceListItems(list, skusByItemId);
                const added = await savePriceList(summary, list, items, productIdBySku, now);
                read.push({ priceList: list.name, currencyCode: list.currency_code ?? '', items: items.length, change: added ? 'Added' : 'Updated' });
                if (list.pricebook_type !== 'per_item' || items.some((i) => i.rate === null)) withoutRates.push(list.name);
                progress.increment();
            }
        }
        return { read, removed: plan.toDelete.length, unchanged: plan.unchanged, withoutRates };
    });

    const linking = await step('link-price-list-items', {}, async () => ({
        linked: await linkUnmatchedPriceListItems(),
        unmatchedSkus: await findUnmatchedPriceListSkus(),
    }));

    return { ...synced, itemsLinked: linking.linked, unmatchedSkus: linking.unmatchedSkus };
}

// The run summary's notes, in markdown, for both flows to show.
export function priceListSyncNotes(summary: PriceListSyncSummary): string[] {
    const notes: string[] = [];
    if (summary.withoutRates.length > 0) {
        notes.push(
            `**${summary.withoutRates.length} price list(s) have items without a rate**, so they can't price those items: ${summary.withoutRates.join(', ')}. A mark-up or mark-down list has no per-item rates in Zoho, and a volume-priced one has rates by quantity, neither of which this sync reads.`
        );
    }
    if (summary.unmatchedSkus.length > 0) {
        const shown = summary.unmatchedSkus.slice(0, 20).join(', ');
        const more = summary.unmatchedSkus.length > 20 ? `, … (${summary.unmatchedSkus.length - 20} more)` : '';
        notes.push(
            `**${summary.unmatchedSkus.length} SKU(s) on price lists match no product here**: ${shown}${more}. Once *Sync Products* brings a product in, the next price list sync links its prices.`
        );
    }
    return notes;
}
