import { SyncAmazonFnskus, FlowConfig } from '@teamkeel/sdk';
import {
    AmazonFnskuPlan,
    amazonLabelSpecExists,
    computeAmazonFnskuPlan,
    fetchFbaInventory,
} from '../lib/amazonFnskuHelpers';
import { ChannelCodeApplyResult, applyChannelCodeSync } from '../lib/channelCodeSync';

const config = {
    title: 'Sync Amazon FNSKUs',
    description: 'Pull each FBA listing’s FNSKU from the Amazon Selling Partner API',
    stages: [
        { name: 'Confirm', key: 'confirm' },
        { name: 'Review changes', key: 'review' },
        { name: 'Complete', key: 'complete' },
    ],
} as const satisfies FlowConfig;

// The inventory listing is paced at two pages a second, so a catalogue of a
// few hundred FBA listings is well under a minute — but give the fetch/apply
// steps headroom above the 60s default all the same.
const LONG_STEP_TIMEOUT = 10 * 60 * 1000;

interface PlanLoad {
    plan: AmazonFnskuPlan;
    // Whether Amazon can print yet — codes alone are not labels.
    hasLabelSpec: boolean;
}

export default SyncAmazonFnskus(config, async (ctx) => {
    // ── Page 1: confirm ──────────────────────────────────────────────────────
    await ctx.ui.page('confirm', {
        stage: 'confirm',
        title: 'Sync Amazon FNSKUs',
        content: [
            ctx.ui.display.markdown({
                content: [
                    'This will pull **every FBA listing** from the Amazon Selling Partner API and compare each listing’s **FNSKU** — the Code 128 barcode on an FBA unit label — against the product’s **Amazon channel code** here (matched by seller SKU).',
                    '',
                    'On the next screen you’ll review the changes before they are applied. Syncing will:',
                    '',
                    '- **Add** an Amazon channel code to products that have none.',
                    '- **Update** codes that differ from the listing’s FNSKU.',
                    '',
                    'Codes for other channels are **not** touched, and nothing is deleted — a product with no FBA listing, or whose listing carries no FNSKU, keeps whatever code it has. A listing set up on the manufacturer barcode (its FNSKU is its ASIN) is reported rather than stored.',
                ].join('\n'),
            }),
        ],
        actions: [{ label: 'Start synchronisation', value: 'start', mode: 'primary' }],
    });

    // ── Step: read-only diff — work out what needs to change ─────────────────
    const { plan, hasLabelSpec } = (await ctx.step('fetch-changes', { timeout: LONG_STEP_TIMEOUT }, async ({ progress }) => {
        progress.set({ message: 'Fetching FBA listings from Amazon…' });
        const listings = await fetchFbaInventory(ctx, progress);
        progress.set({ message: 'Comparing against existing channel codes…' });
        return {
            plan: await computeAmazonFnskuPlan(listings),
            hasLabelSpec: await amazonLabelSpecExists(),
        };
    })) as unknown as PlanLoad;

    // Nothing to do → finish early.
    if (plan.changes.length === 0) {
        return ctx.complete({
            title: 'Everything is up to date',
            stage: 'complete',
            description: `All ${plan.unchanged} matched product(s) already carry their listing’s FNSKU.`,
            content: [
                ...buildNotes(plan).map((note) => ctx.ui.display.markdown({ content: note })),
                ...(hasLabelSpec ? [] : noSpecBanner(ctx)),
            ],
        });
    }

    // ── Page 2: review the planned changes ───────────────────────────────────
    await ctx.ui.page('review', {
        stage: 'review',
        title: `${plan.changes.length} FNSKU${plan.changes.length === 1 ? '' : 's'} to apply`,
        content: [
            ctx.ui.display.markdown({
                content: `Products whose Amazon code changes: **${plan.changes.length}** (${plan.unchanged} unchanged)`,
            }),
            ctx.ui.display.table({
                data: plan.changes.map((change) => ({
                    SKU: change.sku,
                    Product: change.product,
                    FNSKU: change.code,
                    Replaces: change.replaces,
                    Change: change.change,
                })),
            }),
            ...buildNotes(plan).map((note) => ctx.ui.display.markdown({ content: note })),
        ],
        actions: [{ label: 'Apply changes', value: 'apply', mode: 'primary' }],
    });

    // ── Step: apply — upsert each product's Amazon channel code ──────────────
    const result = (await ctx.step('apply-sync', { timeout: LONG_STEP_TIMEOUT }, async ({ progress }) => {
        return await applyChannelCodeSync(plan, progress);
    })) as unknown as ChannelCodeApplyResult;

    // ── Completion: summary of what was applied ──────────────────────────────
    const applied = result.created + result.updated;
    return ctx.complete({
        title: 'Amazon FNSKU sync complete',
        stage: 'complete',
        description: `${applied} product code${applied === 1 ? '' : 's'} synced for ${plan.channelName}.`,
        content: [
            ctx.ui.display.keyValue({
                data: [
                    { key: 'Codes added', value: result.created },
                    { key: 'Codes updated', value: result.updated },
                    { key: 'Already up to date', value: plan.unchanged },
                ],
            }),
            ...buildNotes(plan).map((note) => ctx.ui.display.markdown({ content: note })),
            ...(hasLabelSpec ? [] : noSpecBanner(ctx)),
        ],
    });
});

