import { PrintChannelBarcodes, FlowConfig } from '@teamkeel/sdk';
import {
    LABEL_STOCKS,
    CandidateLoad,
    LabelCandidate,
    LabelFormat,
    LabelQuantityRow,
    buildBatchZpl,
    buildQuantityRows,
    buildShipmentQuantityRows,
    computeLayout,
} from '../lib/barcodeLabelHelpers';
import {
    PrintableChannel,
    ShipmentLabelLoad,
    loadPrintableChannels,
    loadLabelCandidates,
    loadShipmentLabelCandidates,
    loadStockBySku,
} from '../lib/barcodeLabelSelection';

const config = {
    title: 'Print barcode labels',
    description: 'Print unit barcode labels for a channel on the warehouse Zebra',
    stages: [
        { name: 'Channel', key: 'channel' },
        { name: 'Choose products', key: 'select' },
        { name: 'Label counts', key: 'quantities' },
        { name: 'Print', key: 'print' },
    ],
} as const satisfies FlowConfig;

// Must match a printer declared under hardware.printers in keelconfig.yaml —
// the generated Hardware type narrows this to those names, so a typo is a
// compile error rather than a job that vanishes at runtime.
const PRINTER = 'Barcode labels' as const;

export default PrintChannelBarcodes(config, async (ctx, inputs) => {
    // Set when launched from a product page's entry action; absent from the
    // Products space, where products are picked from a table instead.
    const singleProductId = inputs?.productId ?? undefined;
    // Set when launched from a channel shipment. The shipment fixes the channel
    // and the label counts, so it skips both pickers.
    const shipmentId = inputs?.shipmentId ?? undefined;

    let channel: PrintableChannel;
    // Seeded label counts for the grid, and a one-line description of where the
    // run came from for the completion page.
    let seededRows: LabelQuantityRow[];
    let source: string;

    if (shipmentId) {
        // ── Shipment path ───────────────────────────────────────────────────
        const load = (await ctx.step('load-shipment', async () => {
            return await loadShipmentLabelCandidates(shipmentId);
        })) as unknown as ShipmentLabelLoad | null;

        if (!load) {
            return ctx.complete({
                title: 'Shipment not found',
                stage: 'print',
                description: 'It may have been deleted since this page was opened.',
                content: [],
            });
        }

        if (!load.channel) {
            return ctx.complete({
                title: 'This shipment’s channel is not set up for labels',
                stage: 'print',
                description: NO_SPEC_DESCRIPTION,
                content: noSpecBanner(ctx),
            });
        }
        channel = load.channel;

        if (load.candidates.length === 0) {
            return ctx.complete({
                title: 'Nothing to print for this shipment',
                stage: 'print',
                description: describeShipmentProblems(load),
                content: unprintableTable(ctx, load),
            });
        }

        const totalUnits = load.candidates.reduce((sum, c) => sum + c.quantity, 0);
        await ctx.ui.page('shipment', {
            stage: 'select',
            title: `Shipment ${load.reference} — ${channel.channelName}`,
            content: [
                ...(load.unprintable.length > 0
                    ? [
                          ctx.ui.display.banner({
                              title: `${load.unprintable.length} line(s) cannot be labelled`,
                              description: describeShipmentProblems(load),
                              mode: 'warning',
                          }),
                      ]
                    : []),
                ctx.ui.display.keyValue({
                    data: [
                        { key: 'Shipment', value: load.externalId },
                        { key: 'Channel', value: channel.channelName },
                        { key: 'Lines to label', value: load.candidates.length },
                        { key: 'Units going in', value: totalUnits },
                        { key: 'Label stock', value: LABEL_STOCKS[channel.defaultStock].label },
                    ],
                }),
                ctx.ui.display.markdown({
                    content:
                        'Label counts are seeded from the units this consignment is sending. ' +
                        'You can still adjust them on the next screen.',
                }),
                ...unprintableTable(ctx, load),
            ],
            actions: [{ label: 'Set label counts', value: 'next', mode: 'primary' }],
        });

        seededRows = (await ctx.step('seed-shipment-quantities', async () => {
            const stockBySku = await loadStockBySku(load.candidates.map((c) => c.sku));
            return buildShipmentQuantityRows(load.candidates, stockBySku);
        })) as unknown as LabelQuantityRow[];

        source = `shipment ${load.reference}`;
    } else {
        // ── Product paths: whole catalogue, or one product ───────────────────
        const channels = (await ctx.step('load-channels', async () => {
            return await loadPrintableChannels();
        })) as unknown as PrintableChannel[];

        if (channels.length === 0) {
            return ctx.complete({
                title: 'No channel is set up for labels',
                stage: 'print',
                description: NO_SPEC_DESCRIPTION,
                content: noSpecBanner(ctx),
            });
        }

        const channelChoice = await ctx.ui.page('channel', {
            stage: 'channel',
            title: 'Which channel are these labels for?',
            content: [
                ctx.ui.select.one('channelId', {
                    label: 'Channel',
                    options: channels.map((c) => ({
                        label: `${c.channelName} — ${c.symbology === 'Ean13' ? 'EAN-13' : 'Code 128'}, ${c.productsWithCodes} product(s) coded`,
                        value: c.channelId,
                    })),
                    defaultValue: channels[0].channelId,
                }),
            ],
            actions: [{ label: 'Continue', value: 'next', mode: 'primary' }],
        });

        channel = channels.find((c) => c.channelId === channelChoice.data.channelId)!;

        const { candidates, unprintable } = (await ctx.step('load-candidates', async () => {
            return await loadLabelCandidates(channel.channelId, channel.symbology, singleProductId);
        })) as unknown as CandidateLoad;

        if (candidates.length === 0) {
            const why = unprintable.length > 0 ? ` — ${unprintable[0].problem}` : '';
            return ctx.complete({
                title: 'Nothing to print',
                stage: 'print',
                description: singleProductId
                    ? `This product has no printable ${channel.channelName} code${why}. Add one under Channel codes on the product page.`
                    : `No product carries a printable ${channel.channelName} code yet. Add them under Channel codes on each product page.`,
                content: [],
            });
        }

        let selected: LabelCandidate[];

        if (singleProductId) {
            // One product: no picker, but the stock still has to be confirmed.
            selected = candidates;
            await ctx.ui.page('confirm-product', {
                stage: 'select',
                title: `${candidates[0].name} — ${channel.channelName}`,
                content: [
                    ctx.ui.display.keyValue({
                        data: [
                            { key: 'SKU', value: candidates[0].sku },
                            { key: 'Code', value: candidates[0].code },
                            { key: 'Channel', value: channel.channelName },
                            { key: 'Label stock', value: LABEL_STOCKS[channel.defaultStock].label },
                        ],
                    }),
                ],
                actions: [{ label: 'Set label count', value: 'next', mode: 'primary' }],
            });
        } else {
            const selection = await ctx.ui.page('select', {
                stage: 'select',
                title: `Which products need ${channel.channelName} labels?`,
                content: [
                    ...(unprintable.length > 0
                        ? [
                              ctx.ui.display.banner({
                                  title: `${unprintable.length} product(s) have an unusable code`,
                                  description:
                                      'They are left out of the list below. Fix the code under ' +
                                      'Channel codes on the product page to include them.',
                                  mode: 'warning',
                              }),
                          ]
                        : []),
                    ctx.ui.select.table('products', {
                        data: candidates,
                        columns: ['sku', 'name', 'brand', 'code'],
                        mode: 'multi',
                    }),
                ],
                validate: (data) => {
                    if (!data.products || data.products.length === 0) {
                        return 'Pick at least one product to print labels for.';
                    }
                    return true;
                },
                actions: [{ label: 'Set label counts', value: 'next', mode: 'primary' }],
            });
            // Re-sorted by name: the picker hands back the rows the operator
            // ticked, not necessarily in the order they were shown, and the
            // grid, the screen and the printed stack all have to agree.
            selected = ((selection.data.products ?? []) as LabelCandidate[])
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name));
        }

        // A fixed step key: the pages above are already persisted by the time the
        // body re-runs, so `selected` is stable for the run.
        seededRows = (await ctx.step('seed-quantities', async () => {
            const stockBySku = await loadStockBySku(selected.map((s) => s.sku));
            return buildQuantityRows(selected, stockBySku);
        })) as unknown as LabelQuantityRow[];

        source = channel.channelName;
    }

    // Read straight off the channel's label spec — the roll is part of how the
    // channel is set up, not something to re-confirm on every run.
    const format: LabelFormat = {
        symbology: channel.symbology,
        annotation: channel.annotation,
        annotationPlacement: channel.annotationPlacement,
        stock: LABEL_STOCKS[channel.defaultStock],
    };

    // ── Label counts → print, repeatable ────────────────────────────────────
    // The print page can hand control back to the counts grid so a jammed or
    // short label can be re-run on its own: zero the rows that came out fine,
    // leave the one that did not, print again. Each pass is a fresh pair of page
    // keys, since keys have to be unique within a run.
    const MAX_PASSES = 20;
    let rows = seededRows;
    let passesPrinted = 0;

    for (let pass = 0; pass < MAX_PASSES; pass++) {
        const quantities = await ctx.ui.page(`quantities-${pass}`, {
            stage: 'quantities',
            title: pass === 0 ? 'How many labels of each?' : 'Adjust the counts and print again',
            content: [
                ctx.ui.display.markdown({
                    content:
                        pass > 0
                            ? 'Set the products you have already labelled to **0** — only rows with a ' +
                              'count of 1 or more are printed. Remove a row entirely to leave it out.'
                            : shipmentId
                              ? 'One label per unit going into the fulfilment centre. Counts come from the ' +
                                'consignment; **on hand** is shown for reference.'
                              : 'One label per unit going into the fulfilment centre. **On hand** is shown ' +
                                'for reference — counts start at 1 so a stray click cannot commit a whole roll.',
                }),
                ctx.ui.inputs.dataGrid('rows', {
                    data: rows,
                    columns: [
                        { key: 'productId', type: 'hidden' },
                        { key: 'code', label: 'Code', type: 'text', editable: false },
                        { key: 'sku', label: 'SKU', type: 'text', editable: false },
                        { key: 'name', label: 'Product', type: 'text', editable: false },
                        { key: 'onHand', label: 'On hand', type: 'number', editable: false },
                        { key: 'labels', label: 'Labels', type: 'number', editable: true },
                    ],
                    allowAddRows: false,
                    allowDeleteRows: true,
                }),
            ],
            validate: (data) => {
                const entered = (data.rows ?? []) as LabelQuantityRow[];
                if (entered.length === 0) return 'Nothing left to print — every row was removed.';
                const bad = entered.find(
                    (r) => !Number.isInteger(Number(r.labels)) || Number(r.labels) < 0
                );
                if (bad) return `"${bad.sku}" needs a whole label count of 0 or more.`;
                if (!entered.some((r) => Number(r.labels) > 0)) {
                    return 'Every count is 0 — set at least one row to 1 or more.';
                }
                return true;
            },
            actions: [{ label: 'Continue to print', value: 'next', mode: 'primary' }],
        });

        // Carried into the next pass so the grid comes back with what was last
        // entered rather than resetting to the original seed.
        rows = ((quantities.data.rows ?? []) as LabelQuantityRow[]).map((r) => ({
            ...r,
            labels: Number(r.labels),
        }));

        // A count of 0 means "already done" — kept visible in the grid for the
        // next pass, but not printed.
        const printing = rows.filter((r) => r.labels > 0);
        const totalLabels = printing.reduce((sum, r) => sum + r.labels, 0);

        // Codes were all validated on the way in, so buildBatchZpl throwing here
        // would be a backstop rather than a live path. One job for the whole run:
        // a job boundary costs seconds of printer feed/backfeed.
        const data = buildBatchZpl(
            printing.map((row) => ({ code: row.code, title: row.name, quantity: row.labels })),
            format
        );

        // Code 128 widens with the code, so the tightest row decides whether the
        // run is in tolerance — check them all, not just the first.
        const worst = printing
            .map((r) => computeLayout(format, r.code))
            .reduce((a, b) => (a.xDimensionMm <= b.xDimensionMm ? a : b));

        const outcome = await ctx.ui.page(`print-${pass}`, {
            stage: 'print',
            title: `Print ${totalLabels} label(s)`,
            content: [
                ...(worst.withinTolerance
                    ? []
                    : [
                          ctx.ui.display.banner({
                              title: 'Barcode is narrower than the symbology allows on this stock',
                              description:
                                  `${format.stock.label} only fits a ${worst.moduleDots}-dot module ` +
                                  `(${worst.xDimensionMm.toFixed(3)}mm) for the longest code in this ` +
                                  'run. It will usually still scan, but a wider label prints in spec.',
                              mode: 'warning',
                          }),
                      ]),
                ctx.ui.display.keyValue({
                    data: [
                        { key: 'Channel', value: channel.channelName },
                        { key: 'Symbology', value: channel.symbology === 'Ean13' ? 'EAN-13' : 'Code 128' },
                        ...(channel.annotation ? [{ key: 'Annotation', value: channel.annotation }] : []),
                        { key: 'Products', value: printing.length },
                        { key: 'Labels in total', value: totalLabels },
                        { key: 'Label stock', value: format.stock.label },
                        { key: 'Printer', value: PRINTER },
                    ],
                }),
                ctx.ui.display.table({
                    data: printing.map((r) => ({
                        SKU: r.sku,
                        Product: r.name,
                        Code: r.code,
                        Labels: r.labels,
                    })),
                }),
                ctx.ui.interactive.print({
                    title: `${channel.channelName} unit barcodes`,
                    description:
                        'The whole run is one job, so it prints without a pause between products. ' +
                        'If a label jams, go back and re-run just that product.',
                    jobs: [
                        {
                            name: `${printing.length} product(s) × ${totalLabels} label(s)`,
                            type: 'zpl' as const,
                            printer: PRINTER,
                            data,
                        },
                    ],
                    allowReprint: true,
                }),
            ],
            actions: [
                { label: 'Adjust counts and print again', value: 'again' },
                { label: 'Done', value: 'done', mode: 'primary' },
            ],
        });

        passesPrinted++;
        if (outcome.action === 'done') break;
    }

    return ctx.complete({
        stage: 'print',
        autoClose: true,
        title: 'Labels sent to the printer',
        description: `${source} — ${passesPrinted} print run(s) on ${format.stock.label}.`,
    });
});

