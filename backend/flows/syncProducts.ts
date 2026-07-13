import { SyncProducts, FlowConfig } from '@teamkeel/sdk';
import {
    SyncCandidate,
    ApplyResult,
    getZohoAccessToken,
    computeSyncCandidates,
    applyProductSync,
} from '../lib/zohoProductHelpers';

const config = {
    title: 'Sync Products',
    description: 'Pull products and brands from Zoho Books',
    stages: [
        { name: 'Confirm', key: 'confirm' },
        { name: 'Review changes', key: 'review' },
        { name: 'Complete', key: 'complete' },
    ],
} as const satisfies FlowConfig;

// Zoho item fetches can run long for large catalogs — give the fetch/apply
// steps headroom above the 60s default (max is 14 min / 840000ms).
const LONG_STEP_TIMEOUT = 10 * 60 * 1000;

export default SyncProducts(config, async (ctx) => {
    // ── Page 1: confirm ──────────────────────────────────────────────────────
    await ctx.ui.page('confirm', {
        stage: 'confirm',
        title: 'Sync products from Zoho',
        content: [
            ctx.ui.display.markdown({
                content: [
                    'This will pull all **active items** from Zoho Books and compare them against your products.',
                    '',
                    "On the next screen you'll pick which changes to apply. Syncing will:",
                    '',
                    '- **Add** new products (matched by SKU), creating their **brand** if it does not exist yet.',
                    "- **Update** existing products whose **name** or **brand** has changed in Zoho.",
                    '',
                    'Product dimensions, images, prices and enabled status are **not** touched.',
                ].join('\n'),
            }),
        ],
        actions: [{ label: 'Start synchronisation', value: 'start', mode: 'primary' }],
    });

    // ── Step: authenticate with Zoho ─────────────────────────────────────────
    const accessToken = (await ctx.step('authenticate', async () => {
        return await getZohoAccessToken(ctx);
    })) as unknown as string;

    // ── Step: read-only diff — work out what needs adding/updating ───────────
    const candidates = (await ctx.step('fetch-changes', { timeout: LONG_STEP_TIMEOUT }, async () => {
        return await computeSyncCandidates(ctx, accessToken);
    })) as unknown as SyncCandidate[];

    // Nothing to do → finish early.
    if (candidates.length === 0) {
        return ctx.complete({
            title: 'Everything is up to date',
            stage: 'complete',
            description: 'No products in Zoho needed to be added or updated.',
            content: [],
        });
    }

    // ── Page 2: checklist of add/update candidates ───────────────────────────
    const selection = await ctx.ui.page('review', {
        stage: 'review',
        title: `${candidates.length} product${candidates.length === 1 ? '' : 's'} to add or update`,
        content: [
            ctx.ui.display.markdown({
                content: 'Tick the products you want to sync. Only ticked products will be added or updated.',
            }),
            ctx.ui.select.table('products', {
                data: candidates,
                columns: ['sku', 'name', 'brand', 'change'],
                mode: 'multi',
            }),
        ],
        actions: [{ label: 'Sync selected', value: 'sync', mode: 'primary' }],
    });

    const selected = (selection.data.products ?? []) as SyncCandidate[];

    if (selected.length === 0) {
        return ctx.complete({
            title: 'Nothing synced',
            stage: 'complete',
            description: 'No products were selected, so nothing was added or updated.',
            content: [],
        });
    }

    // ── Step: apply — create/update selected products (and their brands) ─────
    const result = (await ctx.step('apply-sync', { timeout: LONG_STEP_TIMEOUT }, async () => {
        return await applyProductSync(selected);
    })) as unknown as ApplyResult;

    // ── Completion: full list of what was added/updated ──────────────────────
    return ctx.complete({
        title: 'Product sync complete',
        stage: 'complete',
        description: `${result.created} added, ${result.updated} updated.`,
        content: [
            ctx.ui.display.keyValue({
                data: [
                    { key: 'Products added', value: result.created },
                    { key: 'Products updated', value: result.updated },
                ],
            }),
            ctx.ui.display.divider(),
            ctx.ui.display.table({
                data: result.synced,
                columns: ['sku', 'name', 'brand', 'change'],
            }),
        ],
    });
});
