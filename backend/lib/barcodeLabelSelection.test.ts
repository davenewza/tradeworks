import { models, resetDatabase } from '@teamkeel/testing';
import {
    BarcodeSymbology,
    ChannelShipmentStatus,
    LabelStockSize,
    LabelAnnotationPlacement,
} from '@teamkeel/sdk';
import { beforeEach, describe, expect, test } from 'vitest';
import { loadShipmentLabelCandidates } from './barcodeLabelSelection';
import { buildShipmentQuantityRows } from './barcodeLabelHelpers';

beforeEach(resetDatabase);

// Two valid EAN-13s, so a run can cover two products without either tripping
// print-time validation.
const EAN_A = '6001234567899';
const EAN_B = '6009876543219';

// ─── Fixtures ───────────────────────────────────────────────────────────────

async function setup(options: { withSpec?: boolean } = {}) {
    const { withSpec = true } = options;
    const channel = await models.channel.create({ name: 'Takealot Marketplace' });
    if (withSpec) {
        await models.channelLabelSpec.create({
            channelId: channel.id,
            symbology: BarcodeSymbology.Ean13,
            annotation: 'MP',
            annotationPlacement: LabelAnnotationPlacement.StackedLeft,
            defaultStock: LabelStockSize.Size50x25,
            isEnabled: true,
        });
    }
    const brand = await models.brand.create({ name: 'Acme' });
    const shipment = await models.channelShipment.create({
        channelId: channel.id,
        externalId: '5001',
        reference: 'JHB-2026-08',
        status: ChannelShipmentStatus.Open,
    });
    return { channel, brand, shipment };
}

async function addLine(
    shipmentId: string,
    externalId: string,
    fields: {
        productId?: string | null;
        sku?: string | null;
        listingRef?: string | null;
        quantitySending?: number;
        quantityRequired?: number;
        cancelled?: boolean;
    } = {}
) {
    return await models.channelShipmentItem.create({
        shipmentId,
        externalId,
        productId: fields.productId ?? null,
        sku: fields.sku ?? null,
        listingRef: fields.listingRef ?? null,
        quantitySending: fields.quantitySending ?? 0,
        quantityRequired: fields.quantityRequired ?? 0,
        cancelled: fields.cancelled ?? false,
    });
}

async function addProduct(brandId: string, sku: string, name: string, channelId: string, code?: string) {
    const product = await models.product.create({ name, sku, brandId });
    if (code) {
        await models.productChannelCode.create({ productId: product.id, channelId, code });
    }
    return product;
}

// ─── loadShipmentLabelCandidates ────────────────────────────────────────────

