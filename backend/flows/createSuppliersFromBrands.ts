import { CreateSuppliersFromBrands, FlowConfig } from '@teamkeel/sdk';
import {
    BrandSupplierCandidate,
    SuppliersFromBrandsResult,
    applySuppliersFromBrands,
    planSuppliersFromBrands,
} from '../lib/supplierHelpers';

const config = {
    title: 'Create suppliers from brands',
    description: 'Start each brand off with a supplier of the same name, and assign its products to it',
    stages: [
        { name: 'Pick brands', key: 'pick' },
        { name: 'Complete', key: 'complete' },
    ],
} as const satisfies FlowConfig;

export default CreateSuppliersFromBrands(config, async (ctx) => {
    const candidates = (await ctx.step('plan', async () => await planSuppliersFromBrands())) as BrandSupplierCandidate[];

    if (candidates.length === 0) {
        return ctx.complete({
            stage: 'complete',
            title: 'Every product has a supplier',
            description: 'No active product is waiting for one.',
            content: [],
        });
    }

    const selection = await ctx.ui.page('pick', {
        stage: 'pick',
        title: `${candidates.length} brand(s) with products that have no supplier`,
        content: [
            ctx.ui.display.markdown({
                content:
                    'Tick the brands you buy **directly from the brand owner**. Each gets a supplier of the same ' +
                    'name — carrying the brand’s lead time, invoicing in ZAR until you change it — and its ' +
                    'unassigned products are assigned to it. Where a supplier of that name already exists it is ' +
                    'reused as it is. Products that already have a supplier are not touched.\n\n' +
                    'Leave out brands bought through a distributor, and assign those products by hand.',
            }),
            ctx.ui.select.table('brands', {
                data: candidates,
                columns: ['brand', 'products', 'leadTimeInDays', 'action'],
                mode: 'multi',
            }),
        ],
        actions: [{ label: 'Create suppliers', value: 'apply', mode: 'primary' }],
    });

    // The picker hands back only the columns it shows, so the ticked rows are
    // matched back to the plan by brand name to recover their ids.
    const ticked = new Set(((selection.data.brands ?? []) as { brand: string }[]).map((r) => r.brand));
    const selected = candidates.filter((c) => ticked.has(c.brand));
    if (selected.length === 0) {
        return ctx.complete({
            stage: 'complete',
            title: 'Nothing changed',
            description: 'No brands were ticked.',
            content: [],
        });
    }

    const result = (await ctx.step(
        'apply',
        async () => await applySuppliersFromBrands(selected.map((c) => c.brandId)),
    )) as SuppliersFromBrandsResult;

    return ctx.complete({
        stage: 'complete',
        title: 'Suppliers created',
        description:
            `${result.suppliersCreated} supplier(s) created, ${result.productsAssigned} product(s) assigned. ` +
            'Set each supplier’s currency, and each product’s price, from the supplier’s page.',
        content: [],
    });
});
