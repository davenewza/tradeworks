import { SyncProducts, FlowConfig } from '@teamkeel/sdk';
import {
    SyncCandidate,
    ApplyResult,
    getZohoAccessToken,
    computeSyncCandidates,
    resolveSelectedCandidates,
    applyProductSync,
    zohoPhotoFetcher,
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
                    'This will pull **every item** from Zoho Books and compare it against your products.',
                    '',
                    "On the next screen you'll pick which changes to apply. Syncing will:",
                    '',
                    '- **Add** new products (matched by SKU), creating their **brand** if it does not exist yet. Items already **inactive** in Zoho come in too, as inactive products — they stay out of the catalogue, but their sales and costs need a SKU to attach to.',
                    '- **Update** existing products whose **name** or **brand** has changed in Zoho.',
                    '- **Deactivate** products whose Zoho item has gone **inactive**, taking them out of the catalogue.',
                    '- **Reactivate** products whose Zoho item is **active** again, bringing them back.',
                    "- **Add a photo** from Zoho to active products that don't have one yet. Existing photos are never replaced.",
                    '',
                    'A product\'s active status lives in Zoho and is only ever changed there — this sync is how it reaches us.',
                    'Product dimensions and prices are **not** touched.',
                ].join('\n'),
            }),
        ],
        actions: [{ label: 'Start synchronisation', value: 'start', mode: 'primary' }],
    });

    // ── Step: authenticate with Zoho ─────────────────────────────────────────
    const accessToken = (await ctx.step('authenticate', { loadingMessage: 'Signing in to Zoho…' }, async () => {
        return await getZohoAccessToken(ctx);
    })) as unknown as string;

    // ── Step: read-only diff — work out what needs adding/updating ───────────
    const candidates = (await ctx.step('fetch-changes', { timeout: LONG_STEP_TIMEOUT }, async ({ progress }) => {
        return await computeSyncCandidates(ctx, accessToken, progress);
    })) as unknown as SyncCandidate[];

    // Nothing to do → finish early.
    if (candidates.length === 0) {
        return ctx.complete({
            title: 'Everything is up to date',
            stage: 'complete',
            description: 'Every product already matches Zoho.',
            content: [],
        });
    }

    // ── Page 2: checklist of add/update candidates ───────────────────────────
    const selection = await ctx.ui.page('review', {
        stage: 'review',
        title: `${candidates.length} product${candidates.length === 1 ? '' : 's'} to sync`,
        content: [
            ctx.ui.display.markdown({
                content: 'Tick the products you want to sync. Only ticked products will be changed.',
            }),
            ctx.ui.select.table('products', {
                data: candidates,
                columns: ['sku', 'name', 'brand', 'change', 'reason', 'photo'],
                mode: 'multi',
            }),
        ],
        actions: [{ label: 'Sync selected', value: 'sync', mode: 'primary' }],
    });

    // The picker returns only the columns it was shown, so the ticked rows have
    // lost `action`, `isActive` and `zohoItemId`. Match them back to the
    // candidates computed above before anything is applied.
    const selectedRows = (selection.data.products ?? []) as { sku: string }[];
    const selected = resolveSelectedCandidates(candidates, selectedRows);

    if (selected.length === 0) {
        return ctx.complete({
            title: 'Nothing synced',
            stage: 'complete',
            description: 'No products were selected, so nothing was changed.',
            content: [],
        });
    }

    // ── Step: apply — create/update selected products (and their brands) ─────
    const result = (await ctx.step('apply-sync', { timeout: LONG_STEP_TIMEOUT }, async ({ progress }) => {
        return await applyProductSync(selected, progress, zohoPhotoFetcher(ctx, accessToken));
    })) as unknown as ApplyResult;

    // ── Completion: full list of what was added/updated ──────────────────────
    return ctx.complete({
        title: 'Product sync complete',
        stage: 'complete',
        description: `${result.created} added, ${result.updated} updated, ${result.deactivated} deactivated, ${result.reactivated} reactivated, ${result.photosAdded} photo${result.photosAdded === 1 ? '' : 's'} added.`,
        content: [
            ctx.ui.display.keyValue({
                data: [
                    { key: 'Products added', value: result.created },
                    { key: '— of those, inactive (history only)', value: result.createdInactive },
                    { key: 'Products updated', value: result.updated },
                    { key: 'Products deactivated', value: result.deactivated },
                    { key: 'Products reactivated', value: result.reactivated },
                    { key: 'Photos added', value: result.photosAdded },
                ],
            }),
            ...(result.photoFailures.length > 0
                ? [
                      ctx.ui.display.markdown({
                          content: `**${result.photoFailures.length} photo${result.photoFailures.length === 1 ? '' : 's'} could not be downloaded** — they'll be offered again on the next sync.`,
                      }),
                      ctx.ui.display.table({ data: result.photoFailures, columns: ['sku', 'error'] }),
                  ]
                : []),
            ctx.ui.display.divider(),
            ctx.ui.display.table({
                data: result.synced,
                columns: ['sku', 'name', 'brand', 'change', 'reason', 'photo'],
            }),
        ],
    });
});
