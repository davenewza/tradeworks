// Refreshing one delivery: ask its provider where the consignment is, then write
// the answer down.
//
// This is deliberately per-delivery rather than per-batch, because three callers
// need exactly one delivery refreshed and only one of them is a batch:
//   - ScheduledRefreshDeliveries — loops over everything due
//   - refreshSupplierDelivery — the "Check now" button on a delivery
//   - createSupplierDelivery — the first check, the moment a delivery is logged
//
// Keeping the provider dispatch and the persistence rules here means all three
// share one definition of what a refresh does; the flow adds only scheduling and
// per-run caps on top.

import { DeliveryMode, DeliveryStatus, SupplierDelivery, models } from '@teamkeel/sdk';
import { TrackingResult, isFailure, latestEvent, newEvents } from './deliveryTrackingHelpers';
import { EasypostCtx, hasEasypostCredentials, refreshEasypostTracker } from './easypostTrackingHelpers';
import { VesselCtx, hasVesselCredentials, trackVessel } from './vesselTrackingHelpers';

// The environment and secrets a refresh needs. Structural, so a flow ctx, a
// function ctx and a test double all satisfy it.
export type RefreshCtx = EasypostCtx & VesselCtx;

// What happened to one delivery. `skipped` is distinct from `failed` on purpose:
// an unconfigured provider or an untrackable delivery is not an error, and must
// not bump the failure backoff or move lastCheckedAt.
export type RefreshOutcome =
    | { kind: 'skipped'; reason: string }
    | { kind: 'failed'; error: string }
    | { kind: 'updated'; status: DeliveryStatus; eventsAdded: number };

// ─── Provider dispatch ──────────────────────────────────────────────────────

// Ask the right provider about one delivery. Returns null when there is nothing
// to ask — no credentials, or the delivery lacks the identifier its mode needs.
// A thrown provider error becomes a failure result rather than escaping, so one
// bad delivery can never abort a batch or a create.
export async function fetchDeliveryTracking(
    ctx: RefreshCtx,
    delivery: SupplierDelivery,
    now: Date,
): Promise<{ result: TrackingResult; trackerId: string | null } | { skipped: string }> {
    if (delivery.mode === DeliveryMode.AirCourier) {
        if (!hasEasypostCredentials(ctx)) {
            return { skipped: 'EasyPost is not configured — set EASYPOST_API_KEY to track couriers' };
        }
        if (!delivery.carrier || !delivery.trackingNumber) {
            return { skipped: 'Courier delivery has no carrier or tracking number' };
        }

        try {
            const result = await refreshEasypostTracker(ctx, {
                carrier: delivery.carrier,
                trackingNumber: delivery.trackingNumber,
                easypostTrackerId: delivery.easypostTrackerId ?? null,
            });
            // Split the transport-level tracker id off the tracking result.
            const { trackerId = null, ...tracking } = result;
            return { result: tracking as TrackingResult, trackerId };
        } catch (error) {
            return { result: { error: `EasyPost request failed: ${errorMessage(error)}` }, trackerId: null };
        }
    }

    if (!hasVesselCredentials(ctx)) {
        return { skipped: 'VesselAPI is not configured — set VESSEL_API_KEY to track sea freight' };
    }
    if (!delivery.vesselName && !delivery.vesselImo && !delivery.vesselMmsi) {
        return { skipped: 'Sea freight delivery has no vessel name or IMO' };
    }

    try {
        const result = await trackVessel(
            ctx,
            {
                vesselName: delivery.vesselName ?? null,
                vesselImo: delivery.vesselImo ?? null,
                vesselMmsi: delivery.vesselMmsi ?? null,
            },
            now,
        );
        return { result, trackerId: null };
    } catch (error) {
        return { result: { error: `VesselAPI request failed: ${errorMessage(error)}` }, trackerId: null };
    }
}

// ─── Persistence ────────────────────────────────────────────────────────────

