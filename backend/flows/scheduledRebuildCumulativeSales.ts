import { ScheduledRebuildCumulativeSales } from '@teamkeel/sdk';
import { formatDay, monthStartOf, rebuildMonth } from '../lib/cumulativeSalesHelpers';

// Months rebuilt on every run: the one in progress, plus the one before it.
// The previous month stays in scope so it is closed out to its last day once
// the month turns, and because invoices keep being edited in Zoho for a while
// after month end. Anything older needs the manual RebuildCumulativeSales flow.
const MONTHS_REBUILT = 2;

// Safety net for the sales worm. The invoice webhook and the sales syncs
// rebuild the months they write into as they go, so this isn't what keeps the
// worm current. It rolls the month in progress forward to today even when
// nothing has sold (and closes last month out on the 1st), and repairs any
// rebuild that failed in the webhook. Pure local SQL — no Zoho calls, so it
// never eats into the shared daily quota.
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
