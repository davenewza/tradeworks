import { PrintChannelBarcodes, FlowConfig, LabelStockSize } from '@teamkeel/sdk';
import {
    LABEL_STOCKS,
    CandidateLoad,
    LabelCandidate,
    LabelFormat,
    LabelQuantityRow,
    buildLabelZpl,
    buildQuantityRows,
    computeLayout,
} from '../lib/barcodeLabelHelpers';
import {
    PrintableChannel,
    loadPrintableChannels,
    loadLabelCandidates,
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

    // ── Page 1: which channel ───────────────────────────────────────────────
    const channels = (await ctx.step('load-channels', async () => {
        return await loadPrintableChannels();
    })) as unknown as PrintableChannel[];

    if (channels.length === 0) {
        return ctx.complete({
            title: 'No channel is set up for labels',
            stage: 'print',
            description:
                'Add a channel label spec first (Products → Barcode labels → Label specs): ' +
                'pick the channel, its symbology — EAN-13 for Takealot, Code 128 for Amazon ' +
                'FNSKU — and the label stock.',
            content: [],
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

    const channel = channels.find((c) => c.channelId === channelChoice.data.channelId)!;

    // ── Page 2: which products (skipped when launched from a product) ───────
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
    let stockKey: LabelStockSize;

    if (singleProductId) {
        // One product: no picker, but the stock still has to be confirmed.
        selected = candidates;
        const stockChoice = await ctx.ui.page('stock', {
            stage: 'select',
            title: `${candidates[0].name} — ${channel.channelName}`,
            content: [
                ctx.ui.display.keyValue({
                    data: [
                        { key: 'SKU', value: candidates[0].sku },
                        { key: 'Code', value: candidates[0].code },
                        { key: 'Channel', value: channel.channelName },
                    ],
                }),
                stockInput(ctx, channel),
            ],
            actions: [{ label: 'Set label count', value: 'next', mode: 'primary' }],
        });
        stockKey = stockChoice.data.stock as LabelStockSize;
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
                stockInput(ctx, channel),
            ],
            validate: (data) => {
                if (!data.products || data.products.length === 0) {
                    return 'Pick at least one product to print labels for.';
                }
                return true;
            },
            actions: [{ label: 'Set label counts', value: 'next', mode: 'primary' }],
        });
        selected = (selection.data.products ?? []) as LabelCandidate[];
        stockKey = selection.data.stock as LabelStockSize;
    }

    const format: LabelFormat = {
        symbology: channel.symbology,
        annotation: channel.annotation,
        annotationPlacement: channel.annotationPlacement,
        stock: LABEL_STOCKS[stockKey] ?? LABEL_STOCKS[channel.defaultStock],
    };

    // ── Page 3: how many of each ────────────────────────────────────────────
    // A fixed step key: the pages above are already persisted by the time the
    // body re-runs, so `selected` is stable for the run.
    const seededRows = (await ctx.step('seed-quantities', async () => {
        const stockBySku = await loadStockBySku(selected.map((s) => s.sku));
        return buildQuantityRows(selected, stockBySku);
    })) as unknown as LabelQuantityRow[];

    const quantities = await ctx.ui.page('quantities', {
        stage: 'quantities',
        title: 'How many labels of each?',
        content: [
            ctx.ui.display.markdown({
                content:
                    'One label per unit going into the fulfilment centre. **On hand** is shown ' +
                    'for reference — counts start at 1 so a stray click cannot commit a whole roll.',
            }),
            ctx.ui.inputs.dataGrid('rows', {
                data: seededRows,
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
            const rows = (data.rows ?? []) as LabelQuantityRow[];
            if (rows.length === 0) return 'Nothing left to print — every row was removed.';
            const bad = rows.find(
                (r) => !Number.isInteger(Number(r.labels)) || Number(r.labels) < 1
            );
            if (bad) return `"${bad.sku}" needs a whole label count of 1 or more.`;
            return true;
        },
        actions: [{ label: 'Continue to print', value: 'next', mode: 'primary' }],
    });

    const rows = ((quantities.data.rows ?? []) as LabelQuantityRow[]).map((r) => ({
        ...r,
        labels: Number(r.labels),
    }));

    // ── Page 4: print ───────────────────────────────────────────────────────
    // Codes were all validated on the way in, so buildLabelZpl throwing here
    // would be a backstop rather than a live path.
    const jobs = rows.map((row) => ({
        name: `${row.sku} × ${row.labels}`,
        type: 'zpl' as const,
        printer: PRINTER,
        data: buildLabelZpl({ code: row.code, title: row.name, quantity: row.labels }, format),
    }));

    const totalLabels = rows.reduce((sum, r) => sum + r.labels, 0);
    // Code 128 widens with the code, so the tightest row decides whether the run
    // is in tolerance — check them all, not just the first.
    const worst = rows
        .map((r) => computeLayout(format, r.code))
        .reduce((a, b) => (a.xDimensionMm <= b.xDimensionMm ? a : b));

    await ctx.ui.page('print', {
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
                    { key: 'Products', value: rows.length },
                    { key: 'Labels in total', value: totalLabels },
                    { key: 'Label stock', value: format.stock.label },
                    { key: 'Printer', value: PRINTER },
                ],
            }),
            ctx.ui.interactive.print({
                title: `${channel.channelName} unit barcodes`,
                description:
                    'Each job prints one product’s labels. Reprint any job if a label jams ' +
                    'or comes out short.',
                jobs,
                allowReprint: true,
            }),
        ],
        actions: [{ label: 'Done', value: 'done', mode: 'primary' }],
    });

    return ctx.complete({
        title: 'Labels sent to the printer',
        stage: 'print',
        description: `${totalLabels} label(s) across ${rows.length} product(s) for ${channel.channelName}, on ${format.stock.label}.`,
        content: [
            ctx.ui.display.table({
                data: rows.map((r) => ({
                    SKU: r.sku,
                    Product: r.name,
                    Code: r.code,
                    Labels: r.labels,
                })),
            }),
        ],
    });
});

// The stock picker, defaulted from the channel's spec. Shared by both entry
// paths so they cannot drift.
function stockInput(ctx: any, channel: PrintableChannel) {
    return ctx.ui.select.one('stock', {
        label: 'Label stock loaded in the printer',
        options: (Object.keys(LABEL_STOCKS) as LabelStockSize[]).map((value) => ({
            label: LABEL_STOCKS[value].label,
            value,
        })),
        defaultValue: channel.defaultStock,
    });
}
