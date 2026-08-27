import { models, resetDatabase } from '@teamkeel/testing';
import { AbcClass, StockCoverStatus } from '@teamkeel/sdk';
import { beforeEach, describe, expect, test } from 'vitest';
import { classifyAbc, computeStockCover, estimatedMonthlySale, loadSaleAggregates, monthsActive, round1 } from './stockCoverHelpers';

const num = (v: unknown) => Number(v);
const NOW = new Date('2026-08-19T00:00:00Z');

describe('monthsActive', () => {
    test('floors at 1 month for brand-new or unknown products', () => {
        expect(monthsActive(null, NOW)).toBe(1);
        expect(monthsActive(new Date('2026-08-15T00:00:00Z'), NOW)).toBe(1); // 4 days
    });

    test('caps at 12 months for long-established products', () => {
        expect(monthsActive(new Date('2020-01-01T00:00:00Z'), NOW)).toBe(12);
    });

    test('is the elapsed months in between', () => {
        // ~3 months of history → divide the window by ~3, not 12.
        expect(monthsActive(new Date('2026-05-19T00:00:00Z'), NOW)).toBeCloseTo(3, 1);
    });
});

describe('estimatedMonthlySale', () => {
    test('established product: window units ÷ 12', () => {
        expect(
            estimatedMonthlySale({ productId: 'x', unitsLast365: 120, revenueLast365: 0, firstSaleDate: new Date('2020-01-01T00:00:00Z') }, NOW),
        ).toBeCloseTo(10, 6);
    });

    test('new product: window units ÷ its shorter active span (not understated)', () => {
        const firstSale = new Date('2026-05-19T00:00:00Z');
        expect(estimatedMonthlySale({ productId: 'x', unitsLast365: 60, revenueLast365: 0, firstSaleDate: firstSale }, NOW)).toBeCloseTo(
            60 / monthsActive(firstSale, NOW),
            6,
        );
        // Sold only a few days → floored to 1 month, so the estimate is the raw units.
        expect(
            estimatedMonthlySale({ productId: 'x', unitsLast365: 20, revenueLast365: 0, firstSaleDate: new Date('2026-08-15T00:00:00Z') }, NOW),
        ).toBe(20);
    });

    test('nothing sold in the window → 0 (drives cover to blank)', () => {
        expect(
            estimatedMonthlySale({ productId: 'x', unitsLast365: 0, revenueLast365: 0, firstSaleDate: new Date('2020-01-01T00:00:00Z') }, NOW),
        ).toBe(0);
    });
});

describe('loadSaleAggregates', () => {
    beforeEach(resetDatabase);

    test('sums only in-window units and revenue, and finds the earliest sale per product', async () => {
        const brand = await models.brand.create({ name: 'B' });
        const p1 = await models.product.create({ name: 'P1', sku: 'AGG-1', brandId: brand.id });
        const p2 = await models.product.create({ name: 'P2', sku: 'AGG-2', brandId: brand.id });
        const channel = await models.channel.create({ name: 'C' });

        const windowStart = new Date(NOW.getTime() - 365 * 24 * 60 * 60 * 1000); // ~2025-08-19

        // p1: an old sale (outside the window) plus one inside it.
        await models.sale.create({ invoiceNumber: 'I1', lineItemId: 'L1', lineKey: 'L1', channelId: channel.id, date: new Date('2023-01-01'), productId: p1.id, quantity: 100, price: 1, netAmount: 999 });
        await models.sale.create({ invoiceNumber: 'I2', lineItemId: 'L2', lineKey: 'L2', channelId: channel.id, date: new Date('2026-06-01'), productId: p1.id, quantity: 5, price: 1, netAmount: 40 });
        // p2: two sales, both inside the window. I3 has no netAmount (synced
        // before the field existed) → revenue falls back to its totalExclVat,
        // which is computed as 85% of price × quantity: 2 × 1 × 0.85 = 1.7.
        await models.sale.create({ invoiceNumber: 'I3', lineItemId: 'L3', lineKey: 'L3', channelId: channel.id, date: new Date('2026-01-10'), productId: p2.id, quantity: 2, price: 1 });
        await models.sale.create({ invoiceNumber: 'I4', lineItemId: 'L4', lineKey: 'L4', channelId: channel.id, date: new Date('2026-03-10'), productId: p2.id, quantity: 3, price: 1, netAmount: 25 });

        const byId = new Map((await loadSaleAggregates(windowStart)).map((a) => [a.productId, a]));

        // p1: the 100-unit sale predates the window and is excluded from units
        // AND revenue; first sale is still the old date.
        expect(num(byId.get(p1.id)!.unitsLast365)).toBe(5);
        expect(num(byId.get(p1.id)!.revenueLast365)).toBe(40);
        expect(byId.get(p1.id)!.firstSaleDate!.getTime()).toBeLessThan(windowStart.getTime());
        // p2: both sales counted; revenue = totalExclVat fallback + netAmount.
        expect(num(byId.get(p2.id)!.unitsLast365)).toBe(5);
        expect(num(byId.get(p2.id)!.revenueLast365)).toBeCloseTo(26.7, 6);
        expect(byId.get(p2.id)!.firstSaleDate!.getTime()).toBeGreaterThanOrEqual(windowStart.getTime());
    });
});

