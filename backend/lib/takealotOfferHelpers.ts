import { models } from '@teamkeel/sdk';
import { getOrCreateChannel } from './zohoSalesHelpers';
import { TAKEALOT_CHANNEL_NAME } from './zohoChannelFeeHelpers';
import { ProgressReporter } from './progress';
import { ChannelCodeEntry, ChannelCodeSyncPlan, planChannelCodeSync } from './channelCodeSync';

// Reads each offer's label barcode from the Takealot Marketplace API into the
// product's Takealot ProductChannelCode row (docs/takealot-barcodes.md).
// Offers are matched to products by SKU. Two entry points share this module:
// the syncTakealotBarcode subscriber (one product, on create / SKU change) and
// the SyncTakealotBarcodes flow (whole catalogue via the paginated listing).
// The flow's plan/apply pair is the channel-generic one in channelCodeSync,
// shared with the Amazon FNSKU import.

// ─── Types ──────────────────────────────────────────────────────────────────

// The subset of ctx needed for Takealot calls, satisfied by flow, function and
// subscriber contexts alike (mirrors ZohoFeeCtx).
export interface TakealotCtx {
    env: { TAKEALOT_API_BASE_URL: string };
    secrets: { TAKEALOT_API_KEY: string };
}

// The slice of a Marketplace API offer the barcode sync reads. An offer
// carries two barcode-like fields and they are not interchangeable.
export interface TakealotOffer {
    sku?: string | null;
    // The EAN-13 Takealot prints on its own Seller Portal unit-label sheets
    // (990-prefixed when Takealot minted it) — the code the fulfilment centre
    // scans, and the one this sync stores.
    product_label?: string | null;
    // The merchant-provided barcode. Takealot backfills offers listed without
    // one with an `MPTAL…`/`MPTALX…` placeholder, so it is deliberately never
    // stored: it is not what Takealot's own labels carry.
    barcode?: string | null;
}

interface TakealotOffersPage {
    items?: TakealotOffer[];
    continuation_token?: string | null;
}

// ─── Fetch ──────────────────────────────────────────────────────────────────

function apiBase(ctx: TakealotCtx): string {
    return ctx.env.TAKEALOT_API_BASE_URL.replace(/\/$/, '');
}

function apiHeaders(ctx: TakealotCtx): Record<string, string> {
    return {
        'X-API-Key': ctx.secrets.TAKEALOT_API_KEY,
        'Content-Type': 'application/json',
    };
}

// The barcode the sync stores for an offer: product_label, never barcode.
function labelBarcode(offer: TakealotOffer): string {
    return offer.product_label?.trim() ?? '';
}

// Look up the seller's offer for one SKU. Returns null on a 404 — the normal
// answer for a product not listed on Takealot, not an error.
export async function fetchOfferBySku(ctx: TakealotCtx, sku: string): Promise<TakealotOffer | null> {
    const url = `${apiBase(ctx)}/v1/offers/by_sku/${encodeURIComponent(sku)}`;

    const response = await fetch(url, { method: 'GET', headers: apiHeaders(ctx) });

    if (response.status === 404) return null;
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to fetch Takealot offer for SKU ${sku}: ${response.status} - ${errorText}`);
    }

    return (await response.json()) as TakealotOffer;
}

// Pull every offer via the paginated listing; continuation_token walks the
// pages. Full offer objects are requested — no fields= trimming — because
// product_label must be present and full payloads are only a few MB at this
// catalogue's scale.
export async function fetchAllOffers(ctx: TakealotCtx, progress?: ProgressReporter): Promise<TakealotOffer[]> {
    const offers: TakealotOffer[] = [];
    let continuationToken: string | null = null;

    do {
        let url = `${apiBase(ctx)}/v1/offers?limit=1000`;
        if (continuationToken) url += `&continuation_token=${encodeURIComponent(continuationToken)}`;

        const response = await fetch(url, { method: 'GET', headers: apiHeaders(ctx) });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to fetch Takealot offers: ${response.status} - ${errorText}`);
        }

        const page: TakealotOffersPage = await response.json();
        offers.push(...(page.items ?? []));
        progress?.set({ message: `Fetched ${offers.length} offers from Takealot…` });

        continuationToken = page.continuation_token ?? null;
    } while (continuationToken);

    return offers;
}

// ─── Plan pass ──────────────────────────────────────────────────────────────

/**
 * Read-only diff of Takealot's offer label barcodes against the stored
 * Takealot channel codes, via the shared plan in channelCodeSync: only the
 * Takealot channel's rows are considered, nothing is ever deleted, and an
 * offer with no label barcode or a product with no offer is surfaced in the
 * plan rather than acted on. Apply with applyChannelCodeSync.
 */
export async function computeBarcodeSyncPlan(offers: TakealotOffer[]): Promise<ChannelCodeSyncPlan> {
    const entries: ChannelCodeEntry[] = [];
    for (const offer of offers) {
        const sku = offer.sku?.trim();
        if (!sku) continue;
        entries.push({ sku, code: labelBarcode(offer) });
    }
    return await planChannelCodeSync(TAKEALOT_CHANNEL_NAME, 'Takealot', entries);
}

// ─── Single-product sync (subscriber path) ──────────────────────────────────

export type ProductBarcodeSyncOutcome =
    | { outcome: 'created'; barcode: string }
    | { outcome: 'updated'; barcode: string }
    | { outcome: 'unchanged'; barcode: string }
    | { outcome: 'no_offer' }
    | { outcome: 'no_barcode' };

// Fetch one product's Takealot offer and upsert its channel code. Used by the
// syncTakealotBarcode subscriber; the flow uses the plan/apply pair above
// rather than one lookup per product.
export async function syncProductBarcodeFromTakealot(
    ctx: TakealotCtx,
    product: { id: string; sku: string }
): Promise<ProductBarcodeSyncOutcome> {
    const offer = await fetchOfferBySku(ctx, product.sku);
    if (!offer) return { outcome: 'no_offer' };

    const barcode = labelBarcode(offer);
    if (!barcode) return { outcome: 'no_barcode' };

    const channel = await getOrCreateChannel(TAKEALOT_CHANNEL_NAME, new Map());
    const existing = await models.productChannelCode.findMany({
        where: { productId: product.id, channelId: channel.id },
    });

    if (existing.length === 0) {
        await models.productChannelCode.create({ productId: product.id, channelId: channel.id, code: barcode });
        return { outcome: 'created', barcode };
    }

    if (existing[0].code !== barcode) {
        await models.productChannelCode.update({ id: existing[0].id }, { code: barcode });
        return { outcome: 'updated', barcode };
    }

    return { outcome: 'unchanged', barcode };
}
