import { models, resetDatabase } from '@teamkeel/testing';
import { AbcClass, StockCoverStatus } from '@teamkeel/sdk';
import { beforeEach, describe, expect, test } from 'vitest';
import {
    DAYS_PER_MONTH,
    PlanCandidate,
    PurchasePlanParams,
    addDays,
    arrivalDate,
    buildPurchasePlan,
    coverHorizon,
    coverStatus,
    daysBetween,
    defaultTargetCoverMonths,
    loadLatestUnitCosts,
    loadPlanCandidates,
    loadPlannableBrands,
    parseDay,
    planLine,
} from './purchasePlanHelpers';
import { describeReason, formatDate, formatRand, toGridRow } from './purchasePlanFormat';

const TODAY = new Date('2026-09-04T00:00:00Z');

// The default scenario: order today, 60-day lead time, land with 4 months of
// cover (2 × the lead time, the middle of the Good band).
const PARAMS: PurchasePlanParams = {
    today: TODAY,
    purchaseDate: TODAY,
    leadTimeInDays: 60,
    targetCoverMonths: 4,
};

// A steady seller: 30 a month. Stock and cost vary per test.
function candidate(overrides: Partial<PlanCandidate> = {}): PlanCandidate {
    return {
        productId: 'p1',
        sku: 'SKU-1',
        name: 'Widget',
        abcClass: AbcClass.A,
        stockAvailable: 100,
        stockOnWay: 0,
        monthlyDemand: 30,
        unitCost: 50,
        ...overrides,
    };
}

describe('dates and defaults', () => {
    test('parseDay accepts a plain day or a full timestamp and pins it to UTC midnight', () => {
        expect(parseDay('2026-09-04')!.toISOString()).toBe('2026-09-04T00:00:00.000Z');
        expect(parseDay('2026-09-04T13:45:00.000Z')!.toISOString()).toBe('2026-09-04T00:00:00.000Z');
        expect(parseDay('')).toBeNull();
        expect(parseDay('not a date')).toBeNull();
        expect(parseDay(undefined)).toBeNull();
    });

    test('arrival is purchase + lead time; the horizon is arrival + the target cover', () => {
        expect(arrivalDate(PARAMS).toISOString()).toBe('2026-11-03T00:00:00.000Z');
        // 4 months × 30.4375 days = 121.75 days after arrival.
        expect(daysBetween(arrivalDate(PARAMS), coverHorizon(PARAMS))).toBeCloseTo(4 * DAYS_PER_MONTH, 6);
    });

    test('the default target is 2 × the lead time in months — the middle of the Good band', () => {
        expect(defaultTargetCoverMonths(60)).toBe(4);
        expect(defaultTargetCoverMonths(45)).toBe(3);
        expect(defaultTargetCoverMonths(30)).toBe(2);
        expect(defaultTargetCoverMonths(100)).toBe(6.7);
    });

    test('coverStatus mirrors the schema bands against the lead time', () => {
        // L = 2 months: Shortfall < 2 · Low 2–3 · Good 3–5 · Oversupply ≥ 5.
        expect(coverStatus(1.9, 60)).toBe(StockCoverStatus.InsufficientSupply);
        expect(coverStatus(2, 60)).toBe(StockCoverStatus.LowSupply);
        expect(coverStatus(2.9, 60)).toBe(StockCoverStatus.LowSupply);
        expect(coverStatus(3, 60)).toBe(StockCoverStatus.GoodSupply);
        expect(coverStatus(4.9, 60)).toBe(StockCoverStatus.GoodSupply);
        expect(coverStatus(5, 60)).toBe(StockCoverStatus.Oversupply);
        expect(coverStatus(null, 60)).toBeNull();
    });
});

