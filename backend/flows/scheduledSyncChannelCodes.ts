import { ScheduledSyncChannelCodes } from '@teamkeel/sdk';
import { ChannelSweepResult, sweepChannelCodes } from '../lib/channelCodeSweep';

// The whole catalogue on both channels, so give the sweep headroom above the
// 60s default (max is 14 min / 840000ms).
const LONG_STEP_TIMEOUT = 10 * 60 * 1000;

// Nightly channel-code sweep: pulls Takealot's offer barcodes and Amazon's
// FNSKUs and applies them unreviewed (lib/channelCodeSweep explains why that is
// safe, and why the per-product subscribers cannot cover this). Neither channel
// draws on the shared Zoho quota, so this is free to run daily.
//
// Runs at 3am, an hour after ScheduledSyncStock, so the two heavy catalogue
// jobs do not overlap.
export default ScheduledSyncChannelCodes({}, async (ctx) => {
    const results = (await ctx.step('sweep-channel-codes', { timeout: LONG_STEP_TIMEOUT }, async () => {
        return await sweepChannelCodes(ctx);
    })) as unknown as ChannelSweepResult[];

    for (const result of results) {
        console.log(
            `${result.channel} channel codes: ${result.status}` +
                (result.status === 'applied'
                    ? ` — ${result.created} added, ${result.updated} updated, ${result.unchanged} unchanged, ${result.unmatchedSkus} SKU(s) with no product`
                    : ` — ${result.detail}`)
        );
    }

    // A failed channel must fail the run so it shows up in the flow history —
    // but only after the other channel has had its turn and its codes applied.
    const failures = results.filter((r) => r.status === 'failed');
    if (failures.length > 0) {
        throw new Error(
            `Channel code sweep failed for ${failures.map((f) => `${f.channel} (${f.detail})`).join('; ')}`
        );
    }

    const created = results.reduce((sum, r) => sum + r.created, 0);
    const updated = results.reduce((sum, r) => sum + r.updated, 0);

    return ctx.complete({
        title: `Channel code sweep complete — ${created} added, ${updated} updated`,
        content: [
            ctx.ui.display.table({
                data: results.map((result) => ({
                    Channel: result.channel,
                    Status: result.status === 'skipped' ? `Skipped — ${result.detail}` : 'Applied',
                    Added: result.created,
                    Updated: result.updated,
                    Unchanged: result.unchanged,
                    'SKUs with no product': result.unmatchedSkus,
                })),
            }),
        ],
    });
});
