import { ScheduledSyncStock, models } from '@teamkeel/sdk';
import { getZohoAccessToken } from '../lib/zohoProductHelpers';
import { fetchProductStock } from '../lib/zohoStockHelpers';
import { COVER_WINDOW_DAYS, loadSaleAggregates, estimatedMonthlySale, computeStockCover, classifyAbc } from '../lib/stockCoverHelpers';

const LOAD_CHUNK = 200;
const LONG_STEP_TIMEOUT = 10 * 60 * 1000;

type ProductRow = Awaited<ReturnType<typeof models.product.findMany>>[number];

// Daily stock & cover refresh — all from the Zoho Books API + local Sale history:
//   - estimatedMonthlySale: trailing-365-day units ÷ months active, ROUNDED to a
//     whole number (matches the sheet, and keeps cover consistent with it).
//   - stockAvailable: stock_on_hand from the Zoho items feed.
//   - currentStockCover / totalStockCover: stock ÷ estimate, rounded to 1 dp.
//   - abcClass: Pareto cut over every product's monthly revenue run-rate
//     (window revenue ÷ months active, so a recently launched product is
//     graded on its rate, not penalised for missing most of the window).
// Cover isn't a @computed field — the engine can't round — so the job derives and
// stores all of these together. Stock On Way is Phase 2 (stays 0 → Total = Current).
// A Zoho rate-limit degrades to a clean pause: estimates, cover and ABC classes
// still refresh from local sales (against last-known stock), and stock catches up
// next run.
export default ScheduledSyncStock({}, async (ctx) => {
    const now = new Date();
    const windowStart = new Date(now.getTime() - COVER_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const accessToken = await ctx.step('authenticate', async () => {
        return await getZohoAccessToken(ctx);
    });

    const fetched = await ctx.step('fetch-stock', async () => {
        return await fetchProductStock(ctx, accessToken);
    });

    const summary = await ctx.step('write-stock-and-cover', { timeout: LONG_STEP_TIMEOUT }, async () => {
        // Fresh stock readings by SKU (partial if Zoho rate-limited mid-fetch).
        const stockBySku = new Map(fetched.stock.map((s) => [s.sku, s.stockAvailable]));

        // Whole-number monthly estimate per product, from local sales.
        const aggregates = await loadSaleAggregates(windowStart);
        const estByProductId = new Map(
            aggregates.map((a) => [a.productId, Math.round(estimatedMonthlySale(a, now))]),
        );

        // ABC class from the same aggregates — a global cut, so it's computed
        // once over every product with sales, not per product. Every product in
        // this map is also in estByProductId, so it's guaranteed to be loaded
        // and written below; products absent here get null (unclassified).
        const abcByProductId = classifyAbc(aggregates, now);

        // Products to (re)compute: those with a fresh stock reading, plus those
        // with sales in the window. Loaded by SKU and by id, then merged.
        const products = new Map<string, ProductRow>();
        const stockSkus = [...stockBySku.keys()];
        for (let i = 0; i < stockSkus.length; i += LOAD_CHUNK) {
            const chunk = stockSkus.slice(i, i + LOAD_CHUNK);
            for (const p of await models.product.findMany({ where: { sku: { oneOf: chunk } } })) {
                products.set(p.id, p);
            }
        }
        const missingIds = [...estByProductId.keys()].filter((id) => !products.has(id));
        for (let i = 0; i < missingIds.length; i += LOAD_CHUNK) {
            const chunk = missingIds.slice(i, i + LOAD_CHUNK);
            for (const p of await models.product.findMany({ where: { id: { oneOf: chunk } } })) {
                products.set(p.id, p);
            }
        }

        let stockUpdated = 0;
        let estimatesUpdated = 0;

        for (const p of products.values()) {
            const hasStock = stockBySku.has(p.sku);
            const hasEstimate = estByProductId.has(p.id);

            // Use this run's value where we have one, else keep what's stored so
            // the other dimension's cover can still be recomputed.
            const stockAvailable = hasStock ? stockBySku.get(p.sku)! : (p.stockAvailable ?? null);
            const estimate = hasEstimate
                ? estByProductId.get(p.id)!
                : (p.estimatedMonthlySale == null ? null : Math.round(Number(p.estimatedMonthlySale)));

            const cover = computeStockCover(stockAvailable, p.stockOnWay ?? 0, estimate);

            await models.product.update(
                { id: p.id },
                {
                    stockAvailable,
                    stockSynchronisedAt: hasStock ? now : p.stockSynchronisedAt,
                    estimatedMonthlySale: estimate,
                    currentStockCover: cover.current,
                    totalStockCover: cover.total,
                    abcClass: abcByProductId.get(p.id) ?? null,
                },
            );

            if (hasStock) stockUpdated++;
            if (hasEstimate) estimatesUpdated++;
        }

        const abcCounts = { A: 0, B: 0, C: 0 };
        for (const cls of abcByProductId.values()) abcCounts[cls]++;

        return { zohoItems: stockBySku.size, productsTouched: products.size, stockUpdated, estimatesUpdated, abcCounts };
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
                        ? [{ key: 'Status', value: "Paused at Zoho's daily API limit — stock refreshes next run; estimates and cover were still updated from local sales." }]
                        : []),
                    { key: 'Zoho items with stock', value: summary.zohoItems },
                    { key: 'Products updated', value: summary.productsTouched },
                    { key: 'Stock levels updated', value: summary.stockUpdated },
                    { key: 'Monthly estimates updated', value: summary.estimatesUpdated },
                    {
                        key: 'ABC classes (A · B · C)',
                        value: `${summary.abcCounts.A} · ${summary.abcCounts.B} · ${summary.abcCounts.C}`,
                    },
                ],
            }),
        ],
    });
});