describe('planLine', () => {
    test('orders the difference between the target and what will be left when the order lands', () => {
        const line = planLine(candidate(), PARAMS);

        // 30/month is 0.9856/day; 60 days of that is 59.14 units, leaving
        // 40.86 of the 100 on the shelf on arrival. Target is 4 × 30 = 120.
        expect(line.demandToArrival).toBeCloseTo(59.14, 2);
        expect(line.projectedAtArrival).toBeCloseTo(40.86, 2);
        expect(line.suggestedQuantity).toBe(80); // ceil(120 − 40.86)
        expect(line.orderQuantity).toBe(80);
        expect(line.reason).toBe('Reorder');
        // 100 units at 0.9856/day run out ~101 days from today — after arrival
        // (day 60) but before the horizon (day 182), hence the reorder.
        expect(daysBetween(TODAY, line.runsOutOn!)).toBeCloseTo(101.5, 0);
        // Lands with (40.86 + 80) / 30 = 4.03 months → 4.0, in the Good band.
        expect(line.coverAtArrivalMonths).toBe(4);
        expect(line.statusAtArrival).toBe(StockCoverStatus.GoodSupply);
        expect(line.lineValue).toBe(4000);
    });

    test('a product that sells out in transit is ordered to the full target, not for the lost sales', () => {
        // 20 units at 30/month is gone in ~20 days; the order lands on day 60.
        const line = planLine(candidate({ stockAvailable: 20 }), PARAMS);

        expect(line.reason).toBe('StockoutBeforeArrival');
        expect(daysBetween(TODAY, line.runsOutOn!)).toBeCloseTo(20.3, 1);
        expect(line.projectedAtArrival).toBeLessThan(0);
        // The 40 days of sales with nothing on the shelf are lost, not
        // deferred — buying for them would overshoot the target.
        expect(line.suggestedQuantity).toBe(120);
        expect(line.coverAtArrivalMonths).toBe(4);
    });

    test('negative stock is a backorder: those units are added on top of the target', () => {
        const line = planLine(candidate({ stockAvailable: -3 }), PARAMS);

        expect(line.reason).toBe('StockoutBeforeArrival');
        expect(line.runsOutOn!.getTime()).toBe(TODAY.getTime());
        expect(line.suggestedQuantity).toBe(123);
        // The 3 owed units leave (123 − 3) / 30 = 4 months on the shelf.
        expect(line.coverAtArrivalMonths).toBe(4);
    });

    test('a product already covered past the horizon gets nothing', () => {
        const line = planLine(candidate({ stockAvailable: 500 }), PARAMS);

        expect(line.reason).toBe('Covered');
        expect(line.suggestedQuantity).toBe(0);
        expect(line.orderQuantity).toBe(0);
        expect(line.lineValue).toBe(0);
        // 440.86 left on arrival ÷ 30 = 14.7 months — oversupplied.
        expect(line.coverAtArrivalMonths).toBe(14.7);
        expect(line.statusAtArrival).toBe(StockCoverStatus.Oversupply);
    });

    test('a product with no forecast is left at zero with no cover figures', () => {
        const line = planLine(candidate({ monthlyDemand: null, stockAvailable: 5 }), PARAMS);

        expect(line.reason).toBe('NoForecast');
        expect(line.suggestedQuantity).toBe(0);
        expect(line.runsOutOn).toBeNull();
        expect(line.coverAtArrivalMonths).toBeNull();
        expect(line.coveredUntil).toBeNull();
        expect(line.statusAtArrival).toBeNull();
        // The buyer can still order some by hand, and the value follows.
        expect(planLine(candidate({ monthlyDemand: null }), PARAMS, 10).orderQuantity).toBe(10);
        expect(planLine(candidate({ monthlyDemand: null }), PARAMS, 10).lineValue).toBe(500);
    });

    test('a product with no stock reading is planned as empty and flagged, not treated as stocked out', () => {
        const line = planLine(candidate({ stockAvailable: null }), PARAMS);

        expect(line.reason).toBe('StockUnknown');
        expect(line.stockPosition).toBe(0);
        expect(line.suggestedQuantity).toBe(120);
    });

    test('stock on the way counts towards the position', () => {
        const withOnWay = planLine(candidate({ stockAvailable: 50, stockOnWay: 50 }), PARAMS);
        const onHandOnly = planLine(candidate({ stockAvailable: 100 }), PARAMS);
        expect(withOnWay.suggestedQuantity).toBe(onHandOnly.suggestedQuantity);
    });

    test('a purchase date in the future adds the wait to the depletion before arrival', () => {
        // Ordering in 10 days: 70 days of sales come off the shelf before the
        // order lands — another 9.86 units — so 120 − (100 − 68.99) = 88.99 → 89.
        const later = planLine(candidate(), { ...PARAMS, purchaseDate: addDays(TODAY, 10) });
        const now = planLine(candidate(), PARAMS);
        expect(later.demandToArrival).toBeCloseTo(now.demandToArrival + 10 * (30 / DAYS_PER_MONTH), 6);
        expect(later.suggestedQuantity).toBe(89);
        expect(now.suggestedQuantity).toBe(80);
    });

    test('a quantity override keeps the suggestion and re-derives the cover from the new quantity', () => {
        const line = planLine(candidate(), PARAMS, 40);

        expect(line.suggestedQuantity).toBe(80);
        expect(line.orderQuantity).toBe(40);
        // (40.86 + 40) / 30 = 2.7 months: below the 3-month Good floor.
        expect(line.coverAtArrivalMonths).toBe(2.7);
        expect(line.statusAtArrival).toBe(StockCoverStatus.LowSupply);
        expect(line.lineValue).toBe(2000);
    });

    test('a missing unit cost leaves the value unknown rather than zero', () => {
        expect(planLine(candidate({ unitCost: null }), PARAMS).lineValue).toBeNull();
    });
});

