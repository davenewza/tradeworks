import { BoxType, GetDeliveryRates } from '@teamkeel/sdk';
import { quoteDelivery } from '../lib/deliveryQuote';

// External delivery-rates API. Authentication is enforced by the action's
// permission expression: the caller's X-API-KEY header must match the
// DELIVERY_API_KEY secret. The quote itself is lib/deliveryQuote, shared with
// the Console's shipping calculator; the error messages here are part of the
// published contract (docs/delivery-rates-api.md §6).
export default GetDeliveryRates(async (ctx, inputs) => {
    // Defence in depth: if the secret is not configured, the permission
    // expression comparing it to the request header can degenerate to
    // always-true. Refuse to serve rather than run unauthenticated.
    if (!ctx.secrets.DELIVERY_API_KEY) {
        throw new Error('The DELIVERY_API_KEY secret is not configured for this environment');
    }

    const outcome = await quoteDelivery(
        {
            lines: inputs.lines ?? [],
            deliveryAddress: inputs.deliveryAddress,
            boxType: inputs.includeEquipmentBox ? BoxType.PlasticEquipment : BoxType.Cardboard
        },
        { apiUrl: ctx.env.SHIPLOGIC_API_URL, apiKey: ctx.secrets.SHIPLOGIC_API_KEY }
    );

    switch (outcome.status) {
        case 'invalid':
            throw new Error(`Cannot calculate delivery rates: ${outcome.issues.join('; ')}`);
        case 'noRates':
            throw new Error('No delivery rates available for this address');
        case 'quoted':
            return outcome.quote;
    }
});
