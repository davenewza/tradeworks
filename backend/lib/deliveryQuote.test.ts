import { models, resetDatabase } from '@teamkeel/testing';
import { BoxType } from '@teamkeel/sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { COLLECTION_ADDRESS, DELIVERY_MARKUP } from './deliveryHelpers';
import { DeliveryQuoteAddress, quoteDelivery, toShipLogicAddress } from './deliveryQuote';

// The quote shared by the getDeliveryRates API and the Console's shipping
// calculator, end to end against the database, with ShipLogic stubbed: what
// is sent to the courier, and what comes back from it.

const SHIPLOGIC = { apiUrl: 'https://shiplogic.test/rates', apiKey: 'test-key' };

const ADDRESS: DeliveryQuoteAddress = {
    organisation: 'Acme (Pty) Ltd',
    addressLine1: '1 Main Rd',
    addressLine2: 'Unit 4',
    suburb: 'Claremont',
    city: 'Cape Town',
    province: 'Western Cape',
    postalCode: '7708'
};

function shipLogicRate(code: string, rate: number, rateExcludingVat: number) {
    return {
        rate,
        rate_excluding_vat: rateExcludingVat,
        base_rate: { vat_percentage: 15 },
        service_level: {
            code,
            name: `${code} service`,
            description: `${code} description`,
            delivery_date_from: '2026-10-15T09:00:00+02:00',
            delivery_date_to: '2026-10-16T17:00:00+02:00'
        },
        charged_weight: 5,
        actual_weight: 2.75,
        volumetric_weight: 5
    };
}

// Stubs ShipLogic, recording each request body it is sent.
function stubShipLogic(response: { status?: number; body: unknown }) {
    const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init: RequestInit) => {
            calls.push({ url, init, body: JSON.parse(String(init.body)) });
            return new Response(JSON.stringify(response.body), { status: response.status ?? 200 });
        })
    );
    return calls;
}

// Two products totalling 8 L and 2 kg, and cardboard boxes of 5 L and 4 L
// effective volume — so the shipment packs into one of each.
async function seedCatalogue() {
    const brand = await models.brand.create({ name: 'Acme' });
    // 2 L, 500 g
    await models.product.create({
        name: 'Widget', sku: 'W-1', brandId: brand.id,
        lengthInCm: 20, widthInCm: 10, heightInCm: 10, weightInGrams: 500
    });
    // 1 L, 250 g
    await models.product.create({
        name: 'Gadget', sku: 'G-1', brandId: brand.id,
        lengthInCm: 10, widthInCm: 10, heightInCm: 10, weightInGrams: 250
    });
    await models.product.create({
        name: 'Retired', sku: 'R-1', brandId: brand.id, isActive: false,
        lengthInCm: 10, widthInCm: 10, heightInCm: 10, weightInGrams: 250
    });
    await models.product.create({ name: 'Unmeasured', sku: 'U-1', brandId: brand.id });

    await models.equipmentBox.create({
        name: 'Cardboard Large', sku: 'CB-L', boxType: BoxType.Cardboard, priceInclVat: 0,
        lengthInCm: 60, widthInCm: 45, heightInCm: 30, weightInGrams: 600,
        holdingVolumeInLitres: 10, volumeUtilisationQuotient: 0.5
    });
    await models.equipmentBox.create({
        name: 'Cardboard Small', sku: 'CB-S', boxType: BoxType.Cardboard, priceInclVat: 0,
        lengthInCm: 38.5, widthInCm: 26.5, heightInCm: 26, weightInGrams: 150,
        holdingVolumeInLitres: 4, volumeUtilisationQuotient: 1
    });
    // Disabled boxes are never packed.
    const disabled = await models.equipmentBox.create({
        name: 'Cardboard Huge', sku: 'CB-H', boxType: BoxType.Cardboard, priceInclVat: 0,
        lengthInCm: 100, widthInCm: 100, heightInCm: 100, weightInGrams: 2000,
        holdingVolumeInLitres: 500, volumeUtilisationQuotient: 1
    });
    await models.equipmentBox.update({ id: disabled.id }, { isEnabled: false });
    await models.equipmentBox.create({
        name: 'Plastic Crate', sku: 'PC-1', boxType: BoxType.PlasticEquipment, priceInclVat: 115,
        lengthInCm: 50, widthInCm: 40, heightInCm: 30, weightInGrams: 1200,
        holdingVolumeInLitres: 20, volumeUtilisationQuotient: 1
    });
}

