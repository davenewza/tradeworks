import { AmazonCtx, FetchOptions, amazonIsConfigured } from './amazonApi';
import { computeAmazonFnskuPlan, fetchFbaInventory } from './amazonFnskuHelpers';
import { ChannelCodeSyncPlan, applyChannelCodeSync } from './channelCodeSync';
import { TakealotCtx, computeBarcodeSyncPlan, fetchAllOffers } from './takealotOfferHelpers';

// The unattended sweep behind ScheduledSyncChannelCodes: run every channel's
// whole-catalogue code sync and apply it without a review page.
//
// It exists because neither per-product subscriber can see a code that appears
// or changes on the channel *after* the product row does — and that is the
// normal case. A Takealot offer's product_label can be reissued, and an FNSKU
// is only minted when the FBA listing is created, typically weeks after the
// product reaches us from Zoho. Both subscribers only call out when the SKU is
// new or changed, so nothing would ever notice.
//
// Applying unreviewed is safe because of what the shared core does and does
// not do (channelCodeSync): it only ever upserts the named channel's row, and
// a SKU the channel lists without a code keeps whatever is stored rather than
// being blanked. The worst a bad run can do is write a code the channel is
// currently reporting.
//
// Each channel is fetched and applied independently so one channel's outage,
// throttle or missing credential cannot stop the other from syncing.

export type ChannelSweepStatus = 'applied' | 'skipped' | 'failed';

export interface ChannelSweepResult {
    // How the channel is named in the run summary ("Takealot", "Amazon").
    channel: string;
    status: ChannelSweepStatus;
    created: number;
    updated: number;
    unchanged: number;
    // SKUs the channel lists that match no product here — the sweep cannot
    // create products, so these wait for a Sync Products run.
    unmatchedSkus: number;
    // Why it was skipped, or what went wrong. Empty when applied.
    detail: string;
}

export type ChannelCodeSweepCtx = TakealotCtx & AmazonCtx;

function skipped(channel: string, detail: string): ChannelSweepResult {
    return { channel, status: 'skipped', created: 0, updated: 0, unchanged: 0, unmatchedSkus: 0, detail };
}

function failed(channel: string, error: unknown): ChannelSweepResult {
    const detail = error instanceof Error ? error.message : String(error);
    return { channel, status: 'failed', created: 0, updated: 0, unchanged: 0, unmatchedSkus: 0, detail };
}

async function applied(channel: string, plan: ChannelCodeSyncPlan): Promise<ChannelSweepResult> {
    const result = await applyChannelCodeSync(plan);
    return {
        channel,
        status: 'applied',
        created: result.created,
        updated: result.updated,
        unchanged: plan.unchanged,
        unmatchedSkus: plan.skusWithoutProduct.length,
        detail: '',
    };
}

async function sweepTakealot(ctx: TakealotCtx): Promise<ChannelSweepResult> {
    if (!ctx.secrets.TAKEALOT_API_KEY) {
        return skipped('Takealot', 'TAKEALOT_API_KEY is not set');
    }

    try {
        return await applied('Takealot', await computeBarcodeSyncPlan(await fetchAllOffers(ctx)));
    } catch (error) {
        return failed('Takealot', error);
    }
}

async function sweepAmazon(ctx: AmazonCtx, options: FetchOptions): Promise<ChannelSweepResult> {
    if (!amazonIsConfigured(ctx)) {
        return skipped('Amazon', 'Amazon credentials are not set');
    }

    try {
        const listings = await fetchFbaInventory(ctx, undefined, options);
        return await applied('Amazon', await computeAmazonFnskuPlan(listings));
    } catch (error) {
        return failed('Amazon', error);
    }
}

/**
 * Sync every channel's codes, one result per channel in a fixed order. Never
 * throws: a channel that cannot run comes back as 'skipped' or 'failed' so the
 * caller can report all of them and still fail the run.
 *
 * @example
 * await sweepChannelCodes(ctx);
 * // [{ channel: 'Takealot', status: 'applied', created: 2, updated: 1, … },
 * //  { channel: 'Amazon',   status: 'skipped', detail: 'Amazon credentials are not set', … }]
 */
export async function sweepChannelCodes(
    ctx: ChannelCodeSweepCtx,
    options: FetchOptions = {}
): Promise<ChannelSweepResult[]> {
    return [await sweepTakealot(ctx), await sweepAmazon(ctx, options)];
}
