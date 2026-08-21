import { ScheduledRefreshDeliveries, FlowConfig, models, DeliveryMode, DeliveryStatus } from '@teamkeel/sdk';
import { RefreshCandidate, dueForRefresh, stalestFirst } from '../lib/deliveryTrackingHelpers';
import { RefreshCtx, refreshDelivery } from '../lib/deliveryRefresh';
import { hasEasypostCredentials } from '../lib/easypostTrackingHelpers';
import { hasVesselCredentials } from '../lib/vesselTrackingHelpers';

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
// What a single refresh *does* lives in lib/deliveryRefresh — shared with the
// per-delivery "Check now" action and the first check on create. This flow adds
// only the scheduling: which deliveries are due, in what order, and how many of
// each kind to attempt per run.
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
        // Longest-waiting first, so the per-run caps below truncate the freshest
        // rather than starving the same tail every run.
        const deliveries = stalestFirst(await loadDeliveries(due));

        // Capped per provider. Anything over a cap is simply left untouched, so it
        // stays due next run rather than looking freshly checked.
        const couriers = deliveries
            .filter((d) => d.mode === DeliveryMode.AirCourier)
            .slice(0, COURIER_MAX_PER_RUN);
        const sea = deliveries.filter((d) => d.mode === DeliveryMode.SeaFreight).slice(0, VESSEL_MAX_PER_RUN);

        let updated = 0;
        let failed = 0;
        let skipped = 0;
        let eventsAdded = 0;
        let delivered = 0;

        for (const delivery of [...couriers, ...sea]) {
            const outcome = await refreshDelivery(ctx as RefreshCtx, delivery, now);

            if (outcome.kind === 'updated') {
                updated++;
                eventsAdded += outcome.eventsAdded;
                if (outcome.status === DeliveryStatus.Delivered) delivered++;
            } else if (outcome.kind === 'failed') {
                failed++;
            } else {
                skipped++;
            }
        }

        const courierTotal = deliveries.filter((d) => d.mode === DeliveryMode.AirCourier).length;
        const seaTotal = deliveries.filter((d) => d.mode === DeliveryMode.SeaFreight).length;

        return {
            due: deliveries.length,
            couriers: courierTotal,
            sea: seaTotal,
            updated,
            failed,
            skipped,
            eventsAdded,
            delivered,
            skippedForCaps:
                Math.max(0, courierTotal - COURIER_MAX_PER_RUN) + Math.max(0, seaTotal - VESSEL_MAX_PER_RUN),
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
                    ...(summary.skipped > 0
                        ? [{ key: 'Skipped (nothing to ask)', value: summary.skipped }]
                        : []),
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
