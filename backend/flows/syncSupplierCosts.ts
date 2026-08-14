import { SyncSupplierCosts, FlowConfig } from '@teamkeel/sdk';
import {
    CostSyncPlan,
    CostApplyResult,
    getZohoInventoryToken,
    fetchLandedCostLines,
    computeCostSyncPlan,
    applyCostSync,
} from '../lib/zohoCostHelpers';

const config = {
    title: 'Sync Supplier Costs',
    description: 'Pull product cost of goods (unit cost + landed freight per bill) from Zoho for a date range',
    stages: [
        { name: 'Confirm', key: 'confirm' },
        { name: 'Review changes', key: 'review' },
        { name: 'Complete', key: 'complete' },
    ],
} as const satisfies FlowConfig;

// Walking bills + their landed costs is call-heavy and rate-limited, so the fetch
// paces itself — give the fetch/apply steps headroom above the 60s default (max
// is 14 min / 840000ms). The date range keeps a single run bounded.
const LONG_STEP_TIMEOUT = 14 * 60 * 1000;

// Zoho dates are YYYY-MM-DD; the flow inputs arrive as Date objects.
function toIsoDate(d: Date): string {
    return new Date(d).toISOString().slice(0, 10);
}

function buildNotes(plan: CostSyncPlan): string[] {
    const notes: string[] = [];
    if (plan.unmatchedSkus.length > 0) {
        const shown = plan.unmatchedSkus.slice(0, 20).join(', ');
        const more = plan.unmatchedSkus.length > 20 ? `, … (${plan.unmatchedSkus.length - 20} more)` : '';
        notes.push(
            `**Note:** ${plan.unmatchedSkus.length} Zoho cost record(s) reference a SKU with no matching product here (run *Sync Products* first): ${shown}${more}`
        );
    }
    if (plan.warnings.length > 0) {
        notes.push(['**Warnings:**', '', ...plan.warnings.map((w) => `- ${w}`)].join('\n'));
    }
    return notes;
}

export default SyncSupplierCosts(config, async (ctx, inputs) => {
    const dateFrom = toIsoDate(inputs.dateFrom);
    const dateTo = toIsoDate(inputs.dateTo);

    // ── Page 1: confirm ──────────────────────────────────────────────────────
    await ctx.ui.page('confirm', {
        stage: 'confirm',
        title: 'Sync supplier costs from Zoho',
        content: [
            ctx.ui.display.markdown({
                content: [
                    `This will walk Zoho bills dated **${dateFrom} → ${dateTo}**, and for each bill that has **landed costs**, pull the freight/duties/fees Zoho allocated across its product lines.`,
                    '',
                    "On the next screen you'll review the changes before they are applied. Syncing will:",
                    '',
                    '- **Create** supplier bills as they are first seen (matched by bill number).',
                    '- **Add or update** a cost line per product per bill: unit cost + landed freight-in, matched by SKU.',
                    '',
                    'Only bills with landed costs are touched. Products, prices, fees and sales are **not** changed. Cost lines are never deleted — cost history is cumulative.',
                ].join('\n'),
            }),
        ],
        actions: [{ label: 'Start synchronisation', value: 'start', mode: 'primary' }],
    });

    // ── Step: authenticate with Zoho (Inventory scope) ───────────────────────
    const accessToken = (await ctx.step('authenticate', async () => {
        return await getZohoInventoryToken(ctx);
    })) as unknown as string;

    // ── Step: read-only diff — fetch bills + landed costs, work out changes ───
    const plan = (await ctx.step('fetch-changes', { timeout: LONG_STEP_TIMEOUT }, async () => {
        const lines = await fetchLandedCostLines(ctx, accessToken, dateFrom, dateTo);
        return await computeCostSyncPlan(lines);
    })) as unknown as CostSyncPlan;

    // Nothing to do → finish early.
    if (plan.costLines.length === 0) {
        return ctx.complete({
            title: 'Everything is up to date',
            stage: 'complete',
            description: `No cost-line changes for bills dated ${dateFrom} → ${dateTo}.`,
            content: buildNotes(plan).map((note) => ctx.ui.display.markdown({ content: note })),
        });
    }

    // ── Page 2: review the planned changes ───────────────────────────────────
    await ctx.ui.page('review', {
        stage: 'review',
        title: `${plan.costLines.length} cost line${plan.costLines.length === 1 ? '' : 's'} to apply`,
        content: [
            ctx.ui.display.markdown({
                content: [
                    `Cost lines to add or update: **${plan.costLines.length}** (${plan.unchangedCostLines} unchanged)`,
                    '',
                    `Supplier bills referenced: **${plan.billCount}**`,
                ].join('\n'),
            }),
            ctx.ui.display.table({
                data: plan.costLines,
                columns: ['sku', 'product', 'billNumber', 'unitCost', 'freightIn', 'landed', 'change'],
            }),
            ...buildNotes(plan).map((note) => ctx.ui.display.markdown({ content: note })),
        ],
        actions: [{ label: 'Apply changes', value: 'apply', mode: 'primary' }],
    });

    // ── Step: apply — upsert bills and cost lines ────────────────────────────
    const result = (await ctx.step('apply-sync', { timeout: LONG_STEP_TIMEOUT }, async () => {
        return await applyCostSync(plan);
    })) as unknown as CostApplyResult;

    // ── Completion: summary of what was applied ──────────────────────────────
    return ctx.complete({
        title: 'Supplier cost sync complete',
        stage: 'complete',
        description: `${result.costLinesCreated + result.costLinesUpdated} cost line${
            result.costLinesCreated + result.costLinesUpdated === 1 ? '' : 's'
        } synced across ${result.billsCreated} new bill${result.billsCreated === 1 ? '' : 's'}.`,
        content: [
            ctx.ui.display.keyValue({
                data: [
                    { key: 'Cost lines added', value: result.costLinesCreated },
                    { key: 'Cost lines updated', value: result.costLinesUpdated },
                    { key: 'Supplier bills created', value: result.billsCreated },
                ],
            }),
            ...buildNotes(plan).map((note) => ctx.ui.display.markdown({ content: note })),
        ],
    });
});
