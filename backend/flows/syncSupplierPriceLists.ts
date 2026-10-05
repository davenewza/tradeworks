import { SyncSupplierPriceLists, FlowConfig } from '@teamkeel/sdk';
import { getZohoInventoryToken, zohoInventoryGet } from '../lib/zohoInventoryApi';
import { PriceListSyncStep, PriceListSyncSummary, priceListSyncNotes, runSupplierPriceListSync } from '../lib/zohoSupplierPriceListHelpers';

const config = {
    title: 'Sync supplier price lists',
    description: 'Pull every purchase price list from Zoho, with the price of each item on it',
    stages: [
        { name: 'Confirm', key: 'confirm' },
        { name: 'Complete', key: 'complete' },
    ],
} as const satisfies FlowConfig;

// The on-demand run of the nightly ScheduledSyncSupplierPriceLists, for a list
// changed in Zoho today. Unlike the nightly run it reads every list, so a
// price edited without Zoho moving the list's modified time is still caught.
export default SyncSupplierPriceLists(config, async (ctx) => {
    await ctx.ui.page('confirm', {
        stage: 'confirm',
        title: 'Sync supplier price lists from Zoho',
        content: [
            ctx.ui.display.markdown({
                content: [
                    'This reads **every purchase price list in Zoho**, with the price of each item on it. A product’s supplier price comes from these lists: its page shows every list it is on, and purchase planning prices from them.',
                    '',
                    '- Lists are **read in full** and replace what is stored here. Price lists can only be changed in Zoho.',
                    '- Lists deleted in Zoho are **removed**.',
                    '- Items are matched to products by **SKU**.',
                    '',
                    'It costs a call per list, plus a few to match Zoho’s items to SKUs, from the Zoho quota we share with the Takealot integration.',
                ].join('\n'),
            }),
        ],
        actions: [{ label: 'Start synchronisation', value: 'start', mode: 'primary' }],
    });

    const accessToken = await ctx.step('authenticate', { retries: 1 }, async () => await getZohoInventoryToken(ctx));
    const step: PriceListSyncStep = (name, options, fn) => ctx.step(name, options, fn as never) as never;
    const summary = await runSupplierPriceListSync(step, zohoInventoryGet(ctx, accessToken), { readAll: true });

    return ctx.complete({
        stage: 'complete',
        title: 'Supplier price lists synced',
        description: describe(summary),
        content: [
            ctx.ui.display.table({
                data: summary.read.map((l) => ({
                    'Price list': l.priceList,
                    Currency: l.currencyCode,
                    Items: l.items,
                    Change: l.change,
                })),
            }),
            ...priceListSyncNotes(summary).map((note) => ctx.ui.display.markdown({ content: note })),
        ],
    });
});

function describe(summary: PriceListSyncSummary): string {
    const added = summary.read.filter((l) => l.change === 'Added').length;
    return `${added} price list(s) added, ${summary.read.length - added} updated and ${summary.removed} removed.`;
}
