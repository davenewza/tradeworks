import { PlanPurchase, FlowConfig } from '@teamkeel/sdk';
import {
    PlannableBrand,
    PurchasePlan,
    PurchasePlanParams,
    buildPurchasePlan,
    defaultTargetCoverMonths,
    loadPlanCandidates,
    loadPlannableBrands,
    parseDay,
} from '../lib/purchasePlanHelpers';
import {
    PlanGridRow,
    formatDate,
    formatRand,
    listProducts,
    statusLabel,
    summaryRows,
    toGridRow,
} from '../lib/purchasePlanFormat';
import { formatDay } from '../lib/cumulativeSalesHelpers';

const config = {
    title: 'Plan a purchase',
    description:
        'Suggest what to reorder from a brand, and how many units, so every product lands with the same months of cover',
    stages: [
        { name: 'Brand', key: 'brand' },
        { name: 'Order details', key: 'details' },
        { name: 'Review', key: 'review' },
    ],
} as const satisfies FlowConfig;

// Recalculate-and-adjust rounds before the run is wrapped up regardless.
const MAX_PASSES = 20;

// The maths lives in lib/purchasePlanHelpers (see docs/purchase-planning.md);
// this is the conversation around it: pick a brand, set the order's dates,
// review and adjust the suggested quantities, finish with the plan as a report.
// Nothing is written — the plan is the run's completion page.
export default PlanPurchase(config, async (ctx, inputs) => {
    // Set when launched from a brand's page; absent from the Products space.
    const presetBrandId = inputs?.brandId ?? undefined;

    // Pinned once per run. The body re-runs on every page submission, so a plan
    // left open over midnight would otherwise move its projections by a day
    // between the review grid and the report.
    const todayIso = await ctx.step('today', async () => formatDay(new Date()));
    const today = parseDay(todayIso)!;

    const brands = await ctx.step('load-brands', async () => await loadPlannableBrands());

    // ── Brand ───────────────────────────────────────────────────────────────
    let picked: PlannableBrand | undefined;
    if (presetBrandId) {
        picked = brands.find((b) => b.brandId === presetBrandId);
        if (!picked) {
            return ctx.complete({
                stage: 'review',
                title: 'Nothing to plan for this brand',
                description: 'It has no enabled products, or it no longer exists.',
                content: [],
            });
        }
    } else {
        if (brands.length === 0) {
            return ctx.complete({
                stage: 'review',
                title: 'Nothing to plan',
                description: 'No brand has any enabled products.',
                content: [],
            });
        }
        const choice = await ctx.ui.page('brand', {
            stage: 'brand',
            title: 'Which brand are you ordering from?',
            content: [
                ctx.ui.select.one('brandId', {
                    label: 'Brand',
                    options: brands.map((b) => ({
                        label: `${b.name} — ${b.productCount} product(s), ${b.leadTimeInDays}-day lead time`,
                        value: b.brandId,
                    })),
                    defaultValue: brands[0].brandId,
                }),
            ],
            actions: [{ label: 'Continue', value: 'next', mode: 'primary' }],
        });
        picked = brands.find((b) => b.brandId === choice.data.brandId)!;
    }
    const brand: PlannableBrand = picked;

    // ── Order details ───────────────────────────────────────────────────────
    const defaultTarget = defaultTargetCoverMonths(brand.leadTimeInDays);
    const details = await ctx.ui.page('details', {
        stage: 'details',
        title: `Order details — ${brand.name}`,
        content: [
            ctx.ui.display.markdown({
                content:
                    'Every product is topped up so that, on the day this order lands, it has the **same months ' +
                    'of cover** — the whole order then runs down together, and the next order can wait for all ' +
                    'of it rather than a top-up for the one product that ran out early. Stock keeps selling at ' +
                    'each product’s run-rate from today, through the purchase date, and for the whole lead time.',
            }),
            ctx.ui.inputs.datePicker('purchaseDate', {
                label: 'Purchase date',
                mode: 'date',
                defaultValue: todayIso,
                helpText: 'When the order goes to the supplier.',
            }),
            ctx.ui.inputs.number('leadTimeInDays', {
                label: 'Lead time (days)',
                defaultValue: brand.leadTimeInDays,
                min: 1,
                helpText:
                    `Purchase to on-the-shelf. ${brand.name} is set to ${brand.leadTimeInDays} days; ` +
                    'a change here applies to this plan only — edit the brand to change it for good.',
            }),
            ctx.ui.inputs.number('targetCoverMonths', {
                label: 'Cover on arrival (months)',
                defaultValue: defaultTarget,
                min: 0.5,
                helpText:
                    'Months of sales every product should have in stock the day the order lands. ' +
                    `${defaultTarget} is 2 × the lead time — the middle of the Good band. Raise it to order ` +
                    'less often; lower it to tie up less cash.',
            }),
        ],
        validate: (data) => {
            if (!parseDay(data.purchaseDate)) return 'Enter the purchase date.';
            const lead = Number(data.leadTimeInDays);
            if (!Number.isInteger(lead) || lead < 1) return 'Lead time must be a whole number of days, 1 or more.';
            const target = Number(data.targetCoverMonths);
            if (!(target > 0)) return 'Cover on arrival must be more than 0 months.';
            return true;
        },
        actions: [{ label: 'Suggest an order', value: 'next', mode: 'primary' }],
    });

    const params: PurchasePlanParams = {
        today,
        purchaseDate: parseDay(details.data.purchaseDate)!,
        leadTimeInDays: Number(details.data.leadTimeInDays),
        targetCoverMonths: Number(details.data.targetCoverMonths),
    };

    const candidates = await ctx.step('load-candidates', async () => await loadPlanCandidates(brand.brandId, today));

    if (candidates.length === 0) {
        return ctx.complete({
            stage: 'review',
            title: `Nothing to plan for ${brand.name}`,
            description: 'This brand has no enabled products.',
            content: [],
        });
    }

    // ── Review & adjust, repeatable ─────────────────────────────────────────
    // Each pass shows the plan at the quantities entered on the pass before
    // (the suggestions, first time round), so a trimmed quantity shows what it
    // does to that product's cover before the plan is finalised. Each pass is a
    // fresh page key; the grid is a pure function of the cached inputs.
    let overrides: Record<string, number> = {};
    for (let pass = 0; pass < MAX_PASSES; pass++) {
        const plan = buildPurchasePlan(candidates, params, overrides);
        const arrival = plan.summary.arrival;
        const rows = plan.lines.map((line) => toGridRow(line, arrival));

        const page = await ctx.ui.page(`review-${pass}`, {
            stage: 'review',
            fullWidth: true,
            title: pass === 0 ? `Suggested order — ${brand.name}` : `Recalculated — ${brand.name}`,
            description:
                `Ordered ${formatDate(params.purchaseDate)}, lands ~${formatDate(arrival)} after ` +
                `${params.leadTimeInDays} days, and every product is topped up to ${params.targetCoverMonths} ` +
                `month(s) of cover — in stock until ~${formatDate(plan.summary.horizon)}.`,
            content: [
                ...warningBanners(ctx, plan),
                ctx.ui.display.keyValue({ data: summaryRows(plan, params) }),
                ctx.ui.display.markdown({
                    content:
                        '**Order** is editable. **Stock** is on hand plus on the way; **Sales/mo** is the ' +
                        'trailing-12-month run-rate. **Cover on arrival** is what the product will have the ' +
                        'day the order lands at the quantity entered — *Recalculate* refreshes it after edits.',
                }),
                ctx.ui.inputs.dataGrid('rows', {
                    data: rows,
                    columns: [
                        { key: 'productId', type: 'hidden' },
                        { key: 'abc', label: 'ABC', type: 'text', editable: false },
                        { key: 'sku', label: 'SKU', type: 'text', editable: false },
                        { key: 'name', label: 'Product', type: 'text', editable: false },
                        { key: 'stock', label: 'Stock', type: 'number', editable: false },
                        { key: 'monthly', label: 'Sales/mo', type: 'number', editable: false },
                        { key: 'suggested', label: 'Suggested', type: 'number', editable: false },
                        { key: 'order', label: 'Order', type: 'number', editable: true },
                        { key: 'cover', label: 'Cover on arrival', type: 'text', editable: false },
                        { key: 'coveredUntil', label: 'In stock until', type: 'text', editable: false },
                        { key: 'value', label: 'Value', type: 'text', editable: false },
                        { key: 'why', label: 'Why', type: 'text', editable: false },
                    ],
                    allowAddRows: false,
                    allowDeleteRows: false,
                }),
            ],
            validate: (data) => {
                const entered = (data.rows ?? []) as PlanGridRow[];
                const bad = entered.find((r) => !Number.isInteger(Number(r.order)) || Number(r.order) < 0);
                if (bad) return `"${bad.sku}" needs a whole order quantity of 0 or more.`;
                return true;
            },
            actions: [
                { label: 'Recalculate cover', value: 'recalculate' },
                { label: 'Finish', value: 'finish', mode: 'primary' },
            ],
        });

        overrides = Object.fromEntries(
            ((page.data.rows ?? []) as PlanGridRow[]).map((r) => [r.productId, Number(r.order)]),
        );
        if (page.action === 'finish') break;
    }

    // ── The plan ────────────────────────────────────────────────────────────
    const plan = buildPurchasePlan(candidates, params, overrides);
    const s = plan.summary;
    const ordered = plan.lines.filter((l) => l.orderQuantity > 0);
    const skipped = plan.lines.filter((l) => l.orderQuantity === 0);

    return ctx.complete({
        stage: 'review',
        fullWidth: true,
        title: `Purchase plan — ${brand.name}`,
        description:
            `${s.totalUnits} unit(s) across ${s.linesToOrder} product(s). Order ${formatDate(params.purchaseDate)}, ` +
            `lands ~${formatDate(s.arrival)}, in stock until ~${formatDate(s.horizon)}.`,
        content: [
            ...warningBanners(ctx, plan),
            ctx.ui.display.keyValue({ data: summaryRows(plan, params) }),
            ctx.ui.display.header({ title: 'Order', description: 'Goods cost is the unit cost on each product’s latest supplier bill.' }),
            ctx.ui.display.table({
                data: ordered.map((l) => ({
                    SKU: l.sku,
                    Product: l.name,
                    ABC: l.abcClass ?? '',
                    Order: l.orderQuantity,
                    'Unit cost': l.unitCost === null ? '' : formatRand(l.unitCost),
                    Value: l.lineValue === null ? '' : formatRand(l.lineValue),
                    'Cover on arrival': l.coverAtArrivalMonths === null ? '' : `${l.coverAtArrivalMonths.toFixed(1)} mo`,
                    Status: statusLabel(l.statusAtArrival),
                    'In stock until': l.coveredUntil ? formatDate(l.coveredUntil) : '',
                })),
            }),
            ...(skipped.length > 0
                ? [
                      ctx.ui.display.header({ title: 'Not ordered' }),
                      ctx.ui.display.table({
                          data: skipped.map((l) => ({
                              SKU: l.sku,
                              Product: l.name,
                              ABC: l.abcClass ?? '',
                              Stock: l.stockPosition,
                              'Sales/mo': Math.round((l.monthlyDemand ?? 0) * 10) / 10,
                              Why: toGridRow(l, s.arrival).why,
                          })),
                      }),
                  ]
                : []),
        ],
    });
});

