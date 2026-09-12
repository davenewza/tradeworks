// The Amazon side of channel shipment syncing: fetch the consignments going
// into Amazon's fulfilment centres from the Fulfillment Inbound API and
// normalise them into the channel-generic shape in channelShipmentHelpers.
// Nothing here touches the database — the generic planner does that — so this
// sits alongside takealotShipmentHelpers rather than duplicating it.
//
// See docs/channel-shipments.md.
//
// Amazon's shape differs from Takealot's in three ways that drive everything
// below:
//   - a shipment is nested inside an **inbound plan** and is only addressable
//     as /inboundPlans/{planId}/shipments/{shipmentId}, so the plan id is kept
//     on the consignment as its `externalGroupId`;
//   - the line carries our own seller SKU (`msku`), so no offer index is
//     needed — and it carries the `fnsku` too, which is the code the unit
//     label has to show;
//   - there is no "not yet shipped" filter. `status=ACTIVE` on the plan
//     listing is the nearest thing, and it is combined with a last-updated
//     window below.

import { ChannelShipmentStatus } from '@teamkeel/sdk';
import {
    AmazonApiError,
    AmazonCtx,
    FetchOptions,
    PAGE_PAUSE_MS,
    amazonApiBase,
    amazonGet,
    getAmazonAccessToken,
    sleeper,
} from './amazonApi';
import {
    ExternalShipment,
    ExternalShipmentItem,
    ShipmentFetchOptions,
} from './channelShipmentHelpers';
import { ProgressReporter } from './progress';

// ─── API shapes ─────────────────────────────────────────────────────────────

// The slice of an inbound plan summary the listing gives us. Note it carries no
// shipments — those only appear on the plan itself, once a placement option has
// been confirmed.
export interface InboundPlanSummary {
    inboundPlanId?: string | null;
    name?: string | null;
    status?: string | null;
    createdAt?: string | null;
    lastUpdatedAt?: string | null;
    marketplaceIds?: string[] | null;
}

interface InboundPlansPage {
    inboundPlans?: InboundPlanSummary[] | null;
    pagination?: { nextToken?: string | null } | null;
}

export interface InboundPlan extends InboundPlanSummary {
    // Populated once a placement option is confirmed; a plan still being built
    // has none, and so has nothing to label yet.
    shipments?: { shipmentId?: string | null; status?: string | null }[] | null;
}

export interface AmazonShipment {
    shipmentId?: string | null;
    // The confirmed id that shows up on the shipment's own labels, e.g.
    // "FBA1234ABCD" — the reference an operator sees in Seller Central.
    shipmentConfirmationId?: string | null;
    name?: string | null;
    status?: string | null;
    destination?: {
        destinationType?: string | null;
        warehouseId?: string | null;
        address?: { city?: string | null } | null;
    } | null;
    dates?: { readyToShipWindow?: { start?: string | null } | null } | null;
    selectedDeliveryWindow?: { startDate?: string | null } | null;
    trackingDetails?: {
        spdTrackingDetail?: { spdTrackingItems?: { trackingId?: string | null }[] | null } | null;
        ltlTrackingDetail?: {
            billOfLadingNumber?: string | null;
            freightBillNumber?: string[] | null;
        } | null;
    } | null;
}

// One line of a shipment. Unlike Takealot's, it names our own SKU directly.
export interface AmazonShipmentItem {
    msku?: string | null;
    fnsku?: string | null;
    asin?: string | null;
    quantity?: number | null;
    // Who puts the unit label on: `SELLER` (us), `AMAZON` (Amazon does it, for
    // a fee) or `NONE` (the units carry the manufacturer's own barcode).
    labelOwner?: string | null;
    expiration?: string | null;
    manufacturingLotCode?: string | null;
}

interface ShipmentItemsPage {
    items?: AmazonShipmentItem[] | null;
    pagination?: { nextToken?: string | null } | null;
}

// ─── Fetch ──────────────────────────────────────────────────────────────────

const PATH = '/inbound/fba/2024-03-20/inboundPlans';

// The plan listing caps pageSize at 30; shipment items allow 1000.
const PLAN_PAGE_LIMIT = 30;
const ITEM_PAGE_LIMIT = 1000;

// How far back a plan's last update can be before the walk stops. Amazon gives
// the listing no date filter, and an inbound plan someone started and abandoned
// stays ACTIVE forever — without a cut-off every sync would walk years of them
// at 2 requests a second. The listing is sorted by last-updated descending, so
// the first plan past the window means every later one is too. Lifted entirely
// for a full-history run.
export const LOOKBACK_DAYS = 90;

