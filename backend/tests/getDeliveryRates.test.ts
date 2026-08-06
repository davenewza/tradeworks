import { BoxType } from '@teamkeel/sdk';
import { models, resetDatabase } from '@teamkeel/testing';
import { createServer, Server } from 'http';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

// The getDeliveryRates action authenticates with an API key header rather
// than an identity, so these tests call the JSON API directly instead of
// going through the generated actions client (which cannot set headers).
//
// Run with `npm test`, which first stores the dummy API key below in the
// keel CLI's test-environment secrets (keel test can only read secrets from
// ~/.keel/config.yaml, so this is per machine). Running `keel test` directly
// works too once that one-time setup has happened.
//
// ShipLogic is mocked: keelconfig.test.yaml points SHIPLOGIC_API_URL at the
// local server started below, so no real network calls are made.

const API_KEY = 'test-delivery-api-key';
const MOCK_SHIPLOGIC_PORT = 59991;

const VALID_ADDRESS = {
    addressLine1: '1 Test Rd',
    addressLine2: 'Unit 4',
    suburb: 'Claremont',
    city: 'Cape Town',
    province: 'Western Cape',
    postalCode: '7708',
    organisation: 'Acme Ltd'
};

function mockRate(rate: number, code: string, name: string) {
    return {
        rate,
        rate_excluding_vat: rate / 1.15,
        base_rate: { vat: rate - rate / 1.15, vat_percentage: 15 },
        charged_weight: 15,
        actual_weight: 12.8,
        volumetric_weight: 15,
        service_level: {
            code,
            name,
            description: `${name} service`,
            delivery_date_from: '2026-08-10',
            delivery_date_to: '2026-08-12',
            collection_date: '2026-08-07',
            collection_cut_off_time: '10:00'
        }
    };
}

let mockShipLogic: Server;
const shipLogicRequests: any[] = [];

async function callGetDeliveryRates(body: unknown, apiKey?: string) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey !== undefined) {
        headers['X-API-KEY'] = apiKey;
    }
    const response = await fetch(`${process.env.KEEL_TESTING_ACTIONS_API_URL}/getDeliveryRates`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
}

async function seedCatalogue() {
    const brand = await models.brand.create({ name: 'Test Brand' });
    await models.product.create({
        name: 'Widget',
        brandId: brand.id,
        sku: 'WIDGET-1',
        lengthInCm: 30,
        widthInCm: 20,
        heightInCm: 10, // 6L, so 2 units (12L) fit one box below
        weightInGrams: 2000,
        isEnabled: true
    });
    await models.equipmentBox.create({
        name: 'Test Box',
        boxType: BoxType.Cardboard,
        priceInclVat: 115,
        lengthInCm: 60,
        widthInCm: 40,
        heightInCm: 40,
        weightInGrams: 800,
        holdingVolumeInLitres: 90,
        volumeUtilisationQuotient: 0.9, // 81L effective
        isEnabled: true
    });
    return brand;
}

