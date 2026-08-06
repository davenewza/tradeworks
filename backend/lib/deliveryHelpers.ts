// Shared delivery-rate logic used by the internal quote actions
// (calculateEquipmentBoxes, calculateDelivery) and the external
// getDeliveryRates API. Everything here is pure or side-effect-free
// apart from fetchShipLogicRates, which calls the ShipLogic API.

// Markup applied to all ShipLogic rates before they are shown or stored.
export const DELIVERY_MARKUP = 1.1;

export interface ShipLogicAddress {
    type: string;
    company: string;
    street_address: string;
    local_area: string;
    city: string;
    zone: string;
    country: string;
    code: string;
}

export const COLLECTION_ADDRESS: ShipLogicAddress = {
    type: "business",
    company: "Tradeworks",
    street_address: "65 Oak Street",
    local_area: "Somerset West",
    city: "Somerset West",
    zone: "Western Cape",
    country: "ZA",
    code: "7130"
};

export interface PackableBox {
    id: string;
    name: string;
    sku: string | null;
    price: number;
    priceInclVat: number;
    lengthInCm: number;
    widthInCm: number;
    heightInCm: number;
    weightInGrams: number;
    effectiveVolumeInLitres: number;
}

export interface PackedBox {
    box: PackableBox;
    quantity: number;
    volumeUsed: number;
}

/**
 * Bin-packs a total product volume into the available equipment boxes.
 *
 * Larger boxes are filled first (whole boxes only); the final remainder
 * goes into the smallest box that can hold it, or the smallest box
 * available if none can.
 */
export function packEquipmentBoxes(totalVolumeLitres: number, availableBoxes: PackableBox[]): PackedBox[] {
    const boxes = [...availableBoxes].sort((a, b) => b.effectiveVolumeInLitres - a.effectiveVolumeInLitres);

    const packed = new Map<string, PackedBox>();
    let remainingVolume = totalVolumeLitres;

    // Bulk-fill with the larger box sizes; the smallest size is reserved
    // for the remainder pass below.
    for (let i = 0; i < boxes.length - 1; i++) {
        const box = boxes[i];

        if (remainingVolume <= 0) {
            break;
        }

        const boxesNeeded = Math.floor(remainingVolume / box.effectiveVolumeInLitres);

        if (boxesNeeded > 0) {
            packed.set(box.id, {
                box,
                quantity: boxesNeeded,
                volumeUsed: box.effectiveVolumeInLitres * boxesNeeded
            });
            remainingVolume -= box.effectiveVolumeInLitres * boxesNeeded;
        }
    }

    if (remainingVolume > 0) {
        const smallestFirst = [...boxes].sort((a, b) => a.effectiveVolumeInLitres - b.effectiveVolumeInLitres);
        const box = smallestFirst.find(b => b.effectiveVolumeInLitres >= remainingVolume) ?? smallestFirst[0];

        if (box) {
            const existing = packed.get(box.id);
            if (existing) {
                existing.quantity += 1;
                existing.volumeUsed += remainingVolume;
            } else {
                packed.set(box.id, { box, quantity: 1, volumeUsed: remainingVolume });
            }
        }
    }

    return Array.from(packed.values());
}

export interface ParcelBoxGroup {
    lengthInCm: number;
    widthInCm: number;
    heightInCm: number;
    weightInGrams: number;
    quantity: number;
}

export interface ShipLogicParcel {
    submitted_length_cm: number;
    submitted_width_cm: number;
    submitted_height_cm: number;
    submitted_weight_kg: number;
}

/**
 * Expands box groups into individual ShipLogic parcels. The total product
 * weight is distributed evenly across all boxes and added to each box's
 * own weight.
 */
export function buildParcels(boxGroups: ParcelBoxGroup[], totalProductWeightKg: number): ShipLogicParcel[] {
    const totalBoxes = boxGroups.reduce((sum, group) => sum + group.quantity, 0);
    if (totalBoxes === 0) {
        return [];
    }

    const productWeightPerBox = totalProductWeightKg / totalBoxes;

    const parcels: ShipLogicParcel[] = [];
    for (const group of boxGroups) {
        for (let i = 0; i < group.quantity; i++) {
            parcels.push({
                submitted_length_cm: group.lengthInCm,
                submitted_width_cm: group.widthInCm,
                submitted_height_cm: group.heightInCm,
                submitted_weight_kg: group.weightInGrams / 1000 + productWeightPerBox
            });
        }
    }
    return parcels;
}

