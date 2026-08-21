import { CreateSupplierDelivery, CreateSupplierDeliveryHooks } from '@teamkeel/sdk';
import { normaliseNewDelivery } from '../lib/deliveryInputHelpers';
import { refreshDelivery } from '../lib/deliveryRefresh';

// A delivery is only trackable if its identifier matches its mode: a courier
// needs a carrier and a tracking number, sea freight needs a vessel name. The
// schema can't express "required when mode is X", so it is enforced here — before
// the row is written, rather than letting the refresh flow discover it later.
const hooks: CreateSupplierDeliveryHooks = {
    beforeWrite: async (ctx, inputs) => {
        const normalised = normaliseNewDelivery({
            mode: inputs.mode,
            carrier: inputs.carrier ?? null,
            trackingNumber: inputs.trackingNumber ?? null,
            vesselName: inputs.vesselName ?? null,
        });

        if ('error' in normalised) {
            throw new Error(normalised.error);
        }

        return {
            ...inputs,
            carrier: normalised.carrier,
            trackingNumber: normalised.trackingNumber,
            vesselName: normalised.vesselName,
        };
    },

    // Check the new delivery against its carrier straight away, for this row
    // only, so it lands with a real status and ETA instead of sitting on Pending
    // for up to three hours until the scheduled run picks it up.
    //
    // A failure here must never fail the create: the delivery is already written
    // and is perfectly valid without a first reading. refreshDelivery records the
    // reason on the row and does not throw for provider errors, but it is wrapped
    // anyway so nothing unforeseen can turn a saved delivery into an error the
    // user sees.
    afterWrite: async (ctx, inputs, data) => {
        try {
            await refreshDelivery(ctx, data, new Date());
        } catch (error) {
            console.error(
                `First tracking check failed for delivery ${data.id}; the scheduled run will retry: ${String(
                    (error as { message?: unknown } | null)?.message ?? error,
                )}`,
            );
        }
    },
};

export default CreateSupplierDelivery(hooks);
