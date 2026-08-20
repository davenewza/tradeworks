import { CreateSupplierDelivery, CreateSupplierDeliveryHooks } from '@teamkeel/sdk';
import { normaliseNewDelivery } from '../lib/deliveryInputHelpers';

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
};

export default CreateSupplierDelivery(hooks);
