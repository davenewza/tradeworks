import { BoxType, CalculateShipping, FlowConfig } from '@teamkeel/sdk';
import {
    BOX_TYPE_LABELS,
    PROVINCES,
    Shipment,
    ShipmentOutcome,
    ShipmentPageData,
    boxRows,
    calculateShipment,
    describeAddress,
    formatRand,
    issuesMarkdown,
    loadProductNames,
    productLabel,
    productRows,
    rateRows,
    readShipmentPage,
    searchShippableProducts,
    shipmentFacts,
    shipmentTotals,
    totalsItems,
    validateShipmentPage
} from '../lib/shippingCalculator';

const config = {
    title: 'Shipping calculator',
    description:
        'Pack products into boxes and price delivery to an address — the same boxes and courier rates as a customer quote',
    stages: [
        { name: 'Shipment', key: 'shipment' },
        { name: 'Rates', key: 'rates' },
    ],
} as const satisfies FlowConfig;

// Change-and-recalculate rounds before the run is wrapped up regardless.
const MAX_PASSES = 20;

// The quote itself is lib/deliveryQuote, shared with the getDeliveryRates API
// (see lib/shippingCalculator for the page wording). Each pass asks for the
// shipment — pre-filled from the pass before — quotes it, and shows the
// result; the operator either finishes or changes the shipment and goes
// round again. Nothing is written: the quote is the run's completion page.
export default CalculateShipping(config, async (ctx) => {
    let shipment: Shipment | undefined;
    let names: Record<string, string> = {};
    let outcome: ShipmentOutcome | undefined;

    for (let pass = 0; pass < MAX_PASSES; pass++) {
        const entered = await ctx.ui.page(`shipment-${pass}`, {
            stage: 'shipment',
            title: pass === 0 ? 'What is being shipped, and where to?' : 'Change the shipment',
            content: [
                ctx.ui.display.markdown({
                    content:
                        'Ships from our Somerset West warehouse with The Courier Guy. The products are packed into ' +
                        'boxes by volume, and every courier rate includes our 10% delivery markup — exactly as a ' +
                        'customer quote is priced.',
                }),
                ctx.ui.inputs.dataGrid('lines', {
                    data: shipment
                        ? shipment.lines.map((line) => ({ sku: line.sku, quantity: line.quantity }))
                        : [{ sku: null as string | null, quantity: 1 }],
                    columns: [
                        {
                            key: 'sku',
                            label: 'Product',
                            type: 'lookup',
                            editable: true,
                            lookup: {
                                search: ({ query }) => searchShippableProducts(query),
                                labels: Object.fromEntries(
                                    Object.entries(names).map(([sku, name]) => [sku, productLabel(sku, name)]),
                                ),
                                placeholder: 'Search by SKU or name',
                            },
                        },
                        { key: 'quantity', label: 'Quantity', type: 'number', editable: true, defaultValue: 1, summary: 'sum' },
                    ],
                    allowAddRows: true,
                    allowDeleteRows: true,
                }),
                ctx.ui.select.one('boxType', {
                    label: 'Pack in',
                    options: [BoxType.Cardboard, BoxType.PlasticEquipment].map((value) => ({
                        label: BOX_TYPE_LABELS[value],
                        value,
                    })),
                    defaultValue: shipment?.boxType ?? BoxType.Cardboard,
                    helpText: 'Plastic equipment boxes are charged for, on top of the delivery fee.',
                }),
                ctx.ui.display.header({ title: 'Deliver to', level: 3 }),
                ctx.ui.inputs.text('organisation', {
                    label: 'Company',
                    optional: true,
                    defaultValue: shipment?.address.organisation ?? undefined,
                }),
                ctx.ui.inputs.text('addressLine1', {
                    label: 'Street address',
                    defaultValue: shipment?.address.addressLine1,
                }),
                ctx.ui.inputs.text('addressLine2', {
                    label: 'Unit, floor or building',
                    optional: true,
                    defaultValue: shipment?.address.addressLine2 ?? undefined,
                }),
                ctx.ui.inputs.text('suburb', { label: 'Suburb', defaultValue: shipment?.address.suburb }),
                ctx.ui.inputs.text('city', { label: 'City or town', defaultValue: shipment?.address.city }),
                ctx.ui.select.one('province', {
                    label: 'Province',
                    options: PROVINCES.map((province) => ({ label: province, value: province })),
                    defaultValue: shipment?.address.province,
                }),
                ctx.ui.inputs.text('postalCode', { label: 'Postal code', defaultValue: shipment?.address.postalCode }),
            ],
            validate: (data) => validateShipmentPage(data as ShipmentPageData),
            actions: [{ label: 'Calculate', value: 'calculate', mode: 'primary' }],
        });

        // Fixed per-pass keys: the page above is persisted by the time the
        // body re-runs, so `current` is stable for the pass.
        const current = readShipmentPage(entered.data as ShipmentPageData);
        shipment = current;
        names = await ctx.step(`names-${pass}`, async () => await loadProductNames(current.lines.map((l) => l.sku)));
        outcome = (await ctx.step(`quote-${pass}`, async () =>
            await calculateShipment(current, { apiUrl: ctx.env.SHIPLOGIC_API_URL, apiKey: ctx.secrets.SHIPLOGIC_API_KEY }),
        )) as ShipmentOutcome;

        const results = await ctx.ui.page(`rates-${pass}`, {
            stage: 'rates',
            fullWidth: true,
            ...heading(outcome, current),
            content: resultContent(ctx, outcome, current, names),
            actions:
                outcome.status === 'quoted'
                    ? [
                          { label: 'Change the shipment', value: 'change' },
                          { label: 'Done', value: 'done', mode: 'primary' },
                      ]
                    : [{ label: 'Change the shipment', value: 'change', mode: 'primary' }],
        });

        if (results.action === 'done') break;
    }

    return ctx.complete({
        stage: 'rates',
        fullWidth: true,
        ...heading(outcome!, shipment!),
        content: resultContent(ctx, outcome!, shipment!, names),
    });
});

