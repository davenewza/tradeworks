import { models } from '@teamkeel/sdk';
import { getOrCreateChannel } from './zohoSalesHelpers';
import { TAKEALOT_CHANNEL_NAME } from './zohoChannelFeeHelpers';
import { ProgressReporter } from './progress';

// Reads each offer's barcode from the Takealot Marketplace API into the
// product's Takealot ProductChannelCode row (docs/takealot-barcodes.md).
// Offers are matched to products by SKU. Two entry points share this module:
// the syncTakealotBarcode subscriber (one product, on create / SKU change) and
// the SyncTakealotBarcodes flow (whole catalogue via the paginated listing).

// ─── Types ──────────────────────────────────────────────────────────────────

// The subset of ctx needed for Takealot calls, satisfied by flow, function and
// subscriber contexts alike (mirrors ZohoFeeCtx).
export interface TakealotCtx {
    env: { TAKEALOT_API_BASE_URL: string };
    secrets: { TAKEALOT_API_KEY: string };
}

// The slice of a Marketplace API offer the barcode sync reads.
export interface TakealotOffer {
    sku?: string | null;
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

// Pull every offer via the paginated listing. fields= trims each offer to the
// two fields the sync reads; continuation_token walks the pages.
export async function fetchAllOffers(ctx: TakealotCtx, progress?: ProgressReporter): Promise<TakealotOffer[]> {
    const offers: TakealotOffer[] = [];
    let continuationToken: string | null = null;

    do {
        let url = `${apiBase(ctx)}/v1/offers?limit=1000&fields=sku,barcode`;
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

export interface BarcodeChange {
    sku: string;
    product: string;
    barcode: string;
    // The stored code being replaced; empty for a new code.
    replaces: string;
    change: 'New' | 'Update';
    productId: string;
}

export interface BarcodeSyncPlan {
    channelName: string;
    changes: BarcodeChange[];
    unchanged: number;
    // Offer SKUs with no matching product (run Sync Products first).
    offersWithoutProduct: string[];
    // Offers that matched a product but carry no barcode on Takealot.
    offersWithoutBarcode: string[];
    // Enabled products Takealot has no offer for — informational only.
    productsWithoutOffer: string[];
    warnings: string[];
}

// Read-only diff of Takealot's offer barcodes against the stored Takealot
// channel codes. Codes on other channels are never considered — an FNSKU on
// the Amazon channel is a different identifier, not a stale Takealot code —
// and nothing is ever deleted: an offer with no barcode, or a product with no
// offer, leaves any stored code alone and is surfaced in the plan instead.
export async function computeBarcodeSyncPlan(offers: TakealotOffer[]): Promise<BarcodeSyncPlan> {
    const warnings: string[] = [];

    // Normalise and de-duplicate offers by SKU (last occurrence wins, matching
    // the fee sync's convention for duplicate Zoho SKUs).
    const offerBySku = new Map<string, string>();
    for (const offer of offers) {
        const sku = offer.sku?.trim();
        if (!sku) continue;
        if (offerBySku.has(sku)) {
            warnings.push(`Duplicate SKU on Takealot: ${sku} — using the last occurrence`);
        }
        offerBySku.set(sku, offer.barcode?.trim() ?? '');
    }

    const products = await models.product.findMany();
    const productBySku = new Map(products.map((p) => [p.sku, p]));

    const channels = await models.channel.findMany({ where: { name: { equals: TAKEALOT_CHANNEL_NAME } } });
    const channel = channels.length > 0 ? channels[0] : null;

    const existingRows = channel
        ? await models.productChannelCode.findMany({ where: { channelId: channel.id } })
        : [];
    const codeByProductId = new Map(existingRows.map((r) => [r.productId, r.code]));

    const changes: BarcodeChange[] = [];
    const offersWithoutProduct: string[] = [];
    const offersWithoutBarcode: string[] = [];
    let unchanged = 0;

    for (const [sku, barcode] of offerBySku) {
        const product = productBySku.get(sku);
        if (!product) {
            offersWithoutProduct.push(sku);
            continue;
        }
        if (!barcode) {
            offersWithoutBarcode.push(sku);
            continue;
        }

        const current = codeByProductId.get(product.id);
        if (current === barcode) {
            unchanged++;
            continue;
        }

        changes.push({
            sku,
            product: product.name,
            barcode,
            replaces: current ?? '',
            change: current !== undefined ? 'Update' : 'New',
            productId: product.id,
        });
    }

    const productsWithoutOffer = products
        .filter((p) => p.isEnabled && !offerBySku.has(p.sku))
        .map((p) => p.sku)
        .sort();

    return {
        channelName: TAKEALOT_CHANNEL_NAME,
        changes,
        unchanged,
        offersWithoutProduct,
        offersWithoutBarcode,
        productsWithoutOffer,
        warnings,
    };
}

// ─── Apply pass ─────────────────────────────────────────────────────────────

export interface BarcodeApplyResult {
    created: number;
    updated: number;
}

// Apply a barcode sync plan. Idempotent: rows are keyed on the unique
// [product, channel] pair — each product carries exactly one code per channel —
// so a step retry updates in place rather than duplicating.
export async function applyBarcodeSync(plan: BarcodeSyncPlan, progress?: ProgressReporter): Promise<BarcodeApplyResult> {
    const channel = await getOrCreateChannel(plan.channelName, new Map());

    let created = 0;
    let updated = 0;

    progress?.set({ current: 0, total: plan.changes.length, unit: 'codes', counter: 'count' });

    for (const change of plan.changes) {
        const existing = await models.productChannelCode.findMany({
            where: { productId: change.productId, channelId: channel.id },
        });

        if (existing.length > 0) {
            await models.productChannelCode.update({ id: existing[0].id }, { code: change.barcode });
            updated++;
        } else {
            await models.productChannelCode.create({
                productId: change.productId,
                channelId: channel.id,
                code: change.barcode,
            });
            created++;
        }

        progress?.increment();
        progress?.log(`${existing.length > 0 ? 'Updated' : 'Added'} barcode for ${change.sku} — ${change.product}`);
    }

    return { created, updated };
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

    const barcode = offer.barcode?.trim();
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