beforeAll(async () => {
    mockShipLogic = createServer((req, res) => {
        let data = '';
        req.on('data', chunk => (data += chunk));
        req.on('end', () => {
            shipLogicRequests.push(JSON.parse(data));
            const body = JSON.stringify({
                rates: [mockRate(230, 'EXP', 'Express'), mockRate(115, 'ECO', 'Economy')]
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(body);
        });
    });
    await new Promise<void>(resolve => mockShipLogic.listen(MOCK_SHIPLOGIC_PORT, '127.0.0.1', resolve));

    // Fail fast with a useful message if auth is not being enforced, which
    // happens when the DELIVERY_API_KEY secret is missing from the test env.
    const probe = await callGetDeliveryRates({ lines: [], deliveryAddress: VALID_ADDRESS });
    if (probe.status !== 403) {
        throw new Error(
            'getDeliveryRates did not reject an unauthenticated request - is the test secret set? ' +
                'Run tests with `npm test`, or run once: ' +
                'keel secrets set --env test DELIVERY_API_KEY test-delivery-api-key'
        );
    }
});

afterAll(() => {
    mockShipLogic?.close();
});

beforeEach(async () => {
    await resetDatabase();
    shipLogicRequests.length = 0;
});

describe('authentication', () => {
    test('rejects requests without an API key', async () => {
        const { status, body } = await callGetDeliveryRates({
            lines: [{ sku: 'WIDGET-1', quantity: 1 }],
            deliveryAddress: VALID_ADDRESS
        });

        expect(status).toBe(403);
        expect(body.code).toBe('ERR_PERMISSION_DENIED');
    });

    test('rejects requests with a wrong API key', async () => {
        const { status, body } = await callGetDeliveryRates(
            { lines: [{ sku: 'WIDGET-1', quantity: 1 }], deliveryAddress: VALID_ADDRESS },
            'not-the-key'
        );

        expect(status).toBe(403);
        expect(body.code).toBe('ERR_PERMISSION_DENIED');
    });
});

describe('validation', () => {
    test('rejects an empty line list', async () => {
        const { status, body } = await callGetDeliveryRates(
            { lines: [], deliveryAddress: VALID_ADDRESS },
            API_KEY
        );

        expect(status).toBe(500);
        expect(body.message).toBe('Cannot calculate delivery rates: at least one line item is required');
    });

    test('rejects an unknown SKU', async () => {
        const { status, body } = await callGetDeliveryRates(
            { lines: [{ sku: 'NOPE-1', quantity: 1 }], deliveryAddress: VALID_ADDRESS },
            API_KEY
        );

        expect(status).toBe(500);
        expect(body.message).toBe(
            'Cannot calculate delivery rates: SKU "NOPE-1": no product with this SKU exists'
        );
    });

    test('reports every invalid line in a single message', async () => {
        const brand = await seedCatalogue();
        await models.product.create({
            name: 'Disabled',
            brandId: brand.id,
            sku: 'DISABLED-1',
            lengthInCm: 10,
            widthInCm: 10,
            heightInCm: 10,
            weightInGrams: 100,
            isEnabled: false
        });
        await models.product.create({
            name: 'No dims',
            brandId: brand.id,
            sku: 'NO-DIMS-1',
            weightInGrams: 100,
            isEnabled: true
        });
        await models.product.create({
            name: 'No weight',
            brandId: brand.id,
            sku: 'NO-WEIGHT-1',
            lengthInCm: 10,
            widthInCm: 10,
            heightInCm: 10,
            isEnabled: true
        });

        const { status, body } = await callGetDeliveryRates(
            {
                lines: [
                    { sku: 'DISABLED-1', quantity: 1 },
                    { sku: 'NO-DIMS-1', quantity: 1 },
                    { sku: 'NO-WEIGHT-1', quantity: 0 },
                    { sku: 'MISSING-1', quantity: 1 }
                ],
                deliveryAddress: VALID_ADDRESS
            },
            API_KEY
        );

        expect(status).toBe(500);
        expect(body.message).toBe(
            'Cannot calculate delivery rates: ' +
                'SKU "DISABLED-1": product is disabled; ' +
                'SKU "NO-DIMS-1": product is missing dimensions (length, width and height must be set); ' +
                'SKU "NO-WEIGHT-1": quantity must be a whole number of 1 or more (got 0); ' +
                'SKU "NO-WEIGHT-1": product is missing a weight (weightInGrams must be greater than 0); ' +
                'SKU "MISSING-1": no product with this SKU exists'
        );
    });

    test('rejects when no equipment boxes exist for the requested box type', async () => {
        await seedCatalogue(); // only seeds a Cardboard box

        const { status, body } = await callGetDeliveryRates(
            {
                lines: [{ sku: 'WIDGET-1', quantity: 1 }],
                deliveryAddress: VALID_ADDRESS,
                includeEquipmentBox: true
            },
            API_KEY
        );

        expect(status).toBe(500);
        expect(body.message).toBe(
            'Cannot calculate delivery rates: no PlasticEquipment equipment boxes are configured'
        );
    });
});

describe('rates', () => {
    test('returns marked-up rates, cheapest first, with the derived box breakdown', async () => {
        await seedCatalogue();

        const { status, body } = await callGetDeliveryRates(
            {
                lines: [{ sku: 'WIDGET-1', quantity: 2 }],
                deliveryAddress: VALID_ADDRESS,
                includeEquipmentBox: false
            },
            API_KEY
        );

        expect(status).toBe(200);

        // Cheapest rate (Economy, raw 115 incl VAT / 100 excl) with 10% markup
        expect(body.deliveryService).toBe('Economy');
        expect(body.deliveryFee).toBeCloseTo(110);
        expect(body.deliveryFeeInclVat).toBeCloseTo(126.5);

        // 2 x 6L widgets pack into one 81L-effective box
        expect(body.boxType).toBe('Cardboard');
        expect(body.boxes).toEqual([
            expect.objectContaining({ name: 'Test Box', quantity: 1, priceExclVat: 100, priceInclVat: 115 })
        ]);
        expect(body.totalParcels).toBe(1);
        // 2 x 2kg product + 0.8kg box
        expect(body.totalWeightKg).toBeCloseTo(4.8);

        expect(body.rates.map((r: any) => r.serviceLevel.code)).toEqual(['ECO', 'EXP']);
        expect(body.rates[0].pricing.rate).toBeCloseTo(115 * 1.1);
        expect(body.rates[0].pricing.rateExcludingVat).toBeCloseTo(100 * 1.1);
        // Regression: the VAT percentage must not have the markup applied
        expect(body.rates[0].pricing.vatPercentage).toBe(15);

        // ShipLogic received one parcel with box dimensions and combined weight
        expect(shipLogicRequests).toHaveLength(1);
        expect(shipLogicRequests[0].delivery_address).toEqual(
            expect.objectContaining({
                street_address: '1 Test Rd, Unit 4',
                local_area: 'Claremont',
                city: 'Cape Town',
                zone: 'Western Cape',
                country: 'ZA',
                code: '7708',
                company: 'Acme Ltd'
            })
        );
        expect(shipLogicRequests[0].parcels).toEqual([
            {
                submitted_length_cm: 60,
                submitted_width_cm: 40,
                submitted_height_cm: 40,
                submitted_weight_kg: 4.8
            }
        ]);
    });

    test('uses plastic equipment boxes when includeEquipmentBox is true', async () => {
        await seedCatalogue();
        await models.equipmentBox.create({
            name: 'Plastic Box',
            boxType: BoxType.PlasticEquipment,
            priceInclVat: 230,
            lengthInCm: 60,
            widthInCm: 40,
            heightInCm: 40,
            weightInGrams: 1500,
            holdingVolumeInLitres: 90,
            volumeUtilisationQuotient: 0.9,
            isEnabled: true
        });

        const { status, body } = await callGetDeliveryRates(
            {
                lines: [{ sku: 'WIDGET-1', quantity: 2 }],
                deliveryAddress: VALID_ADDRESS,
                includeEquipmentBox: true
            },
            API_KEY
        );

        expect(status).toBe(200);
        expect(body.boxType).toBe('PlasticEquipment');
        expect(body.boxes).toEqual([expect.objectContaining({ name: 'Plastic Box', quantity: 1 })]);
        // 4kg product + 1.5kg plastic box
        expect(body.totalWeightKg).toBeCloseTo(5.5);
    });

    test('defaults the country to ZA when omitted', async () => {
        await seedCatalogue();
        const { addressLine2, organisation, country, ...rest } = VALID_ADDRESS as any;

        const { status } = await callGetDeliveryRates(
            { lines: [{ sku: 'WIDGET-1', quantity: 1 }], deliveryAddress: rest },
            API_KEY
        );

        expect(status).toBe(200);
        expect(shipLogicRequests[0].delivery_address.country).toBe('ZA');
        expect(shipLogicRequests[0].delivery_address.street_address).toBe('1 Test Rd');
    });
});
