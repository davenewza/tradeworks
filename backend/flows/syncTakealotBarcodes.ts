import { SyncTakealotBarcodes, FlowConfig } from '@teamkeel/sdk';
import {
    BarcodeSyncPlan,
    BarcodeApplyResult,
    fetchAllOffers,
    computeBarcodeSyncPlan,
    applyBarcodeSync,
} from '../lib/takealotOfferHelpers';

const config = {
    title: 'Sync Takealot Barcodes',
    description: 'Pull offer barcodes from the Takealot Marketplace API',
    stages: [
        { name: 'Confirm', key: 'confirm' },
        { name: 'Review changes', key: 'review' },
        { name: 'Complete', key: 'complete' },
    ],
} as const satisfies FlowConfig;

// The offer listing pages at 1000 per call, so even a large catalogue is a
// handful of requests — but give the fetch/apply steps headroom above the 60s
// default all the same.
const LONG_STEP_TIMEOUT = 10 * 60 * 1000;

// Markdown blocks for the plan's notes, shared by the review and completion
// pages. Empty when there is nothing to note.
function buildNotes(plan: BarcodeSyncPlan): string[] {
    const notes: string[] = [];

    const capped = (skus: string[]) => {
        const shown = skus.slice(0, 20).join(', ');
        const more = skus.length > 20 ? `, … (${skus.length - 20} more)` : '';
        return `${shown}${more}`;
    };

    if (plan.offersWithoutProduct.length > 0) {
        notes.push(
            `**Note:** ${plan.offersWithoutProduct.length} Takealot offer(s) have no matching product here (run *Sync Products* first to bring them in): ${capped(plan.offersWithoutProduct)}`
        );
    }

    if (plan.offersWithoutBarcode.length > 0) {
        notes.push(
            `**Note:** ${plan.offersWithoutBarcode.length} offer(s) carry no barcode on Takealot, so their products were left untouched: ${capped(plan.offersWithoutBarcode)}`
        );
    }

    if (plan.productsWithoutOffer.length > 0) {
        notes.push(
            `${plan.productsWithoutOffer.length} enabled product(s) have no Takealot offer: ${capped(plan.productsWithoutOffer)}`
        );
    }

    if (plan.warnings.length > 0) {
        notes.push(['**Warnings:**', '', ...plan.warnings.map((w) => `- ${w}`)].join('\n'));
    }

    return notes;
}

export default SyncTakealotBarcodes(config, async (ctx) => {
    // ── Page 1: confirm ──────────────────────────────────────────────────────
    await ctx.ui.page('confirm', {
        stage: 'confirm',
        title: 'Sync Takealot barcodes',
        content: [
            ctx.ui.display.markdown({
                content: [
                    'This will pull **every offer** from the Takealot Marketplace API and compare each offer\'s barcode against the product\'s **Takealot channel code** here (matched by SKU).',
                    '',
                    "On the next screen you'll review the changes before they are applied. Syncing will:",
                    '',
                    '- **Add** a Takealot channel code to products that have none.',
                    "- **Update** codes that differ from the offer's barcode.",
                    '',
                    'Codes for other channels are **not** touched, and nothing is deleted — a product whose offer is missing or has no barcode keeps whatever code it has.',
                ].join('\n'),
            }),
        ],
        actions: [{ label: 'Start synchronisation', value: 'start', mode: 'primary' }],
    });

    // ── Step: read-only diff — work out what needs to change ─────────────────
    const plan = (await ctx.step('fetch-changes', { timeout: LONG_STEP_TIMEOUT }, async ({ progress }) => {
        progress.set({ message: 'Fetching offers from Takealot…' });
        const offers = await fetchAllOffers(ctx, progress);
        progress.set({ message: 'Comparing against existing channel codes…' });
        return await computeBarcodeSyncPlan(offers);
    })) as unknown as BarcodeSyncPlan;

    // Nothing to do → finish early.
    if (plan.changes.length === 0) {
        return ctx.complete({
            title: 'Everything is up to date',
            stage: 'complete',
            description: `All ${plan.unchanged} matched product(s) already carry their offer's barcode.`,
            content: buildNotes(plan).map((note) => ctx.ui.display.markdown({ content: note })),
        });
    }

    // ── Page 2: review the planned changes ───────────────────────────────────
    await ctx.ui.page('review', {
        stage: 'review',
        title: `${plan.changes.length} barcode${plan.changes.length === 1 ? '' : 's'} to apply`,
        content: [
            ctx.ui.display.markdown({
                content: `Products whose Takealot code changes: **${plan.changes.length}** (${plan.unchanged} unchanged)`,
            }),
            ctx.ui.display.table({
                data: plan.changes,
                columns: ['sku', 'product', 'barcode', 'replaces', 'change'],
            }),
            ...buildNotes(plan).map((note) => ctx.ui.display.markdown({ content: note })),
        ],
        actions: [{ label: 'Apply changes', value: 'apply', mode: 'primary' }],
    });

    // ── Step: apply — upsert each product's Takealot channel code ────────────
    const result = (await ctx.step('apply-sync', { timeout: LONG_STEP_TIMEOUT }, async ({ progress }) => {
        return await applyBarcodeSync(plan, progress);
    })) as unknown as BarcodeApplyResult;

    // ── Completion: summary of what was applied ──────────────────────────────
    return ctx.complete({
        title: 'Takealot barcode sync complete',
        stage: 'complete',
        description: `${result.created + result.updated} product code${
            result.created + result.updated === 1 ? '' : 's'
        } synced for ${plan.channelName}.`,
        content: [
            ctx.ui.display.keyValue({
                data: [
                    { key: 'Codes added', value: result.created },
                    { key: 'Codes updated', value: result.updated },
                    { key: 'Already up to date', value: plan.unchanged },
                ],
            }),
            ...buildNotes(plan).map((note) => ctx.ui.display.markdown({ content: note })),
        ],
    });
});
