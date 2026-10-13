import { ScheduledRebuildCumulativeSales } from '@teamkeel/sdk';
import { formatDay, pruneCumulativeSales, rebuildMonth, wormMonths } from '../lib/cumulativeSalesHelpers';

// Safety net for the sales worm. The invoice webhook and the sales syncs
// rebuild the months they write into as they go, so this isn't what keeps the
// worm current. It rolls the month in progress forward to today even when
// nothing has sold, and repairs any rebuild that failed in the webhook. At the
// turn of the month it closes last month out to its last day and retires the
// month that has just left the worm's window. Every month in the window is
// rebuilt on each run — it's cheap, pure local SQL with no Zoho calls, so it
// never eats into the shared daily quota.
export default ScheduledRebuildCumulativeSales({}, async (ctx) => {
    const now = new Date();

    const rebuilt: { key: string; value: number }[] = [];
    let totalRows = 0;

    for (const monthStart of wormMonths(now)) {
        const monthKey = formatDay(monthStart).slice(0, 7);

        const rows = await ctx.step(`rebuild-${monthKey}`, async () => {
            return await rebuildMonth(monthStart, now, now);
        });

        rebuilt.push({ key: monthKey, value: rows });
        totalRows += rows;
    }

    const pruned = await ctx.step('prune', async () => {
        return await pruneCumulativeSales(now);
    });

    return ctx.complete({
        title: 'Cumulative sales refreshed',
        content: [
            ctx.ui.display.keyValue({
                data: [
                    { key: 'Rows written', value: totalRows },
                    { key: 'Rows outside the window removed', value: pruned },
                    ...rebuilt,
                ],
            }),
        ],
    });
});
