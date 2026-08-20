import { ScheduledRebuildCumulativeSales } from '@teamkeel/sdk';
import { formatDay, monthStartOf, rebuildMonth } from '../lib/cumulativeSalesHelpers';

// Months rebuilt on every run: the one in progress, plus the one before it.
// The previous month stays in scope because invoices keep being edited in Zoho
// for a while after month end, and each SyncSales run can revise sales already
// dated to it. Anything older needs the manual RebuildCumulativeSales flow.
const MONTHS_REBUILT = 2;

// Keeps the sales worm current. Runs 30 minutes past every 6th hour, just behind
// ScheduledSyncSales, so it derives from sales that run has already written.
// Pure local SQL — no Zoho calls, so it never eats into the shared daily quota.
export default ScheduledRebuildCumulativeSales({}, async (ctx) => {
    const now = new Date();
    const thisMonth = monthStartOf(now);

    const months = Array.from({ length: MONTHS_REBUILT }, (_, i) => {
        return new Date(Date.UTC(thisMonth.getUTCFullYear(), thisMonth.getUTCMonth() - i, 1));
    }).reverse();

    const rebuilt: { key: string; value: number }[] = [];
    let totalRows = 0;

    for (const monthStart of months) {
        const monthKey = formatDay(monthStart).slice(0, 7);

        const rows = await ctx.step(`rebuild-${monthKey}`, async () => {
            return await rebuildMonth(monthStart, now, now);
        });

        rebuilt.push({ key: monthKey, value: rows });
        totalRows += rows;
    }

    return ctx.complete({
        title: 'Cumulative sales refreshed',
        content: [
            ctx.ui.display.keyValue({
                data: [{ key: 'Rows written', value: totalRows }, ...rebuilt],
            }),
        ],
    });
});
