import { models } from '@teamkeel/sdk';
import {
    AmazonCtx,
    FetchOptions,
    PAGE_PAUSE_MS,
    amazonApiBase,
    amazonGet,
    getAmazonAccessToken,
    sleeper,
} from './amazonApi';
import { ChannelCodeEntry, ChannelCodeSyncPlan, planChannelCodeSync } from './channelCodeSync';
import { getOrCreateChannel } from './zohoSalesHelpers';
import { ProgressReporter } from './progress';

// Reads each FBA listing's FNSKU from the Amazon Selling Partner API into the
// product's Amazon ProductChannelCode row (docs/amazon-fnskus.md). Listings are
// matched to products by seller SKU. Three entry points share this module: the
// SyncAmazonFnskus flow and the ScheduledSyncChannelCodes sweep both run the
// whole catalogue through the plan → apply core shared with the Takealot sync
// (channelCodeSync), and the syncAmazonFnsku subscriber looks up one SKU.
//
// Two calls per catalogue sync: a Login with Amazon token exchange, then the
// FBA Inventory summaries listing paged to the end. The per-product lookup is
// the same two calls with the listing filtered to one SKU. Neither touches the
// shared Zoho quota.
//
// The token exchange and the throttle-aware GET live in amazonApi, shared with
// the inbound shipment sync (amazonShipmentHelpers). They are re-exported here
// so this module stays the one import the FNSKU flow needs.
export type { AmazonCtx, FetchOptions };
export { getAmazonAccessToken };

// The channel the views import lands Amazon traffic on, and the Zoho sales
// sync names Amazon sales with, so codes, views and sales sit on one row.
export const AMAZON_CHANNEL_NAME = 'Amazon Marketplace';

// ─── Types ──────────────────────────────────────────────────────────────────

// One FBA listing as the sync sees it — the slice of an inventory summary that
// matters for labels.
export interface AmazonListing {
    sku: string;
    // Empty when Amazon reports the listing without one.
    fnsku: string;
    asin: string;
    condition: string;
    productName: string;
}

// The slice of an FBA Inventory API summary the sync reads.
interface InventorySummary {
    asin?: string | null;
    fnSku?: string | null;
    sellerSku?: string | null;
    condition?: string | null;
    productName?: string | null;
}

interface InventorySummariesResponse {
    payload?: { inventorySummaries?: InventorySummary[] } | null;
    pagination?: { nextToken?: string | null } | null;
    errors?: { code?: string; message?: string; details?: string }[] | null;
}

// ─── Fetch ──────────────────────────────────────────────────────────────────

// One inventory summary as the sync reads it. Null when Amazon reports the
// summary without a seller SKU — there is nothing to match a product on.
function toListing(summary: InventorySummary): AmazonListing | null {
    const sku = summary.sellerSku?.trim();
    if (!sku) return null;
    return {
        sku,
        fnsku: summary.fnSku?.trim() ?? '',
        asin: summary.asin?.trim() ?? '',
        condition: summary.condition?.trim() ?? '',
        productName: summary.productName?.trim() ?? '',
    };
}

/**
 * Every FBA listing in the marketplace, with its FNSKU. Walks the FBA Inventory
 * summaries to the last page — with no SKU or date filter the API returns all
 * of them, which is what a whole-catalogue sync wants.
 *
 * @example
 * const listings = await fetchFbaInventory(ctx, progress);
 * // [{ sku: 'CS-UNO', fnsku: 'X001UNO000', asin: 'B0UNO00000', condition: 'NewItem', productName: '…' }, …]
 */