describe('classifyAbc', () => {
    // All long-established (months active capped at 12), so raw revenues map
    // straight onto run-rate shares and the expected cuts are easy to read.
    const LONG_AGO = new Date('2020-01-01T00:00:00Z');
    const revs = (...pairs: Array<[string, number]>) =>
        pairs.map(([productId, revenueLast365]) => ({ productId, revenueLast365, firstSaleDate: LONG_AGO }));

    test('cuts A/B/C at 80% and 95% of the cumulative run-rate', () => {
        // Shares sit clear of the exact cut points (b starts at 82%, c at 96%)
        // — ÷ months active makes the shares float-derived, so exact-boundary
        // behaviour is pinned by the equal-run-rates test below instead.
        const classes = classifyAbc(revs(['a', 820], ['b', 140], ['c', 40]), NOW);
        expect(classes.get('a')).toBe(AbcClass.A);
        expect(classes.get('b')).toBe(AbcClass.B);
        expect(classes.get('c')).toBe(AbcClass.C);
    });

    test('a recently launched product is graded on its run-rate, not raw window revenue', () => {
        // "old" took 1200 over a full year → 100/month. "fresh" launched two
        // months ago and took 900 → ~450/month. Raw window revenue would rank
        // old first; run-rate puts fresh on top (~82% share → old starts in B).
        const twoMonthsAgo = new Date(NOW.getTime() - 61 * 24 * 60 * 60 * 1000);
        const classes = classifyAbc(
            [
                { productId: 'old', revenueLast365: 1200, firstSaleDate: LONG_AGO },
                { productId: 'fresh', revenueLast365: 900, firstSaleDate: twoMonthsAgo },
            ],
            NOW,
        );
        expect(classes.get('fresh')).toBe(AbcClass.A);
        expect(classes.get('old')).toBe(AbcClass.B);
    });

    test('the product crossing a boundary keeps the higher class', () => {
        // The top product alone is 85% of the run-rate — still A, not demoted to
        // B for crossing the 80% line. The next starts at 85% → B; last at 96% → C.
        const classes = classifyAbc(revs(['big', 850], ['mid', 110], ['tail', 40]), NOW);
        expect(classes.get('big')).toBe(AbcClass.A);
        expect(classes.get('mid')).toBe(AbcClass.B);
        expect(classes.get('tail')).toBe(AbcClass.C);
    });

    test('a single selling product is A', () => {
        expect(classifyAbc(revs(['only', 10]), NOW).get('only')).toBe(AbcClass.A);
    });

    test('equal run-rates split deterministically at the boundaries', () => {
        // 10 equal products: the first 8 fill 0–80% → A; the 9th and 10th start
        // at 80% and 90% → B. Ties rank by product id, so reruns agree.
        const classes = classifyAbc(revs(...Array.from({ length: 10 }, (_, i) => [`p${i}`, 100] as [string, number])), NOW);
        expect([...classes.values()].filter((c) => c === AbcClass.A)).toHaveLength(8);
        expect(classes.get('p8')).toBe(AbcClass.B);
        expect(classes.get('p9')).toBe(AbcClass.B);
    });

    test('products with zero or negative window revenue are left unclassified', () => {
        const classes = classifyAbc(revs(['sold', 100], ['dormant', 0], ['refunded', -50]), NOW);
        expect(classes.get('sold')).toBe(AbcClass.A);
        expect(classes.has('dormant')).toBe(false);
        expect(classes.has('refunded')).toBe(false);
    });

    test('no positive revenue at all → nothing classified', () => {
        expect(classifyAbc(revs(['x', 0]), NOW).size).toBe(0);
        expect(classifyAbc([], NOW).size).toBe(0);
    });
});

describe('round1', () => {
    test('rounds to one decimal place', () => {
        expect(round1(12.6667)).toBe(12.7);
        expect(round1(14.64)).toBe(14.6);
        expect(round1(22)).toBe(22);
    });
});

