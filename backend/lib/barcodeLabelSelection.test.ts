import { models, resetDatabase } from '@teamkeel/testing';
import {
    BarcodeSymbology,
    ChannelShipmentStatus,
    LabelElementKind,
    LabelStockSize,
} from '@teamkeel/sdk';
import { beforeEach, describe, expect, test } from 'vitest';
import {
    loadPrintableChannels,
    loadProductLabelOptions,
    loadShipmentLabelCandidates,
} from './barcodeLabelSelection';
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
        const spec = await models.channelLabelSpec.create({
            channelId: channel.id,
            symbology: BarcodeSymbology.Ean13,
            defaultStock: LabelStockSize.Size50x25,
            isEnabled: true,
        });
        // The Takealot shape: name over the symbol, "MP" stacked beside it.
        await models.channelLabelElement.create({
            specId: spec.id,
            position: 1,
            kind: LabelElementKind.Title,
            maxLines: 2,
        });
        await models.channelLabelElement.create({
            specId: spec.id,
            position: 2,
            kind: LabelElementKind.Barcode,
        });
        await models.channelLabelElement.create({
            specId: spec.id,
            position: 3,
            kind: LabelElementKind.StackedText,
            text: 'MP',
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
        labelledByChannel?: boolean;
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
        labelledByChannel: fields.labelledByChannel ?? false,
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

    test('excludes lines the channel labels itself and counts them', async () => {
        const { channel, brand, shipment } = await setup();
        const widget = await addProduct(brand.id, 'ACME-001', 'Widget', channel.id, EAN_A);
        await addLine(shipment.id, '91', {
            productId: widget.id,
            sku: 'ACME-001',
            quantitySending: 30,
            labelledByChannel: true,
        });

        const load = (await loadShipmentLabelCandidates(shipment.id))!;

        // Amazon applies the label itself, or the units carry the
        // manufacturer's barcode — nothing for us to print either way.
        expect(load.candidates).toEqual([]);
        expect(load.channelLabelledLines).toBe(1);
        expect(load.unprintable).toEqual([]);
    });

    test('a line the channel labels is not reported as missing a code', async () => {
        const { channel, brand, shipment } = await setup();
        // A manufacturer-barcode listing deliberately has no code stored.
        const widget = await addProduct(brand.id, 'ACME-001', 'Widget', channel.id);
        await addLine(shipment.id, '91', {
            productId: widget.id,
            sku: 'ACME-001',
            quantitySending: 30,
            labelledByChannel: true,
        });

        const load = (await loadShipmentLabelCandidates(shipment.id))!;

        expect(load.unprintable).toEqual([]);
        expect(load.channelLabelledLines).toBe(1);
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

// ─── loadProductLabelOptions ────────────────────────────────────────────────

// A second printable channel, so a product can be read across more than one.
async function addAmazon() {
    const channel = await models.channel.create({ name: 'Amazon' });
    const spec = await models.channelLabelSpec.create({
        channelId: channel.id,
        symbology: BarcodeSymbology.Code128,
        defaultStock: LabelStockSize.Size67x25,
        isEnabled: true,
    });
    // The Amazon shape: name, symbol, then the item condition.
    await models.channelLabelElement.create({
        specId: spec.id,
        position: 1,
        kind: LabelElementKind.Title,
        maxLines: 1,
    });
    await models.channelLabelElement.create({
        specId: spec.id,
        position: 2,
        kind: LabelElementKind.Barcode,
    });
    await models.channelLabelElement.create({
        specId: spec.id,
        position: 3,
        kind: LabelElementKind.Text,
        text: 'New',
    });
    return channel;
}

describe('loadProductLabelOptions', () => {
    test('returns null for a product that no longer exists', async () => {
        const channels = await loadPrintableChannels();
        expect(await loadProductLabelOptions('2Zx000000000000000000000000', channels)).toBeNull();
    });

    test('one option per channel whose code is printable', async () => {
        const { channel, brand } = await setup();
        const amazon = await addAmazon();
        const widget = await addProduct(brand.id, 'ACME-001', 'Widget', channel.id, EAN_A);
        await models.productChannelCode.create({
            productId: widget.id,
            channelId: amazon.id,
            code: 'X001ABCDEF',
        });

        const load = (await loadProductLabelOptions(widget.id, await loadPrintableChannels()))!;

        expect(load).toMatchObject({ productId: widget.id, sku: 'ACME-001', name: 'Widget' });
        expect(load.options.map((o) => [o.channel.channelName, o.code])).toEqual([
            ['Amazon', 'X001ABCDEF'],
            ['Takealot Marketplace', EAN_A],
        ]);
        expect(load.unprintable).toEqual([]);
    });

    test('names the channels that cannot label it, and why', async () => {
        const { channel, brand } = await setup();
        const amazon = await addAmazon();
        // Right length, wrong check digit — never silently corrected.
        const widget = await addProduct(brand.id, 'ACME-001', 'Widget', channel.id, '6001234567890');
        await models.productChannelCode.create({
            productId: widget.id,
            channelId: amazon.id,
            code: '',
        });

        const load = (await loadProductLabelOptions(widget.id, await loadPrintableChannels()))!;

        expect(load.options).toEqual([]);
        expect(load.unprintable.map((u) => u.channelName)).toEqual(['Amazon', 'Takealot Marketplace']);
        expect(load.unprintable[1].problem).toMatch(/check digit/);
    });

    test('a channel with no code for the product is reported as missing, not malformed', async () => {
        const { channel, brand } = await setup();
        await addAmazon();
        const widget = await addProduct(brand.id, 'ACME-001', 'Widget', channel.id, EAN_A);

        const load = (await loadProductLabelOptions(widget.id, await loadPrintableChannels()))!;

        expect(load.options.map((o) => o.channel.channelName)).toEqual(['Takealot Marketplace']);
        expect(load.unprintable).toEqual([
            { channelName: 'Amazon', problem: 'no code captured for this channel' },
        ]);
    });

    test('a disabled product is still printable from its own page', async () => {
        const { channel, brand } = await setup();
        const widget = await models.product.create({
            name: 'Widget',
            sku: 'ACME-001',
            brandId: brand.id,
            isEnabled: false,
        });
        await models.productChannelCode.create({
            productId: widget.id,
            channelId: channel.id,
            code: EAN_A,
        });

        const load = (await loadProductLabelOptions(widget.id, await loadPrintableChannels()))!;
        expect(load.options.map((o) => o.code)).toEqual([EAN_A]);
    });

    test('floors negative or unknown stock for the reference figure', async () => {
        const { channel, brand } = await setup();
        const widget = await addProduct(brand.id, 'ACME-001', 'Widget', channel.id, EAN_A);
        const channels = await loadPrintableChannels();

        expect((await loadProductLabelOptions(widget.id, channels))!.onHand).toBe(0);

        await models.product.update({ id: widget.id }, { stockAvailable: -4 });
        expect((await loadProductLabelOptions(widget.id, channels))!.onHand).toBe(0);
    });
});