export async function fetchFbaInventory(
    ctx: AmazonCtx,
    progress?: ProgressReporter,
    options: FetchOptions = {}
): Promise<AmazonListing[]> {
    const sleep = sleeper(options);
    const accessToken = await getAmazonAccessToken(ctx);
    const base = amazonApiBase(ctx);
    const marketplaceId = ctx.env.AMAZON_MARKETPLACE_ID;

    const listings: AmazonListing[] = [];
    let nextToken: string | null = null;

    do {
        const params = new URLSearchParams({
            granularityType: 'Marketplace',
            granularityId: marketplaceId,
            marketplaceIds: marketplaceId,
        });
        if (nextToken) params.set('nextToken', nextToken);

        const page = await amazonGet<InventorySummariesResponse>(
            `${base}/fba/inventory/v1/summaries?${params.toString()}`,
            accessToken,
            'FBA inventory',
            sleep
        );

        for (const summary of page.payload?.inventorySummaries ?? []) {
            const listing = toListing(summary);
            if (listing) listings.push(listing);
        }
        progress?.set({ message: `Fetched ${listings.length} FBA listings from Amazon…` });

        nextToken = page.pagination?.nextToken ?? null;
        if (nextToken) await sleep(PAGE_PAUSE_MS);
    } while (nextToken);

    return listings;
}

/**
 * One product's FBA listing, looked up by seller SKU. The summaries endpoint
 * takes a `sellerSkus` filter, so this is a single call instead of a walk of
 * the whole catalogue — what the per-product subscriber needs.
 *
 * Returns null when Amazon holds no FBA listing for the SKU. That is the
 * ordinary answer for a product that is not on Amazon, or not sent to FBA yet,
 * and not an error: unlike Takealot's by-SKU endpoint the API answers 200 with
 * an empty summary list rather than 404.
 *
 * @example
 * await fetchFbaListingBySku(ctx, 'CS-UNO');
 * // { sku: 'CS-UNO', fnsku: 'X001UNO000', asin: 'B0UNO00000', condition: 'NewItem', productName: '…' }
 */
export async function fetchFbaListingBySku(
    ctx: AmazonCtx,
    sku: string,
    options: FetchOptions = {}
): Promise<AmazonListing | null> {
    const sleep = sleeper(options);
    const accessToken = await getAmazonAccessToken(ctx);
    const marketplaceId = ctx.env.AMAZON_MARKETPLACE_ID;

    const params = new URLSearchParams({
        granularityType: 'Marketplace',
        granularityId: marketplaceId,
        marketplaceIds: marketplaceId,
        sellerSkus: sku,
    });

    const page = await amazonGet<InventorySummariesResponse>(
        `${amazonApiBase(ctx)}/fba/inventory/v1/summaries?${params.toString()}`,
        accessToken,
        'FBA inventory',
        sleep
    );

    // The filter is Amazon's, but match again here: a summary for a different
    // SKU must never be stored as this product's code.
    const wanted = sku.trim();
    for (const summary of page.payload?.inventorySummaries ?? []) {
        const listing = toListing(summary);
        if (listing?.sku === wanted) return listing;
    }
    return null;
}

/**
 * Whether the listing is set up to scan the manufacturer barcode: Amazon
 * reports such a listing's FNSKU as its ASIN. The fulfilment centre scans the
 * product's own EAN/UPC and no FNSKU label goes on those units, so the ASIN is
 * never stored as the product's Amazon code.
 */
export function usesManufacturerBarcode(listing: AmazonListing): boolean {
    const fnsku = listing.fnsku.trim();
    return fnsku.length > 0 && fnsku === listing.asin.trim();
}

/**
 * Whether a listing's condition is Amazon's New. The API writes it as
 * `NewItem`, `NewWithWarranty`, `NewOEM`, `NewOpenBox`; anything starting with
 * "new" counts.
 *
 * @example
 * isNewCondition('NewItem')     // true
 * isNewCondition('UsedLikeNew') // false
 */
export function isNewCondition(condition: string): boolean {
    return /^new/i.test(condition.trim());
}

// ─── Plan ───────────────────────────────────────────────────────────────────

export interface AmazonFnskuPlan extends ChannelCodeSyncPlan {
    // SKUs whose FNSKU is their ASIN. Amazon does that for a listing set up to
    // use the manufacturer barcode: the fulfilment centre scans the product's
    // own EAN/UPC and no FNSKU label goes on those units, so an ASIN is never
    // stored as the product's Amazon code. Any code already stored is kept.
    manufacturerBarcodeSkus: string[];
    // SKUs Amazon lists in a condition other than New. Their FNSKU is still
    // synced, but the label spec prints one fixed condition for the whole
    // channel, so a used or refurbished unit would be labelled "New".
    nonNewConditions: { sku: string; condition: string }[];
}

