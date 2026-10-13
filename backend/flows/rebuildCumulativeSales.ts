import { RebuildCumulativeSales } from '@teamkeel/sdk';
import { formatDay, pruneCumulativeSales, rebuildMonth, wormMonths } from '../lib/cumulativeSalesHelpers';

// Manual rebuild of the sales worm: the same work as the scheduled refresh,
// for when it can't wait for the next run — e.g. to repair a month whose
// rebuild failed when its sales landed. Reads only local Sale rows, so it costs
// nothing against the shared Zoho API quota and is safe to re-run.
export default RebuildCumulativeSales({}, async (ctx) => {
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
        title: 'Cumulative sales rebuilt',
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