const LINES = [
    { sku: 'W-1', quantity: 3 },
    { sku: 'G-1', quantity: 2 }
];

describe('quoteDelivery', () => {
    beforeEach(resetDatabase);
    afterEach(() => vi.unstubAllGlobals());

    test('packs, parcels and prices the shipment, cheapest service first with the markup applied', async () => {
        await seedCatalogue();
        const calls = stubShipLogic({
            body: { rates: [shipLogicRate('OVN', 230, 200), shipLogicRate('ECO', 115, 100)] }
        });

        const outcome = await quoteDelivery({ lines: LINES, deliveryAddress: ADDRESS, boxType: BoxType.Cardboard }, SHIPLOGIC);

        // One request to the configured ShipLogic host, with our key.
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(SHIPLOGIC.apiUrl);
        expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
        expect(calls[0].body.collection_address).toEqual(COLLECTION_ADDRESS);
        expect(calls[0].body.delivery_address).toEqual({
            type: 'business',
            company: 'Acme (Pty) Ltd',
            street_address: '1 Main Rd, Unit 4',
            local_area: 'Claremont',
            city: 'Cape Town',
            zone: 'Western Cape',
            country: 'ZA',
            code: '7708'
        });
        // 8 L → one 5 L large box, 3 L remainder → the 4 L small box. The
        // 2 kg of product is split evenly across the two boxes.
        const parcels = calls[0].body.parcels;
        expect(parcels).toHaveLength(2);
        expect(parcels[0]).toMatchObject({ submitted_length_cm: 60, submitted_width_cm: 45, submitted_height_cm: 30 });
        expect(parcels[0].submitted_weight_kg).toBeCloseTo(1.6);
        expect(parcels[1]).toMatchObject({ submitted_length_cm: 38.5, submitted_width_cm: 26.5, submitted_height_cm: 26 });
        expect(parcels[1].submitted_weight_kg).toBeCloseTo(1.15);

        expect(outcome.status).toBe('quoted');
        if (outcome.status !== 'quoted') return;
        const quote = outcome.quote;
        expect(quote.deliveryService).toBe('ECO service');
        expect(quote.deliveryFee).toBeCloseTo(100 * DELIVERY_MARKUP);
        expect(quote.deliveryFeeInclVat).toBeCloseTo(115 * DELIVERY_MARKUP);
        expect(quote.boxType).toBe(BoxType.Cardboard);
        expect(quote.boxes.map((b) => [b.name, b.sku, b.quantity])).toEqual([
            ['Cardboard Large', 'CB-L', 1],
            ['Cardboard Small', 'CB-S', 1]
        ]);
        expect(quote.totalParcels).toBe(2);
        expect(quote.totalWeightKg).toBeCloseTo(2.75);
        expect(quote.rates.map((r) => r.serviceLevel.code)).toEqual(['ECO', 'OVN']);
        expect(quote.rates[1].pricing.rateExcludingVat).toBeCloseTo(200 * DELIVERY_MARKUP);
    });

    test('packs into plastic equipment boxes, priced per box, when asked to', async () => {
        await seedCatalogue();
        const calls = stubShipLogic({ body: { rates: [shipLogicRate('ECO', 115, 100)] } });

        const outcome = await quoteDelivery({ lines: LINES, deliveryAddress: ADDRESS, boxType: BoxType.PlasticEquipment }, SHIPLOGIC);

        expect(calls[0].body.parcels).toHaveLength(1);
        expect(outcome.status).toBe('quoted');
        if (outcome.status !== 'quoted') return;
        expect(outcome.quote.boxType).toBe(BoxType.PlasticEquipment);
        expect(outcome.quote.boxes).toHaveLength(1);
        expect(outcome.quote.boxes[0]).toMatchObject({ name: 'Plastic Crate', quantity: 1, priceInclVat: 115 });
        expect(outcome.quote.boxes[0].priceExclVat).toBeCloseTo(100);
    });

    test('adds up the same SKU across lines', async () => {
        await seedCatalogue();
        const calls = stubShipLogic({ body: { rates: [shipLogicRate('ECO', 115, 100)] } });

        await quoteDelivery(
            {
                lines: [{ sku: 'W-1', quantity: 1 }, { sku: 'W-1', quantity: 2 }, { sku: 'G-1', quantity: 2 }],
                deliveryAddress: ADDRESS,
                boxType: BoxType.Cardboard
            },
            SHIPLOGIC
        );

        // Same 8 L / 2 kg as LINES.
        const weights = calls[0].body.parcels.map((p: any) => p.submitted_weight_kg);
        expect(weights).toHaveLength(2);
        expect(weights[0] + weights[1]).toBeCloseTo(2.75);
    });

    test('reports every problem with the lines at once, without calling the courier', async () => {
        await seedCatalogue();
        const calls = stubShipLogic({ body: { rates: [] } });

        const outcome = await quoteDelivery(
            {
                lines: [
                    { sku: 'NOPE', quantity: 1 },
                    { sku: 'R-1', quantity: 1 },
                    { sku: 'U-1', quantity: 0 }
                ],
                deliveryAddress: ADDRESS,
                boxType: BoxType.Cardboard
            },
            SHIPLOGIC
        );

        expect(outcome).toEqual({
            status: 'invalid',
            issues: [
                'SKU "NOPE": no product with this SKU exists',
                'SKU "R-1": product is inactive',
                'SKU "U-1": quantity must be a whole number of 1 or more (got 0)',
                'SKU "U-1": product is missing dimensions (length, width and height must be set)',
                'SKU "U-1": product is missing a weight (weightInGrams must be greater than 0)'
            ]
        });
        expect(calls).toHaveLength(0);
    });

    test('refuses a box type with no enabled boxes', async () => {
        await seedCatalogue();
        const calls = stubShipLogic({ body: { rates: [] } });
        const plastic = await models.equipmentBox.findMany({ where: { boxType: BoxType.PlasticEquipment } });
        for (const box of plastic) {
            await models.equipmentBox.update({ id: box.id }, { isEnabled: false });
        }

        const outcome = await quoteDelivery({ lines: LINES, deliveryAddress: ADDRESS, boxType: BoxType.PlasticEquipment }, SHIPLOGIC);

        expect(outcome).toEqual({ status: 'invalid', issues: ['no PlasticEquipment equipment boxes are configured'] });
        expect(calls).toHaveLength(0);
    });

    test('says so when the courier has no service to the address', async () => {
        await seedCatalogue();
        stubShipLogic({ body: { rates: [] } });

        const outcome = await quoteDelivery({ lines: LINES, deliveryAddress: ADDRESS, boxType: BoxType.Cardboard }, SHIPLOGIC);

        expect(outcome).toEqual({ status: 'noRates' });
    });

    test('throws the courier’s own error', async () => {
        await seedCatalogue();
        stubShipLogic({ status: 401, body: { message: 'unauthorised' } });

        await expect(
            quoteDelivery({ lines: LINES, deliveryAddress: ADDRESS, boxType: BoxType.Cardboard }, SHIPLOGIC)
        ).rejects.toThrow('Shiplogic API error: 401');
    });
});

describe('toShipLogicAddress', () => {
    test('leaves the second line and company out when they are blank, and defaults to South Africa', () => {
        expect(
            toShipLogicAddress({
                addressLine1: '1 Main Rd',
                addressLine2: null,
                suburb: 'Claremont',
                city: 'Cape Town',
                province: 'Western Cape',
                postalCode: '7708'
            })
        ).toEqual({
            type: 'business',
            company: '',
            street_address: '1 Main Rd',
            local_area: 'Claremont',
            city: 'Cape Town',
            zone: 'Western Cape',
            country: 'ZA',
            code: '7708'
        });
    });
});
