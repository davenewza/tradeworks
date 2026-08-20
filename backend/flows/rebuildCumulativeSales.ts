import { RebuildCumulativeSales } from '@teamkeel/sdk';
import { formatDay, monthsInRange, rebuildMonth } from '../lib/cumulativeSalesHelpers';

// Manual rebuild of the sales worm over a date range — used to backfill history,
// or to pick up a Zoho correction that landed outside the window the scheduled
// job covers. Reads only local Sale rows, so it costs nothing against the shared
// Zoho API quota and is safe to re-run.
export default RebuildCumulativeSales({}, async (ctx, inputs) => {
    const now = new Date();
    const months = monthsInRange(inputs.start, inputs.end);

    const rebuilt: { key: string; value: number }[] = [];
    let totalRows = 0;

    for (const monthStart of months) {
        const monthKey = formatDay(monthStart).slice(0, 7);

        // A step per month keeps each unit of work small and the whole backfill
        // resumable — a long range that trips a timeout resumes at the month it
        // failed on rather than starting over. Step names are stable across runs.
        const rows = await ctx.step(`rebuild-${monthKey}`, async () => {
            return await rebuildMonth(monthStart, now, now);
        });

        rebuilt.push({ key: monthKey, value: rows });
        totalRows += rows;
    }

    return ctx.complete({
        title: 'Cumulative sales rebuilt',
        content: [
            ctx.ui.display.keyValue({
                data: [
                    { key: 'Months rebuilt', value: months.length },
                    { key: 'Rows written', value: totalRows },
                    ...rebuilt,
                ],
            }),
        ],
    });
});
