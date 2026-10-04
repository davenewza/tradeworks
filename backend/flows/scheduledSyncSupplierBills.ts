import { ScheduledSyncSupplierBills } from '@teamkeel/sdk';
import { BillSyncStep, billSyncNotes, runSupplierBillSync } from '../lib/zohoBillHelpers';

// Nightly supplier bill sync, unattended: the same run as SyncSupplierBills.
// It only adds what Zoho holds and removes what Zoho has dropped, so there is
// nothing to review. Bills unchanged since the last run cost nothing beyond
// the one list call per supplier.
export default ScheduledSyncSupplierBills({}, async (ctx) => {
    const step: BillSyncStep = (name, options, fn) => ctx.step(name, options, fn as never) as never;
    const summary = await runSupplierBillSync(step, ctx);

    for (const s of summary.suppliers) {
        console.log(`${s.supplier}: ${s.added} added, ${s.updated} updated, ${s.removed} removed, ${s.unchanged} unchanged`);
    }

    const added = summary.suppliers.reduce((sum, s) => sum + s.added, 0);
    const updated = summary.suppliers.reduce((sum, s) => sum + s.updated, 0);
    const removed = summary.suppliers.reduce((sum, s) => sum + s.removed, 0);

    return ctx.complete({
        title: `Supplier bill sync complete — ${added} added, ${updated} updated, ${removed} removed`,
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
