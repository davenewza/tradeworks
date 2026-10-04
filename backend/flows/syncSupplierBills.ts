import { SyncSupplierBills, FlowConfig } from '@teamkeel/sdk';
import { BillSyncStep, billSyncNotes, runSupplierBillSync } from '../lib/zohoBillHelpers';

const config = {
    title: 'Sync supplier bills',
    description: 'Pull every bill from every supplier in Zoho, with the freight allocated to each line',
    stages: [
        { name: 'Confirm', key: 'confirm' },
        { name: 'Complete', key: 'complete' },
    ],
} as const satisfies FlowConfig;

// The on-demand run of the nightly ScheduledSyncSupplierBills, for a first
// import or to pick up a bill entered in Zoho today.
export default SyncSupplierBills(config, async (ctx) => {
    await ctx.ui.page('confirm', {
        stage: 'confirm',
        title: 'Sync supplier bills from Zoho',
        content: [
            ctx.ui.display.markdown({
                content: [
                    'This reads the bills of **every supplier linked to a Zoho vendor**, with each line and the freight, duties and fees Zoho allocated to it. Products price off these lines: their cost of goods and freight-in are averages over them, weighted by units bought.',
                    '',
                    '- Bills new or changed in Zoho since the last sync are **read in full**. Bills unchanged since are skipped.',
                    '- Bills deleted or voided in Zoho are **removed**.',
                    '- Lines are matched to products by **SKU**.',
                    '',
                    'The first sync reads every bill, which takes a while and a few calls per bill from the Zoho quota we share with the Takealot integration. Later syncs mostly cost one call per supplier.',
                ].join('\n'),
            }),
        ],
        actions: [{ label: 'Start synchronisation', value: 'start', mode: 'primary' }],
    });

    const step: BillSyncStep = (name, options, fn) => ctx.step(name, options, fn as never) as never;
    const summary = await runSupplierBillSync(step, ctx);

    const added = summary.suppliers.reduce((sum, s) => sum + s.added, 0);
    const updated = summary.suppliers.reduce((sum, s) => sum + s.updated, 0);
    const removed = summary.suppliers.reduce((sum, s) => sum + s.removed, 0);

    return ctx.complete({
        stage: 'complete',
        title: 'Supplier bills synced',
        description: `${added} bill(s) added, ${updated} updated and ${removed} removed across ${summary.suppliers.length} supplier(s).`,
        content: [
            ctx.ui.display.table({
                data: summary.suppliers.map((s) => ({
                    Supplier: s.supplier,
                    Added: s.added,
                    Updated: s.updated,
                    Removed: s.removed,
                    Unchanged: s.unchanged,
                })),
            }),
            ...billSyncNotes(summary).map((note) => ctx.ui.display.markdown({ content: note })),
        ],
    });
});
