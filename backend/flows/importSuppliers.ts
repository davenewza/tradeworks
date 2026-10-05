import { ImportSuppliers, FlowConfig } from '@teamkeel/sdk';
import { getZohoAccessToken } from '../lib/zohoChannelFeeHelpers';
import {
    ImportResult,
    VendorCandidate,
    ZOHO_CONTACTS_SCOPE,
    ZohoVendor,
    fetchZohoVendors,
    importVendors,
    loadVendorCandidates,
} from '../lib/zohoVendorHelpers';

const config = {
    title: 'Import suppliers from Zoho',
    description: 'Pick vendors from Zoho Books to buy stock from',
    stages: [
        { name: 'Pick vendors', key: 'pick' },
        { name: 'Complete', key: 'complete' },
    ],
} as const satisfies FlowConfig;

export default ImportSuppliers(config, async (ctx) => {
    // A few pages at most, so a generous timeout costs nothing; one retry, not
    // the default four, since each attempt re-reads the whole vendor list
    // against the shared Zoho quota.
    const vendors = (await ctx.step(
        'fetch-vendors',
        { loadingMessage: 'Fetching vendors from Zoho…', timeout: 5 * 60 * 1000, retries: 1 },
        async () => {
            const accessToken = await getZohoAccessToken(ctx, ZOHO_CONTACTS_SCOPE);
            return await fetchZohoVendors(ctx, accessToken);
        },
    )) as unknown as ZohoVendor[];

    const candidates = (await ctx.step('candidates', async () => await loadVendorCandidates(vendors))) as VendorCandidate[];

    if (candidates.length === 0) {
        return ctx.complete({
            stage: 'complete',
            title: 'Every vendor is already a supplier',
            description: `All ${vendors.length} active vendor(s) in Zoho Books are linked to a supplier.`,
            content: [],
        });
    }

    const selection = await ctx.ui.page('pick', {
        stage: 'pick',
        title: `${candidates.length} vendor(s) in Zoho that aren't suppliers yet`,
        content: [
            ctx.ui.display.markdown({
                content:
                    'Tick the vendors you buy stock from. Each becomes a supplier linked to its Zoho vendor, ' +
                    'in the vendor’s currency, with a 60-day lead time to start — set the real lead time on ' +
                    'the supplier afterwards. **Link** means a supplier of that name already exists here ' +
                    'without a Zoho vendor; it is linked and keeps its price lists and settings.',
            }),
            ctx.ui.select.table('vendors', {
                data: candidates,
                columns: ['name', 'company', 'currency', 'action'],
                mode: 'multi',
            }),
        ],
        validate: (data) => ((data.vendors ?? []).length > 0 ? true : 'Tick at least one vendor.'),
        actions: [{ label: 'Import', value: 'import', mode: 'primary' }],
    });

    // The picker hands back only the columns it shows, so the ticked rows are
    // matched back to the candidates by name to recover their vendor ids.
    const ticked = new Set(((selection.data.vendors ?? []) as { name: string }[]).map((r) => r.name));
    const selected = candidates.filter((c) => ticked.has(c.name));

    const result = (await ctx.step('import', async () => await importVendors(selected, vendors))) as ImportResult;

    return ctx.complete({
        stage: 'complete',
        title: 'Suppliers imported',
        description:
            `${result.created.length} supplier(s) created, ${result.linked.length} linked` +
            (result.skipped.length > 0 ? `, ${result.skipped.length} skipped` : '') +
            '. Set each one’s lead time, then link its price lists to it.',
        content: [
            ...(result.created.length > 0
                ? [ctx.ui.display.header({ title: 'Created' }), ctx.ui.display.table({ data: result.created, columns: ['name', 'currency'] })]
                : []),
            ...(result.linked.length > 0
                ? [ctx.ui.display.header({ title: 'Linked' }), ctx.ui.display.table({ data: result.linked, columns: ['name'] })]
                : []),
            ...(result.skipped.length > 0
                ? [ctx.ui.display.header({ title: 'Skipped' }), ctx.ui.display.table({ data: result.skipped, columns: ['name', 'reason'] })]
                : []),
        ],
    });
});