describe('buildPurchasePlan', () => {
    // Three products with very different rates and stock: after the plan, all
    // three stay in stock until the same date. This is the point of the whole
    // exercise — no top-up order for whichever one would have run out first.
    const fast = candidate({ productId: 'fast', sku: 'FAST', name: 'Fast', monthlyDemand: 120, stockAvailable: 90 });
    const slow = candidate({ productId: 'slow', sku: 'SLOW', name: 'Slow', monthlyDemand: 2.5, stockAvailable: 8 });
    const steady = candidate({ productId: 'steady', sku: 'STDY', name: 'Steady', monthlyDemand: 30, stockAvailable: 100 });

    test('every ordered product lands with the target cover and stays in stock to the same horizon', () => {
        const plan = buildPurchasePlan([slow, fast, steady], PARAMS);
        const horizon = coverHorizon(PARAMS).getTime();

        for (const line of plan.lines) {
            expect(line.orderQuantity).toBeGreaterThan(0);
            // Whole units round the cover up, never down …
            expect(line.coveredUntil!.getTime()).toBeGreaterThanOrEqual(horizon - 1);
            // … by less than one unit's worth of days.
            const oneUnitDays = DAYS_PER_MONTH / line.monthlyDemand!;
            expect(daysBetween(coverHorizon(PARAMS), line.coveredUntil!)).toBeLessThan(oneUnitDays);
        }
        // A slow seller isn't zeroed out: 8 on hand covers ~97 days (past
        // arrival, short of the horizon), so it still needs a few.
        const slowLine = plan.lines.find((l) => l.productId === 'slow')!;
        expect(slowLine.reason).toBe('Reorder');
        expect(slowLine.suggestedQuantity).toBe(7); // ceil(10 − (8 − 4.93))
        expect(plan.summary.shortOfHorizon).toEqual([]);
    });

    test('orders the products in trouble first, then the rest', () => {
        const out = candidate({ productId: 'out', sku: 'OUT', name: 'Out', stockAvailable: 0 });
        const soon = candidate({ productId: 'soon', sku: 'SOON', name: 'Soon', stockAvailable: 20 });
        const covered = candidate({ productId: 'cov', sku: 'COV', name: 'Aardvark', stockAvailable: 900 });
        const blank = candidate({ productId: 'blank', sku: 'BLNK', name: 'Blank', monthlyDemand: null });
        const unknown = candidate({ productId: 'unk', sku: 'UNK', name: 'Unknown', stockAvailable: null });

        const plan = buildPurchasePlan([covered, blank, steady, soon, unknown, out], PARAMS);

        expect(plan.lines.map((l) => l.productId)).toEqual(['out', 'soon', 'steady', 'unk', 'blank', 'cov']);
    });

    test('totals count only what is being ordered, and say when a value is incomplete', () => {
        const uncosted = candidate({ productId: 'nc', sku: 'NC', name: 'No cost', unitCost: null });
        const plan = buildPurchasePlan([steady, uncosted, candidate({ productId: 'cov', stockAvailable: 900 })], PARAMS);

        expect(plan.summary.products).toBe(3);
        expect(plan.summary.linesToOrder).toBe(2);
        expect(plan.summary.totalUnits).toBe(160);
        expect(plan.summary.totalValue).toBe(4000);
        expect(plan.summary.linesWithoutCost).toBe(1);
        expect(plan.summary.stockouts).toBe(0);
        expect(plan.summary.arrival.toISOString()).toBe('2026-11-03T00:00:00.000Z');
    });

    test('a trimmed quantity that no longer reaches the horizon is called out as a top-up risk', () => {
        const plan = buildPurchasePlan([fast, steady], PARAMS, { fast: 100 });

        expect(plan.summary.shortOfHorizon.map((l) => l.productId)).toEqual(['fast']);
        const trimmed = plan.lines.find((l) => l.productId === 'fast')!;
        expect(trimmed.orderQuantity).toBe(100);
        expect(trimmed.coveredUntil!.getTime()).toBeLessThan(coverHorizon(PARAMS).getTime());
    });

    test('an override of zero is a decision, not a missing value', () => {
        const plan = buildPurchasePlan([steady], PARAMS, { steady: 0 });
        expect(plan.lines[0].orderQuantity).toBe(0);
        expect(plan.summary.linesToOrder).toBe(0);
    });
});