// Markdown blocks for the plan's notes, shared by the review and completion
// pages. Empty when there is nothing to note.
function buildNotes(plan: AmazonFnskuPlan): string[] {
    const notes: string[] = [];

    const capped = (items: string[]) => {
        const shown = items.slice(0, 20).join(', ');
        const more = items.length > 20 ? `, … (${items.length - 20} more)` : '';
        return `${shown}${more}`;
    };

    if (plan.skusWithoutProduct.length > 0) {
        notes.push(
            `**Note:** ${plan.skusWithoutProduct.length} FBA listing(s) have no matching product here — ` +
                `run *Sync Products* first, or check the seller SKU on Amazon matches the Zoho SKU: ${capped(plan.skusWithoutProduct)}`
        );
    }

    if (plan.skusWithoutCode.length > 0) {
        notes.push(
            `**Note:** ${plan.skusWithoutCode.length} listing(s) carry no FNSKU on Amazon, so their products were left untouched: ${capped(plan.skusWithoutCode)}`
        );
    }

    if (plan.manufacturerBarcodeSkus.length > 0) {
        notes.push(
            `**Note:** ${plan.manufacturerBarcodeSkus.length} listing(s) use the manufacturer barcode — ` +
                'their FNSKU is their ASIN, so Amazon scans the product’s own EAN/UPC and no FNSKU label is needed. ' +
                `Left untouched: ${capped(plan.manufacturerBarcodeSkus)}`
        );
    }

    if (plan.nonNewConditions.length > 0) {
        notes.push(
            `**Warning:** ${plan.nonNewConditions.length} listing(s) are not in New condition, but the Amazon label prints ` +
                `one fixed condition for the whole channel: ${capped(plan.nonNewConditions.map((c) => `${c.sku} (${c.condition})`))}`
        );
    }

    if (plan.productsWithoutSource.length > 0) {
        notes.push(
            `${plan.productsWithoutSource.length} enabled product(s) have no FBA listing: ${capped(plan.productsWithoutSource)}`
        );
    }

    if (plan.warnings.length > 0) {
        notes.push(['**Warnings:**', '', ...plan.warnings.map((w) => `- ${w}`)].join('\n'));
    }

    return notes;
}

// Codes and the label spec are set up separately, so a first sync can leave
// every product coded and still nothing printable. Say so, with the shape the
// Amazon FBA label takes (docs/channel-barcode-labels.md).
function noSpecBanner(ctx: any) {
    return [
        ctx.ui.display.banner({
            title: 'Amazon is not set up for printing yet',
            description:
                'The codes are in place, but nothing prints until the channel has a label spec. ' +
                'Products → Barcode labels → Add a label spec: channel Amazon Marketplace, ' +
                'symbology Code 128, 50 × 30 mm stock. Then give it three elements, in this ' +
                'order: the barcode, the product name, and the text “New” — Amazon requires the ' +
                'item condition at the bottom of every unit label.',
            mode: 'warning',
        }),
    ];
}