// Both entry paths dead-end the same way when the channel has no label spec:
// the codes can be synced and sitting on every product, but nothing is
// printable until a spec says how the label is built.
const NO_SPEC_DESCRIPTION =
    'Add a channel label spec first — Products → Barcode labels → Add a label spec. ' +
    'Pick the channel, its symbology (EAN-13 for Takealot, Code 128 for Amazon FNSKU), ' +
    'the fixed annotation, and the label stock.';

// ctx.complete always renders as a success, tick and all, so a run that stopped
// because something is missing has to say so in the body — otherwise "nothing
// is set up" reads as "done".
function noSpecBanner(ctx: any) {
    return [
        ctx.ui.display.banner({
            title: 'Setup needed — nothing was printed',
            description:
                'Product codes are synced separately from the label spec, so a channel can ' +
                'carry a code for every product and still not be printable.',
            mode: 'warning',
        }),
    ];
}

// Why some of a consignment's lines are being left out, in one sentence.
function describeShipmentProblems(load: ShipmentLabelLoad): string {
    const parts: string[] = [];
    if (load.unprintable.length > 0) {
        parts.push(
            `${load.unprintable.length} line(s) cannot be labelled — see the reasons below. ` +
                'Unmatched lines are fixed by running *Sync Products* then *Sync channel shipments*; ' +
                'a missing or invalid code is fixed under Channel codes on the product page.'
        );
    }
    if (load.cancelledLines > 0) {
        parts.push(`${load.cancelledLines} cancelled line(s) were excluded.`);
    }
    if (parts.length === 0) {
        parts.push('This consignment has no lines to label.');
    }
    return parts.join(' ');
}

// The unprintable lines as a table, so the completion page names them rather
// than just counting them.
function unprintableTable(ctx: any, load: ShipmentLabelLoad) {
    if (load.unprintable.length === 0) return [];
    return [
        ctx.ui.display.table({
            data: load.unprintable.map((u) => ({
                Line: u.sku,
                Product: u.name,
                Problem: u.problem,
            })),
        }),
    ];
}
