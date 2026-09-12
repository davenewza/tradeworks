// Wiring for the PrintChannelBarcodes flow: which pages a run actually shows,
// and which questions it answers from the data instead of asking. The label
// geometry and ZPL are covered in lib/barcodeLabelHelpers.test.ts, and the
// queries in lib/barcodeLabelSelection.test.ts.

import { flows, models, resetDatabase } from '@teamkeel/testing';
import {
    BarcodeSymbology,
    ChannelShipmentStatus,
    LabelElementKind,
    LabelStockSize,
    Team,
} from '@teamkeel/sdk';
import { beforeEach, describe, expect, test } from 'vitest';

const FLOW_TIMEOUT = 30000;

// Two valid EAN-13s and an FNSKU-shaped Code 128, so a run can cover two
// channels without either tripping print-time validation.
const EAN_A = '6001234567899';
const EAN_B = '6009876543219';
const FNSKU = 'X001ABCDEF';

// Roles come from team membership on User, so an operator is a User in the
// Warehouse team plus an Identity pointing at it.
let seq = 0;
async function operator() {
    const email = `packer-${++seq}@tradeworks.test`;
    const user = await models.user.create({ email, teams: [Team.Warehouse] });
    return await models.identity.create({ email, userId: user.id });
}

// The Takealot shape: name over the symbol, "MP" stacked beside it.
async function takealot() {
    const channel = await models.channel.create({ name: 'Takealot' });
    const spec = await models.channelLabelSpec.create({
        channelId: channel.id,
        symbology: BarcodeSymbology.Ean13,
        defaultStock: LabelStockSize.Size50x30,
        isEnabled: true,
    });
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
    return channel;
}

