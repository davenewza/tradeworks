import { ProgressReporter } from './progress';
import { ZohoProductCtx } from './zohoProductHelpers';
import { isZohoDailyRateLimit } from './zohoSalesHelpers';

// ─── Zoho types ─────────────────────────────────────────────────────────────

// The item shape we read from GET /items. stock_on_hand and the composite flag
// are optional: they're absent on non-inventory/service items, and Zoho returns
// numeric fields as strings. We deliberately read stock straight off the list
// response (no per-item detail call) to stay cheap on the shared daily quota.
export interface ZohoStockItem {
    item_id: string;
    sku?: string;
    status?: string;
    stock_on_hand?: string | number | null;
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
// numeric stock_on_hand (service items etc. — nothing to give cover on). Pure,
// so the sheet-matching rules are exercised directly in tests.
export function parseStockItems(items: ZohoStockItem[]): ProductStock[] {
    const out: ProductStock[] = [];
    for (const item of items) {
        const sku = item.sku?.trim();
        if (!sku) continue;
        if ((item.status ?? '').toLowerCase() === 'inactive') continue;
        if (isCompositeItem(item)) continue;

        const raw = item.stock_on_hand;
        if (raw === null || raw === undefined || raw === '') continue;
        const stock = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(stock)) continue;

        out.push({ sku, stockAvailable: stock });
    }
    return out;
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

// Page every active item from Zoho Books (200/page) and read stock_on_hand off
// the list response. A daily rate-limit stops the sweep and returns what we have
// with rateLimited=true (STOP, don't retry — the quota won't recover today); any
// other non-OK response throws.
export async function fetchProductStock(
    ctx: ZohoProductCtx,
    accessToken: string,
    progress?: ProgressReporter,
): Promise<FetchStockResult> {
    const stock: ProductStock[] = [];
    let page = 1;
    let hasMorePages = true;

    progress?.set({ message: 'Fetching stock levels from Zoho…' });
    while (hasMorePages) {
        const url = `${ctx.env.ZOHO_BOOKS_BASE_URL}/items?organization_id=${ctx.env.ZOHO_BOOKS_ORG_ID}&filter_by=Status.Active&page=${page}&per_page=200`;

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Zoho-oauthtoken ${accessToken}`,
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            if (isZohoDailyRateLimit(response.status, errorText)) {
                return { stock, rateLimited: true };
            }
            throw new Error(`Failed to fetch items from Zoho: ${response.status} - ${errorText}`);
        }

        const data: ZohoItemsResponse = await response.json();
        stock.push(...parseStockItems(data.items ?? []));

        hasMorePages = data.page_context?.has_more_page ?? false;
        progress?.set({ message: `Fetched stock for ${stock.length} item${stock.length === 1 ? '' : 's'}…` });
        page++;
    }

    return { stock, rateLimited: false };
}
