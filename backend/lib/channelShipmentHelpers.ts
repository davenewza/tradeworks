// Channel-generic syncing of inbound fulfilment-centre consignments.
//
// A platform adapter (lib/takealotShipmentHelpers today) turns that platform's
// payload into `ExternalShipment[]`; everything below is shared. The split is
// what keeps a second platform to one new file: nothing here knows what
// Takealot is, and nothing there touches the database.
//
// Two passes, matching the barcode sync's shape: a read-only `computeSyncPlan`
// the flow shows for review, then `applyShipmentSync`. See
// docs/channel-shipments.md.

import { models, ChannelShipmentStatus } from '@teamkeel/sdk';
import { getOrCreateChannel } from './zohoSalesHelpers';
import { ProgressReporter } from './progress';

// ─── The shape adapters produce ─────────────────────────────────────────────

// One line of a consignment, as the channel describes it. `sku` is the channel's
// SKU for the listing, which is how the line is matched to our catalogue — the
// same rule the barcode sync uses. It is nullable because a channel can name a
// line by its own listing id alone (Takealot does), and that id may not resolve.
export interface ExternalShipmentItem {
    externalId: string;
    listingRef: string | null;
    sku: string | null;
    quantityRequired: number;
    quantitySending: number;
    cancelled: boolean;
}

// Dates are ISO 8601 strings, not Date objects, because a plan built by an
// adapter is handed straight back through `ctx.step()` — which round-trips
// through JSON, so a Date would arrive at the apply pass as a string anyway.
// Keeping the transport shape honest means the conversion happens once, in
// toDate() below, rather than silently at the boundary.
export interface ExternalShipment {
    externalId: string;
    reference: string | null;
    status: ChannelShipmentStatus;
    statusDescription: string | null;
    destination: string | null;
    placedAt: string | null;
    // A calendar date (YYYY-MM-DD), not an instant — a consignment is due on a
    // day, and channels state it that way. Held as the bare date because a
    // Postgres date column round-trips as local midnight: parsing "2026-09-01"
    // as UTC and comparing instants would report a change on every sync in any
    // timezone east of UTC.
    dueDate: string | null;
    receivedAt: string | null;
    trackingInfo: string | null;
    isArchived: boolean;
    items: ExternalShipmentItem[];
}

