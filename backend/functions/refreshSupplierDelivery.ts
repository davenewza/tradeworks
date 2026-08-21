import { RefreshSupplierDelivery, models } from '@teamkeel/sdk';
import { refreshDeliveryById } from '../lib/deliveryRefresh';

// "Check now" for a single delivery — the button on its Console page.
//
// Deliberately ignores the scheduled interval and the failure backoff: those
// exist to ration automatic polling, and someone clicking the button is an
// explicit request to ask the carrier regardless. It also works on archived and
// already-delivered deliveries, since re-reading a stored tracker is free and a
// person asking for it has a reason.
//
// Never throws for provider reasons. A delivery we cannot ask about, or a carrier
// that errored, comes back as `refreshed: false` with the reason in `message`, so
// the Console shows what happened instead of a stack trace.
export default RefreshSupplierDelivery(async (ctx, inputs) => {
    const outcome = await refreshDeliveryById(ctx, inputs.id, new Date());

    if (outcome === null) {
        // Distinct from a failed refresh: the row genuinely isn't there.
        throw new Error('Delivery not found');
    }

    // Read back the persisted row so the response reflects what was actually
    // stored — including the fields a refresh deliberately leaves alone, like an
    // ETA the provider omitted this time.
    const delivery = await models.supplierDelivery.findOne({ id: inputs.id });

    const message =
        outcome.kind === 'updated'
            ? outcome.eventsAdded > 0
                ? `Updated — ${outcome.eventsAdded} new tracking event${outcome.eventsAdded === 1 ? '' : 's'}`
                : 'Updated — no new tracking events since the last check'
            : outcome.kind === 'skipped'
              ? outcome.reason
              : outcome.error;

    return {
        refreshed: outcome.kind === 'updated',
        message,
        // Optional message fields are `T | undefined`, so absent values are
        // omitted rather than sent as explicit nulls.
        status: delivery?.status ?? undefined,
        statusDescription: delivery?.statusDescription ?? undefined,
        estimatedArrival: delivery?.estimatedArrival ?? undefined,
        destination: delivery?.destination ?? undefined,
        newEvents: outcome.kind === 'updated' ? outcome.eventsAdded : 0,
        lastCheckedAt: delivery?.lastCheckedAt ?? undefined,
    };
});
