import { ScheduledSyncSupplierPriceLists } from '@teamkeel/sdk';
import { getZohoInventoryToken, zohoInventoryGet } from '../lib/zohoInventoryApi';
import { PriceListSyncStep, priceListSyncNotes, runSupplierPriceListSync } from '../lib/zohoSupplierPriceListHelpers';

// Nightly supplier price list sync, unattended. It reads only the lists Zoho
// has modified since the last run, so an unchanged night costs one call
// against the shared quota.
export default ScheduledSyncSupplierPriceLists({}, async (ctx) => {
    const accessToken = await ctx.step('authenticate', { retries: 1 }, async () => await getZohoInventoryToken(ctx));
    const step: PriceListSyncStep = (name, options, fn) => ctx.step(name, options, fn as never) as never;
    const summary = await runSupplierPriceListSync(step, zohoInventoryGet(ctx, accessToken), { readAll: false });

    const added = summary.read.filter((l) => l.change === 'Added').length;
    return ctx.complete({
        title: `Supplier price list sync complete — ${added} added, ${summary.read.length - added} updated, ${summary.removed} removed, ${summary.unchanged} unchanged`,
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