/** An ISO string from an adapter as a Date, for writing or comparing. */
export function toDate(iso: string | null): Date | null {
    if (!iso) return null;
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * A YYYY-MM-DD calendar date as a Date at *local* midnight, which is what a
 * Postgres date column stores and hands back.
 *
 * @example
 * toCalendarDate('2026-09-01') // 2026-09-01T00:00 local
 */
export function toCalendarDate(dateOnly: string | null): Date | null {
    if (!dateOnly) return null;
    // No trailing Z: parsed in the local zone, so the calendar day is preserved
    // both on the way in and on the way back out.
    const parsed = new Date(`${dateOnly}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** A stored date column back as YYYY-MM-DD, read in the local zone. */
export function toDateOnly(date: Date | null): string | null {
    if (!date) return null;
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// The stored rows the comparison reads, taken from the generated model types so
// they cannot drift from the schema.
type StoredShipment = Awaited<ReturnType<typeof models.channelShipment.findMany>>[number];
type StoredShipmentItem = Awaited<ReturnType<typeof models.channelShipmentItem.findMany>>[number];

export interface ShipmentFetchOptions {
    // Pull consignments the channel has already dispatched. Off by default: the
    // reason to sync is to label what is still going out, and a channel keeps
    // every consignment it has ever had.
    includeShipped?: boolean;
    // Pull consignments the channel has archived as well. Off by default for the
    // same reason.
    includeArchived?: boolean;
    // Channel-side ids to fetch regardless of the filters above — see
    // openShipmentExternalIds.
    alsoFetchIds?: string[];
}

/**
 * The channel-side ids of consignments we track that have not finished.
 *
 * These are fetched even when the sync is filtered to unshipped consignments.
 * Without that, a shipment that has since been dispatched simply stops coming
 * back from the channel, and its stored row would sit at `Open` forever —
 * still offering to print labels for stock that has already gone.
 *
 * `Received` and `Cancelled` are terminal, so they drop out and stop costing a
 * lookup.
 */
export async function openShipmentExternalIds(channelName: string): Promise<string[]> {
    const channels = await models.channel.findMany({ where: { name: { equals: channelName } } });
    if (channels.length === 0) return [];

    const stored = await models.channelShipment.findMany({
        where: {
            channelId: channels[0].id,
            status: {
                oneOf: [ChannelShipmentStatus.Open, ChannelShipmentStatus.Shipped],
            },
        },
    });
    return stored.map((s) => s.externalId);
}

// ─── Plan pass ──────────────────────────────────────────────────────────────

// One consignment that needs writing, flattened for the review table. `shipment`
// rides along so the apply pass needs no second fetch; it is dropped from the
// displayed columns.
export interface ShipmentChange {
    externalId: string;
    reference: string;
    status: ChannelShipmentStatus;
    change: 'New' | 'Update';
    lines: number;
    units: number;
    // Lines on this consignment whose SKU matches no product here.
    unmatched: number;
    shipment: ExternalShipment;
}

export interface ShipmentSyncPlan {
    channelName: string;
    changes: ShipmentChange[];
    unchanged: number;
    // SKUs seen on shipment lines that match no product here — run Sync Products
    // first. Distinct, sorted.
    unmatchedSkus: string[];
    // Lines whose listing the channel could not name at all (no SKU behind the
    // listing id). Reported as listing refs, since that is all we have.
    unresolvedListings: string[];
    warnings: string[];
}

// Compare a stored timestamp against an adapter's ISO string.
const sameTime = (stored: Date | null, iso: string | null): boolean => {
    const incoming = toDate(iso);
    if (stored === null || incoming === null) return stored === incoming;
    return stored.getTime() === incoming.getTime();
};

// Compare a stored date column against an adapter's YYYY-MM-DD, by calendar day
// rather than by instant — see the note on ExternalShipment.dueDate.
const sameDay = (stored: Date | null, dateOnly: string | null): boolean =>
    toDateOnly(stored) === (dateOnly ?? null);

/**
 * Read-only diff of a channel's consignments against what is stored.
 *
 * Nothing is deleted at shipment level: a consignment the channel stops
 * returning (filtered out as archived, say) keeps its row and its history. Lines
 * *within* a synced consignment are a different matter — see applyShipmentSync.
 *
 * @example
 * const plan = await computeShipmentSyncPlan('Takealot Marketplace', external);
 * plan.changes.length // consignments to write
 */
export async function computeShipmentSyncPlan(
    channelName: string,
    external: ExternalShipment[]
): Promise<ShipmentSyncPlan> {
    const warnings: string[] = [];

    // De-duplicate by the channel's own id (last occurrence wins, matching the
    // barcode sync's convention for duplicate SKUs).
    const byExternalId = new Map<string, ExternalShipment>();
    for (const shipment of external) {
        if (byExternalId.has(shipment.externalId)) {
            warnings.push(
                `Duplicate shipment id from ${channelName}: ${shipment.externalId} — using the last occurrence`
            );
        }
        byExternalId.set(shipment.externalId, shipment);
    }

    const products = await models.product.findMany();
    const productBySku = new Map(products.map((p) => [p.sku, p.id]));

    const channels = await models.channel.findMany({ where: { name: { equals: channelName } } });
    const channel = channels.length > 0 ? channels[0] : null;

    const stored = channel
        ? await models.channelShipment.findMany({ where: { channelId: channel.id } })
        : [];
    const storedByExternalId = new Map(stored.map((s) => [s.externalId, s]));

    // Every stored line for the channel in one query, grouped by shipment. The
    // comparison below needs the lines of every shipment, so fetching them per
    // shipment would be a round trip each — hundreds of them on a full sync.
    const storedItems =
        stored.length > 0
            ? await models.channelShipmentItem.findMany({
                  where: { shipmentId: { oneOf: stored.map((s) => s.id) } },
              })
            : [];
    const itemsByShipmentId = new Map<string, typeof storedItems>();
    for (const item of storedItems) {
        const group = itemsByShipmentId.get(item.shipmentId);
        if (group) group.push(item);
        else itemsByShipmentId.set(item.shipmentId, [item]);
    }

    const changes: ShipmentChange[] = [];
    const unmatchedSkus = new Set<string>();
    const unresolvedListings = new Set<string>();
    let unchanged = 0;

    for (const shipment of byExternalId.values()) {
        let unmatched = 0;
        for (const item of shipment.items) {
            if (!item.sku) {
                unmatched++;
                if (item.listingRef) unresolvedListings.add(item.listingRef);
                continue;
            }
            if (!productBySku.has(item.sku)) {
                unmatched++;
                unmatchedSkus.add(item.sku);
            }
        }

        const existing = storedByExternalId.get(shipment.externalId);
        if (
            existing &&
            shipmentMatchesStored(
                shipment,
                existing,
                itemsByShipmentId.get(existing.id) ?? [],
                productBySku
            )
        ) {
            unchanged++;
            continue;
        }

        changes.push({
            externalId: shipment.externalId,
            reference: shipment.reference ?? '—',
            status: shipment.status,
            change: existing ? 'Update' : 'New',
            lines: shipment.items.length,
            units: shipment.items.reduce((sum, i) => sum + i.quantitySending, 0),
            unmatched,
            shipment,
        });
    }

    return {
        channelName,
        changes,
        unchanged,
        unmatchedSkus: [...unmatchedSkus].sort(),
        unresolvedListings: [...unresolvedListings].sort(),
        warnings,
    };
}

// Whether a stored consignment already says exactly what the channel says —
// header *and* every line. Compared in full rather than on a timestamp: channels
// do not reliably stamp a consignment when only a line quantity moves, and a
// missed quantity change would mean printing the wrong number of labels.
function shipmentMatchesStored(
    shipment: ExternalShipment,
    stored: StoredShipment,
    storedItems: StoredShipmentItem[],
    productBySku: Map<string, string>
): boolean {
    const headerMatches =
        stored.reference === shipment.reference &&
        stored.status === shipment.status &&
        stored.statusDescription === shipment.statusDescription &&
        stored.destination === shipment.destination &&
        stored.trackingInfo === shipment.trackingInfo &&
        stored.isArchived === shipment.isArchived &&
        sameTime(stored.placedAt, shipment.placedAt) &&
        sameDay(stored.dueDate, shipment.dueDate) &&
        sameTime(stored.receivedAt, shipment.receivedAt);

    if (!headerMatches) return false;
    if (storedItems.length !== shipment.items.length) return false;

    const storedByExternalId = new Map(storedItems.map((i) => [i.externalId, i]));
    return shipment.items.every((item) => {
        const storedItem = storedByExternalId.get(item.externalId);
        if (!storedItem) return false;
        return (
            storedItem.listingRef === item.listingRef &&
            storedItem.sku === item.sku &&
            storedItem.productId === (item.sku ? (productBySku.get(item.sku) ?? null) : null) &&
            storedItem.quantityRequired === item.quantityRequired &&
            storedItem.quantitySending === item.quantitySending &&
            storedItem.cancelled === item.cancelled
        );
    });
}

// ─── Apply pass ─────────────────────────────────────────────────────────────

export interface ShipmentApplyResult {
    created: number;
    updated: number;
    linesWritten: number;
    linesRemoved: number;
}

/**
 * Apply a shipment sync plan.
 *
 * Idempotent: shipments are keyed on the unique `[channel, externalId]` pair and
 * lines on `[shipment, externalId]`, so a retried step updates in place rather
 * than duplicating.
 *
 * Lines the channel no longer lists on a synced consignment *are* deleted — the
 * channel owns what is on its own consignment, and a stale line would otherwise
 * keep printing labels for units that are not going in.
 */
export async function applyShipmentSync(
    plan: ShipmentSyncPlan,
    progress?: ProgressReporter
): Promise<ShipmentApplyResult> {
    const channel = await getOrCreateChannel(plan.channelName, new Map());

    const products = await models.product.findMany();
    const productBySku = new Map(products.map((p) => [p.sku, p.id]));

    const result: ShipmentApplyResult = { created: 0, updated: 0, linesWritten: 0, linesRemoved: 0 };

    progress?.set({ current: 0, total: plan.changes.length, unit: 'shipments', counter: 'count' });

    for (const change of plan.changes) {
        const shipment = change.shipment;
        const fields = {
            reference: shipment.reference,
            status: shipment.status,
            statusDescription: shipment.statusDescription,
            destination: shipment.destination,
            placedAt: toDate(shipment.placedAt),
            dueDate: toCalendarDate(shipment.dueDate),
            receivedAt: toDate(shipment.receivedAt),
            trackingInfo: shipment.trackingInfo,
            isArchived: shipment.isArchived,
            synchronisedAt: new Date(),
        };

        const existing = await models.channelShipment.findMany({
            where: { channelId: channel.id, externalId: shipment.externalId },
        });

        let shipmentId: string;
        if (existing.length > 0) {
            shipmentId = existing[0].id;
            await models.channelShipment.update({ id: shipmentId }, fields);
            result.updated++;
        } else {
            const created = await models.channelShipment.create({
                channelId: channel.id,
                externalId: shipment.externalId,
                ...fields,
            });
            shipmentId = created.id;
            result.created++;
        }

        const storedItems = await models.channelShipmentItem.findMany({
            where: { shipmentId },
        });
        const storedByExternalId = new Map(storedItems.map((i) => [i.externalId, i]));

        for (const item of shipment.items) {
            const itemFields = {
                listingRef: item.listingRef,
                sku: item.sku,
                productId: item.sku ? (productBySku.get(item.sku) ?? null) : null,
                quantityRequired: item.quantityRequired,
                quantitySending: item.quantitySending,
                cancelled: item.cancelled,
            };

            const storedItem = storedByExternalId.get(item.externalId);
            if (storedItem) {
                await models.channelShipmentItem.update({ id: storedItem.id }, itemFields);
            } else {
                await models.channelShipmentItem.create({
                    shipmentId,
                    externalId: item.externalId,
                    ...itemFields,
                });
            }
            result.linesWritten++;
        }

        const stillListed = new Set(shipment.items.map((i) => i.externalId));
        for (const storedItem of storedItems) {
            if (stillListed.has(storedItem.externalId)) continue;
            await models.channelShipmentItem.delete({ id: storedItem.id });
            result.linesRemoved++;
        }

        progress?.increment();
        progress?.log(
            `${existing.length > 0 ? 'Updated' : 'Added'} shipment ${shipment.externalId}` +
                `${shipment.reference ? ` (${shipment.reference})` : ''} — ${shipment.items.length} line(s)`
        );
    }

    return result;
}
