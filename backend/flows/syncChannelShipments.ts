import { SyncChannelShipments, FlowConfig } from '@teamkeel/sdk';
import {
    ShipmentSyncPlan,
    ShipmentApplyResult,
    computeShipmentSyncPlan,
    applyShipmentSync,
    openShipmentExternalIds,
} from '../lib/channelShipmentHelpers';
import { configuredAdapters, adapterFor } from '../lib/channelShipmentAdapters';

const config = {
    title: 'Sync channel shipments',
    description: "Pull consignments going into a channel's fulfilment centre",
    stages: [
        { name: 'Confirm', key: 'confirm' },
        { name: 'Review changes', key: 'review' },
        { name: 'Complete', key: 'complete' },
    ],
} as const satisfies FlowConfig;

// Shipments and the offer index both page at 1000 per call, so this is a handful
// of requests — but give the fetch and apply steps headroom above the 60s
// default, since apply writes a row per line.
const LONG_STEP_TIMEOUT = 10 * 60 * 1000;

// Notes on what the sync could not resolve, shared by the review and completion
// pages. Empty when there is nothing to say.
function buildNotes(plan: ShipmentSyncPlan): string[] {
    const notes: string[] = [];

    const capped = (values: string[]) => {
        const shown = values.slice(0, 20).join(', ');
        const more = values.length > 20 ? `, … (${values.length - 20} more)` : '';
        return `${shown}${more}`;
    };

    if (plan.unmatchedSkus.length > 0) {
        notes.push(
            `**Note:** ${plan.unmatchedSkus.length} SKU(s) on these shipments match no product here, so those lines cannot be labelled (run *Sync Products* first): ${capped(plan.unmatchedSkus)}`
        );
    }

    if (plan.unresolvedListings.length > 0) {
        notes.push(
            `**Note:** ${plan.unresolvedListings.length} shipment line(s) name a listing that no longer exists on ${plan.channelName}, so no SKU could be found for them: ${capped(plan.unresolvedListings)}`
        );
    }

    if (plan.warnings.length > 0) {
        notes.push(['**Warnings:**', '', ...plan.warnings.map((w) => `- ${w}`)].join('\n'));
    }

    return notes;
}

export default SyncChannelShipments(config, async (ctx) => {
    const adapters = configuredAdapters(ctx);

    if (adapters.length === 0) {
        return ctx.complete({
            title: 'No channel is set up for shipments',
            stage: 'complete',
            description:
                'None of the channels we can pull shipments from have their API credentials ' +
                'set. Takealot needs TAKEALOT_API_KEY (Seller Portal → API Access).',
            content: [],
        });
    }

    // ── Page 1: confirm ──────────────────────────────────────────────────────
    // With one channel configured there is nothing to choose, so the picker only
    // appears once a second platform has an adapter.
    const confirmation = await ctx.ui.page('confirm', {
        stage: 'confirm',
        title: 'Sync channel shipments',
        content: [
            ctx.ui.display.markdown({
                content: [
                    adapters.length === 1
                        ? `This pulls the consignments **${adapters[0].channelName}** is still expecting from us, together with the lines on each one, and matches those lines to products **by SKU**.`
                        : 'This pulls the consignments the channel is still expecting from us, together with the lines on each one, and matches those lines to products **by SKU**.',
                    '',
                    'Only consignments that have **not shipped yet** are pulled — those are the ones that still need labelling. Anything already tracked here is refreshed too, so a consignment that has since gone out is closed off rather than left showing as open.',
                    '',
                    "You'll review the changes before they are applied. Nothing is pushed back to the channel — this only reads.",
                ].join('\n'),
            }),
            ...(adapters.length > 1
                ? [
                      ctx.ui.select.one('channelName', {
                          label: 'Channel',
                          options: adapters.map((a) => ({
                              label: a.channelName,
                              value: a.channelName,
                          })),
                          defaultValue: adapters[0].channelName,
                      }),
                  ]
                : []),
            ctx.ui.inputs.boolean('fullHistory', {
                label: 'Pull the full history, including shipped and archived consignments',
                optional: true,
                defaultValue: false,
            }),
        ],
        actions: [{ label: 'Start synchronisation', value: 'start', mode: 'primary' }],
    });

    const channelName = (confirmation.data.channelName as string) ?? adapters[0].channelName;
    const fullHistory = Boolean(confirmation.data.fullHistory);
    const adapter = adapterFor(channelName)!;

    // ── Step: fetch and diff ─────────────────────────────────────────────────
    const plan = (await ctx.step('fetch-changes', { timeout: LONG_STEP_TIMEOUT }, async ({ progress }) => {
        progress.set({ message: `Fetching shipments from ${channelName}…` });
        // Consignments already tracked here are fetched even when they fall
        // outside the unshipped filter, so their status keeps moving.
        const alsoFetchIds = fullHistory ? [] : await openShipmentExternalIds(channelName);
        const external = await adapter.fetch(
            ctx,
            { includeShipped: fullHistory, includeArchived: fullHistory, alsoFetchIds },
            progress
        );
        progress.set({ message: 'Comparing against stored shipments…' });
        return await computeShipmentSyncPlan(channelName, external);
    })) as unknown as ShipmentSyncPlan;

    if (plan.changes.length === 0) {
        return ctx.complete({
            title: 'Everything is up to date',
            stage: 'complete',
            description: `All ${plan.unchanged} shipment(s) on ${channelName} already match what is stored.`,
            content: buildNotes(plan).map((note) => ctx.ui.display.markdown({ content: note })),
        });
    }

    // ── Page 2: review ───────────────────────────────────────────────────────
    const totalUnits = plan.changes.reduce((sum, c) => sum + c.units, 0);

    await ctx.ui.page('review', {
        stage: 'review',
        title: `${plan.changes.length} shipment${plan.changes.length === 1 ? '' : 's'} to apply`,
        content: [
            ctx.ui.display.markdown({
                content: `Shipments that change: **${plan.changes.length}** (${plan.unchanged} unchanged), **${totalUnits}** unit(s) in total.`,
            }),
            ctx.ui.display.table({
                data: plan.changes.map((c) => ({
                    Shipment: c.externalId,
                    Reference: c.reference,
                    Status: c.status,
                    Change: c.change,
                    Lines: c.lines,
                    Units: c.units,
                    Unmatched: c.unmatched,
                })),
            }),
            ...buildNotes(plan).map((note) => ctx.ui.display.markdown({ content: note })),
        ],
        actions: [{ label: 'Apply changes', value: 'apply', mode: 'primary' }],
    });

    // ── Step: apply ──────────────────────────────────────────────────────────
    const result = (await ctx.step('apply-sync', { timeout: LONG_STEP_TIMEOUT }, async ({ progress }) => {
        return await applyShipmentSync(plan, progress);
    })) as unknown as ShipmentApplyResult;

    // ── Completion ───────────────────────────────────────────────────────────
    return ctx.complete({
        title: 'Shipment sync complete',
        stage: 'complete',
        description: `${result.created + result.updated} shipment(s) synced for ${channelName}. Print their unit labels from the shipment page.`,
        content: [
            ctx.ui.display.keyValue({
                data: [
                    { key: 'Shipments added', value: result.created },
                    { key: 'Shipments updated', value: result.updated },
                    { key: 'Already up to date', value: plan.unchanged },
                    { key: 'Lines written', value: result.linesWritten },
                    { key: 'Lines removed', value: result.linesRemoved },
                ],
            }),
            ...buildNotes(plan).map((note) => ctx.ui.display.markdown({ content: note })),
        ],
    });
});
