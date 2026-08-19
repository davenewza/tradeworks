import { ScheduledSyncStock, models } from '@teamkeel/sdk';
import { getZohoAccessToken } from '../lib/zohoProductHelpers';
import { fetchProductStock } from '../lib/zohoStockHelpers';
import { loadSaleAggregates, estimatedMonthlySale } from '../lib/stockCoverHelpers';

const COVER_WINDOW_DAYS = 365;
const WRITE_CHUNK = 200;

// Daily stock & cover refresh. Two independent halves:
//   1. Monthly sales estimate — derived from local Sale history, no Zoho calls.
//   2. Stock levels — stock_on_hand pulled from Zoho items.
// The estimate runs first so it still lands if Zoho is rate-limited or down.
// currentStockCover / totalStockCover are @computed on Product, so they recompute
// automatically once these inputs are written. Stock On Way is Phase 2 (stays 0).
export default ScheduledSyncStock({}, async (ctx) => {
    const now = new Date();
    const windowStart = new Date(now.getTime() - COVER_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    // ── 1. Monthly sales estimate (local data only) ───────────────────────────
    const estimates = await ctx.step('write-estimates', async () => {
        const aggregates = await loadSaleAggregates(windowStart);
        let updated = 0;
        for (const agg of aggregates) {
            await models.product.update(
                { id: agg.productId },
                { estimatedMonthlySale: estimatedMonthlySale(agg, now) },
            );
            updated++;
        }
        return { productsWithSales: aggregates.length, updated };
    });

    // ── 2. Stock levels from Zoho items ───────────────────────────────────────
    const accessToken = await ctx.step('authenticate', async () => {
        return await getZohoAccessToken(ctx);
    });

    const fetched = await ctx.step('fetch-stock', async () => {
        return await fetchProductStock(ctx, accessToken);
    });

    const stockWrite = await ctx.step('write-stock', async () => {
        const bySku = new Map(fetched.stock.map((s) => [s.sku, s.stockAvailable]));
        const skus = Array.from(bySku.keys());
        let updated = 0;

        for (let i = 0; i < skus.length; i += WRITE_CHUNK) {
            const chunk = skus.slice(i, i + WRITE_CHUNK);
            const products = await models.product.findMany({ where: { sku: { oneOf: chunk } } });
            for (const product of products) {
                const stock = bySku.get(product.sku);
                if (stock === undefined) continue;
                await models.product.update(
                    { id: product.id },
                    { stockAvailable: stock, stockSynchronisedAt: now },
                );
                updated++;
            }
        }

        // Zoho SKUs with no local Product — usually items not yet pulled in by the
        // product sync. Surfaced so a growing gap is visible rather than silent.
        return { zohoItems: bySku.size, updated, unmatched: bySku.size - updated };
    });

    const rateLimited = fetched.rateLimited;

    return ctx.complete({
        title: rateLimited
            ? 'Stock sync paused — Zoho daily API limit reached'
            : 'Stock & cover sync complete',
        content: [
            ctx.ui.display.keyValue({
                data: [
                    ...(rateLimited
                        ? [{ key: 'Status', value: "Paused at Zoho's daily API limit — stock refreshes on the next run. Monthly estimates were still updated." }]
                        : []),
                    { key: 'Products with sales', value: estimates.productsWithSales },
                    { key: 'Monthly estimates updated', value: estimates.updated },
                    { key: 'Zoho items with stock', value: stockWrite.zohoItems },
                    { key: 'Stock levels updated', value: stockWrite.updated },
                    { key: 'Zoho SKUs unmatched locally', value: stockWrite.unmatched },
                ],
            }),
        ],
    });
});
