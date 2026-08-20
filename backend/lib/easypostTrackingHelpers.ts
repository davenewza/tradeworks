// Courier tracking via EasyPost, which fronts FedEx, DHL and UPS behind one API.
//
//   Create/upsert: POST {base}/v2/trackers   (tracker[tracking_code], tracker[carrier])
//   Read back:     GET  {base}/v2/trackers/{id}
//   Auth:          HTTP Basic, API key as the username with an empty password
//
// Billing and idempotency. EasyPost bills per tracker created (~$0.02 for a
// standalone tracker), but POST is idempotent: re-posting a tracking code returns
// the *same* tracker id rather than creating a second one — verified against the
// live API. We still store the id on the delivery and GET it on later polls, so
// the normal path is a plain read and a duplicate create is impossible by
// construction rather than only by EasyPost's goodwill.
//
// No carrier accounts needed: a DHL Express consignment resolved on a bare
// production key with no DHL credentials of our own (verified end to end against
// a real Hong Kong → Cape Town shipment).

import {
    FetchLike,
    TrackingEvent,
    TrackingResult,
    TrackingSnapshot,
    latestEvent,
    parseTimestamp,
} from './deliveryTrackingHelpers';
import { DeliveryCarrier, DeliveryStatus } from '@teamkeel/sdk';

export interface EasypostCtx {
    env: { EASYPOST_API_BASE_URL: string };
    secrets: { EASYPOST_API_KEY: string };
}

// ─── EasyPost response types ────────────────────────────────────────────────

interface EasypostTrackingLocation {
    city?: string | null;
    state?: string | null;
    country?: string | null;
    zip?: string | null;
}

interface EasypostTrackingDetail {
    message?: string | null;
    description?: string | null;
    status?: string | null;
    status_detail?: string | null;
    datetime?: string | null;
    tracking_location?: EasypostTrackingLocation | null;
}

interface EasypostCarrierDetail {
    service?: string | null;
    origin_location?: string | null;
    destination_location?: string | null;
}

export interface EasypostTracker {
    id?: string;
    mode?: string;
    tracking_code?: string;
    carrier?: string;
    status?: string | null;
    status_detail?: string | null;
    // "The estimated delivery date provided by the carrier (if available)" — a
    // straight passthrough, so it is null once a parcel is delivered and null for
    // any carrier that does not publish one.
    est_delivery_date?: string | null;
    signed_by?: string | null;
    carrier_detail?: EasypostCarrierDetail | null;
    tracking_details?: EasypostTrackingDetail[] | null;
}

interface EasypostError {
    error?: { code?: string; message?: string };
}

// ─── Carrier codes ──────────────────────────────────────────────────────────

// EasyPost's own carrier strings. All three verified accepted by the live API.
const EASYPOST_CARRIER_CODES: Record<DeliveryCarrier, string> = {
    [DeliveryCarrier.Fedex]: 'FedEx',
    [DeliveryCarrier.Dhl]: 'DHLExpress',
    [DeliveryCarrier.Ups]: 'UPS',
};

export function easypostCarrierCode(carrier: DeliveryCarrier): string {
    return EASYPOST_CARRIER_CODES[carrier];
}

// ─── Status mapping ─────────────────────────────────────────────────────────

// EasyPost's coarse `status`, already normalised across carriers by them.
const STATUS_MAP: Record<string, DeliveryStatus> = {
    pre_transit: DeliveryStatus.InfoReceived,
    in_transit: DeliveryStatus.InTransit,
    out_for_delivery: DeliveryStatus.OutForDelivery,
    // At a pickup point, so it has landed but is not with us yet.
    available_for_pickup: DeliveryStatus.Arrived,
    delivered: DeliveryStatus.Delivered,
    return_to_sender: DeliveryStatus.Exception,
    failure: DeliveryStatus.Exception,
    cancelled: DeliveryStatus.Cancelled,
    // EasyPost could not track the number at all — same situation as a carrier
    // "not found", and equally worth retrying rather than writing off.
    error: DeliveryStatus.NotFound,
    unknown: DeliveryStatus.Unknown,
};

// `status_detail` values that matter more than the coarse status they sit under.
//
// This is not defensive padding — it is the lesson from a real consignment. A
// Hong Kong → Cape Town DHL parcel of ours sat in customs for a day:
//
//   2026-06-29T12:09:48Z   in_transit   held   "Shipment is on hold"
//
// The top-level status stayed `in_transit` the whole time. Mapping from status
// alone would have shown "In transit" while the single most actionable event on
// an inbound delivery went unnoticed, so these details win.
const STATUS_DETAIL_OVERRIDES: Record<string, DeliveryStatus> = {
    held: DeliveryStatus.Exception,
    delayed: DeliveryStatus.Exception,
    lost: DeliveryStatus.Exception,
    damaged: DeliveryStatus.Exception,
    address_correction: DeliveryStatus.Exception,
    failure: DeliveryStatus.Exception,
    cancelled: DeliveryStatus.Cancelled,
};

// Map one EasyPost (status, status_detail) pair onto our vocabulary. An unknown
// status degrades to Unknown rather than guessing; the carrier's own wording
// still reaches the Console via statusDescription.
export function mapEasypostStatus(status: string | null | undefined, statusDetail?: string | null): DeliveryStatus {
    const detail = (statusDetail ?? '').trim().toLowerCase();
    const override = STATUS_DETAIL_OVERRIDES[detail];
    if (override) return override;

    const coarse = (status ?? '').trim().toLowerCase();
    if (coarse === '') return DeliveryStatus.Unknown;
    return STATUS_MAP[coarse] ?? DeliveryStatus.Unknown;
}

