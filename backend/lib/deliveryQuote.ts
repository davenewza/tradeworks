import { BoxType, models } from '@teamkeel/sdk';
import {
    COLLECTION_ADDRESS,
    MappedRate,
    PackableBox,
    RateLineInput,
    RateLineProduct,
    ShipLogicAddress,
    buildParcels,
    fetchShipLogicRates,
    mapRates,
    packEquipmentBoxes,
    validateRateLines
} from './deliveryHelpers';

// One delivery quote for a set of products going to an address: look the
// products up, pack their volume into equipment boxes, turn the boxes into
// parcels carrying the product weight, and price the parcels with ShipLogic.
// Nothing is written. The external getDeliveryRates API and the Console's
// CalculateShipping flow both quote through here, so they cannot disagree;
// the packing, parcel and markup rules underneath are the same helpers the
// customer portal's quotes use (calculateEquipmentBoxes, calculateDelivery).

export interface DeliveryQuoteAddress {
    // Required by getDeliveryRates; optional in the Console's calculator
    addressLine1?: string | null;
    addressLine2?: string | null;
    suburb: string;
    city: string;
    province: string;
    postalCode: string;
    // Defaults to "ZA" when omitted
    country?: string | null;
    organisation?: string | null;
}

export interface DeliveryQuoteRequest {
    lines: RateLineInput[];
    deliveryAddress: DeliveryQuoteAddress;
    boxType: BoxType;
}

export interface ShipLogicCredentials {
    apiUrl: string;
    apiKey: string;
}

export interface DeliveryQuoteBox {
    name: string;
    sku?: string;
    quantity: number;
    priceExclVat: number;
    priceInclVat: number;
    lengthInCm: number;
    widthInCm: number;
    heightInCm: number;
    weightInGrams: number;
}

export interface DeliveryQuote {
    // Cheapest available service, which the fee fields refer to
    deliveryService: string;
    // Excluding VAT - the same basis as a quote's totalDeliveryFees
    deliveryFee: number;
    deliveryFeeInclVat: number;
    boxType: BoxType;
    boxes: DeliveryQuoteBox[];
    totalParcels: number;
    totalWeightKg: number;
    // Every service on offer, cheapest first
    rates: MappedRate[];
}

// `invalid` is a request that cannot be quoted as it stands (unknown or
// incomplete products, no boxes configured); `noRates` is a valid request the
// courier has no service for. Upstream ShipLogic failures are thrown.
export type DeliveryQuoteOutcome =
    | { status: 'invalid'; issues: string[] }
    | { status: 'noRates' }
    | { status: 'quoted'; quote: DeliveryQuote };

export function toShipLogicAddress(address: DeliveryQuoteAddress): ShipLogicAddress {
    return {
        type: 'business',
        company: address.organisation ?? '',
        street_address: [address.addressLine1, address.addressLine2].filter((line) => !!line).join(', '),
        local_area: address.suburb,
        city: address.city,
        zone: address.province,
        country: address.country ?? 'ZA',
        code: address.postalCode
    };
}

export async function quoteDelivery(
    request: DeliveryQuoteRequest,
    shipLogic: ShipLogicCredentials
): Promise<DeliveryQuoteOutcome> {
    const lines = request.lines;

    // Look up every SKU first, then validate everything in one pass so the
    // caller gets every problem at once.
    const skus = [...new Set(lines.map((line) => line.sku).filter((sku) => !!sku))];
    const products = skus.length === 0 ? [] : await models.product.findMany({ where: { sku: { oneOf: skus } } });
    const productsBySku = new Map<string, RateLineProduct | null>(skus.map((sku) => [sku, null]));
    for (const product of products) {
        productsBySku.set(product.sku, {
            sku: product.sku,
            name: product.name,
            isActive: product.isActive,
            volumeInLitres: product.volumeInLitres === null ? null : Number(product.volumeInLitres),
            weightInGrams: product.weightInGrams === null ? null : Number(product.weightInGrams)
        });
    }

    const issues = validateRateLines(lines, productsBySku);
    if (issues.length > 0) {
        return { status: 'invalid', issues };
    }

    let totalVolumeLitres = 0;
    let totalProductWeightKg = 0;
    for (const line of lines) {
        const product = productsBySku.get(line.sku)!;
        totalVolumeLitres += product.volumeInLitres! * line.quantity;
        totalProductWeightKg += (product.weightInGrams! * line.quantity) / 1000;
    }

    const equipmentBoxes = await models.equipmentBox.findMany({
        where: { boxType: request.boxType, isEnabled: true }
    });

    if (equipmentBoxes.length === 0) {
        return { status: 'invalid', issues: [`no ${request.boxType} equipment boxes are configured`] };
    }

    const packableBoxes: PackableBox[] = equipmentBoxes.map((box) => ({
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
        return { status: 'invalid', issues: ['total product volume is zero'] };
    }

    const apiResponse = await fetchShipLogicRates(shipLogic.apiUrl, shipLogic.apiKey, {
        collection_address: COLLECTION_ADDRESS,
        delivery_address: toShipLogicAddress(request.deliveryAddress),
        parcels
    });

    const rates = mapRates(apiResponse.rates || []);

    if (rates.length === 0) {
        return { status: 'noRates' };
    }

    const cheapest = rates[0];

    return {
        status: 'quoted',
        quote: {
            deliveryService: cheapest.serviceLevel.name,
            deliveryFee: cheapest.pricing.rateExcludingVat,
            deliveryFeeInclVat: cheapest.pricing.rate,
            boxType: request.boxType,
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
            totalWeightKg: parcels.reduce((sum, parcel) => sum + parcel.submitted_weight_kg, 0),
            rates
        }
    };
}
