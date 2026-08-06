import { describe, expect, test } from 'vitest';
import {
    DELIVERY_MARKUP,
    PackableBox,
    RateLineProduct,
    buildParcels,
    mapRates,
    packEquipmentBoxes,
    validateRateLines
} from './deliveryHelpers';

function box(overrides: Partial<PackableBox> & Pick<PackableBox, 'id' | 'effectiveVolumeInLitres'>): PackableBox {
    return {
        name: overrides.id,
        sku: null,
        price: 100,
        priceInclVat: 115,
        lengthInCm: 40,
        widthInCm: 30,
        heightInCm: 20,
        weightInGrams: 500,
        ...overrides
    };
}

describe('packEquipmentBoxes', () => {
    const large = box({ id: 'large', effectiveVolumeInLitres: 50 });
    const medium = box({ id: 'medium', effectiveVolumeInLitres: 20 });
    const small = box({ id: 'small', effectiveVolumeInLitres: 5 });

    test('bulk-fills with the largest box and puts the remainder in the smallest box that fits', () => {
        // 112L -> 2x large (100L), 12L remainder -> medium (20L) fits
        const packed = packEquipmentBoxes(112, [small, large, medium]);

        expect(packed).toEqual([
            { box: large, quantity: 2, volumeUsed: 100 },
            { box: medium, quantity: 1, volumeUsed: 12 }
        ]);
    });

    test('merges the remainder into an already-used box size', () => {
        // 55L -> 2x medium (40L), 15L remainder -> medium is the smallest that fits
        const packed = packEquipmentBoxes(55, [medium, small]);

        expect(packed).toEqual([{ box: medium, quantity: 3, volumeUsed: 55 }]);
    });

    test('uses no remainder box when the volume is an exact multiple', () => {
        const packed = packEquipmentBoxes(100, [large, small]);

        expect(packed).toEqual([{ box: large, quantity: 2, volumeUsed: 100 }]);
    });

    test('falls back to the smallest box when nothing fits the remainder', () => {
        // 3L -> no bulk fill, small (5L) is the smallest that fits
        const packed = packEquipmentBoxes(3, [large, medium, small]);

        expect(packed).toEqual([{ box: small, quantity: 1, volumeUsed: 3 }]);
    });

    test('returns nothing for zero volume', () => {
        expect(packEquipmentBoxes(0, [large, small])).toEqual([]);
    });

    test('a single box size is only ever used once (current behaviour)', () => {
        // The bulk-fill phase skips the smallest size, so with one size the
        // whole volume lands in the remainder pass, which adds a single box.
        const packed = packEquipmentBoxes(100, [small]);

        expect(packed).toEqual([{ box: small, quantity: 1, volumeUsed: 100 }]);
    });
});

describe('buildParcels', () => {
    test('expands box groups into one parcel per box', () => {
        const parcels = buildParcels(
            [
                { lengthInCm: 40, widthInCm: 30, heightInCm: 20, weightInGrams: 500, quantity: 2 },
                { lengthInCm: 20, widthInCm: 15, heightInCm: 10, weightInGrams: 250, quantity: 1 }
            ],
            0
        );

        expect(parcels).toHaveLength(3);
        expect(parcels[0]).toEqual({
            submitted_length_cm: 40,
            submitted_width_cm: 30,
            submitted_height_cm: 20,
            submitted_weight_kg: 0.5
        });
        expect(parcels[2].submitted_length_cm).toBe(20);
    });

    test('distributes the product weight evenly across all boxes', () => {
        const parcels = buildParcels(
            [
                { lengthInCm: 40, widthInCm: 30, heightInCm: 20, weightInGrams: 500, quantity: 3 },
                { lengthInCm: 20, widthInCm: 15, heightInCm: 10, weightInGrams: 1000, quantity: 1 }
            ],
            8 // 8kg of product over 4 boxes -> 2kg each
        );

        expect(parcels.map(p => p.submitted_weight_kg)).toEqual([2.5, 2.5, 2.5, 3]);
    });

    test('returns nothing when there are no boxes', () => {
        expect(buildParcels([], 10)).toEqual([]);
    });
});

