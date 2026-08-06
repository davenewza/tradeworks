import { BoxType, GetDeliveryRates, models } from '@teamkeel/sdk';
import {
    COLLECTION_ADDRESS,
    PackableBox,
    RateLineProduct,
    ShipLogicAddress,
    buildParcels,
    fetchShipLogicRates,
    mapRates,
    packEquipmentBoxes,
    validateRateLines
} from '../lib/deliveryHelpers';

// External delivery-rates API. Authentication is enforced by the action's
// permission expression: the caller's X-API-KEY header must match the
// DELIVERY_API_KEY secret.
export default GetDeliveryRates(async (ctx, inputs) => {
    // Defence in depth: if the secret is not configured, the permission
    // expression comparing it to the request header can degenerate to
    // always-true. Refuse to serve rather than run unauthenticated.
    if (!ctx.secrets.DELIVERY_API_KEY) {
        throw new Error('The DELIVERY_API_KEY secret is not configured for this environment');
    }

    const lines = inputs.lines ?? [];

    // Look up every SKU first, then validate everything in one pass so the
    // caller gets a single error message listing all problems.
    const productsBySku = new Map<string, RateLineProduct | null>();
    for (const line of lines) {
        if (!line.sku || productsBySku.has(line.sku)) {
            continue;
        }
        const product = await models.product.findOne({ sku: line.sku });
        productsBySku.set(
            line.sku,
            product
                ? {
                      sku: product.sku,
                      name: product.name,
                      isEnabled: product.isEnabled,
                      volumeInLitres: product.volumeInLitres === null ? null : Number(product.volumeInLitres),
                      weightInGrams: product.weightInGrams === null ? null : Number(product.weightInGrams)
                  }
                : null
        );
    }

    const issues = validateRateLines(lines, productsBySku);
    if (issues.length > 0) {
        throw new Error(`Cannot calculate delivery rates: ${issues.join('; ')}`);
    }

    let totalVolumeLitres = 0;
    let totalProductWeightKg = 0;
    for (const line of lines) {
        const product = productsBySku.get(line.sku)!;
        totalVolumeLitres += product.volumeInLitres! * line.quantity;
        totalProductWeightKg += (product.weightInGrams! * line.quantity) / 1000;
    }

    const boxType = inputs.includeEquipmentBox ? BoxType.PlasticEquipment : BoxType.Cardboard;

    const equipmentBoxes = await models.equipmentBox.findMany({
        where: { boxType, isEnabled: true }
    });

    if (equipmentBoxes.length === 0) {
        throw new Error(`Cannot calculate delivery rates: no ${boxType} equipment boxes are configured`);
    }

    const packableBoxes: PackableBox[] = equipmentBoxes.map(box => ({
        id: box.id,
        name: box.name,
        sku: box.sku,
        price: Number(box.price),
        priceInclVat: Number(box.priceInclVat),
        lengthInCm: Number(box.lengthInCm),
        widthInCm: Number(box.widthInCm),
        heightInCm: Number(box.heightInCm),
        weightInGrams: Number(box.weightInGrams),
        effectiveVolumeInLitres: Number(box.effectiveVolumeInLitres)
    }));

    const packed = packEquipmentBoxes(totalVolumeLitres, packableBoxes);

    const parcels = buildParcels(
        packed.map(({ box, quantity }) => ({
            lengthInCm: box.lengthInCm,
            widthInCm: box.widthInCm,
            heightInCm: box.heightInCm,
            weightInGrams: box.weightInGrams,
            quantity
        })),
        totalProductWeightKg
    );

    if (parcels.length === 0) {
        throw new Error('Cannot calculate delivery rates: total product volume is zero');
    }

    const address = inputs.deliveryAddress;
    const deliveryAddress: ShipLogicAddress = {
        type: 'business',
        company: address.organisation ?? '',
        street_address: address.addressLine2
            ? `${address.addressLine1}, ${address.addressLine2}`
            : address.addressLine1,
        local_area: address.suburb,
        city: address.city,
        zone: address.province,
        country: address.country ?? 'ZA',
        code: address.postalCode
    };

    const apiResponse = await fetchShipLogicRates(ctx.env.SHIPLOGIC_API_URL, ctx.secrets.SHIPLOGIC_API_KEY, {
        collection_address: COLLECTION_ADDRESS,
        delivery_address: deliveryAddress,
        parcels
    });

    const rates = mapRates(apiResponse.rates || []);

    if (rates.length === 0) {
        throw new Error('No delivery rates available for this address');
    }

    const cheapest = rates[0];
    const totalWeightKg = parcels.reduce((sum, parcel) => sum + parcel.submitted_weight_kg, 0);

    return {
        deliveryService: cheapest.serviceLevel.name,
        deliveryFee: cheapest.pricing.rateExcludingVat,
        deliveryFeeInclVat: cheapest.pricing.rate,
        boxType,
        boxes: packed.map(({ box, quantity }) => ({
            name: box.name,
            sku: box.sku ?? undefined,
            quantity,
            priceExclVat: box.price,
            priceInclVat: box.priceInclVat,
            lengthInCm: box.lengthInCm,
            widthInCm: box.widthInCm,
            heightInCm: box.heightInCm,
            weightInGrams: box.weightInGrams
        })),
        totalParcels: parcels.length,
        totalWeightKg,
        rates
    };
});