export interface ShipLogicRateRequest {
    collection_address: ShipLogicAddress;
    delivery_address: ShipLogicAddress;
    parcels: ShipLogicParcel[];
}

export async function fetchShipLogicRates(apiUrl: string, apiKey: string, request: ShipLogicRateRequest): Promise<any> {
    const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(request)
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error('Shiplogic API error:', response.status, errorText);
        throw new Error(`Shiplogic API error: ${response.status} - ${errorText}`);
    }

    return response.json();
}

export interface MappedRate {
    serviceLevel: {
        code: string;
        name: string;
        description: string | undefined;
        deliveryDateFrom: string | undefined;
        deliveryDateTo: string | undefined;
        collectionDate: string | undefined;
        collectionCutOffTime: string | undefined;
    };
    pricing: {
        rate: number;
        rateExcludingVat: number;
        vat: number;
        vatPercentage: number;
    };
    weights: {
        chargedWeight: number | undefined;
        actualWeight: number | undefined;
        volumetricWeight: number | undefined;
    };
}

/**
 * Maps raw ShipLogic rates to the shape we expose, cheapest first, with
 * DELIVERY_MARKUP applied to all monetary amounts. vatPercentage is a
 * percentage, not a price, so the markup does not apply to it.
 */
export function mapRates(rates: any[]): MappedRate[] {
    return [...rates]
        .sort((a, b) => a.rate - b.rate)
        .map((rate) => ({
            serviceLevel: {
                code: rate.service_level.code,
                name: rate.service_level.name,
                description: rate.service_level.description,
                deliveryDateFrom: rate.service_level.delivery_date_from,
                deliveryDateTo: rate.service_level.delivery_date_to,
                collectionDate: rate.service_level.collection_date,
                collectionCutOffTime: rate.service_level.collection_cut_off_time
            },
            pricing: {
                rate: rate.rate * DELIVERY_MARKUP,
                rateExcludingVat: rate.rate_excluding_vat * DELIVERY_MARKUP,
                vat: rate.base_rate.vat * DELIVERY_MARKUP,
                vatPercentage: rate.base_rate.vat_percentage
            },
            weights: {
                chargedWeight: rate.charged_weight,
                actualWeight: rate.actual_weight,
                volumetricWeight: rate.volumetric_weight
            }
        }));
}

export interface RateLineInput {
    sku: string;
    quantity: number;
}

export interface RateLineProduct {
    sku: string;
    name: string;
    isEnabled: boolean;
    volumeInLitres: number | null;
    weightInGrams: number | null;
}

/**
 * Validates external rate-request lines against their products. Returns
 * every problem found (not just the first) so the caller can report one
 * complete error message.
 */
export function validateRateLines(
    lines: RateLineInput[],
    productsBySku: Map<string, RateLineProduct | null>
): string[] {
    const issues: string[] = [];

    if (lines.length === 0) {
        issues.push('at least one line item is required');
    }

    for (const line of lines) {
        if (!line.sku || line.sku.trim() === '') {
            issues.push('each line item must have a sku');
            continue;
        }

        if (!Number.isInteger(line.quantity) || line.quantity < 1) {
            issues.push(`SKU "${line.sku}": quantity must be a whole number of 1 or more (got ${line.quantity})`);
        }

        const product = productsBySku.get(line.sku);
        if (product === undefined) {
            continue;
        }
        if (product === null) {
            issues.push(`SKU "${line.sku}": no product with this SKU exists`);
            continue;
        }
        if (!product.isEnabled) {
            issues.push(`SKU "${line.sku}": product is disabled`);
        }
        if (product.volumeInLitres === null || !(product.volumeInLitres > 0)) {
            issues.push(`SKU "${line.sku}": product is missing dimensions (length, width and height must be set)`);
        }
        if (product.weightInGrams === null || !(product.weightInGrams > 0)) {
            issues.push(`SKU "${line.sku}": product is missing a weight (weightInGrams must be greater than 0)`);
        }
    }

    return issues;
}
