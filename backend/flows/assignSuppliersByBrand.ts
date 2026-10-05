import { AssignSuppliersByBrand, FlowConfig, models } from '@teamkeel/sdk';
import { getZohoInventoryToken, zohoInventoryGet } from '../lib/zohoInventoryApi';
import {
    NO_BRAND,
    applyAssignments,
    fetchZohoItemBrands,
    groupProductsByBrand,
    loadBilledBy,
    loadProducts,
    planAssignments,
    suggestSupplier,
} from '../lib/brandSupplierHelpers';

const config = {
    title: 'Assign suppliers by brand',
    description: 'Map each Zoho brand to its supplier, and give every product of the brand that supplier',
    stages: [
        { name: 'Map brands', key: 'map' },
        { name: 'Review', key: 'review' },
        { name: 'Complete', key: 'complete' },
    ],
} as const satisfies FlowConfig;

const STEP_TIMEOUT = 10 * 60 * 1000;
const UNASSIGNED = 'none';

// A one-off to fill in products' suppliers. Nothing is written until the
// review page is confirmed.
export default AssignSuppliersByBrand(config, async (ctx) => {
    const accessToken = await ctx.step('authenticate', { retries: 1 }, async () => await getZohoInventoryToken(ctx));
    const items = await ctx.step('fetch-item-brands', { timeout: STEP_TIMEOUT, retries: 1 }, async ({ progress }) => {
        return await fetchZohoItemBrands(zohoInventoryGet(ctx, accessToken), progress);
    });

    const loaded = await ctx.step('load', async () => {
        const products = await loadProducts();
        const suppliers = await models.supplier.findMany({ orderBy: { name: 'asc' } });
        const billedBy = await loadBilledBy();
        const groups = groupProductsByBrand(items, products).map((g) => ({ ...g, suggestion: suggestSupplier(g.productIds, billedBy) }));
        return { products, groups, suppliers: suppliers.map((s) => ({ id: s.id, name: s.name })) };
    });
    const { products, groups, suppliers } = loaded;
    const supplierName = new Map(suppliers.map((s) => [s.id, s.name]));

    if (suppliers.length === 0 || groups.length === 0) {
        return ctx.complete({
            stage: 'complete',
            title: 'Nothing to assign',
            description:
                suppliers.length === 0
                    ? 'There are no suppliers yet. Import them with Import suppliers from Zoho first.'
                    : 'None of our products are in Zoho’s item list.',
            content: [],
        });
    }

    // ── Map brands ──────────────────────────────────────────────────────────
    const options = [{ label: 'Leave unassigned', value: UNASSIGNED }, ...suppliers.map((s) => ({ label: s.name, value: s.id }))];
    const mapped = await ctx.ui.page('map', {
        stage: 'map',
        title: 'Which supplier does each brand come from?',
        content: [
            ctx.ui.display.markdown({
                content: [
                    `Every product takes the supplier you pick for its **brand in Zoho**. ${groups.length} brands cover ` +
                        `${groups.reduce((n, g) => n + g.productIds.length, 0)} of our products.`,
                    '',
                    'Each brand starts on the supplier that has **billed the most of its products**, where there are bills. Check them: ' +
                        'a brand bought through a distributor is billed by the distributor. Pick *Leave unassigned* to skip a brand.',
                ].join('\n'),
            }),
            ...groups.map((g, i) =>
                ctx.ui.select.one(`brand_${i}`, {
                    label: `${g.brand === NO_BRAND ? 'No brand in Zoho' : g.brand} — ${g.productIds.length} product(s)`,
                    options,
                    defaultValue: g.suggestion?.supplierId ?? UNASSIGNED,
                    helpText: [
                        g.suggestion
                            ? `Billed by ${supplierName.get(g.suggestion.supplierId)} for ${g.suggestion.productsBilled} of the ${g.suggestion.productsWithBills} product(s) with bills.`
                            : 'None of its products have been billed yet.',
                        g.withSupplier > 0 ? `${g.withSupplier} already have a supplier.` : '',
                    ]
                        .filter(Boolean)
                        .join(' '),
                })
            ),
            ctx.ui.inputs.boolean('replaceExisting', {
                label: 'Also replace suppliers already set on products',
                defaultValue: false,
                helpText: 'Off: only products with no supplier get one. On: every product of a mapped brand moves to its supplier.',
            }),
        ],
        actions: [{ label: 'Review', value: 'review', mode: 'primary' }],
    });

    const data = mapped.data as Record<string, unknown>;
    const mapping = Object.fromEntries(
        groups.map((g, i) => {
            const value = data[`brand_${i}`];
            return [g.brand, typeof value === 'string' && value !== UNASSIGNED ? value : null];
        })
    );
    const plan = planAssignments(groups, mapping, products, data.replaceExisting === true);
    const toAssign = plan.brands.reduce((n, b) => n + b.assigned, 0);
    const toReplace = plan.brands.reduce((n, b) => n + b.replaced, 0);

    // ── Review ──────────────────────────────────────────────────────────────
    const review = await ctx.ui.page('review', {
        stage: 'review',
        title: `Assign suppliers to ${toAssign + toReplace} product(s)?`,
        content: [
            ctx.ui.display.markdown({
                content:
                    `**${toAssign}** product(s) get a supplier for the first time` +
                    (toReplace > 0 ? `, and **${toReplace}** move from another supplier` : '') +
                    '. Stock cover statuses re-grade against the new suppliers’ lead times straight away.',
            }),
            ctx.ui.display.table({
                data: plan.brands.map((b) => ({
                    Brand: b.brand,
                    Supplier: b.supplierId ? supplierName.get(b.supplierId)! : 'Left unassigned',
                    Assign: b.assigned,
                    Replace: b.replaced,
                    Unchanged: b.unchanged,
                })),
            }),
        ],
        actions: [
            { label: 'Assign suppliers', value: 'apply', mode: 'primary' },
            { label: 'Cancel', value: 'cancel', mode: 'secondary' },
        ],
    });

    if (review.action === 'cancel' || toAssign + toReplace === 0) {
        return ctx.complete({ stage: 'complete', title: 'Nothing changed', description: 'No product’s supplier was changed.', content: [] });
    }

    const changed = await ctx.step('apply', async () => await applyAssignments(plan, new Date()));

    return ctx.complete({
        stage: 'complete',
        title: `Suppliers assigned to ${changed} product(s)`,
        description: 'Their stock cover statuses now grade against their suppliers’ lead times.',
        content: [
            ctx.ui.display.table({
                data: plan.brands
                    .filter((b) => b.assigned + b.replaced > 0)
                    .map((b) => ({ Brand: b.brand, Supplier: supplierName.get(b.supplierId!)!, Products: b.assigned + b.replaced })),
            }),
        ],
    });
});
