import { ScheduledRefreshDeliveries, FlowConfig, models, DeliveryMode, DeliveryStatus } from '@teamkeel/sdk';
import {
    RefreshCandidate,
    TrackingResult,
    dueForRefresh,
    isFailure,
    latestEvent,
    newEvents,
    stalestFirst,
} from '../lib/deliveryTrackingHelpers';
import {
    EasypostCtx,
    hasEasypostCredentials,
    refreshEasypostTracker,
} from '../lib/easypostTrackingHelpers';
import { VesselCtx, hasVesselCredentials, trackVessel } from '../lib/vesselTrackingHelpers';

const config = {} as const satisfies FlowConfig;

const LONG_STEP_TIMEOUT = 10 * 60 * 1000;

// Per-run ceilings.
//
// EasyPost has no documented per-second or daily cap and bills per tracker
// *created*, not per read — and every delivery after its first poll is a read of a
// stored tracker id. So the courier cap is a sanity bound rather than a quota
// defence. VesselAPI's free tier is only 150 calls/month, which is why sea
// deliveries sit on a 24-hour interval (SEA_REFRESH_INTERVAL_MS) and only a
// handful are ever due on a given run.
const COURIER_MAX_PER_RUN = 200;
const VESSEL_MAX_PER_RUN = 10;

type DeliveryRow = Awaited<ReturnType<typeof models.supplierDelivery.findMany>>[number];

// Refresh open supplier deliveries against their carrier's API.
//
// Couriers (FedEx, DHL, UPS) go through EasyPost; sea freight through VesselAPI.
// Runs every 3 hours, though sea deliveries are only due once a day. Open means:
// not archived, and not already Delivered or Cancelled — with a per-delivery
// exponential backoff so one bad tracking number doesn't keep costing calls
// (see dueForRefresh).
//
// Every provider is independently credential-gated: with no keys configured this
// flow does nothing and reports that, so the feature is safe to deploy before the
// accounts exist. A provider that fails records the reason on the affected
// deliveries and leaves their last-known status intact rather than overwriting it.
export default ScheduledRefreshDeliveries(config, async (ctx) => {
    const now = new Date();

    const due = await ctx.step('select-due', async () => {
        // Terminal and archived deliveries are excluded in the query; the backoff
        // decision needs per-row arithmetic, so it happens in dueForRefresh.
        const open = await models.supplierDelivery.findMany({
            where: {
                isArchived: false,
                status: {
                    oneOf: [
                        DeliveryStatus.Pending,
                        DeliveryStatus.InfoReceived,
                        DeliveryStatus.InTransit,
                        DeliveryStatus.OutForDelivery,
                        DeliveryStatus.Arrived,
                        DeliveryStatus.Exception,
                        DeliveryStatus.NotFound,
                        DeliveryStatus.Unknown,
                    ],
                },
            },
        });

        return open.filter((d) => dueForRefresh(toCandidate(d), now)).map((d) => d.id);
    });

    const providers = {
        easypost: hasEasypostCredentials(ctx),
        vessel: hasVesselCredentials(ctx),
    };

    const summary = await ctx.step('refresh', { timeout: LONG_STEP_TIMEOUT }, async () => {
        const deliveries = stalestFirst(await loadDeliveries(due));

        // One courier path now: EasyPost fronts all three carriers.
        const couriers = deliveries.filter(
            (d) => d.mode === DeliveryMode.AirCourier && d.carrier && d.trackingNumber,
        );
        const sea = deliveries.filter((d) => d.mode === DeliveryMode.SeaFreight);

        const results = new Map<string, TrackingResult>();
        // Tracker ids learned this run, written back so later polls read rather
        // than re-create (EasyPost bills per tracker created).
        const trackerIds = new Map<string, string>();

        if (providers.easypost) {
            await refreshCouriers(ctx, couriers.slice(0, COURIER_MAX_PER_RUN), results, trackerIds);
        }
        if (providers.vessel) {
            await refreshSea(ctx, sea.slice(0, VESSEL_MAX_PER_RUN), now, results);
        }

        let updated = 0;
        let failed = 0;
        let eventsAdded = 0;
        let delivered = 0;

        for (const delivery of deliveries) {
            const result = results.get(delivery.id);
            // No result means the provider was skipped (no credentials) or the
            // delivery fell outside a per-run cap — leave the row untouched so it
            // stays due next run rather than looking freshly checked.
            if (!result) continue;

            if (isFailure(result)) {
                await recordFailure(delivery, result.error, now);
                failed++;
                continue;
            }

            const added = await applySnapshot(delivery, result, now, trackerIds.get(delivery.id) ?? null);
            eventsAdded += added;
            updated++;
            if (result.status === DeliveryStatus.Delivered) delivered++;
        }

        return {
            due: deliveries.length,
            couriers: couriers.length,
            sea: sea.length,
            updated,
            failed,
            eventsAdded,
            delivered,
            skippedForCaps:
                Math.max(0, couriers.length - COURIER_MAX_PER_RUN) +
                Math.max(0, sea.length - VESSEL_MAX_PER_RUN),
        };
    });

    const disabled = Object.entries(providers)
        .filter(([, enabled]) => !enabled)
        .map(([name]) => name);

    return ctx.complete({
        title:
            disabled.length === 2
                ? 'Delivery refresh skipped — no carrier credentials configured'
                : 'Supplier delivery refresh complete',
        content: [
            ctx.ui.display.keyValue({
                data: [
                    ...(disabled.length > 0
                        ? [
                              {
                                  key: 'Providers not configured',
                                  value: `${disabled.join(', ')} — set the API secrets to start tracking these`,
                              },
                          ]
                        : []),
                    { key: 'Deliveries due', value: summary.due },
                    { key: 'Couriers / sea', value: `${summary.couriers} / ${summary.sea}` },
                    { key: 'Updated', value: summary.updated },
                    { key: 'Newly delivered', value: summary.delivered },
                    { key: 'New tracking events', value: summary.eventsAdded },
                    { key: 'Failed', value: summary.failed },
                    ...(summary.skippedForCaps > 0
                        ? [
                              {
                                  key: 'Deferred to next run',
                                  value: `${summary.skippedForCaps} (per-run provider caps)`,
                              },
                          ]
                        : []),
                ],
            }),
        ],
    });
});