describe('presentation', () => {
    test('dates, money and the Why column read the way the Console shows them', () => {
        expect(formatDate(new Date('2026-11-03T00:00:00Z'))).toBe('3 Nov 2026');
        expect(formatRand(1234.5)).toBe('R 1,234.50');

        const arrival = arrivalDate(PARAMS);
        const why = (c: Partial<PlanCandidate>, qty?: number) => describeReason(planLine(candidate(c), PARAMS, qty), arrival);

        expect(why({ stockAvailable: 20 })).toMatch(/^Sells out ~24 Sept? 2026, 40 day\(s\) before this order lands$/);
        expect(why({ stockAvailable: 0 })).toBe('Already out of stock — 60 day(s) of lost sales before this order lands');
        expect(why({})).toBe('Sells out ~14 Dec 2026 without this order');
        // 500 units at 0.9856/day is 507 days: well past the horizon.
        expect(why({ stockAvailable: 500 })).toBe('Already covered to ~24 Jan 2028');
        expect(why({ stockAvailable: null })).toBe('No stock reading yet — planned as if none on hand');
        expect(why({ monthlyDemand: null })).toBe('No sales in the last 12 months — type a quantity to include it');
    });

    test('grid rows carry numbers where the buyer edits and blanks where a figure is unknown', () => {
        const arrival = arrivalDate(PARAMS);
        const row = toGridRow(planLine(candidate({ unitCost: null }), PARAMS), arrival);
        expect(row).toMatchObject({ abc: 'A', sku: 'SKU-1', stock: 100, monthly: 30, suggested: 80, order: 80, value: '' });
        expect(row.cover).toBe('4.0 mo · Good');
        expect(row.coveredUntil).toMatch(/2027$/);

        const blank = toGridRow(planLine(candidate({ monthlyDemand: null, stockAvailable: null }), PARAMS), arrival);
        expect(blank).toMatchObject({ abc: 'A', stock: 0, monthly: 0, suggested: 0, order: 0, cover: '', coveredUntil: '' });
    });
});