function heading(outcome: ShipmentOutcome, shipment: Shipment): { title: string; description: string } {
    switch (outcome.status) {
        case 'quoted': {
            const total = shipmentTotals(outcome.quote).totalInclVat;
            return {
                title: `${formatRand(total)} incl. VAT — ${outcome.quote.deliveryService}`,
                description: `${shipment.address.city}, ${shipment.address.province}. Cheapest service first; every option is listed below.`,
            };
        }
        case 'invalid':
            return {
                title: 'This shipment cannot be quoted yet',
                description:
                    'Fix what is listed below, then calculate again. A product needs its dimensions and a weight, ' +
                    'set on its product page, to be packed and priced.',
            };
        case 'noRates':
            return {
                title: 'The courier has no service to this address',
                description: `Nothing came back for ${describeAddress(shipment.address)}. Check the address, then calculate again.`,
            };
        case 'failed':
            return {
                title: 'The courier could not price this shipment',
                description: 'Check the address, then calculate again.',
            };
    }
}

function resultContent(ctx: any, outcome: ShipmentOutcome, shipment: Shipment, names: Record<string, string>): any[] {
    const products = [
        ctx.ui.display.header({ title: 'Products', level: 3 }),
        ctx.ui.display.table({ data: productRows(shipment, names) }),
    ];

    switch (outcome.status) {
        case 'quoted': {
            const quote = outcome.quote;
            return [
                ctx.ui.display.summary({ title: 'Shipping', items: totalsItems(quote) }),
                ctx.ui.display.keyValue({ data: shipmentFacts(quote, shipment) }),
                ctx.ui.display.header({ title: 'Courier options', level: 3 }),
                ctx.ui.display.table({ data: rateRows(quote) }),
                ctx.ui.display.header({ title: 'Boxes', level: 3 }),
                ctx.ui.display.table({ data: boxRows(quote) }),
                ...products,
            ];
        }
        case 'invalid':
            return [ctx.ui.display.markdown({ content: issuesMarkdown(outcome.issues) }), ...products];
        case 'noRates':
            return products;
        case 'failed':
            return [
                ctx.ui.display.banner({ title: 'The courier returned an error', description: outcome.message, mode: 'error' }),
                ...products,
            ];
    }
}