// ─── Parsing ────────────────────────────────────────────────────────────────

// "SOUTH SAN FRANCISCO, CA, US" from the parts EasyPost actually populated —
// state and country are frequently null on international scans.
function formatLocation(location: EasypostTrackingLocation | null | undefined): string | null {
    if (!location) return null;
    const parts = [location.city, location.state, location.country].filter(
        (p): p is string => typeof p === 'string' && p.trim() !== '',
    );
    return parts.length > 0 ? parts.join(', ') : null;
}

export function parseEasypostTracker(tracker: EasypostTracker): TrackingSnapshot {
    const status = mapEasypostStatus(tracker.status, tracker.status_detail);

    const events: TrackingEvent[] = (tracker.tracking_details ?? [])
        .map((detail): TrackingEvent | null => {
            const occurredAt = parseTimestamp(detail.datetime);
            if (!occurredAt) return null;
            return {
                occurredAt,
                description: detail.message?.trim() || detail.description?.trim() || 'Carrier scan',
                location: formatLocation(detail.tracking_location),
                status: mapEasypostStatus(detail.status, detail.status_detail),
            };
        })
        .filter((e): e is TrackingEvent => e !== null);

    // The tracker has no top-level description, so the newest scan's wording is
    // the carrier's own account of where things stand.
    const newest = latestEvent(events);

    // EasyPost exposes no delivered-at field: on a delivered parcel the time is
    // the last delivered scan. Confirmed against a real shipment, whose final
    // event was "Delivered" at Somerset West.
    const deliveredAt =
        status === DeliveryStatus.Delivered
            ? (events
                  .filter((e) => e.status === DeliveryStatus.Delivered)
                  .reduce<Date | null>((last, e) => (!last || e.occurredAt > last ? e.occurredAt : last), null) ??
              newest?.occurredAt ??
              null)
            : null;

    return {
        status,
        statusDescription: newest?.description ?? tracker.status_detail ?? null,
        estimatedArrival: parseTimestamp(tracker.est_delivery_date),
        deliveredAt,
        destination: tracker.carrier_detail?.destination_location?.trim() || null,
        events,
    };
}

// ─── Fetch ──────────────────────────────────────────────────────────────────

export function hasEasypostCredentials(ctx: EasypostCtx): boolean {
    return Boolean(ctx.secrets.EASYPOST_API_KEY);
}

// EasyPost authenticates with the API key as the Basic username and no password.
function authHeader(ctx: EasypostCtx): string {
    return `Basic ${Buffer.from(`${ctx.secrets.EASYPOST_API_KEY}:`).toString('base64')}`;
}

// A tracker plus the id to store, so the caller can read it back next time
// instead of re-creating it.
export interface EasypostRefresh {
    snapshot: TrackingSnapshot;
    trackerId: string | null;
}

async function readError(response: Response): Promise<string> {
    const body = await response.text();
    try {
        const parsed: EasypostError = JSON.parse(body);
        if (parsed.error?.message) {
            return `${parsed.error.code ?? response.status} — ${parsed.error.message}`;
        }
    } catch {
        // Not JSON; fall through to the raw body.
    }
    return `${response.status} - ${body.slice(0, 200)}`;
}

// Refresh one courier consignment. Reads the stored tracker back when we have its
// id, and otherwise creates it (idempotently) and returns the id to store.
export async function refreshEasypostTracker(
    ctx: EasypostCtx,
    delivery: { carrier: DeliveryCarrier; trackingNumber: string; easypostTrackerId: string | null },
    fetchImpl: FetchLike = fetch,
): Promise<TrackingResult & { trackerId?: string | null }> {
    const base = ctx.env.EASYPOST_API_BASE_URL.replace(/\/$/, '');
    const headers = { Authorization: authHeader(ctx), Accept: 'application/json' };

    let response: Response;

    if (delivery.easypostTrackerId) {
        response = await fetchImpl(`${base}/v2/trackers/${encodeURIComponent(delivery.easypostTrackerId)}`, {
            method: 'GET',
            headers,
        });
    } else {
        const body = new URLSearchParams({
            'tracker[tracking_code]': delivery.trackingNumber,
            'tracker[carrier]': easypostCarrierCode(delivery.carrier),
        });
        response = await fetchImpl(`${base}/v2/trackers`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
        });
    }

    if (!response.ok) {
        const detail = await readError(response);
        // A tracking code the carrier has not registered yet is a status, not a
        // failure — it gets retried on the usual backoff.
        if (/INVALID|NOT_FOUND|not found|unable to track/i.test(detail)) {
            return {
                status: DeliveryStatus.NotFound,
                statusDescription: `EasyPost could not track this number yet (${detail.slice(0, 120)})`,
                estimatedArrival: null,
                deliveredAt: null,
                destination: null,
                events: [],
                trackerId: null,
            };
        }
        return { error: `EasyPost: ${detail}` };
    }

    const tracker: EasypostTracker = await response.json();
    return { ...parseEasypostTracker(tracker), trackerId: tracker.id ?? null };
}