describe('mapRates', () => {
    function rawRate(rate: number, overrides: any = {}) {
        return {
            rate,
            rate_excluding_vat: rate / 1.15,
            // base_rate.vat excludes VAT charged on surcharges, so it is
            // deliberately smaller than (rate - rate_excluding_vat) here
            base_rate: { vat: (rate - rate / 1.15) * 0.9, vat_percentage: 15 },
            charged_weight: 12,
            actual_weight: 10,
            volumetric_weight: 12,
            service_level: {
                code: 'ECO',
                name: 'Economy',
                description: 'Standard road freight',
                delivery_date_from: '2026-08-10',
                delivery_date_to: '2026-08-12',
                collection_date: '2026-08-07',
                collection_cut_off_time: '10:00',
                ...overrides.service_level
            },
            ...overrides
        };
    }

    test('sorts rates cheapest first', () => {
        const mapped = mapRates([
            rawRate(200, { service_level: { code: 'EXP', name: 'Express' } }),
            rawRate(100)
        ]);

        expect(mapped.map(r => r.serviceLevel.code)).toEqual(['ECO', 'EXP']);
    });

    test('applies the markup to all monetary amounts', () => {
        const [mapped] = mapRates([rawRate(115)]);

        expect(mapped.pricing.rate).toBeCloseTo(115 * DELIVERY_MARKUP);
        expect(mapped.pricing.rateExcludingVat).toBeCloseTo(100 * DELIVERY_MARKUP);
        expect(mapped.pricing.vat).toBeCloseTo(15 * DELIVERY_MARKUP);
    });

    test('vat is the total VAT on the fee, not the base-rate-only VAT', () => {
        const [mapped] = mapRates([rawRate(115)]);

        expect(mapped.pricing.vat).toBeCloseTo(mapped.pricing.rate - mapped.pricing.rateExcludingVat);
    });

    test('does not apply the markup to the VAT percentage', () => {
        const [mapped] = mapRates([rawRate(115)]);

        expect(mapped.pricing.vatPercentage).toBe(15);
    });

    test('passes weights and service level details through', () => {
        const [mapped] = mapRates([rawRate(115)]);

        expect(mapped.weights).toEqual({ chargedWeight: 12, actualWeight: 10, volumetricWeight: 12 });
        expect(mapped.serviceLevel.name).toBe('Economy');
        expect(mapped.serviceLevel.deliveryDateFrom).toBe('2026-08-10');
    });
});

describe('validateRateLines', () => {
    function product(overrides: Partial<RateLineProduct> = {}): RateLineProduct {
        return {
            sku: 'GOOD-1',
            name: 'Good product',
            isEnabled: true,
            volumeInLitres: 2.5,
            weightInGrams: 800,
            ...overrides
        };
    }

    test('returns no issues for valid lines', () => {
        const issues = validateRateLines(
            [{ sku: 'GOOD-1', quantity: 3 }],
            new Map([['GOOD-1', product()]])
        );

        expect(issues).toEqual([]);
    });

    test('requires at least one line', () => {
        expect(validateRateLines([], new Map())).toEqual(['at least one line item is required']);
    });

    test('reports every problem across all lines in one pass', () => {
        const issues = validateRateLines(
            [
                { sku: 'MISSING', quantity: 1 },
                { sku: 'DISABLED', quantity: 1 },
                { sku: 'NO-DIMS', quantity: 1 },
                { sku: 'NO-WEIGHT', quantity: 0 }
            ],
            new Map([
                ['MISSING', null],
                ['DISABLED', product({ sku: 'DISABLED', isEnabled: false })],
                ['NO-DIMS', product({ sku: 'NO-DIMS', volumeInLitres: null })],
                ['NO-WEIGHT', product({ sku: 'NO-WEIGHT', weightInGrams: null })]
            ])
        );

        expect(issues).toEqual([
            'SKU "MISSING": no product with this SKU exists',
            'SKU "DISABLED": product is disabled',
            'SKU "NO-DIMS": product is missing dimensions (length, width and height must be set)',
            'SKU "NO-WEIGHT": quantity must be a whole number of 1 or more (got 0)',
            'SKU "NO-WEIGHT": product is missing a weight (weightInGrams must be greater than 0)'
        ]);
    });

    test('rejects zero-volume and zero-weight products', () => {
        const issues = validateRateLines(
            [{ sku: 'ZERO', quantity: 1 }],
            new Map([['ZERO', product({ sku: 'ZERO', volumeInLitres: 0, weightInGrams: 0 })]])
        );

        expect(issues).toEqual([
            'SKU "ZERO": product is missing dimensions (length, width and height must be set)',
            'SKU "ZERO": product is missing a weight (weightInGrams must be greater than 0)'
        ]);
    });

    test('rejects fractional and missing quantities', () => {
        const issues = validateRateLines(
            [{ sku: 'GOOD-1', quantity: 1.5 }],
            new Map([['GOOD-1', product()]])
        );

        expect(issues).toEqual(['SKU "GOOD-1": quantity must be a whole number of 1 or more (got 1.5)']);
    });

    test('rejects lines without a sku', () => {
        const issues = validateRateLines([{ sku: '', quantity: 1 }], new Map());

        expect(issues).toEqual(['each line item must have a sku']);
    });
});