describe('computeStockCover', () => {
    test('cover = stock ÷ whole estimate to 1 dp; total cover adds stock on way', () => {
        // 76 / 6 = 12.6667 → 12.7 ; (76 + 12) / 6 = 14.6667 → 14.7
        expect(computeStockCover(76, 12, 6)).toEqual({ current: 12.7, total: 14.7 });
        // exact division stays clean, and with no stock on way total equals current
        expect(computeStockCover(22, 0, 1)).toEqual({ current: 22, total: 22 });
    });

    test('null cover when the estimate is 0/unknown or stock is unknown (blank, like the sheet)', () => {
        expect(computeStockCover(20, 0, 0)).toEqual({ current: null, total: null });
        expect(computeStockCover(20, 0, null)).toEqual({ current: null, total: null });
        expect(computeStockCover(null, 0, 5)).toEqual({ current: null, total: null });
    });

    test('negative stock (billed ahead of stock) yields negative cover', () => {
        // -3 / 2 = -1.5
        expect(computeStockCover(-3, 0, 2)).toEqual({ current: -1.5, total: -1.5 });
    });
});

describe('Product stockCoverStatus (computed enum)', () => {
    beforeEach(resetDatabase);

    // leadTimeInDays / 30 = lead time L (months). Bands: cover < L → Shortfall
    // (red); [L, 1.5L) → Low (amber); [1.5L, 2.5L) → Good (green); ≥ 2.5L →
    // Oversupply (purple).
    async function makeProduct(sku: string, cover: number | null, leadTimeInDays = 60) {
        const brand = await models.brand.create({ name: `B-${sku}`, leadTimeInDays });
        const product = await models.product.create({ name: sku, sku, brandId: brand.id, currentStockCover: cover });
        return { product, brand };
    }
    const statusOf = async (id: string) => (await models.product.findOne({ id }))!.stockCoverStatus;

    test('grades cover into the four bands (60d lead → L=2, 1.5L=3, 2.5L=5)', async () => {
        expect(await statusOf((await makeProduct('ST-1', 1)).product.id)).toBe(StockCoverStatus.InsufficientSupply); // < 2
        expect(await statusOf((await makeProduct('ST-2', 2.25)).product.id)).toBe(StockCoverStatus.LowSupply); // [2, 3)
        expect(await statusOf((await makeProduct('ST-3', 4)).product.id)).toBe(StockCoverStatus.GoodSupply); // [3, 5)
        expect(await statusOf((await makeProduct('ST-4', 6)).product.id)).toBe(StockCoverStatus.Oversupply); // ≥ 5
    });

    // Each boundary belongs to the band above it, so a product sitting exactly on
    // the lead time isn't a Shortfall and exactly 2.5L isn't still Good.
    test('band boundaries are inclusive at the lower edge (60d lead)', async () => {
        expect(await statusOf((await makeProduct('ST-B1', 2)).product.id)).toBe(StockCoverStatus.LowSupply); // L
        expect(await statusOf((await makeProduct('ST-B2', 2.9)).product.id)).toBe(StockCoverStatus.LowSupply);
        expect(await statusOf((await makeProduct('ST-B3', 3)).product.id)).toBe(StockCoverStatus.GoodSupply); // 1.5L
        expect(await statusOf((await makeProduct('ST-B4', 4.9)).product.id)).toBe(StockCoverStatus.GoodSupply);
        expect(await statusOf((await makeProduct('ST-B5', 5)).product.id)).toBe(StockCoverStatus.Oversupply); // 2.5L
    });

    test('negative cover is Shortfall; unknown cover is null', async () => {
        expect(await statusOf((await makeProduct('ST-5', -1.5)).product.id)).toBe(StockCoverStatus.InsufficientSupply);
        expect(await statusOf((await makeProduct('ST-6', null)).product.id)).toBeNull();
    });

    test('re-grades when the brand lead time changes', async () => {
        // 3mo cover at a 2mo lead (L=2) → 3 ∈ [3, 5) → Good.
        const { product, brand } = await makeProduct('ST-7', 3, 60);
        expect(await statusOf(product.id)).toBe(StockCoverStatus.GoodSupply);
        // Stretch the lead time to 120 days (4mo): 3mo cover < 4 → Shortfall.
        await models.brand.update({ id: brand.id }, { leadTimeInDays: 120 });
        expect(await statusOf(product.id)).toBe(StockCoverStatus.InsufficientSupply);
    });
});
