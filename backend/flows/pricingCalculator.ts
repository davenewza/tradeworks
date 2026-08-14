import { PricingCalculator, FlowConfig } from '@teamkeel/sdk';
import {
    loadPricingProducts,
    loadProductPricingContext,
    buildPricingView,
} from '../lib/pricingCalculatorHelpers';

const config = {
    title: 'Pricing Calculator',
    description: 'Set a target margin or sale price and see the fees, profit and per-bill freight sensitivity',
    stages: [{ name: 'Calculate', key: 'calc' }],
} as const satisfies FlowConfig;

const money = (n: number) => (Number.isFinite(n) ? 'R ' + n.toFixed(2) : '—');
const pct = (f: number) => (Number.isFinite(f) ? (f * 100).toFixed(1) + '%' : '—');

const BASIS_OPTIONS = [
    { label: 'Weighted average (by units)', value: 'weightedAverage' },
    { label: 'Latest bill', value: 'latest' },
    { label: 'Worst case (air / highest freight)', value: 'highestFreight' },
    { label: 'Best case (sea / lowest freight)', value: 'lowestFreight' },
];

const LEVER_OPTIONS = [
    { label: 'Target margin (%)', value: 'margin' },
    { label: 'Sale price (incl VAT)', value: 'price' },
];

const BASIS_LABEL: Record<string, string> = {
    weightedAverage: 'weighted avg',
    latest: 'latest',
    highestFreight: 'worst case',
    lowestFreight: 'best case',
};

export default PricingCalculator(config, async (ctx) => {
    const products = await ctx.step('load-products', async () => loadPricingProducts());
    if (products.length === 0) {
        return ctx.complete({
            title: 'No products',
            stage: 'calc',
            data: [{ key: 'Status', value: 'No enabled products found — run Sync Products first.' }],
        });
    }
    const productOptions = products.map((p) => ({ label: p.label, value: p.id }));
    const labelById = new Map(products.map((p) => [p.id, p.label]));

    // Current inputs — rebuilt from replayed page submissions on each body re-run.
    let sel: any = {
        productId: products[0].id,
        lever: 'margin',
        marginPct: 40,
        priceIncl: undefined,
        roas: undefined,
        basis: 'weightedAverage',
    };
    let i = 0;

    while (true) {
        const context = await loadProductPricingContext(sel.productId);
        const view = buildPricingView(context, {
            lever: sel.lever,
            marginPct: Number(sel.marginPct ?? 0),
            priceIncl: sel.priceIncl == null ? null : Number(sel.priceIncl),
            roas: sel.roas == null ? null : Number(sel.roas),
            basis: sel.basis,
        });
        const r = view.result;

        // Notices
        const notices: any[] = [];
        if (!context.hasCostLines)
            notices.push(
                ctx.ui.display.banner({
                    title: 'No cost lines synced',
                    description: 'Cost of goods is treated as zero. Run “Sync Supplier Costs” for this product’s bills.',
                    mode: 'warning',
                })
            );
        if (!context.hasFees)
            notices.push(
                ctx.ui.display.banner({
                    title: 'No channel fees',
                    description: 'Success and fulfilment fees are treated as zero for this product.',
                    mode: 'warning',
                })
            );
        if (!r.feasible)
            notices.push(
                ctx.ui.display.banner({
                    title: 'Margin not achievable',
                    description: `The success fee alone consumes this margin. Keep the target below ${pct(view.retentionCeiling)}.`,
                    mode: 'error',
                })
            );

        // Breakdown
        const breakdown: { key: string; value: string }[] = [
            { key: 'Product', value: labelById.get(sel.productId) ?? '' },
        ];
        if (r.feasible) {
            breakdown.push(
                { key: 'Sale price (incl VAT)', value: money(r.priceInclVat) },
                { key: 'Sale price (excl VAT)', value: money(r.priceExclVat) },
                { key: `Landed unit cost (${BASIS_LABEL[sel.basis]})`, value: money(view.representativeLanded) },
                { key: 'Fulfilment fee', value: money(context.fulfilmentFee) },
                { key: `Success fee (${pct(context.successRate)} of incl VAT)`, value: money(r.successFee) },
                { key: 'Cost base (excl VAT)', value: money(r.costBase) },
                { key: 'Gross profit', value: `${money(r.grossProfit)} · ${pct(r.grossMargin)} margin` },
                { key: 'Markup on cost', value: pct(r.markup) }
            );
            if (view.roas > 0) {
                breakdown.push(
                    { key: `Marketing (ROAS ${view.roas}×)`, value: money(r.marketingCost) },
                    { key: 'Net profit', value: `${money(r.netProfit)} · ${pct(r.netMargin)} margin` }
                );
            }
        }

        // Per-bill sensitivity
        const sensRows = view.sensitivity.map((s) => ({
            Bill: s.billNumber,
            Date: s.dateLabel,
            'Unit cost': money(s.unitCost),
            'Freight-in': money(s.freightIn),
            Landed: money(s.landed),
            'Gross margin': pct(s.grossMargin),
            'Net margin': s.netMargin == null ? '—' : pct(s.netMargin),
        }));

        const content: any[] = [
            ctx.ui.select.one('productId', { label: 'Product', options: productOptions, defaultValue: sel.productId }),
            ctx.ui.select.one('lever', { label: 'Drive by', options: LEVER_OPTIONS, defaultValue: sel.lever }),
            ctx.ui.inputs.number('marginPct', { label: 'Target gross margin (%) — when driving by margin', defaultValue: sel.marginPct, optional: true }),
            ctx.ui.inputs.number('priceIncl', { label: 'Sale price incl VAT (R) — when driving by price', defaultValue: sel.priceIncl, optional: true }),
            ctx.ui.inputs.number('roas', { label: 'Marketing ROAS (×) — optional', defaultValue: sel.roas, optional: true }),
            ctx.ui.select.one('basis', { label: 'Freight-in basis', options: BASIS_OPTIONS, defaultValue: sel.basis }),
            ...notices,
            ctx.ui.display.divider(),
            ctx.ui.display.keyValue({ data: breakdown }),
            ...(sensRows.length
                ? [
                      ctx.ui.display.divider(),
                      ctx.ui.display.table({
                          data: sensRows,
                          columns: ['Bill', 'Date', 'Unit cost', 'Freight-in', 'Landed', 'Gross margin', 'Net margin'],
                      }),
                  ]
                : []),
        ];

        const page = await ctx.ui.page(`calc-${i}`, {
            stage: 'calc',
            title: 'Pricing calculator',
            content,
            validate: (data: any, action?: string) => {
                if (action !== 'recalc') return true;
                if (data.lever === 'price' && !(Number(data.priceIncl) > 0))
                    return 'Enter a sale price (incl VAT) when driving by price.';
                if (data.lever === 'margin' && data.marginPct == null) return 'Enter a target margin.';
                return true;
            },
            actions: [
                { label: 'Recalculate', value: 'recalc', mode: 'primary' },
                { label: 'Done', value: 'done' },
            ],
        });

        sel = {
            productId: page.data.productId ?? sel.productId,
            lever: page.data.lever ?? sel.lever,
            marginPct: page.data.marginPct ?? sel.marginPct,
            priceIncl: page.data.priceIncl,
            roas: page.data.roas,
            basis: page.data.basis ?? sel.basis,
        };
        if (page.action === 'done') break;
        i++;
    }

    return ctx.complete({
        title: 'Pricing calculator closed',
        stage: 'calc',
        data: [{ key: 'Tip', value: 'Re-run the flow any time to price another product.' }],
    });
});
