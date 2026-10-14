import { models, resetDatabase } from '@teamkeel/testing';
import { BoxType } from '@teamkeel/sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MappedRate } from './deliveryHelpers';
import { DeliveryQuote } from './deliveryQuote';
import {
    Shipment,
    boxRows,
    calculateShipment,
    describeAddress,
    describeShippingData,
    formatDeliveryWindow,
    issuesMarkdown,
    loadProductNames,
    productRows,
    rateRows,
    readShipmentPage,
    searchShippableProducts,
    shipmentFacts,
    shipmentTotals,
    totalsItems,
    validateShipmentPage
} from './shippingCalculator';

const ADDRESS_FIELDS = {
    addressLine1: '1 Main Rd',
    suburb: 'Claremont',
    city: 'Cape Town',
    province: 'Western Cape',
    postalCode: '7708'
};

function rate(overrides: { code: string; excl: number; incl: number; from?: string; to?: string; charged?: number }): MappedRate {
    return {
        serviceLevel: {
            code: overrides.code,
            name: `${overrides.code} service`,
            deliveryDateFrom: overrides.from,
            deliveryDateTo: overrides.to
        },
        pricing: {
            rate: overrides.incl,
            rateExcludingVat: overrides.excl,
            vat: overrides.incl - overrides.excl,
            vatPercentage: 15
        },
        weights: { chargedWeight: overrides.charged, actualWeight: 2.75 }
    };
}

// Delivery R110 excl / R126.50 incl, plus two plastic crates at R100 / R115.
const QUOTE: DeliveryQuote = {
    deliveryService: 'ECO service',
    deliveryFee: 110,
    deliveryFeeInclVat: 126.5,
    boxType: BoxType.PlasticEquipment,
    boxes: [
        {
            name: 'Plastic Crate', sku: 'PC-1', quantity: 2, priceExclVat: 100, priceInclVat: 115,
            lengthInCm: 50, widthInCm: 40, heightInCm: 30.5, weightInGrams: 1200
        }
    ],
    totalParcels: 2,
    totalWeightKg: 6.4,
    rates: [
        rate({ code: 'ECO', excl: 110, incl: 126.5, from: '2026-10-15T09:00:00+02:00', to: '2026-10-16T17:00:00+02:00', charged: 15 }),
        rate({ code: 'LSE', excl: 220, incl: 253, from: '2026-10-14T09:00:00+02:00', to: '2026-10-14T15:00:00+02:00' })
    ]
};

const SHIPMENT: Shipment = {
    lines: [{ sku: 'W-1', quantity: 3 }],
    boxType: BoxType.PlasticEquipment,
    address: { ...ADDRESS_FIELDS, organisation: 'Acme', addressLine2: null, country: 'ZA' }
};

describe('validateShipmentPage', () => {
    test('needs at least one product, ignoring rows added but never filled', () => {
        expect(validateShipmentPage({ ...ADDRESS_FIELDS, lines: [] })).toBe('Add at least one product.');
        expect(validateShipmentPage({ ...ADDRESS_FIELDS, lines: [{ sku: null, quantity: 1 }, { sku: '  ', quantity: 1 }] })).toBe(
            'Add at least one product.'
        );
    });

    test('needs a whole quantity of 1 or more on every product', () => {
        expect(validateShipmentPage({ ...ADDRESS_FIELDS, lines: [{ sku: 'W-1', quantity: 0 }] })).toBe(
            'Set a whole quantity of 1 or more for W-1.'
        );
        expect(validateShipmentPage({ ...ADDRESS_FIELDS, lines: [{ sku: 'W-1', quantity: 1.5 }] })).toBe(
            'Set a whole quantity of 1 or more for W-1.'
        );
        expect(validateShipmentPage({ ...ADDRESS_FIELDS, lines: [{ sku: 'W-1', quantity: null }] })).toBe(
            'Set a whole quantity of 1 or more for W-1.'
        );
    });

    test('names every blank required address field', () => {
        expect(
            validateShipmentPage({ lines: [{ sku: 'W-1', quantity: 1 }], addressLine1: ' ', suburb: 'Claremont', city: 'Cape Town' })
        ).toBe('Enter the street address, province, postal code.');
    });

    test('accepts a complete shipment', () => {
        expect(validateShipmentPage({ ...ADDRESS_FIELDS, lines: [{ sku: 'W-1', quantity: '2' }] })).toBe(true);
    });
});