/**
 * Read-only diff of Amazon's FNSKUs against the stored Amazon codes. Only the
 * Amazon channel's rows are read; nothing is deleted. See channelCodeSync for
 * the shared rules.
 */
export async function computeAmazonFnskuPlan(listings: AmazonListing[]): Promise<AmazonFnskuPlan> {
    const manufacturerBarcode = new Set<string>();
    const nonNewConditions: { sku: string; condition: string }[] = [];

    const entries: ChannelCodeEntry[] = listings.map((listing) => {
        const fnsku = listing.fnsku.trim();
        const manufacturer = usesManufacturerBarcode(listing);
        if (manufacturer) manufacturerBarcode.add(listing.sku);
        if (listing.condition && !isNewCondition(listing.condition)) {
            nonNewConditions.push({ sku: listing.sku, condition: listing.condition });
        }
        // Handed over with an empty code so the SKU still counts as listed on
        // Amazon — it must not show up as "not on Amazon".
        return { sku: listing.sku, code: manufacturer ? '' : fnsku };
    });

    const plan = await planChannelCodeSync(AMAZON_CHANNEL_NAME, 'Amazon', entries);

    return {
        ...plan,
        // Those SKUs have their own note; they are not "missing an FNSKU".
        skusWithoutCode: plan.skusWithoutCode.filter((sku) => !manufacturerBarcode.has(sku)),
        manufacturerBarcodeSkus: [...manufacturerBarcode].sort(),
        nonNewConditions,
    };
}

/**
 * Whether the Amazon channel has an enabled label spec — the difference
 * between "codes captured" and "labels printable". The sync surfaces this so
 * a first run does not end with codes on every product and nothing to print.
 */
export async function amazonLabelSpecExists(): Promise<boolean> {
    const channels = await models.channel.findMany({ where: { name: { equals: AMAZON_CHANNEL_NAME } } });
    if (channels.length === 0) return false;
    const specs = await models.channelLabelSpec.findMany({
        where: { channelId: channels[0].id, isEnabled: { equals: true } },
    });
    return specs.length > 0;
}

// ─── Single-product sync (subscriber path) ──────────────────────────────────

export type ProductFnskuSyncOutcome =
    | { outcome: 'created'; fnsku: string }
    | { outcome: 'updated'; fnsku: string }
    | { outcome: 'unchanged'; fnsku: string }
    | { outcome: 'no_listing' }
    | { outcome: 'no_fnsku' }
    | { outcome: 'manufacturer_barcode' };

/**
 * Fetch one product's FBA listing and upsert its Amazon channel code. Used by
 * the syncAmazonFnsku subscriber; the flow and the scheduled sweep use the
 * plan/apply pair above rather than one lookup per product.
 *
 * Follows the same rules as the plan, so the two paths can never disagree:
 * only the Amazon channel's row is touched, and a listing with no FNSKU or one
 * on the manufacturer barcode leaves any stored code alone rather than
 * blanking it.
 */
export async function syncProductFnskuFromAmazon(
    ctx: AmazonCtx,
    product: { id: string; sku: string },
    options: FetchOptions = {}
): Promise<ProductFnskuSyncOutcome> {
    const listing = await fetchFbaListingBySku(ctx, product.sku, options);
    if (!listing) return { outcome: 'no_listing' };

    if (usesManufacturerBarcode(listing)) return { outcome: 'manufacturer_barcode' };

    const fnsku = listing.fnsku.trim();
    if (!fnsku) return { outcome: 'no_fnsku' };

    const channel = await getOrCreateChannel(AMAZON_CHANNEL_NAME, new Map());
    const existing = await models.productChannelCode.findMany({
        where: { productId: product.id, channelId: channel.id },
    });

    if (existing.length === 0) {
        await models.productChannelCode.create({ productId: product.id, channelId: channel.id, code: fnsku });
        return { outcome: 'created', fnsku };
    }

    if (existing[0].code !== fnsku) {
        await models.productChannelCode.update({ id: existing[0].id }, { code: fnsku });
        return { outcome: 'updated', fnsku };
    }

    return { outcome: 'unchanged', fnsku };
}