// The Amazon shape: name, symbol, then the item condition.
async function amazon() {
    const channel = await models.channel.create({ name: 'Amazon' });
    const spec = await models.channelLabelSpec.create({
        channelId: channel.id,
        symbology: BarcodeSymbology.Code128,
        defaultStock: LabelStockSize.Size67x25,
        isEnabled: true,
    });
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

async function product(fields: { sku?: string; name?: string; isEnabled?: boolean } = {}) {
    const brand = await models.brand.create({ name: `Acme ${++seq}` });
    return await models.product.create({
        name: fields.name ?? 'Widget',
        sku: fields.sku ?? `ACME-W-${seq}`,
        brandId: brand.id,
        stockAvailable: 42,
        isEnabled: fields.isEnabled ?? true,
    });
}

type Executor = ReturnType<typeof flows.printChannelBarcodes.withIdentity>;

async function pendingPage(authed: Executor, runId: string) {
    const run = await authed.untilAwaitingInput(runId, FLOW_TIMEOUT);
    const step = run.steps.find((s) => s.type === 'UI' && s.status === 'PENDING')!;
    return { run, step, ui: step.ui as any };
}

const elements = (ui: any, type: string): any[] =>
    (ui.content as any[]).filter((el) => el.__type === type);

const element = (ui: any, type: string): any | undefined => elements(ui, type)[0];

// The key/value pairs of the first keyValue block, as a plain object.
function keyValues(ui: any): Record<string, unknown> {
    const block = element(ui, 'ui.display.keyValue');
    return Object.fromEntries((block.data as any[]).map((d) => [d.key, d.value]));
}

// The ZPL of the single job on a print page. The runtime hands job data back as
// an array of formats, so it is joined before being matched against.
function jobZpl(ui: any): string {
    const print = element(ui, 'ui.interactive.print');
    const job = print.data[0];
    return Array.isArray(job.data) ? job.data.join('\n') : String(job.data);
}

describe('PrintChannelBarcodes — from a product page', () => {
    beforeEach(resetDatabase);

    test('one printable channel: straight to the label count, then print', async () => {
        const channel = await takealot();
        const widget = await product({ sku: 'ACME-W' });
        await models.productChannelCode.create({
            productId: widget.id,
            channelId: channel.id,
            code: EAN_A,
        });
        const authed = flows.printChannelBarcodes.withIdentity(await operator());

        let run = await authed.start({ productId: widget.id });

        // No channel page and no confirmation page — the first thing asked is
        // the only thing that is not already known.
        let page = await pendingPage(authed, run.id);
        expect(page.step.name).toBe('quantities-0');
        expect(page.ui.title).toBe('Widget');
        expect(keyValues(page.ui)).toMatchObject({
            SKU: 'ACME-W',
            'On hand': 42,
            Channel: 'Takealot',
            Code: EAN_A,
            'Label stock': '50 × 30 mm',
        });

        // One channel is not a question, so no dropdown is rendered.
        expect(element(page.ui, 'ui.select.one')).toBeUndefined();
        const count = element(page.ui, 'ui.input.number');
        expect(count.name).toBe('labels');
        expect(count.defaultValue).toBe(1);

        run = await authed.putStepValues(run.id, page.step.id, { labels: 3 }, 'next');

        page = await pendingPage(authed, run.id);
        expect(page.step.name).toBe('print-0');
        expect(keyValues(page.ui)).toMatchObject({
            Channel: 'Takealot',
            Symbology: 'EAN-13',
            'Label layout': 'Product name \u2192 Barcode, \u201cMP\u201d stacked left',
            Products: 1,
            'Labels in total': 3,
            Printer: 'Barcode labels',
        });

        // One job, three copies of one format — not three jobs.
        const print = element(page.ui, 'ui.interactive.print');
        expect(print.data).toHaveLength(1);
        const zpl = jobZpl(page.ui);
        expect(zpl.match(/\^XA/g)).toHaveLength(1);
        expect(zpl).toContain('^PQ3');
        // ^BE takes the 12 data digits; the printer adds the check digit.
        expect(zpl).toContain(`^FD${EAN_A.slice(0, 12)}^FS`);

        // A single product prints as the page opens: that is what makes this
        // one page and one click.
        expect(print.autoPrint).toBe(true);

        run = await authed.putStepValues(run.id, page.step.id, {}, 'done');
        run = await authed.untilFinished(run.id, FLOW_TIMEOUT);
        expect(run.status).toBe('COMPLETED');
        const done = run.steps.find((s) => s.type === 'COMPLETE')!;
        expect((done.ui as any).description).toBe('Widget — 1 print run(s) on 50 × 30 mm.');
    });

    test('two printable channels: the choice rides on the counts page', async () => {
        const tak = await takealot();
        const amz = await amazon();
        const widget = await product({ sku: 'ACME-W' });
        await models.productChannelCode.create({ productId: widget.id, channelId: tak.id, code: EAN_A });
        await models.productChannelCode.create({ productId: widget.id, channelId: amz.id, code: FNSKU });
        const authed = flows.printChannelBarcodes.withIdentity(await operator());

        let run = await authed.start({ productId: widget.id });

        // Still one page: the channel is a dropdown on it, not a page before it.
        let page = await pendingPage(authed, run.id);
        expect(page.step.name).toBe('quantities-0');
        const select = element(page.ui, 'ui.select.one');
        expect(select.name).toBe('channelId');
        // No default: an arbitrary one would print the wrong channel's label
        // unread, since the print page fires on open.
        expect(select.defaultValue).toBeUndefined();
        expect(select.options.map((o: any) => o.label)).toEqual([
            `Amazon — ${FNSKU} · Code 128 on 66.7 × 25.4 mm (2⅝" × 1")`,
            `Takealot — ${EAN_A} · EAN-13 on 50 × 30 mm`,
        ]);

        // The code and stock live in the options, not in a key/value block that
        // would go stale the moment the other channel is picked.
        expect(Object.keys(keyValues(page.ui))).toEqual(['SKU', 'On hand']);

        run = await authed.putStepValues(
            run.id,
            page.step.id,
            { channelId: amz.id, labels: 2 },
            'next'
        );

        page = await pendingPage(authed, run.id);
        expect(page.step.name).toBe('print-0');
        expect(keyValues(page.ui)).toMatchObject({
            Channel: 'Amazon',
            Symbology: 'Code 128',
            'Label layout': 'Product name \u2192 Barcode \u2192 \u201cNew\u201d',
            'Labels in total': 2,
            'Label stock': '66.7 × 25.4 mm (2⅝" × 1")',
        });
        expect(jobZpl(page.ui)).toContain(FNSKU);
    });

    test('a channel that cannot label the product is named, but costs no page', async () => {
        const tak = await takealot();
        await amazon();
        const widget = await product();
        await models.productChannelCode.create({ productId: widget.id, channelId: tak.id, code: EAN_A });
        const authed = flows.printChannelBarcodes.withIdentity(await operator());

        const run = await authed.start({ productId: widget.id });
        const page = await pendingPage(authed, run.id);

        expect(page.step.name).toBe('quantities-0');
        expect(element(page.ui, 'ui.select.one')).toBeUndefined();
        const banner = element(page.ui, 'ui.display.banner');
        expect(banner.title).toBe('1 other channel(s) cannot label this product');
        expect(banner.description).toMatch(/^Amazon cannot label it/);
    });

    test('an invalid code leaves the channel out and says why', async () => {
        const tak = await takealot();
        const widget = await product();
        // Right length, wrong check digit — a transcription error, never
        // silently corrected.
        await models.productChannelCode.create({
            productId: widget.id,
            channelId: tak.id,
            code: '6001234567890',
        });
        const authed = flows.printChannelBarcodes.withIdentity(await operator());

        const run = await authed.start({ productId: widget.id });
        const finished = await authed.untilFinished(run.id, FLOW_TIMEOUT);
        const done = finished.steps.find((s) => s.type === 'COMPLETE')!;
        expect((done.ui as any).title).toBe('Nothing to print for this product');
        const table = (done.ui as any).content.find((el: any) => el.__type === 'ui.display.table');
        expect(table.data).toEqual([
            { Channel: 'Takealot', Problem: expect.stringContaining('check digit') },
        ]);
    });

    test('no code at all completes with the reason rather than an empty picker', async () => {
        await takealot();
        const widget = await product();
        const authed = flows.printChannelBarcodes.withIdentity(await operator());

        const run = await authed.start({ productId: widget.id });
        const finished = await authed.untilFinished(run.id, FLOW_TIMEOUT);
        const done = finished.steps.find((s) => s.type === 'COMPLETE')!;
        expect((done.ui as any).title).toBe('Nothing to print for this product');
        expect((done.ui as any).description).toBe(
            'Takealot cannot label it — see below. A missing or invalid code is fixed ' +
                'under Channel codes on the product page.'
        );
    });

    test('a disabled product still prints from its own page', async () => {
        const tak = await takealot();
        const widget = await product({ isEnabled: false });
        await models.productChannelCode.create({ productId: widget.id, channelId: tak.id, code: EAN_A });
        const authed = flows.printChannelBarcodes.withIdentity(await operator());

        const run = await authed.start({ productId: widget.id });
        const page = await pendingPage(authed, run.id);
        expect(page.step.name).toBe('quantities-0');
        expect(keyValues(page.ui)).toMatchObject({ Code: EAN_A });
    });

    test('the label count must be a whole number of 1 or more', async () => {
        const tak = await takealot();
        const widget = await product();
        await models.productChannelCode.create({ productId: widget.id, channelId: tak.id, code: EAN_A });
        const authed = flows.printChannelBarcodes.withIdentity(await operator());

        const run = await authed.start({ productId: widget.id });
        const page = await pendingPage(authed, run.id);
        const rejected = await authed.putStepValues(run.id, page.step.id, { labels: 0 }, 'next');

        // The rejection rides on the response to the submission itself — a
        // re-fetched run renders the page afresh, without it.
        const step = rejected.steps.find((s) => s.type === 'UI' && s.status === 'PENDING')!;
        expect(step.name).toBe('quantities-0');
        expect((step.ui as any).validationError).toBe('Set a whole number of labels, 1 or more.');
    });
});

describe('PrintChannelBarcodes — from the Products space', () => {
    beforeEach(resetDatabase);

    test('one printable channel is not a question', async () => {
        const tak = await takealot();
        const widget = await product();
        await models.productChannelCode.create({ productId: widget.id, channelId: tak.id, code: EAN_A });
        const authed = flows.printChannelBarcodes.withIdentity(await operator());

        const run = await authed.start({});
        const page = await pendingPage(authed, run.id);
        expect(page.step.name).toBe('select');
        expect(page.ui.title).toBe('Which products need Takealot labels?');
    });

    test('more than one printable channel is still asked first', async () => {
        const tak = await takealot();
        const amz = await amazon();
        const widget = await product();
        await models.productChannelCode.create({ productId: widget.id, channelId: tak.id, code: EAN_A });
        await models.productChannelCode.create({ productId: widget.id, channelId: amz.id, code: FNSKU });
        const authed = flows.printChannelBarcodes.withIdentity(await operator());

        let run = await authed.start({});
        let page = await pendingPage(authed, run.id);
        expect(page.step.name).toBe('channel');

        run = await authed.putStepValues(run.id, page.step.id, { channelId: tak.id }, 'next');
        page = await pendingPage(authed, run.id);
        expect(page.step.name).toBe('select');
    });

    test('picked products land in the counts grid, seeded at 1', async () => {
        const tak = await takealot();
        const widget = await product({ sku: 'ACME-W', name: 'Widget' });
        const gadget = await product({ sku: 'ACME-G', name: 'Gadget' });
        await models.productChannelCode.create({ productId: widget.id, channelId: tak.id, code: EAN_A });
        await models.productChannelCode.create({ productId: gadget.id, channelId: tak.id, code: EAN_B });
        const authed = flows.printChannelBarcodes.withIdentity(await operator());

        let run = await authed.start({});
        let page = await pendingPage(authed, run.id);
        const table = element(page.ui, 'ui.select.table');
        run = await authed.putStepValues(run.id, page.step.id, { products: table.data }, 'next');

        page = await pendingPage(authed, run.id);
        expect(page.step.name).toBe('quantities-0');
        const grid = element(page.ui, 'ui.input.dataGrid');
        expect(grid.data.map((r: any) => [r.sku, r.labels, r.onHand])).toEqual([
            ['ACME-G', 1, 42],
            ['ACME-W', 1, 42],
        ]);
    });
});

describe('PrintChannelBarcodes — from a channel shipment', () => {
    beforeEach(resetDatabase);

    test('the consignment summary rides on the counts page, not a page of its own', async () => {
        const tak = await takealot();
        const widget = await product({ sku: 'ACME-W' });
        await models.productChannelCode.create({ productId: widget.id, channelId: tak.id, code: EAN_A });
        const shipment = await models.channelShipment.create({
            channelId: tak.id,
            externalId: '5001',
            reference: 'JHB-2026-08',
            status: ChannelShipmentStatus.Open,
        });
        await models.channelShipmentItem.create({
            shipmentId: shipment.id,
            externalId: 'L1',
            productId: widget.id,
            sku: 'ACME-W',
            quantitySending: 6,
            quantityRequired: 6,
        });
        const authed = flows.printChannelBarcodes.withIdentity(await operator());

        const run = await authed.start({ shipmentId: shipment.id });
        const page = await pendingPage(authed, run.id);

        expect(page.step.name).toBe('quantities-0');
        expect(page.ui.title).toBe('Shipment JHB-2026-08 — Takealot');
        expect(keyValues(page.ui)).toMatchObject({
            Shipment: '5001',
            Channel: 'Takealot',
            'Lines to label': 1,
            'Units going in': 6,
        });

        // Counts still come from the consignment, not from 1.
        const grid = element(page.ui, 'ui.input.dataGrid');
        expect(grid.data.map((r: any) => [r.sku, r.labels])).toEqual([['ACME-W', 6]]);
    });
});