// Plan statuses. ACTIVE is everything still in progress — the analogue of
// Takealot's `shipped=false`; the other two are only walked for a full history.
const ACTIVE_ONLY = ['ACTIVE'];
const ALL_STATUSES = ['ACTIVE', 'SHIPPED', 'VOIDED'];

/**
 * Every inbound plan worth looking at, newest-updated first.
 *
 * The API has no marketplace filter, so plans belonging to another marketplace
 * on the same seller account are dropped here — otherwise a seller listing in
 * several countries would pull consignments that are nothing to do with this
 * channel.
 */
export async function fetchInboundPlans(
    ctx: AmazonCtx,
    accessToken: string,
    options: ShipmentFetchOptions = {},
    fetchOptions: FetchOptions = {},
    progress?: ProgressReporter
): Promise<InboundPlanSummary[]> {
    const sleep = sleeper(fetchOptions);
    const base = amazonApiBase(ctx);
    const fullHistory = Boolean(options.includeShipped || options.includeArchived);
    const cutoff = fullHistory ? null : Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000;

    const plans: InboundPlanSummary[] = [];

    for (const status of fullHistory ? ALL_STATUSES : ACTIVE_ONLY) {
        let nextToken: string | null = null;
        let reachedCutoff = false;

        do {
            const params = new URLSearchParams({
                pageSize: String(PLAN_PAGE_LIMIT),
                status,
                sortBy: 'LAST_UPDATED_TIME',
                sortOrder: 'DESC',
            });
            if (nextToken) params.set('paginationToken', nextToken);

            const page = await amazonGet<InboundPlansPage>(
                `${base}${PATH}?${params.toString()}`,
                accessToken,
                'inbound plans',
                sleep
            );

            for (const plan of page.inboundPlans ?? []) {
                // The cutoff is judged before the marketplace filter: the sort
                // is by last-updated across every marketplace, so a plan from
                // another one still says the walk has gone far enough back.
                if (cutoff !== null && olderThan(plan.lastUpdatedAt, cutoff)) {
                    reachedCutoff = true;
                    continue;
                }
                if (!plan.inboundPlanId) continue;
                if (!(plan.marketplaceIds ?? []).includes(ctx.env.AMAZON_MARKETPLACE_ID)) continue;
                plans.push(plan);
            }
            progress?.set({ message: `Found ${plans.length} Amazon inbound plan(s)…` });

            nextToken = reachedCutoff ? null : (page.pagination?.nextToken ?? null);
            if (nextToken) await sleep(PAGE_PAUSE_MS);
        } while (nextToken);
    }

    return plans;
}

// Whether a plan's last-updated stamp falls outside the window. An unparseable
// or absent stamp is treated as in-window: dropping a plan because Amazon sent
// a date we could not read would silently lose a consignment.
function olderThan(lastUpdatedAt: string | null | undefined, cutoff: number): boolean {
    if (!lastUpdatedAt) return false;
    const parsed = new Date(lastUpdatedAt);
    return !Number.isNaN(parsed.getTime()) && parsed.getTime() < cutoff;
}

/** One inbound plan, which is the only place its shipment ids are listed. */
export async function fetchInboundPlan(
    ctx: AmazonCtx,
    accessToken: string,
    inboundPlanId: string,
    fetchOptions: FetchOptions = {}
): Promise<InboundPlan> {
    return await amazonGet<InboundPlan>(
        `${amazonApiBase(ctx)}${PATH}/${encodeURIComponent(inboundPlanId)}`,
        accessToken,
        `inbound plan ${inboundPlanId}`,
        sleeper(fetchOptions)
    );
}

/** One shipment's header — destination, dates, tracking and confirmed id. */
export async function fetchShipment(
    ctx: AmazonCtx,
    accessToken: string,
    inboundPlanId: string,
    shipmentId: string,
    fetchOptions: FetchOptions = {}
): Promise<AmazonShipment> {
    return await amazonGet<AmazonShipment>(
        `${amazonApiBase(ctx)}${PATH}/${encodeURIComponent(inboundPlanId)}/shipments/${encodeURIComponent(shipmentId)}`,
        accessToken,
        `shipment ${shipmentId}`,
        sleeper(fetchOptions)
    );
}

