import { SyncChannelFees, FlowConfig } from '@teamkeel/sdk';
import {
    FeeSyncPlan,
    FeeApplyResult,
    TAKEALOT_CHANNEL_NAME,
    getZohoAccessToken,
    fetchChannelFees,
    fetchItemFeeAssignments,
    computeFeeSyncPlan,
    applyFeeSync,
} from '../lib/zohoChannelFeeHelpers';

const config = {
    title: 'Sync Channel Fees',
    description: 'Pull Takealot fees from Zoho Books',
    stages: [
        { name: 'Confirm', key: 'confirm' },
        { name: 'Review changes', key: 'review' },
        { name: 'Complete', key: 'complete' },
    ],
} as const satisfies FlowConfig;

// Zoho item fetches can run long for large catalogs — give the fetch/apply
// steps headroom above the 60s default (max is 14 min / 840000ms).
const LONG_STEP_TIMEOUT = 10 * 60 * 1000;

// Markdown blocks for the plan's warnings and unmatched SKUs, shared by the
// review and completion pages. Empty when there is nothing to note.
function buildNotes(plan: FeeSyncPlan): string[] {
    const notes: string[] = [];

    if (plan.unmatchedSkus.length > 0) {
        const shown = plan.unmatchedSkus.slice(0, 20).join(', ');
        const more = plan.unmatchedSkus.length > 20 ? `, … (${plan.unmatchedSkus.length - 20} more)` : '';
        notes.push(
            `**Note:** ${plan.unmatchedSkus.length} Zoho item(s) have fees but no matching product here (run *Sync Products* first to bring them in): ${shown}${more}`
        );
    }

    if (plan.warnings.length > 0) {
        notes.push(['**Warnings:**', '', ...plan.warnings.map((w) => `- ${w}`)].join('\n'));
    }

    return notes;
}

export default SyncChannelFees(config, async (ctx) => {
    // ── Page 1: confirm ──────────────────────────────────────────────────────
    await ctx.ui.page('confirm', {
        stage: 'confirm',
        title: 'Sync channel fees from Zoho',
        content: [
            ctx.ui.display.markdown({
                content: [
                    `This will pull the Takealot fees from the Zoho Books custom modules, along with the fees assigned to each **active item**, and compare them against the **${TAKEALOT_CHANNEL_NAME}** channel here.`,
                    '',
                    "On the next screen you'll review the changes before they are applied. Syncing will:",
                    '',
                    '- **Add or update** fees (matched by their Zoho record).',
                    "- **Set** each product's fees to match its Zoho item (matched by SKU), adding and removing assignments so they mirror Zoho.",
                    '',
                    'Products, prices and sales are **not** touched. Items with no fees in Zoho and no fees here are left alone.',
                ].join('\n'),
            }),
        ],
        actions: [{ label: 'Start synchronisation', value: 'start', mode: 'primary' }],
    });

    // ── Step: authenticate with Zoho ─────────────────────────────────────────
    const accessToken = (await ctx.step('authenticate', async () => {
        return await getZohoAccessToken(ctx);
    })) as unknown as string;

    // ── Step: read-only diff — work out what needs to change ─────────────────
    const plan = (await ctx.step('fetch-changes', { timeout: LONG_STEP_TIMEOUT }, async () => {
        const fees = await fetchChannelFees(ctx, accessToken);
        const items = await fetchItemFeeAssignments(ctx, accessToken);
        return await computeFeeSyncPlan(fees, items);
    })) as unknown as FeeSyncPlan;

    const totalChanges = plan.fees.length + plan.productFees.length;

    // Nothing to do → finish early.
    if (totalChanges === 0) {
        return ctx.complete({
            title: 'Everything is up to date',
            stage: 'complete',
            description: 'All fees and product fees already match Zoho.',
            content: buildNotes(plan).map((note) => ctx.ui.display.markdown({ content: note })),
        });
    }

    // ── Page 2: review the planned changes ───────────────────────────────────
    await ctx.ui.page('review', {
        stage: 'review',
        title: `${totalChanges} change${totalChanges === 1 ? '' : 's'} to apply`,
        content: [
            ctx.ui.display.markdown({
                content: [
                    `Fees to add or update: **${plan.fees.length}** (${plan.unchangedFees} unchanged)`,
                    '',
                    `Products whose fees change: **${plan.productFees.length}** (${plan.unchangedProductFees} unchanged)`,
                ].join('\n'),
            }),
            ...(plan.fees.length > 0
                ? [
                      ctx.ui.display.markdown({ content: '### Fees' }),
                      ctx.ui.display.table({
                          data: plan.fees,
                          columns: ['name', 'feeType', 'value', 'change'],
                      }),
                  ]
                : []),
            ...(plan.productFees.length > 0
                ? [
                      ctx.ui.display.markdown({ content: '### Product fees' }),
                      ctx.ui.display.table({
                          data: plan.productFees,
                          columns: ['sku', 'product', 'fees', 'change'],
                      }),
                  ]
                : []),
            ...buildNotes(plan).map((note) => ctx.ui.display.markdown({ content: note })),
        ],
        actions: [{ label: 'Apply changes', value: 'apply', mode: 'primary' }],
    });

    // ── Step: apply — upsert fees and reconcile product assignments ──────────
    const result = (await ctx.step('apply-sync', { timeout: LONG_STEP_TIMEOUT }, async () => {
        return await applyFeeSync(plan);
    })) as unknown as FeeApplyResult;

    // ── Completion: summary of what was applied ──────────────────────────────
    return ctx.complete({
        title: 'Channel fee sync complete',
        stage: 'complete',
        description: `${result.feesCreated + result.feesUpdated} fees synced and ${result.productsChanged} product${
            result.productsChanged === 1 ? '' : 's'
        } updated for ${plan.channelName}.`,
        content: [
            ctx.ui.display.keyValue({
                data: [
                    { key: 'Fees added', value: result.feesCreated },
                    { key: 'Fees updated', value: result.feesUpdated },
                    { key: 'Product assignments added', value: result.assignmentsAdded },
                    { key: 'Product assignments removed', value: result.assignmentsRemoved },
                ],
            }),
            ...buildNotes(plan).map((note) => ctx.ui.display.markdown({ content: note })),
        ],
    });
});
