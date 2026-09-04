// The Takealot side of channel shipment syncing: fetch consignments from the
// Marketplace API and normalise them into the channel-generic shape in
// channelShipmentHelpers. Nothing here touches the database — the generic
// planner does that — so an adapter for another platform only has to produce
// the same `ExternalShipment[]`.
//
// See docs/channel-shipments.md.

import { ChannelShipmentStatus } from '@teamkeel/sdk';
import { TakealotCtx } from './takealotOfferHelpers';
import {
    ExternalShipment,
    ExternalShipmentItem,
    ShipmentFetchOptions,
} from './channelShipmentHelpers';
import { ProgressReporter } from './progress';

// ─── API shapes ─────────────────────────────────────────────────────────────

// One line of a shipment. Note what is *not* here: a SKU. Takealot identifies
// the line by `offer_id` only, so resolving it to one of our products takes a
// second lookup against the offers endpoint — see fetchOfferSkuIndex.
export interface TakealotShipmentItem {
    shipment_item_id?: number | null;
    offer_id?: number | null;
    cancelled?: boolean | null;
    quantity_required?: number | null;
    quantity_sending?: number | null;
}

export interface TakealotShipment {
    shipment_id?: number | null;
    reference?: string | null;
    // The fulfilment centre's region, e.g. "JHB" / "CPT".
    destination_region?: string | null;
    shipped?: boolean | null;
    cancelled?: boolean | null;
    archived?: boolean | null;
    due_date?: string | null;
    created_at?: string | null;
    // Set once the FC has unloaded the consignment — our "received".
    date_unloaded?: string | null;
    // Takealot's own wording for where the shipment is in its process.
    purchase_order_state?: string | null;
    tracking_info?: string | null;
    shipment_items?: TakealotShipmentItem[] | null;
}

interface TakealotShipmentsPage {
    items?: TakealotShipment[];
    continuation_token?: string | null;
}

interface TakealotOfferIndexEntry {
    offer_id?: number | null;
    sku?: string | null;
}

interface TakealotOfferIndexPage {
    items?: TakealotOfferIndexEntry[];
    continuation_token?: string | null;
}

// ─── Fetch ──────────────────────────────────────────────────────────────────

// Both endpoints cap `limit` at 1000, so a season of consignments is a handful
// of requests.
const PAGE_LIMIT = 1000;

// How many ids to put in one `shipment_id__in` query. Keeps the URL well clear
// of any gateway length limit when a lot of consignments are being tracked.
const ID_BATCH = 100;

function apiBase(ctx: TakealotCtx): string {
    return ctx.env.TAKEALOT_API_BASE_URL.replace(/\/$/, '');
}

function apiHeaders(ctx: TakealotCtx): Record<string, string> {
    return {
        'X-API-Key': ctx.secrets.TAKEALOT_API_KEY,
        'Content-Type': 'application/json',
    };
}

