import { ProgressReporter } from './progress';
import { ZohoApiError, ZohoGet } from './zohoInventoryApi';

// ─── Zoho types ─────────────────────────────────────────────────────────────

// The item shape we read from GET /items. The stock figure and the composite
// flag are optional: they're absent on non-inventory/service items, and Zoho
// can return numeric fields as strings. We deliberately read stock straight off
// the list response (no per-item detail call) to stay cheap on the shared daily
// quota.
//
// actual_available_stock is physical stock: it moves when a purchase order is
// received, where stock_on_hand moves when it is billed. The two agree on every
// item except one on an order billed ahead of its delivery — see
// zohoPurchaseOrderHelpers, which counts those units as on the way instead.
export interface ZohoStockItem {
    item_id: string;
    sku?: string;
    status?: string;
    actual_available_stock?: string | number | null;
    // Composite/bundle markers — Zoho exposes these inconsistently across orgs,
    // so we check all of them.
    is_combo_product?: boolean;
    item_type?: string;
    combo_type?: string;
}

interface ZohoItemsResponse {
    items?: ZohoStockItem[];
    page_context?: {
        has_more_page?: boolean;
    };
}

// A resolved (sku → stock-on-hand) pair for one product.
export interface ProductStock {
    sku: string;
    stockAvailable: number;
}

export interface FetchStockResult {
    stock: ProductStock[];
    // True when Zoho's daily quota was hit mid-fetch: `stock` holds whatever was
    // read before the limit, and the caller should treat this as a clean pause
    // (resume next run) rather than a failure.
    rateLimited: boolean;
}

// ─── Pure helpers (unit-tested) ───────────────────────────────────────────────

// True when the Zoho item is a composite/bundle. The reorder sheet excludes
// these — a composite's stock is derived from its components, not tracked in its
// own right — so we do too.
export function isCompositeItem(item: ZohoStockItem): boolean {
    if (item.is_combo_product === true) return true;
    const marker = `${item.item_type ?? ''} ${item.combo_type ?? ''}`.toLowerCase();
    return marker.includes('combo') || marker.includes('composite');
}

// Reduce a page of raw Zoho items to the (sku, stockAvailable) pairs we persist.
// Drops items without a SKU, inactive items, composites, and anything without a
// numeric physical stock figure (service items etc. — nothing to give cover
// on). Pure, so the sheet-matching rules are exercised directly in tests.
export function parseStockItems(items: ZohoStockItem[]): ProductStock[] {
    const out: ProductStock[] = [];
    for (const item of items) {
        const sku = item.sku?.trim();
        if (!sku) continue;
        if ((item.status ?? '').toLowerCase() === 'inactive') continue;
        if (isCompositeItem(item)) continue;

        const raw = item.actual_available_stock;
        if (raw === null || raw === undefined || raw === '') continue;
        const stock = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(stock)) continue;

        out.push({ sku, stockAvailable: stock });
    }
    return out;
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

// Page every active item from Zoho Inventory (200/page) and read physical stock
// off the list response. A daily rate-limit stops the sweep and returns what we
// have with rateLimited=true (STOP, don't retry — the quota won't recover
// today); any other failure throws.
export async function fetchProductStock(get: ZohoGet, progress?: ProgressReporter): Promise<FetchStockResult> {
    const stock: ProductStock[] = [];

    progress?.set({ message: 'Fetching stock levels from Zoho…' });
    for (let page = 1; ; page++) {
        let data: ZohoItemsResponse;
        try {
            data = await get('/items', { filter_by: 'Status.Active', page: String(page), per_page: '200' });
        } catch (error) {
            if (error instanceof ZohoApiError && error.isDailyRateLimit) return { stock, rateLimited: true };
            throw error;
        }
        stock.push(...parseStockItems(data.items ?? []));
        progress?.set({ message: `Fetched stock for ${stock.length} item${stock.length === 1 ? '' : 's'}…` });
        if (!data.page_context?.has_more_page) return { stock, rateLimited: false };
    }
}