// What the buyer needs to know before trusting the quantities: products this
// order cannot save, products the plan is guessing about, and — after edits —
// products that will now need the very top-up order the plan is meant to avoid.
function warningBanners(ctx: any, plan: PurchasePlan) {
    const s = plan.summary;
    const banners: any[] = [];

    if (s.stockouts > 0) {
        const lines = plan.lines.filter((l) => l.reason === 'StockoutBeforeArrival');
        banners.push(
            ctx.ui.display.banner({
                mode: 'warning',
                title: `${s.stockouts} product(s) sell out before this order lands`,
                description:
                    `${listProducts(lines, (l) => l.runsOutOn)}. This order lands ~${formatDate(s.arrival)}; ` +
                    'only a faster shipment closes the gap. They are ordered to the full target, since nothing will be left.',
            }),
        );
    }

    if (s.shortOfHorizon.length > 0) {
        banners.push(
            ctx.ui.display.banner({
                mode: 'warning',
                title: `${s.shortOfHorizon.length} product(s) now run out before ~${formatDate(s.horizon)}`,
                description:
                    `At the quantities entered: ${listProducts(s.shortOfHorizon, (l) => l.coveredUntil)}. ` +
                    'These would need a top-up order before the rest of this order runs down.',
            }),
        );
    }

    if (s.stockUnknown > 0) {
        banners.push(
            ctx.ui.display.banner({
                mode: 'warning',
                title: `${s.stockUnknown} product(s) have no stock reading`,
                description:
                    'They are planned as if the shelf were empty. Run the stock & cover sync and plan again ' +
                    'to use their real stock level.',
            }),
        );
    }

    if (s.noForecast > 0) {
        banners.push(
            ctx.ui.display.banner({
                mode: 'info',
                title: `${s.noForecast} product(s) have no sales forecast`,
                description:
                    'Nothing sold in the last 12 months, so there is no rate to project. They are listed at 0 — ' +
                    'type a quantity to include them.',
            }),
        );
    }

    return banners;
}