async function getJson<T>(ctx: TakealotCtx, url: string, what: string): Promise<T> {
    const response = await fetch(url, { method: 'GET', headers: apiHeaders(ctx) });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to fetch Takealot ${what}: ${response.status} - ${errorText}`);
    }
    return (await response.json()) as T;
}

/**
 * Every shipment, newest first, with its lines expanded.
 *
 * `expands=shipment_items` is what makes this one request per page rather than
 * one per shipment — without it the listing returns headers only and each
 * shipment's lines would need a separate call.
 *
 * `includeArchived` is false by default: Takealot keeps consignments forever and
 * the day-to-day question is about live ones. The flow offers it for a full
 * backfill.
 */
export async function fetchShipments(
    ctx: TakealotCtx,
    options: ShipmentFetchOptions = {},
    progress?: ProgressReporter
): Promise<TakealotShipment[]> {
    let query = `limit=${PAGE_LIMIT}&expands=shipment_items&order_by=-shipment_id`;
    // Filter server-side rather than pulling everything and discarding: Takealot
    // keeps every consignment forever, and only the ones still to go out need
    // labelling. `shipped=false` covers Takealot's draft and confirmed states.
    if (!options.includeShipped) query += '&shipped=false';

    const shipments = await fetchShipmentPages(ctx, query, progress);

    const byId = new Map<number, TakealotShipment>();
    for (const shipment of shipments) {
        if (shipment.shipment_id !== null && shipment.shipment_id !== undefined) {
            byId.set(shipment.shipment_id, shipment);
        }
    }

    // Anything we already track that the filter above excluded still has to be
    // refreshed — otherwise a consignment that shipped since the last sync would
    // sit at "Open" here forever.
    const missing = (options.alsoFetchIds ?? [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && !byId.has(id));

    if (missing.length > 0) {
        progress?.set({ message: `Refreshing ${missing.length} tracked shipment(s)…` });
        for (const batch of chunk(missing, ID_BATCH)) {
            const ids = batch.map((id) => `&shipment_id__in=${id}`).join('');
            const refreshed = await fetchShipmentPages(
                ctx,
                `limit=${PAGE_LIMIT}&expands=shipment_items${ids}`,
                progress
            );
            for (const shipment of refreshed) {
                if (shipment.shipment_id !== null && shipment.shipment_id !== undefined) {
                    byId.set(shipment.shipment_id, shipment);
                }
            }
        }
    }

    const all = [...byId.values()];
    return options.includeArchived ? all : all.filter((s) => !s.archived);
}

// Walk one listing query's pages to exhaustion.
async function fetchShipmentPages(
    ctx: TakealotCtx,
    query: string,
    progress?: ProgressReporter
): Promise<TakealotShipment[]> {
    const shipments: TakealotShipment[] = [];
    let continuationToken: string | null = null;

    do {
        let url = `${apiBase(ctx)}/v1/shipments?${query}`;
        if (continuationToken) url += `&continuation_token=${encodeURIComponent(continuationToken)}`;

        const page = await getJson<TakealotShipmentsPage>(ctx, url, 'shipments');
        shipments.push(...(page.items ?? []));
        progress?.set({ message: `Fetched ${shipments.length} shipments from Takealot…` });

        continuationToken = page.continuation_token ?? null;
    } while (continuationToken);

    return shipments;
}

const chunk = <T>(items: T[], size: number): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
};

/**
 * offer_id → SKU for the whole catalogue, so shipment lines can be resolved to
 * products by SKU — the same matching rule the barcode sync uses.
 *
 * `fields=offer_id,sku` keeps this small: it is an index, not the offers
 * themselves, so unlike fetchAllOffers (which needs whole objects for
 * `product_label`) it can be trimmed hard.
 *
 * @example
 * const skuByOfferId = await fetchOfferSkuIndex(ctx);
 * skuByOfferId.get('12345') // 'ACME-001'
 */
export async function fetchOfferSkuIndex(
    ctx: TakealotCtx,
    progress?: ProgressReporter
): Promise<Map<string, string>> {
    const index = new Map<string, string>();
    let continuationToken: string | null = null;

    do {
        let url = `${apiBase(ctx)}/v1/offers?limit=${PAGE_LIMIT}&fields=offer_id&fields=sku`;
        if (continuationToken) url += `&continuation_token=${encodeURIComponent(continuationToken)}`;

        const page = await getJson<TakealotOfferIndexPage>(ctx, url, 'offers');
        for (const entry of page.items ?? []) {
            const offerId = entry.offer_id;
            const sku = entry.sku?.trim();
            if (offerId === null || offerId === undefined || !sku) continue;
            index.set(String(offerId), sku);
        }
        progress?.set({ message: `Indexed ${index.size} Takealot offers…` });

        continuationToken = page.continuation_token ?? null;
    } while (continuationToken);

    return index;
}

// ─── Normalise ──────────────────────────────────────────────────────────────

/**
 * Map Takealot's shipment state onto the shared vocabulary.
 *
 * Order matters: a cancelled consignment can also be flagged shipped, and one
 * that has been unloaded is always flagged shipped too, so the most advanced
 * state has to win. `date_unloaded` is the only positive signal that the stock
 * actually reached the fulfilment centre.
 *
 * @example
 * takealotStatus({ shipped: true, date_unloaded: '2026-08-01T09:00:00Z' }) // Received
 */
export function takealotStatus(shipment: TakealotShipment): ChannelShipmentStatus {
    if (shipment.cancelled) return ChannelShipmentStatus.Cancelled;
    if (shipment.date_unloaded) return ChannelShipmentStatus.Received;
    if (shipment.shipped) return ChannelShipmentStatus.Shipped;
    return ChannelShipmentStatus.Open;
}

// Normalise Takealot's date strings to ISO 8601, which is the transport shape
// ExternalShipment uses. A blank or unparseable value becomes null rather than
// an Invalid Date that would fail the write much later.
function parseDate(value: string | null | undefined): string | null {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// The calendar-date half of a channel value, for fields that mean a day rather
// than an instant. Takealot sends `due_date` as YYYY-MM-DD already; the slice
// also copes if it ever starts sending a full timestamp.
function parseDateOnly(value: string | null | undefined): string | null {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(value ?? '');
    return match ? match[1] : null;
}

/**
 * Turn Takealot's payload into the channel-generic shape.
 *
 * `skuByOfferId` resolves each line's `offer_id`; a line whose offer is not in
 * the index keeps its `listingRef` and comes through with a null SKU, so the
 * planner records it as unmatched rather than silently dropping units from the
 * consignment.
 */
export function toExternalShipments(
    shipments: TakealotShipment[],
    skuByOfferId: Map<string, string>
): ExternalShipment[] {
    const external: ExternalShipment[] = [];

    for (const shipment of shipments) {
        const shipmentId = shipment.shipment_id;
        // No id means nothing to key the upsert on — skip rather than mint a row
        // that the next sync would duplicate.
        if (shipmentId === null || shipmentId === undefined) continue;

        const items: ExternalShipmentItem[] = [];
        for (const item of shipment.shipment_items ?? []) {
            const itemId = item.shipment_item_id;
            if (itemId === null || itemId === undefined) continue;

            const listingRef =
                item.offer_id === null || item.offer_id === undefined ? null : String(item.offer_id);

            items.push({
                externalId: String(itemId),
                listingRef,
                sku: listingRef ? (skuByOfferId.get(listingRef) ?? null) : null,
                quantityRequired: item.quantity_required ?? 0,
                quantitySending: item.quantity_sending ?? 0,
                cancelled: Boolean(item.cancelled),
            });
        }

        external.push({
            externalId: String(shipmentId),
            reference: shipment.reference?.trim() || null,
            status: takealotStatus(shipment),
            statusDescription: shipment.purchase_order_state?.trim() || null,
            destination: shipment.destination_region?.trim() || null,
            placedAt: parseDate(shipment.created_at),
            dueDate: parseDateOnly(shipment.due_date),
            receivedAt: parseDate(shipment.date_unloaded),
            trackingInfo: shipment.tracking_info?.trim() || null,
            isArchived: Boolean(shipment.archived),
            items,
        });
    }

    return external;
}

/**
 * The whole Takealot fetch: shipments, plus the offer index needed to name their
 * lines. The offer index is only fetched when at least one line actually needs
 * resolving, so a sync that finds no consignments costs one request.
 */
export async function fetchTakealotShipments(
    ctx: TakealotCtx,
    options: ShipmentFetchOptions = {},
    progress?: ProgressReporter
): Promise<ExternalShipment[]> {
    const shipments = await fetchShipments(ctx, options, progress);

    const needsOfferIndex = shipments.some((s) => (s.shipment_items ?? []).length > 0);
    const skuByOfferId = needsOfferIndex
        ? await fetchOfferSkuIndex(ctx, progress)
        : new Map<string, string>();

    return toExternalShipments(shipments, skuByOfferId);
}