describe('readShipmentPage', () => {
    test('drops blank rows, trims, and leaves blank optional fields out', () => {
        expect(
            readShipmentPage({
                lines: [{ sku: ' W-1 ', quantity: '3' }, { sku: null, quantity: 1 }],
                boxType: BoxType.PlasticEquipment,
                organisation: '  ',
                addressLine1: ' 1 Main Rd ',
                addressLine2: '',
                suburb: 'Claremont',
                city: 'Cape Town',
                province: 'Western Cape',
                postalCode: ' 7708'
            })
        ).toEqual({
            lines: [{ sku: 'W-1', quantity: 3 }],
            boxType: BoxType.PlasticEquipment,
            address: {
                organisation: null,
                addressLine1: '1 Main Rd',
                addressLine2: null,
                suburb: 'Claremont',
                city: 'Cape Town',
                province: 'Western Cape',
                postalCode: '7708',
                country: 'ZA'
            }
        });
    });

    test('packs in cardboard unless plastic was chosen', () => {
        expect(readShipmentPage({ ...ADDRESS_FIELDS, lines: [] }).boxType).toBe(BoxType.Cardboard);
    });
});

describe('describeShippingData', () => {
    test('shows weight and volume', () => {
        expect(describeShippingData(1250, 2.5)).toBe('1.25 kg · 2.5 L');
    });

    test('says what is missing', () => {
        expect(describeShippingData(null, 2)).toBe('No weight — cannot be quoted');
        expect(describeShippingData(0, null)).toBe('No dimensions or weight — cannot be quoted');
    });
});

describe('formatDeliveryWindow', () => {
    test('shows the hours of a same-day window, in South African time', () => {
        expect(formatDeliveryWindow(QUOTE.rates[1])).toBe('Wed 14 Oct 09:00–15:00');
    });

    test('shows the days of a window across days', () => {
        expect(formatDeliveryWindow(QUOTE.rates[0])).toBe('Thu 15 Oct – Fri 16 Oct');
    });

    test('is blank without an estimate, and one day with only one end', () => {
        expect(formatDeliveryWindow(rate({ code: 'X', excl: 1, incl: 1 }))).toBe('');
        expect(formatDeliveryWindow(rate({ code: 'X', excl: 1, incl: 1, to: '2026-10-16T17:00:00+02:00' }))).toBe('Fri 16 Oct');
    });
});

describe('shipment totals', () => {
    test('add the box charge to the cheapest delivery fee', () => {
        const totals = shipmentTotals(QUOTE);
        expect(totals.deliveryExclVat).toBe(110);
        expect(totals.boxesExclVat).toBe(200);
        expect(totals.vat).toBeCloseTo(16.5 + 30);
        expect(totals.totalInclVat).toBeCloseTo(356.5);
    });

    test('are listed delivery, boxes, VAT, then the total', () => {
        expect(totalsItems(QUOTE)).toEqual([
            { label: 'Delivery — ECO service', value: 'R 110.00' },
            { label: 'Plastic equipment boxes', value: 'R 200.00' },
            { label: 'VAT', value: 'R 46.50' },
            { label: 'Total incl. VAT', value: 'R 356.50', important: true }
        ]);
    });
});

describe('results rows', () => {
    test('one row per courier option', () => {
        expect(rateRows(QUOTE)).toEqual([
            {
                Service: 'ECO service',
                'Estimated delivery': 'Thu 15 Oct – Fri 16 Oct',
                'Excl. VAT': 'R 110.00',
                'Incl. VAT': 'R 126.50',
                'Charged weight': '15 kg'
            },
            {
                Service: 'LSE service',
                'Estimated delivery': 'Wed 14 Oct 09:00–15:00',
                'Excl. VAT': 'R 220.00',
                'Incl. VAT': 'R 253.00',
                'Charged weight': ''
            }
        ]);
    });

    test('one row per box size', () => {
        expect(boxRows(QUOTE)).toEqual([
            {
                Box: 'Plastic Crate',
                Qty: 2,
                'Size (cm)': '50 × 40 × 30.5',
                'Empty weight': '1.2 kg',
                'Each excl. VAT': 'R 100.00',
                'Total incl. VAT': 'R 230.00'
            }
        ]);
    });

    test('the shipment’s facts, with the cheapest service’s charged weight', () => {
        expect(shipmentFacts(QUOTE, SHIPMENT)).toEqual([
            { key: 'Deliver to', value: 'Acme, 1 Main Rd, Claremont, Cape Town, Western Cape 7708' },
            { key: 'Packed in', value: 'Plastic equipment boxes' },
            { key: 'Parcels', value: 2 },
            { key: 'Actual weight', value: '6.4 kg' },
            { key: 'Charged weight', value: '15 kg' }
        ]);
    });

    test('the products, named where the SKU is known', () => {
        expect(productRows({ ...SHIPMENT, lines: [...SHIPMENT.lines, { sku: 'GONE', quantity: 1 }] }, { 'W-1': 'Widget' })).toEqual([
            { SKU: 'W-1', Product: 'Widget', Qty: 3 },
            { SKU: 'GONE', Product: '', Qty: 1 }
        ]);
    });

    test('an address on one line, without blanks', () => {
        expect(describeAddress({ ...ADDRESS_FIELDS, addressLine2: 'Unit 4', organisation: null })).toBe(
            '1 Main Rd, Unit 4, Claremont, Cape Town, Western Cape 7708'
        );
    });

    test('issues as a markdown list', () => {
        expect(issuesMarkdown(['no Cardboard equipment boxes are configured', 'SKU "X": product is inactive'])).toBe(
            '- No Cardboard equipment boxes are configured\n- SKU "X": product is inactive'
        );
    });
});