// A failure bumps the backoff counter and records why, but deliberately leaves
// status/ETA alone: last-known-good beats blanking a shipment because a carrier
// had a bad afternoon. lastCheckedAt still moves so the backoff can be measured.
export async function recordFailure(delivery: SupplierDelivery, error: string, now: Date): Promise<void> {
    await models.supplierDelivery.update(
        { id: delivery.id },
        {
            lastCheckedAt: now,
            refreshError: error.slice(0, 500),
            consecutiveFailures: (delivery.consecutiveFailures ?? 0) + 1,
        },
    );
}

// Write a successful snapshot and any events not already stored. Returns the
// number of events inserted.
export async function applySnapshot(
    delivery: SupplierDelivery,
    snapshot: Exclude<TrackingResult, { error: string }>,
    now: Date,
    easypostTrackerId: string | null,
): Promise<number> {
    const existing = await models.deliveryEvent.findMany({ where: { delivery: { id: delivery.id } } });
    const fresh = newEvents(snapshot.events, new Set(existing.map((e) => e.eventKey)));

    for (const { event, key } of fresh) {
        try {
            await models.deliveryEvent.create({
                deliveryId: delivery.id,
                occurredAt: event.occurredAt,
                description: event.description.slice(0, 500),
                location: event.location,
                status: event.status,
                eventKey: key,
            });
        } catch (error) {
            // A scheduled run and a manual "Check now" can overlap on the same
            // delivery and race on the unique key; the row exists either way, so
            // a duplicate is not a failure.
            if (!isDuplicateKey(error)) throw error;
        }
    }

    const last = latestEvent(snapshot.events);

    await models.supplierDelivery.update(
        { id: delivery.id },
        {
            status: snapshot.status,
            statusDescription: snapshot.statusDescription,
            // Only overwrite an ETA/destination when the provider gave one — a
            // payload that omits the field shouldn't erase what we already know.
            estimatedArrival: snapshot.estimatedArrival ?? delivery.estimatedArrival,
            destination: snapshot.destination ?? delivery.destination,
            deliveredAt: snapshot.deliveredAt ?? delivery.deliveredAt,
            lastEventAt: last?.occurredAt ?? delivery.lastEventAt,
            lastEventLocation: last?.location ?? delivery.lastEventLocation,
            vesselImo: snapshot.vesselImo ?? delivery.vesselImo,
            vesselMmsi: snapshot.vesselMmsi ?? delivery.vesselMmsi,
            easypostTrackerId: easypostTrackerId ?? delivery.easypostTrackerId,
            lastCheckedAt: now,
            refreshError: null,
            consecutiveFailures: 0,
        },
    );

    return fresh.length;
}

// ─── One whole refresh ──────────────────────────────────────────────────────

// Fetch and persist, for a single delivery. This is the unit every caller wants:
// the flow calls it per due delivery, the Console button calls it once, and the
// create hook calls it for the row it just wrote.
//
// Never throws for provider reasons — a refresh going wrong is data to record,
// not an exception to propagate into a create or abort a batch.
export async function refreshDelivery(
    ctx: RefreshCtx,
    delivery: SupplierDelivery,
    now: Date,
): Promise<RefreshOutcome> {
    const fetched = await fetchDeliveryTracking(ctx, delivery, now);

    if ('skipped' in fetched) {
        return { kind: 'skipped', reason: fetched.skipped };
    }

    if (isFailure(fetched.result)) {
        await recordFailure(delivery, fetched.result.error, now);
        return { kind: 'failed', error: fetched.result.error };
    }

    const eventsAdded = await applySnapshot(delivery, fetched.result, now, fetched.trackerId);
    return { kind: 'updated', status: fetched.result.status, eventsAdded };
}

// Refresh a delivery by id, reloading it first so the caller does not have to.
// Returns null when the id does not exist.
export async function refreshDeliveryById(
    ctx: RefreshCtx,
    id: string,
    now: Date,
): Promise<RefreshOutcome | null> {
    const delivery = await models.supplierDelivery.findOne({ id });
    if (!delivery) return null;
    return await refreshDelivery(ctx, delivery, now);
}

// ─── Small utilities ────────────────────────────────────────────────────────

export function errorMessage(error: unknown): string {
    return String((error as { message?: unknown } | null)?.message ?? error);
}

export function isDuplicateKey(error: unknown): boolean {
    const message = errorMessage(error);
    return message.includes('duplicate key value') || message.includes('unique constraint');
}
