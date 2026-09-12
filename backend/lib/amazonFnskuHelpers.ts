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
import { ProgressReporter } from './progress';

// Reads each FBA listing's FNSKU from the Amazon Selling Partner API into the
// product's Amazon ProductChannelCode row (docs/amazon-fnskus.md). Listings are
// matched to products by seller SKU. The SyncAmazonFnskus flow is the one entry
// point; it runs on the same plan → review → apply core as the Takealot sync
// (channelCodeSync).
//
// Two calls per sync: a Login with Amazon token exchange, then the FBA
// Inventory summaries listing paged to the end. Neither touches the shared
// Zoho quota.
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
            const sku = summary.sellerSku?.trim();
            if (!sku) continue;
            listings.push({
                sku,
                fnsku: summary.fnSku?.trim() ?? '',
                asin: summary.asin?.trim() ?? '',
                condition: summary.condition?.trim() ?? '',
                productName: summary.productName?.trim() ?? '',
            });
        }
        progress?.set({ message: `Fetched ${listings.length} FBA listings from Amazon…` });

        nextToken = page.pagination?.nextToken ?? null;
        if (nextToken) await sleep(PAGE_PAUSE_MS);
    } while (nextToken);

    return listings;
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
        const usesManufacturerBarcode = fnsku.length > 0 && fnsku === listing.asin.trim();
        if (usesManufacturerBarcode) manufacturerBarcode.add(listing.sku);
        if (listing.condition && !isNewCondition(listing.condition)) {
            nonNewConditions.push({ sku: listing.sku, condition: listing.condition });
        }
        // Handed over with an empty code so the SKU still counts as listed on
        // Amazon — it must not show up as "not on Amazon".
        return { sku: listing.sku, code: usesManufacturerBarcode ? '' : fnsku };
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
