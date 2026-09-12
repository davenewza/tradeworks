import { PrintChannelBarcodes, FlowConfig, BarcodeSymbology } from '@teamkeel/sdk';
import {
    LABEL_STOCKS,
    CandidateLoad,
    LabelCandidate,
    LabelFormat,
    LabelQuantityRow,
    MIN_BAR_HEIGHT_MM,
    buildBatchZpl,
    buildQuantityRows,
    buildShipmentQuantityRows,
    computeLayout,
    describeElements,
} from '../lib/barcodeLabelHelpers';
import {
    PrintableChannel,
    ProductLabelLoad,
    ShipmentLabelLoad,
    loadPrintableChannels,
    loadLabelCandidates,
    loadProductLabelOptions,
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

    // The channel this run prints on. Settled before the counts page on the
    // shipment and catalogue paths; on the single-product path the counts page
    // settles it, and this holds the only candidate until then.
    let channel: PrintableChannel;
    // Set only on the single-product path: the product, and every channel it can
    // be labelled for.
    let single: ProductLabelLoad | undefined;
    // Set only on the shipment path, so the counts page can show where the run
    // came from and what it is leaving out.
    let shipmentLoad: ShipmentLabelLoad | undefined;
    // Seeded label counts for the grid, and a one-line description of where the
    // run came from for the completion page.
    let seededRows: LabelQuantityRow[] = [];
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

        if (load.candidates.length === 0) {
            return ctx.complete({
                title: 'Nothing to print for this shipment',
                stage: 'print',
                description: describeShipmentProblems(load),
                content: unprintableTable(ctx, load),
            });
        }

        shipmentLoad = load;
        channel = load.channel;

        seededRows = (await ctx.step('seed-shipment-quantities', async () => {
            const stockBySku = await loadStockBySku(load.candidates.map((c) => c.sku));
            return buildShipmentQuantityRows(load.candidates, stockBySku);
        })) as unknown as LabelQuantityRow[];

        source = `shipment ${load.reference}`;
    } else {
        // ── Product paths: one product, or the whole catalogue ───────────────
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

        if (singleProductId) {
            // One product, read across every channel at once. Which channel to
            // print is then a question the data usually answers on its own, so
            // it never gets a page: it is either settled here, or it rides on
            // the counts page as a dropdown.
            const load = (await ctx.step('load-product', async () => {
                return await loadProductLabelOptions(singleProductId, channels);
            })) as unknown as ProductLabelLoad | null;

            if (!load) {
                return ctx.complete({
                    title: 'Product not found',
                    stage: 'print',
                    description: 'It may have been deleted since this page was opened.',
                    content: [],
                });
            }

            if (load.options.length === 0) {
                return ctx.complete({
                    title: 'Nothing to print for this product',
                    stage: 'print',
                    description: describeProductProblems(load),
                    content: productProblemTable(ctx, load),
                });
            }

            single = load;
            channel = load.options[0].channel;
            source = load.name;
        } else {
            // One printable channel is not a question. Asking anyway spent a
            // page on every run for an answer that could not have differed.
            if (channels.length === 1) {
                channel = channels[0];
            } else {
                const channelChoice = await ctx.ui.page('channel', {
                    stage: 'channel',
                    title: 'Which channel are these labels for?',
                    content: [
                        ctx.ui.select.one('channelId', {
                            label: 'Channel',
                            options: channels.map((c) => ({
                                label: `${c.channelName} — ${symbologyLabel(c.symbology)}, ${c.productsWithCodes} product(s) coded`,
                                value: c.channelId,
                            })),
                            defaultValue: channels[0].channelId,
                        }),
                    ],
                    actions: [{ label: 'Continue', value: 'next', mode: 'primary' }],
                });

                channel = channels.find((c) => c.channelId === channelChoice.data.channelId)!;
            }

            const { candidates, unprintable } = (await ctx.step('load-candidates', async () => {
                return await loadLabelCandidates(channel.channelId, channel.symbology);
            })) as unknown as CandidateLoad;

            if (candidates.length === 0) {
                return ctx.complete({
                    title: 'Nothing to print',
                    stage: 'print',
                    description:
                        `No product carries a printable ${channel.channelName} code yet. ` +
                        'Add them under Channel codes on each product page.',
                    content: [],
                });
            }

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
            const selected = ((selection.data.products ?? []) as LabelCandidate[])
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name));

            // A fixed step key: the pages above are already persisted by the time
            // the body re-runs, so `selected` is stable for the run.
            seededRows = (await ctx.step('seed-quantities', async () => {
                const stockBySku = await loadStockBySku(selected.map((s) => s.sku));
                return buildQuantityRows(selected, stockBySku);
            })) as unknown as LabelQuantityRow[];

            source = channel.channelName;
        }
    }

    // ── Label counts → print, repeatable ────────────────────────────────────
    // The print page can hand control back to the counts page so a jammed or
    // short label can be re-run: on a batch, zero the rows that came out fine
    // and leave the one that did not; on a single product, just print again.
    // Each pass is a fresh pair of page keys, since keys have to be unique
    // within a run.
    const MAX_PASSES = 20;
    let rows = seededRows;
    let labels = 1;
    let passesPrinted = 0;

    for (let pass = 0; pass < MAX_PASSES; pass++) {
        if (single) {
            // One product needs one number, not a grid — and with no grid to
            // build, the channel can be chosen on this same page. That is what
            // makes a product page's label one page and one click.
            const entered = await ctx.ui.page(`quantities-${pass}`, {
                stage: 'quantities',
                title: pass === 0 ? single.name : 'Print this label again',
                content: [
                    ...(pass === 0 && single.unprintable.length > 0
                        ? [
                              ctx.ui.display.banner({
                                  title: `${single.unprintable.length} other channel(s) cannot label this product`,
                                  description: describeProductProblems(single),
                                  mode: 'warning',
                              }),
                          ]
                        : []),
                    ctx.ui.display.keyValue({
                        data: [
                            { key: 'SKU', value: single.sku },
                            { key: 'On hand', value: single.onHand },
                            // Only when there is nothing to choose — otherwise
                            // the dropdown below carries the same facts per
                            // channel, and stating one of them here would go
                            // stale the moment the operator picks the other.
                            ...(single.options.length === 1
                                ? [
                                      { key: 'Channel', value: channel.channelName },
                                      { key: 'Code', value: single.options[0].code },
                                      {
                                          key: 'Label stock',
                                          value: LABEL_STOCKS[channel.defaultStock].label,
                                      },
                                  ]
                                : []),
                        ],
                    }),
                    ...(single.options.length > 1
                        ? [
                              ctx.ui.select.one('channelId', {
                                  label: 'Channel',
                                  options: single.options.map((o) => ({
                                      label:
                                          `${o.channel.channelName} — ${o.code} · ` +
                                          `${symbologyLabel(o.channel.symbology)} on ` +
                                          `${LABEL_STOCKS[o.channel.defaultStock].label}`,
                                      value: o.channel.channelId,
                                  })),
                                  // No default on the first pass: with a real
                                  // choice to make, an arbitrary one that the
                                  // print page then fires on its own is a
                                  // wrong-channel label nobody read. The
                                  // runtime requires a pick. A re-run defaults
                                  // to the channel just printed.
                                  defaultValue: pass === 0 ? undefined : channel.channelId,
                              }),
                          ]
                        : []),
                    ctx.ui.inputs.number('labels', {
                        label: 'Labels',
                        defaultValue: labels,
                        min: 1,
                        helpText:
                            'One label per unit going into the fulfilment centre. Starts at 1 so a ' +
                            'stray click cannot commit a whole roll.',
                    }),
                ],
                validate: (data) => {
                    const count = Number((data as { labels?: unknown }).labels);
                    if (!Number.isInteger(count) || count < 1) {
                        return 'Set a whole number of labels, 1 or more.';
                    }
                    return true;
                },
                actions: [{ label: 'Print', value: 'next', mode: 'primary' }],
            });

            const answer = entered.data as { channelId?: string; labels: number };
            // The fallback is the one-option case, where there is no dropdown on
            // the page to answer with; where there is one, it is required.
            const option =
                single.options.find((o) => o.channel.channelId === answer.channelId) ??
                single.options[0];
            channel = option.channel;
            labels = Number(answer.labels);
            rows = [
                {
                    productId: single.productId,
                    code: option.code,
                    sku: single.sku,
                    name: single.name,
                    onHand: single.onHand,
                    labels,
                },
            ];
        } else {
            const quantities = await ctx.ui.page(`quantities-${pass}`, {
                stage: 'quantities',
                title:
                    pass > 0
                        ? 'Adjust the counts and print again'
                        : shipmentLoad
                          ? `Shipment ${shipmentLoad.reference} — ${channel.channelName}`
                          : 'How many labels of each?',
                content: [
                    // The shipment summary. It was a page of its own until it
                    // became clear it only ever preceded this one — the same
                    // facts, one click cheaper.
                    ...(pass === 0 && shipmentLoad
                        ? [
                              ...(shipmentLoad.unprintable.length > 0
                                  ? [
                                        ctx.ui.display.banner({
                                            title: `${shipmentLoad.unprintable.length} line(s) cannot be labelled`,
                                            description: describeShipmentProblems(shipmentLoad),
                                            mode: 'warning',
                                        }),
                                    ]
                                  : []),
                              ctx.ui.display.keyValue({
                                  data: [
                                      { key: 'Shipment', value: shipmentLoad.externalId },
                                      { key: 'Channel', value: channel.channelName },
                                      { key: 'Lines to label', value: shipmentLoad.candidates.length },
                                      {
                                          key: 'Units going in',
                                          value: shipmentLoad.candidates.reduce(
                                              (sum, c) => sum + c.quantity,
                                              0
                                          ),
                                      },
                                      {
                                          key: 'Label stock',
                                          value: LABEL_STOCKS[channel.defaultStock].label,
                                      },
                                  ],
                              }),
                              ...unprintableTable(ctx, shipmentLoad),
                          ]
                        : []),
                    ctx.ui.display.markdown({
                        content:
                            pass > 0
                                ? 'Set the products you have already labelled to **0** — only rows with a ' +
                                  'count of 1 or more are printed. Remove a row entirely to leave it out.'
                                : shipmentLoad
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

            // Carried into the next pass so the grid comes back with what was
            // last entered rather than resetting to the original seed.
            rows = ((quantities.data.rows ?? []) as LabelQuantityRow[]).map((r) => ({
                ...r,
                labels: Number(r.labels),
            }));
        }

        // Read straight off the channel's label spec — the roll is part of how
        // the channel is set up, not something to re-confirm on every run.
        const format: LabelFormat = {
            symbology: channel.symbology,
            elements: channel.elements,
            stock: LABEL_STOCKS[channel.defaultStock],
        };

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
            title: single
                ? `Printing ${totalLabels} label(s)`
                : `Print ${totalLabels} label(s)`,
            content: [
                ...elementsBanner(ctx, channel),
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
                ...(worst.barHeightWithinTolerance
                    ? []
                    : [
                          ctx.ui.display.banner({
                              title: 'Barcode is shorter than it should be on this label',
                              description:
                                  `What the label’s other elements leave the bars is ` +
                                  `${worst.barHeightMm.toFixed(1)}mm, under the ${MIN_BAR_HEIGHT_MM}mm ` +
                                  'a unit label should carry. Raise or clear the barcode element’s ' +
                                  'height cap, remove an element, drop the product name to one line, ' +
                                  'or move this channel to a taller roll — under Products → ' +
                                  'Barcode labels → Label specs.',
                              mode: 'warning',
                          }),
                      ]),
                ctx.ui.display.keyValue({
                    data: [
                        { key: 'Channel', value: channel.channelName },
                        { key: 'Symbology', value: symbologyLabel(channel.symbology) },
                        { key: 'Label layout', value: describeElements(channel.elements) },
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
                    description: single
                        ? 'Printing as this page opens. Press print again if the label comes out short.'
                        : 'The whole run is one job, so it prints without a pause between products. ' +
                          'If a label jams, go back and re-run just that product.',
                    jobs: [
                        {
                            name: `${printing.length} product(s) × ${totalLabels} label(s)`,
                            type: 'zpl' as const,
                            printer: PRINTER,
                            data,
                        },
                    ],
                    // Fires the job as the page opens, so one product is a single
                    // click from its page to a label in hand. Deliberately not
                    // done for the batch paths: a run there is tens or hundreds
                    // of labels, and anything that re-fires the job costs a roll
                    // rather than a label.
                    autoPrint: single !== undefined,
                    allowReprint: true,
                }),
            ],
            actions: [
                {
                    label: single ? 'Print another count' : 'Adjust counts and print again',
                    value: 'again',
                },
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
        description: `${source} — ${passesPrinted} print run(s) on ${LABEL_STOCKS[channel.defaultStock].label}.`,
    });
});

const symbologyLabel = (symbology: BarcodeSymbology): string =>
    symbology === BarcodeSymbology.Ean13 ? 'EAN-13' : 'Code 128';

// Both entry paths dead-end the same way when the channel has no label spec:
// the codes can be synced and sitting on every product, but nothing is
// printable until a spec says how the label is built.
const NO_SPEC_DESCRIPTION =
    'Add a channel label spec first — Products → Barcode labels → Add a label spec. ' +
    'Pick the channel, its symbology (EAN-13 for Takealot, Code 128 for Amazon FNSKU) ' +
    'and the label stock, then add the elements that go on the label — the barcode, ' +
    'the product name, and any fixed text such as Amazon’s item condition.';

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

// A channel printing the fallback layout, or carrying element rows that do not
// make a label, still prints — but silently plain labels are worse than plain
// ones you were told about, so the print page says which and why.
function elementsBanner(ctx: any, channel: PrintableChannel) {
    if (!channel.usingDefaultElements) return [];
    const why =
        channel.elementProblems.length > 0
            ? `Its own elements cannot be used: ${channel.elementProblems.join('; ')}. `
            : 'It has no label elements yet. ';
    return [
        ctx.ui.display.banner({
            title: `${channel.channelName} is printing the default label`,
            description:
                `${why}These labels carry the product name over the barcode and nothing else — ` +
                'no item condition, no stacked marker. Add or fix the elements under Products → ' +
                'Barcode labels → Label specs → the channel.',
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
    if (load.channelLabelledLines > 0) {
        parts.push(
            `${load.channelLabelledLines} line(s) were excluded because the channel labels ` +
                'those units itself, or they carry the manufacturer’s own barcode.'
        );
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

// Which channels cannot label this product, in one sentence. Named rather than
// counted, since with two channels in play "one of them is missing a code" is
// not enough to act on.
function describeProductProblems(load: ProductLabelLoad): string {
    if (load.unprintable.length === 0) {
        return 'No channel is set up to label this product.';
    }
    return (
        `${load.unprintable.map((u) => u.channelName).join(', ')} cannot label it — see below. ` +
        'A missing or invalid code is fixed under Channel codes on the product page.'
    );
}

function productProblemTable(ctx: any, load: ProductLabelLoad) {
    if (load.unprintable.length === 0) return [];
    return [
        ctx.ui.display.table({
            data: load.unprintable.map((u) => ({
                Channel: u.channelName,
                Problem: u.problem,
            })),
        }),
    ];
}