/** Every line of one shipment, paged to the end. */
export async function fetchShipmentItems(
    ctx: AmazonCtx,
    accessToken: string,
    inboundPlanId: string,
    shipmentId: string,
    fetchOptions: FetchOptions = {}
): Promise<AmazonShipmentItem[]> {
    const sleep = sleeper(fetchOptions);
    const base = amazonApiBase(ctx);
    const items: AmazonShipmentItem[] = [];
    let nextToken: string | null = null;

    do {
        const params = new URLSearchParams({ pageSize: String(ITEM_PAGE_LIMIT) });
        if (nextToken) params.set('paginationToken', nextToken);

        const page = await amazonGet<ShipmentItemsPage>(
            `${base}${PATH}/${encodeURIComponent(inboundPlanId)}/shipments/${encodeURIComponent(shipmentId)}/items?${params.toString()}`,
            accessToken,
            `items of shipment ${shipmentId}`,
            sleep
        );
        items.push(...(page.items ?? []));

        nextToken = page.pagination?.nextToken ?? null;
        if (nextToken) await sleep(PAGE_PAUSE_MS);
    } while (nextToken);

    return items;
}

// ─── Normalise ──────────────────────────────────────────────────────────────

/**
 * Map Amazon's shipment state onto the shared vocabulary.
 *
 * `DELIVERED` is deliberately *not* `Received`: `Received` is terminal here, so
 * treating "the carrier dropped it off" as received would stop the consignment
 * being refreshed before the fulfilment centre had actually checked it in.
 * `Received` is reserved for the states where the centre has the stock.
 *
 * An unrecognised state falls back to `Open`, which keeps the consignment
 * visible and refreshing rather than quietly retiring it.
 *
 * @example
 * amazonStatus('READY_TO_SHIP') // Open
 * amazonStatus('CHECKED_IN')    // Received
 */
export function amazonStatus(status: string | null | undefined): ChannelShipmentStatus {
    switch ((status ?? '').trim().toUpperCase()) {
        case 'CANCELLED':
        case 'ABANDONED':
        case 'DELETED':
            return ChannelShipmentStatus.Cancelled;
        case 'CHECKED_IN':
        case 'RECEIVING':
        case 'CLOSED':
            return ChannelShipmentStatus.Received;
        case 'SHIPPED':
        case 'IN_TRANSIT':
        case 'DELIVERED':
        // Boxes of the one consignment sitting in different states. Something
        // has moved, and it is not finished, so it reads as shipped.
        case 'MIXED':
            return ChannelShipmentStatus.Shipped;
        default:
            return ChannelShipmentStatus.Open;
    }
}

// A voided plan takes its shipments with it, whatever they each say.
const isVoidedPlan = (plan: InboundPlanSummary): boolean =>
    (plan.status ?? '').trim().toUpperCase() === 'VOIDED';

// An ISO timestamp's calendar-date half, which is the transport shape for a
// field that means a day rather than an instant.
function parseDateOnly(value: string | null | undefined): string | null {
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(value ?? '');
    return match ? match[1] : null;
}