describe('loading', () => {
    beforeEach(resetDatabase);

    const NOW = new Date('2026-09-04T12:00:00Z');
    const sale = (productId: string, channelId: string, date: string, quantity: number, n: number) =>
        models.sale.create({
            invoiceNumber: `INV-${n}`,
            lineItemId: `L${n}`,
            lineKey: `L${n}`,
            channelId,
            date: new Date(date),
            productId,
            quantity,
            price: 10,
            netAmount: quantity * 10,
        });

    test('loadPlannableBrands lists brands with enabled products, with their lead times and counts', async () => {
        const acme = await models.brand.create({ name: 'Acme', leadTimeInDays: 45 });
        const zeta = await models.brand.create({ name: 'Zeta' });
        await models.brand.create({ name: 'Empty' });
        await models.product.create({ name: 'A1', sku: 'A1', brandId: acme.id });
        await models.product.create({ name: 'A2', sku: 'A2', brandId: acme.id });
        await models.product.create({ name: 'A3', sku: 'A3', brandId: acme.id, isEnabled: false });
        await models.product.create({ name: 'Z1', sku: 'Z1', brandId: zeta.id });

        expect(await loadPlannableBrands()).toEqual([
            { brandId: acme.id, name: 'Acme', leadTimeInDays: 45, productCount: 2 },
            { brandId: zeta.id, name: 'Zeta', leadTimeInDays: 60, productCount: 1 },
        ]);
    });

    test('loadPlanCandidates builds each enabled product of the brand with an unrounded rate and its latest cost', async () => {
        const acme = await models.brand.create({ name: 'Acme' });
        const other = await models.brand.create({ name: 'Other' });
        const channel = await models.channel.create({ name: 'Shop' });

        const widget = await models.product.create({
            name: 'Widget', sku: 'W-1', brandId: acme.id, stockAvailable: 40, abcClass: AbcClass.B,
        });
        const trickle = await models.product.create({ name: 'Trickle', sku: 'T-1', brandId: acme.id, stockAvailable: 3 });
        const dormant = await models.product.create({ name: 'Dormant', sku: 'D-1', brandId: acme.id });
        await models.product.create({ name: 'Retired', sku: 'R-1', brandId: acme.id, isEnabled: false });
        await models.product.create({ name: 'Elsewhere', sku: 'E-1', brandId: other.id, stockAvailable: 9 });

        // Widget: established (first sale years ago → 12 months active), 120 in
        // the window → 10/month. An old sale outside the window doesn't count.
        await sale(widget.id, channel.id, '2022-01-01', 500, 1);
        await sale(widget.id, channel.id, '2026-03-01', 120, 2);
        // Trickle: 5 in the window over an established history → 0.4167/month,
        // which the whole-number estimate on the product would show as 0.
        await sale(trickle.id, channel.id, '2022-01-01', 1, 3);
        await sale(trickle.id, channel.id, '2026-06-01', 5, 4);
        // Dormant: only ancient sales.
        await sale(dormant.id, channel.id, '2021-01-01', 30, 5);

        // Two bills for Widget: the later one's cost wins, regardless of insert order.
        const newer = await models.supplierBill.create({ billNumber: 'B-2', date: new Date('2026-05-01') });
        const older = await models.supplierBill.create({ billNumber: 'B-1', date: new Date('2025-01-01') });
        await models.productCostLine.create({ productId: widget.id, supplierBillId: newer.id, unitCost: 55, quantity: 100, zohoRecordId: 'z2' });
        await models.productCostLine.create({ productId: widget.id, supplierBillId: older.id, unitCost: 40, quantity: 100, zohoRecordId: 'z1' });

        const candidates = await loadPlanCandidates(acme.id, NOW);

        expect(candidates.map((c) => c.sku)).toEqual(['D-1', 'T-1', 'W-1']);
        const byId = new Map(candidates.map((c) => [c.productId, c]));

        expect(byId.get(widget.id)).toMatchObject({
            sku: 'W-1', name: 'Widget', abcClass: AbcClass.B, stockAvailable: 40, stockOnWay: 0, unitCost: 55,
        });
        expect(byId.get(widget.id)!.monthlyDemand).toBeCloseTo(10, 6);
        expect(byId.get(trickle.id)!.monthlyDemand).toBeCloseTo(5 / 12, 6);
        expect(byId.get(trickle.id)!.unitCost).toBeNull();
        expect(byId.get(dormant.id)).toMatchObject({ monthlyDemand: null, stockAvailable: null, abcClass: null });
    });

    test('loadPlanCandidates is empty for a brand with nothing enabled', async () => {
        const brand = await models.brand.create({ name: 'Bare' });
        await models.product.create({ name: 'Off', sku: 'OFF', brandId: brand.id, isEnabled: false });
        expect(await loadPlanCandidates(brand.id, NOW)).toEqual([]);
    });

    test('loadLatestUnitCosts puts undated bills last and handles an empty request', async () => {
        const brand = await models.brand.create({ name: 'Acme' });
        const product = await models.product.create({ name: 'P', sku: 'P', brandId: brand.id });
        const undated = await models.supplierBill.create({ billNumber: 'U' });
        const dated = await models.supplierBill.create({ billNumber: 'D', date: new Date('2024-01-01') });
        await models.productCostLine.create({ productId: product.id, supplierBillId: undated.id, unitCost: 99, zohoRecordId: 'u' });
        await models.productCostLine.create({ productId: product.id, supplierBillId: dated.id, unitCost: 12, zohoRecordId: 'd' });

        expect(await loadLatestUnitCosts([product.id])).toEqual(new Map([[product.id, 12]]));
        expect(await loadLatestUnitCosts([])).toEqual(new Map());
    });
});