// ─── Selection ──────────────────────────────────────────────────────────────

function toCandidate(delivery: DeliveryRow): RefreshCandidate {
    return {
        mode: delivery.mode,
        status: delivery.status,
        isArchived: delivery.isArchived,
        lastCheckedAt: delivery.lastCheckedAt ?? null,
        consecutiveFailures: delivery.consecutiveFailures ?? 0,
    };
}

const LOAD_CHUNK = 200;

async function loadDeliveries(ids: string[]): Promise<DeliveryRow[]> {
    const out: DeliveryRow[] = [];
    for (let i = 0; i < ids.length; i += LOAD_CHUNK) {
        const chunk = ids.slice(i, i + LOAD_CHUNK);
        out.push(...(await models.supplierDelivery.findMany({ where: { id: { oneOf: chunk } } })));
    }
    return out;
}

// ─── Per-provider refresh ───────────────────────────────────────────────────

// One call per courier delivery: a read of the stored EasyPost tracker, or a
// create the first time we see it. Any learned tracker id is handed back so
// applySnapshot can persist it and later runs stay on the read path.
async function refreshCouriers(
    ctx: EasypostCtx,
    deliveries: DeliveryRow[],
    results: Map<string, TrackingResult>,
    trackerIds: Map<string, string>,
): Promise<void> {
    for (const delivery of deliveries) {
        try {
            const result = await refreshEasypostTracker(ctx, {
                carrier: delivery.carrier!,
                trackingNumber: delivery.trackingNumber!,
                easypostTrackerId: delivery.easypostTrackerId ?? null,
            });

            if (result.trackerId) trackerIds.set(delivery.id, result.trackerId);

            // Drop the transport-level extra before it reaches the snapshot writer.
            const { trackerId: _ignored, ...tracking } = result;
            results.set(delivery.id, tracking as TrackingResult);
        } catch (error) {
            results.set(delivery.id, { error: `EasyPost request failed: ${errorMessage(error)}` });
        }
    }
}

async function refreshSea(
    ctx: VesselCtx,
    deliveries: DeliveryRow[],
    now: Date,
    results: Map<string, TrackingResult>,
): Promise<void> {
    for (const delivery of deliveries) {
        try {
            results.set(
                delivery.id,
                await trackVessel(
                    ctx,
                    {
                        vesselName: delivery.vesselName ?? null,
                        vesselImo: delivery.vesselImo ?? null,
                        vesselMmsi: delivery.vesselMmsi ?? null,
                    },
                    now,
                ),
            );
        } catch (error) {
            results.set(delivery.id, { error: `VesselAPI request failed: ${errorMessage(error)}` });
        }
    }
}

// ─── Persistence ────────────────────────────────────────────────────────────

// A failure bumps the backoff counter and records why, but deliberately leaves
// status/ETA alone: last-known-good beats blanking a shipment because a carrier
// had a bad afternoon. lastCheckedAt still moves so the backoff can be measured.
async function recordFailure(delivery: DeliveryRow, error: string, now: Date): Promise<void> {
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
async function applySnapshot(
    delivery: DeliveryRow,
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
            // Two runs overlapping on the same delivery race on the unique key;
            // the row exists either way, so a duplicate is not a failure.
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

// ─── Small utilities ────────────────────────────────────────────────────────

function errorMessage(error: unknown): string {
    return String((error as { message?: unknown } | null)?.message ?? error);
}

function isDuplicateKey(error: unknown): boolean {
    const message = errorMessage(error);
    return message.includes('duplicate key value') || message.includes('unique constraint');
}