describe('searchShippableProducts', () => {
    beforeEach(resetDatabase);

    async function seed() {
        const brand = await models.brand.create({ name: 'Acme' });
        await models.product.create({
            name: 'Talisker Bottle', sku: 'MS-TALBOT', brandId: brand.id,
            lengthInCm: 10, widthInCm: 10, heightInCm: 30, weightInGrams: 1500
        });
        await models.product.create({ name: 'Bottle opener', sku: 'OP-1', brandId: brand.id });
        await models.product.create({ name: 'Old bottle', sku: 'OLD-1', brandId: brand.id, isActive: false });
        await models.product.create({ name: '100% cotton bag', sku: 'BAG-1', brandId: brand.id });
        // Sorts before 'Bottle opener' by name, and its SKU only contains "op".
        await models.product.create({ name: 'Aardvark top', sku: 'TOP-1', brandId: brand.id });
    }

    test('matches SKU or name, ignoring case, active products only', async () => {
        await seed();

        const options = await searchShippableProducts('BOTTLE');

        expect(options.map((o) => o.value).sort()).toEqual(['MS-TALBOT', 'OP-1']);
    });

    test('puts a SKU-prefix match first', async () => {
        await seed();

        const options = await searchShippableProducts('op');

        expect(options.map((o) => o.value)).toEqual(['OP-1', 'TOP-1']);
    });

    test('labels each option with its SKU and name, and its shipping data', async () => {
        await seed();

        const [option] = await searchShippableProducts('ms-tal');

        expect(option).toEqual({ value: 'MS-TALBOT', label: 'MS-TALBOT · Talisker Bottle', description: '1.5 kg · 3 L' });
    });

    test('treats % and _ as plain characters', async () => {
        await seed();

        expect((await searchShippableProducts('100%')).map((o) => o.value)).toEqual(['BAG-1']);
        expect(await searchShippableProducts('_')).toEqual([]);
    });

    test('names products by SKU, leaving unknown SKUs out', async () => {
        await seed();

        expect(await loadProductNames(['OP-1', 'NOPE', 'OP-1'])).toEqual({ 'OP-1': 'Bottle opener' });
        expect(await loadProductNames([])).toEqual({});
    });
});

describe('calculateShipment', () => {
    beforeEach(resetDatabase);
    afterEach(() => vi.unstubAllGlobals());

    test('turns a courier failure into an outcome the operator can act on', async () => {
        const brand = await models.brand.create({ name: 'Acme' });
        await models.product.create({
            name: 'Widget', sku: 'W-1', brandId: brand.id,
            lengthInCm: 10, widthInCm: 10, heightInCm: 10, weightInGrams: 500
        });
        await models.equipmentBox.create({
            name: 'Box', boxType: BoxType.Cardboard, priceInclVat: 0,
            lengthInCm: 30, widthInCm: 30, heightInCm: 30, weightInGrams: 300,
            holdingVolumeInLitres: 20, volumeUtilisationQuotient: 1
        });
        vi.stubGlobal('fetch', vi.fn(async () => new Response('bad address', { status: 422 })));

        const outcome = await calculateShipment({ ...SHIPMENT, boxType: BoxType.Cardboard }, { apiUrl: 'https://x.test', apiKey: 'k' });

        expect(outcome).toEqual({ status: 'failed', message: 'Shiplogic API error: 422 - bad address' });
    });
});