describe('loadShipmentLabelCandidates', () => {
    test('returns null for a shipment that no longer exists', async () => {
        expect(await loadShipmentLabelCandidates('2Zx000000000000000000000000')).toBeNull();
    });

    test('seeds one candidate per line, at the units being sent', async () => {
        const { channel, brand, shipment } = await setup();
        const widget = await addProduct(brand.id, 'ACME-001', 'Widget', channel.id, EAN_A);
        const gadget = await addProduct(brand.id, 'ACME-002', 'Gadget', channel.id, EAN_B);
        await addLine(shipment.id, '91', { productId: widget.id, sku: 'ACME-001', quantitySending: 30 });
        await addLine(shipment.id, '92', { productId: gadget.id, sku: 'ACME-002', quantitySending: 12 });

        const load = (await loadShipmentLabelCandidates(shipment.id))!;

        expect(load.reference).toBe('JHB-2026-08');
        expect(load.channel?.channelName).toBe('Takealot Marketplace');
        expect(load.channel?.symbology).toBe(BarcodeSymbology.Ean13);
        expect(load.candidates).toEqual([
            {
                productId: gadget.id,
                sku: 'ACME-002',
                name: 'Gadget',
                brand: 'Acme',
                code: EAN_B,
                quantity: 12,
            },
            {
                productId: widget.id,
                sku: 'ACME-001',
                name: 'Widget',
                brand: 'Acme',
                code: EAN_A,
                quantity: 30,
            },
        ]);
        expect(load.unprintable).toEqual([]);
    });

    test('falls back to the required quantity for a consignment not yet packed', async () => {
        const { channel, brand, shipment } = await setup();
        const widget = await addProduct(brand.id, 'ACME-001', 'Widget', channel.id, EAN_A);
        await addLine(shipment.id, '91', {
            productId: widget.id,
            sku: 'ACME-001',
            quantityRequired: 40,
            quantitySending: 0,
        });

        const load = (await loadShipmentLabelCandidates(shipment.id))!;

        expect(load.candidates[0].quantity).toBe(40);
    });

    test('excludes cancelled lines and counts them', async () => {
        const { channel, brand, shipment } = await setup();
        const widget = await addProduct(brand.id, 'ACME-001', 'Widget', channel.id, EAN_A);
        await addLine(shipment.id, '91', {
            productId: widget.id,
            sku: 'ACME-001',
            quantitySending: 30,
            cancelled: true,
        });

        const load = (await loadShipmentLabelCandidates(shipment.id))!;

        expect(load.candidates).toEqual([]);
        // Not a problem to fix — just not being sent — so it is counted, not listed.
        expect(load.cancelledLines).toBe(1);
        expect(load.unprintable).toEqual([]);
    });

    test('reports an unmatched line by its SKU, or by its listing when there is none', async () => {
        const { shipment } = await setup();
        await addLine(shipment.id, '91', { sku: 'GHOST-1', quantitySending: 3 });
        await addLine(shipment.id, '92', { listingRef: '999', quantitySending: 4 });

        const load = (await loadShipmentLabelCandidates(shipment.id))!;

        expect(load.candidates).toEqual([]);
        expect(load.unprintable).toEqual([
            { sku: 'GHOST-1', name: '—', problem: 'line is not matched to a product here' },
            { sku: 'listing 999', name: '—', problem: 'line is not matched to a product here' },
        ]);
    });

    test('reports a matched product with no code for the channel', async () => {
        const { channel, brand, shipment } = await setup();
        const widget = await addProduct(brand.id, 'ACME-001', 'Widget', channel.id);
        await addLine(shipment.id, '91', { productId: widget.id, sku: 'ACME-001', quantitySending: 30 });

        const load = (await loadShipmentLabelCandidates(shipment.id))!;

        expect(load.unprintable).toEqual([
            { sku: 'ACME-001', name: 'Widget', problem: 'no code captured for this channel' },
        ]);
    });

    test('reports a code that cannot be printed under the channel’s symbology', async () => {
        const { channel, brand, shipment } = await setup();
        // Right length, wrong check digit — a transcription error, not something
        // to silently "fix" by reprinting a different product's EAN.
        const widget = await addProduct(brand.id, 'ACME-001', 'Widget', channel.id, '6001234567890');
        await addLine(shipment.id, '91', { productId: widget.id, sku: 'ACME-001', quantitySending: 30 });

        const load = (await loadShipmentLabelCandidates(shipment.id))!;

        expect(load.candidates).toEqual([]);
        expect(load.unprintable[0].problem).toContain('check digit should be 9');
    });

    test('reports a line carrying no units at all', async () => {
        const { channel, brand, shipment } = await setup();
        const widget = await addProduct(brand.id, 'ACME-001', 'Widget', channel.id, EAN_A);
        await addLine(shipment.id, '91', { productId: widget.id, sku: 'ACME-001' });

        const load = (await loadShipmentLabelCandidates(shipment.id))!;

        expect(load.unprintable).toEqual([
            { sku: 'ACME-001', name: 'Widget', problem: 'no units on this line' },
        ]);
    });

    test('says the channel has no label spec rather than showing an empty picker', async () => {
        const { channel, brand, shipment } = await setup({ withSpec: false });
        const widget = await addProduct(brand.id, 'ACME-001', 'Widget', channel.id, EAN_A);
        await addLine(shipment.id, '91', { productId: widget.id, sku: 'ACME-001', quantitySending: 30 });

        const load = (await loadShipmentLabelCandidates(shipment.id))!;

        expect(load.channel).toBeNull();
        expect(load.candidates).toEqual([]);
    });

    test('only reads codes for the shipment’s own channel', async () => {
        const { channel, brand, shipment } = await setup();
        const amazon = await models.channel.create({ name: 'Amazon' });
        const widget = await models.product.create({
            name: 'Widget',
            sku: 'ACME-001',
            brandId: brand.id,
        });
        // An FNSKU on another channel is a different identifier, not a Takealot code.
        await models.productChannelCode.create({
            productId: widget.id,
            channelId: amazon.id,
            code: 'X001ABCDEF',
        });
        await addLine(shipment.id, '91', { productId: widget.id, sku: 'ACME-001', quantitySending: 30 });

        const load = (await loadShipmentLabelCandidates(shipment.id))!;

        expect(load.candidates).toEqual([]);
        expect(load.unprintable[0].problem).toBe('no code captured for this channel');
        expect(channel.id).not.toBe(amazon.id);
    });
});

// ─── buildShipmentQuantityRows ──────────────────────────────────────────────

describe('buildShipmentQuantityRows', () => {
    const candidate = {
        productId: 'p1',
        sku: 'ACME-001',
        name: 'Widget',
        brand: 'Acme',
        code: EAN_A,
        quantity: 30,
    };

    test('seeds the label count from the consignment, not from 1', () => {
        expect(buildShipmentQuantityRows([candidate], { 'ACME-001': 12 })).toEqual([
            {
                productId: 'p1',
                code: EAN_A,
                sku: 'ACME-001',
                name: 'Widget',
                onHand: 12,
                labels: 30,
            },
        ]);
    });

    test('floors negative or unknown stock for the reference column', () => {
        expect(buildShipmentQuantityRows([candidate], { 'ACME-001': -4 })[0].onHand).toBe(0);
        expect(buildShipmentQuantityRows([candidate])[0].onHand).toBe(0);
    });
});