// Normalise a date string to ISO 8601. A blank or unparseable value becomes
// null rather than an Invalid Date that would fail the write much later.
function parseDate(value: string | null | undefined): string | null {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// How many tracking ids to name before summarising. A small-parcel consignment
// carries one per box, and a hundred of them is not a useful field.
const TRACKING_SHOWN = 5;

/**
 * A shipment's tracking as one readable line.
 *
 * Small parcel gives one tracking id per box, so those are capped; less-than-
 * truckload gives a bill of lading and freight bill numbers instead.
 */
export function amazonTracking(shipment: AmazonShipment): string | null {
    const ltl = shipment.trackingDetails?.ltlTrackingDetail;
    const parts: string[] = [];

    if (ltl?.billOfLadingNumber?.trim()) parts.push(`BOL ${ltl.billOfLadingNumber.trim()}`);
    const freight = (ltl?.freightBillNumber ?? []).map((n) => n?.trim()).filter(Boolean);
    if (freight.length > 0) parts.push(`Freight bill ${freight.join(', ')}`);

    const spd = (shipment.trackingDetails?.spdTrackingDetail?.spdTrackingItems ?? [])
        .map((item) => item.trackingId?.trim())
        .filter((id): id is string => Boolean(id));
    if (spd.length > 0) {
        const shown = spd.slice(0, TRACKING_SHOWN).join(', ');
        parts.push(spd.length > TRACKING_SHOWN ? `${shown}, … (${spd.length} boxes)` : shown);
    }

    return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Where the consignment is going, as a fulfilment centre code.
 *
 * A plan whose placement Amazon has yet to optimise names no warehouse; the
 * destination city stands in where there is one, and otherwise the field is
 * left blank rather than filled with "AMAZON_OPTIMIZED", which says nothing.
 */
export function amazonDestination(shipment: AmazonShipment): string | null {
    const warehouse = shipment.destination?.warehouseId?.trim();
    if (warehouse) return warehouse;
    return shipment.destination?.address?.city?.trim() || null;
}

/**
 * Turn one shipment's lines into the channel-generic shape, one entry per SKU.
 *
 * Amazon returns *item packages*, so the same MSKU can appear more than once —
 * necessarily so when the units have different expiry dates or lot codes, which
 * cannot share a box. Those are summed into one line per key, because a label
 * run cares about the total units of a SKU going in, not how they are boxed.
 *
 * `quantityRequired` and `quantitySending` are both the quantity: Amazon draws
 * no distinction between what was asked for and what is being sent — the
 * shipment *is* what we are sending.
 */
export function toExternalItems(items: AmazonShipmentItem[]): ExternalShipmentItem[] {
    const byKey = new Map<string, ExternalShipmentItem>();

    for (const item of items) {
        const sku = item.msku?.trim();
        // Nothing to key the line on and nothing to match — Amazon should never
        // send this, but a line minted from it would duplicate on every sync.
        if (!sku) continue;

        const fnsku = item.fnsku?.trim() ?? '';
        const asin = item.asin?.trim() ?? '';
        // Amazon reports the FNSKU *as* the ASIN for a listing set to use the
        // manufacturer barcode; storing that as the product's code would print a
        // label nobody wants, so it is refused here exactly as the FNSKU sync
        // refuses it.
        const code = fnsku && fnsku !== asin ? fnsku : null;

        // Units of one SKU with different expiry or lot codes come back as
        // separate packages, so those are part of the line's identity.
        const key = [sku, item.expiration?.trim() ?? '', item.manufacturingLotCode?.trim() ?? '']
            .filter(Boolean)
            .join('|');

        const quantity = item.quantity ?? 0;
        const existing = byKey.get(key);
        if (existing) {
            existing.quantityRequired += quantity;
            existing.quantitySending += quantity;
            continue;
        }

        byKey.set(key, {
            externalId: key,
            // The FNSKU is what identifies the line's units in the fulfilment
            // network and is the code its label carries, so it is the useful
            // thing to keep; the ASIN stands in for a manufacturer-barcode
            // listing, which has no FNSKU of its own.
            listingRef: fnsku || asin || null,
            sku,
            quantityRequired: quantity,
            quantitySending: quantity,
            // Amazon's inbound API has no per-line cancellation — a shipment is
            // cancelled whole.
            cancelled: false,
            // Anything but SELLER means the unit label is not ours to print:
            // AMAZON applies it for a fee, NONE means the manufacturer barcode.
            labelledByChannel: (item.labelOwner ?? 'SELLER').trim().toUpperCase() !== 'SELLER',
            code,
        });
    }

    return [...byKey.values()];
}

/**
 * Turn one plan's shipment into the channel-generic shape.
 *
 * The plan is needed as well as the shipment: it carries the creation date (a
 * shipment has none of its own) and the voided state that overrides whatever
 * its shipments say.
 */
export function toExternalShipment(
    plan: InboundPlanSummary,
    shipment: AmazonShipment,
    items: AmazonShipmentItem[]
): ExternalShipment | null {
    const shipmentId = shipment.shipmentId?.trim();
    const planId = plan.inboundPlanId?.trim();
    // No id means nothing to key the upsert on — skip rather than mint a row
    // the next sync would duplicate.
    if (!shipmentId || !planId) return null;

    return {
        externalId: shipmentId,
        externalGroupId: planId,
        reference: shipment.shipmentConfirmationId?.trim() || shipment.name?.trim() || null,
        status: isVoidedPlan(plan) ? ChannelShipmentStatus.Cancelled : amazonStatus(shipment.status),
        // Amazon's own wording is SCREAMING_SNAKE, kept as sent — the field's
        // job is to show what the platform says, not our reading of it.
        statusDescription: shipment.status?.trim() || null,
        destination: amazonDestination(shipment),
        // The plan's creation is the nearest thing to "when the channel created
        // the consignment"; a shipment carries no date of its own.
        placedAt: parseDate(plan.createdAt),
        // When the fulfilment centre expects it, which is what a due date means
        // here. Before a delivery window is chosen, the date we have to ship by
        // is the best available answer.
        dueDate:
            parseDateOnly(shipment.selectedDeliveryWindow?.startDate) ??
            parseDateOnly(shipment.dates?.readyToShipWindow?.start),
        // Amazon exposes no unload timestamp; arrival is carried by the status
        // alone.
        receivedAt: null,
        trackingInfo: amazonTracking(shipment),
        // Amazon has no archive flag — a plan it is finished with is voided,
        // which comes through as cancelled.
        isArchived: false,
        items: toExternalItems(items),
    };
}

/**
 * The whole Amazon fetch: the plans worth looking at, then each one's shipments
 * and their lines.
 *
 * Plans belonging to consignments we already track are always included, even
 * when the filters above would have excluded them — otherwise a consignment
 * that shipped since the last sync would stop coming back and sit at its stale
 * status here forever.
 *
 * The call budget is one token exchange, a page of plans per 30, then one call
 * per plan plus two per shipment. Every operation allows 2 requests a second,
 * which is what the pacing in amazonApi is for. None of this touches the shared
 * Zoho quota.
 */
export async function fetchAmazonShipments(
    ctx: AmazonCtx,
    options: ShipmentFetchOptions = {},
    progress?: ProgressReporter,
    fetchOptions: FetchOptions = {}
): Promise<ExternalShipment[]> {
    const sleep = sleeper(fetchOptions);
    const accessToken = await getAmazonAccessToken(ctx);

    const plans = await fetchInboundPlans(ctx, accessToken, options, fetchOptions, progress);
    const byPlanId = new Map<string, InboundPlanSummary>();
    for (const plan of plans) {
        if (plan.inboundPlanId) byPlanId.set(plan.inboundPlanId, plan);
    }

    // A consignment we track names the plan it came from, which is the only way
    // to ask Amazon for it again.
    const trackedOnly = new Set<string>();
    for (const ref of options.alsoFetch ?? []) {
        if (ref.externalGroupId && !byPlanId.has(ref.externalGroupId)) {
            byPlanId.set(ref.externalGroupId, { inboundPlanId: ref.externalGroupId });
            trackedOnly.add(ref.externalGroupId);
        }
    }

    const external: ExternalShipment[] = [];
    let done = 0;

    // Every one of these operations allows 2 requests a second, so each call is
    // spaced rather than relying on the throttle retry to absorb a burst.
    for (const [planId, summary] of byPlanId) {
        await sleep(PAGE_PAUSE_MS);

        let plan: InboundPlan;
        try {
            plan = await fetchInboundPlan(ctx, accessToken, planId, fetchOptions);
        } catch (error) {
            // A plan we only know about because a consignment here points at it
            // can have been purged on Amazon's side. Skipping keeps its stored
            // row and its history; letting the 404 through would wedge every
            // future sync on the same dead plan. Any other failure — expired
            // credentials, Amazon down — is real and still propagates.
            if (error instanceof AmazonApiError && error.status === 404 && trackedOnly.has(planId)) {
                progress?.log(`Amazon no longer has inbound plan ${planId} — leaving it as it is`);
                continue;
            }
            throw error;
        }
        // The listing's summary is kept where there is one, so a plan reached
        // only through a tracked consignment still gets its dates and status.
        const merged: InboundPlanSummary = { ...summary, ...plan };

        for (const entry of plan.shipments ?? []) {
            const shipmentId = entry.shipmentId?.trim();
            // A plan whose placement has not been confirmed lists no shipments;
            // there is nothing to label yet.
            if (!shipmentId) continue;

            await sleep(PAGE_PAUSE_MS);
            const shipment = await fetchShipment(ctx, accessToken, planId, shipmentId, fetchOptions);
            await sleep(PAGE_PAUSE_MS);
            const items = await fetchShipmentItems(
                ctx,
                accessToken,
                planId,
                shipmentId,
                fetchOptions
            );

            const normalised = toExternalShipment(merged, { ...shipment, shipmentId }, items);
            if (normalised) external.push(normalised);
        }

        done++;
        progress?.set({
            message: `Read ${done} of ${byPlanId.size} Amazon inbound plan(s) — ${external.length} consignment(s)…`,
        });
    }

    return external;
}
