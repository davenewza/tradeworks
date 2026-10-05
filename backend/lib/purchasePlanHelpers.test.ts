import { models, resetDatabase } from '@teamkeel/testing';
import { AbcClass, Currency, StockCoverStatus } from '@teamkeel/sdk';
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
    loadPlannableSuppliers,
    loadSupplierPrices,
    parseDay,
    pickSupplierPrice,
    planLine,
} from './purchasePlanHelpers';
import { describeReason, formatDate, formatMoney, summaryRows, toGridRow } from './purchasePlanFormat';

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
        currency: Currency.ZAR,
        costSource: 'PriceList',
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
        expect(plan.summary.valueByCurrency).toEqual([{ currency: Currency.ZAR, value: 4000 }]);
        expect(plan.summary.linesWithoutCost).toBe(1);
        expect(plan.summary.stockouts).toBe(0);
        expect(plan.summary.arrival.toISOString()).toBe('2026-11-03T00:00:00.000Z');
    });

    test('values are totalled per currency, never added across them, largest first', () => {
        const pounds = candidate({ productId: 'gbp', sku: 'GBP', currency: Currency.GBP, unitCost: 10 });
        const dollars = candidate({ productId: 'usd', sku: 'USD', currency: Currency.USD, unitCost: 2, stockAvailable: 0 });
        const billed = candidate({ productId: 'bill', sku: 'BILL', unitCost: 100, costSource: 'LastBill' });
        const plan = buildPurchasePlan([pounds, dollars, billed], PARAMS);

        // 80 × £10, 120 × $2 (out of stock: full 4-month target), 80 × R100.
        expect(plan.summary.valueByCurrency).toEqual([
            { currency: Currency.ZAR, value: 8000 },
            { currency: Currency.GBP, value: 800 },
            { currency: Currency.USD, value: 240 },
        ]);
        expect(plan.summary.linesCostedFromBills).toBe(1);

        const value = summaryRows(plan, PARAMS).find((r) => r.key.startsWith('Goods value'))!.value;
        expect(value).toBe('R 8,000.00 + £800.00 + $240.00');
        expect(summaryRows(plan, PARAMS).find((r) => r.key === 'Costed from last bill')!.value).toMatch(/^1 line/);
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
        expect(formatMoney(1234.5, Currency.ZAR)).toBe('R 1,234.50');
        expect(formatMoney(1234.5, Currency.GBP)).toBe('£1,234.50');
        expect(formatMoney(0.5, Currency.USD)).toBe('$0.50');

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

        // A price list's price shows in its own currency; a last-bill stand-in says so.
        expect(toGridRow(planLine(candidate({ currency: Currency.USD, unitCost: 2 }), PARAMS), arrival).value).toBe('$160.00');
        expect(toGridRow(planLine(candidate({ costSource: 'LastBill' }), PARAMS), arrival).value).toBe('R 4,000.00 (last bill)');
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
    const bill = (billNumber: string, date: Date | null) =>
        models.supplierBill.create({ zohoBillId: `zb-${billNumber}`, billNumber, date, zohoModifiedAt: NOW });
    let lineCount = 0;
    const billLine = (supplierBillId: string, productId: string, unitCost: number, quantity: number) =>
        models.supplierBillLine.create({ supplierBillId, productId, unitCost, quantity, zohoLineItemId: `li-${++lineCount}`, position: lineCount });
    let listCount = 0;
    // A product's supplier is the supplier of a price list it is on.
    const priceList = (name: string, currencyCode: string, modifiedAt: string, supplierId: string | null = null, isActive = true) =>
        models.supplierPriceList.create({ zohoPriceListId: `zpl-${++listCount}`, name, currencyCode, supplierId, isActive, zohoModifiedAt: new Date(modifiedAt) });
    const price = (priceListId: string, productId: string, rate: number | null) =>
        models.supplierPriceListItem.create({ priceListId, productId, rate, zohoItemId: `zi-${productId}` });
    const product = (sku: string, brandId: string, values: Record<string, unknown> = {}) =>
        models.product.create({ name: sku, sku, brandId, ...values });

    test('loadPlannableSuppliers lists suppliers with active products on their lists, with their lead times and counts', async () => {
        const brand = await models.brand.create({ name: 'Acme' });
        const acme = await models.supplier.create({ name: 'Acme Ltd', leadTimeInDays: 45 });
        const zeta = await models.supplier.create({ name: 'Zeta' });
        const empty = await models.supplier.create({ name: 'Empty' });
        const acmeZar = await priceList('Acme', 'ZAR', '2026-09-01T10:00:00Z', acme.id);
        const acmeGbp = await priceList('Acme (GBP)', 'GBP', '2026-09-01T10:00:00Z', acme.id);
        const a1 = await product('A1', brand.id);
        await price(acmeZar.id, a1.id, 1);
        // On both of Acme's lists, but one product.
        await price(acmeGbp.id, a1.id, 1);
        await price(acmeZar.id, (await product('A2', brand.id)).id, 1);
        await price(acmeZar.id, (await product('A3', brand.id, { isActive: false })).id, 1);
        await price((await priceList('Zeta', 'ZAR', '2026-09-01T10:00:00Z', zeta.id)).id, (await product('Z1', brand.id)).id, 1);
        // A supplier whose list carries nothing active has nothing to plan.
        await price((await priceList('Empty', 'ZAR', '2026-09-01T10:00:00Z', empty.id)).id, (await product('E1', brand.id, { isActive: false })).id, 1);
        // A list linked to no supplier puts its products in no supplier's plan.
        await price((await priceList('Unlinked', 'ZAR', '2026-09-01T10:00:00Z')).id, (await product('N1', brand.id)).id, 1);

        expect(await loadPlannableSuppliers()).toEqual([
            { supplierId: acme.id, name: 'Acme Ltd', leadTimeInDays: 45, productCount: 2 },
            { supplierId: zeta.id, name: 'Zeta', leadTimeInDays: 60, productCount: 1 },
        ]);
    });

    test('loadPlanCandidates builds each active product of the supplier with an unrounded rate and its cost', async () => {
        const brand = await models.brand.create({ name: 'Acme' });
        const acme = await models.supplier.create({ name: 'Acme Ltd', currency: Currency.GBP });
        const other = await models.supplier.create({ name: 'Other' });
        const channel = await models.channel.create({ name: 'Shop' });

        // Brand and supplier are independent: a second brand bought from the
        // same supplier is in the same plan.
        const otherBrand = await models.brand.create({ name: 'Bolt' });
        const widget = await models.product.create({
            name: 'Widget', sku: 'W-1', brandId: brand.id, stockAvailable: 40, abcClass: AbcClass.B,
        });
        const trickle = await models.product.create({ name: 'Trickle', sku: 'T-1', brandId: otherBrand.id, stockAvailable: 3 });
        const dormant = await models.product.create({ name: 'Dormant', sku: 'D-1', brandId: brand.id });
        const retired = await models.product.create({ name: 'Retired', sku: 'R-1', brandId: brand.id, isActive: false });
        const elsewhere = await models.product.create({ name: 'Elsewhere', sku: 'E-1', brandId: brand.id, stockAvailable: 9 });

        // Acme's rand list carries Widget and Trickle with no rate (volume
        // pricing, say) and Retired; its pound list prices Dormant. Other's
        // list prices Dormant too, which Acme's plan mustn't use.
        const acmeZar = await priceList('Acme', 'ZAR', '2026-09-01T10:00:00Z', acme.id);
        for (const p of [widget, trickle, retired]) await price(acmeZar.id, p.id, null);
        await price((await priceList('Acme (GBP)', 'GBP', '2026-09-01T10:00:00Z', acme.id)).id, dormant.id, 7.25);
        const otherList = await priceList('Other', 'GBP', '2026-10-01T10:00:00Z', other.id);
        await price(otherList.id, dormant.id, 6);
        await price(otherList.id, elsewhere.id, 3);

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

        // Widget has no rate on Acme's lists, so it falls back to its bills:
        // the later one's cost wins, regardless of insert order. Dormant has a
        // rate on Acme's list, which wins over its bill.
        const newer = await bill('B-2', new Date('2026-05-01'));
        const older = await bill('B-1', new Date('2025-01-01'));
        await billLine(newer.id, widget.id, 55, 100);
        await billLine(older.id, widget.id, 40, 100);
        await billLine(newer.id, dormant.id, 140, 10);

        const candidates = await loadPlanCandidates(acme.id, NOW);

        expect(candidates.map((c) => c.sku)).toEqual(['D-1', 'T-1', 'W-1']);
        const byId = new Map(candidates.map((c) => [c.productId, c]));

        expect(byId.get(widget.id)).toMatchObject({
            sku: 'W-1', name: 'Widget', abcClass: AbcClass.B, stockAvailable: 40, stockOnWay: 0,
            unitCost: 55, currency: Currency.ZAR, costSource: 'LastBill',
        });
        expect(byId.get(widget.id)!.monthlyDemand).toBeCloseTo(10, 6);
        expect(byId.get(trickle.id)!.monthlyDemand).toBeCloseTo(5 / 12, 6);
        expect(byId.get(trickle.id)).toMatchObject({ unitCost: null, currency: null, costSource: null });
        expect(byId.get(dormant.id)).toMatchObject({
            monthlyDemand: null, stockAvailable: null, abcClass: null,
            unitCost: 7.25, currency: Currency.GBP, costSource: 'PriceList',
        });
    });

    test("loadSupplierPrices reads rates on the supplier's active lists only, and skips items with no rate", async () => {
        const brand = await models.brand.create({ name: 'Acme' });
        const acme = await models.supplier.create({ name: 'Acme Ltd' });
        const other = await models.supplier.create({ name: 'Other' });
        const widget = await models.product.create({ name: 'Widget', sku: 'W-1', brandId: brand.id });
        const gadget = await models.product.create({ name: 'Gadget', sku: 'G-1', brandId: brand.id });
        const current = await priceList('Current', 'GBP', '2026-09-01T10:00:00Z', acme.id);
        const retired = await priceList('Retired', 'GBP', '2026-08-01T10:00:00Z', acme.id, false);
        const volume = await priceList('Volume', 'USD', '2026-08-01T10:00:00Z', acme.id);
        const theirs = await priceList('Theirs', 'GBP', '2026-10-01T10:00:00Z', other.id);
        await price(current.id, widget.id, 12.85);
        await price(retired.id, widget.id, 11);
        await price(volume.id, widget.id, null);
        await price(theirs.id, widget.id, 10);
        await price(current.id, gadget.id, 124.75);

        const prices = await loadSupplierPrices(acme.id, [widget.id]);

        expect([...prices.keys()]).toEqual([widget.id]);
        expect(prices.get(widget.id)).toEqual([
            { rate: 12.85, currencyCode: 'GBP', priceListName: 'Current', priceListModifiedAt: new Date('2026-09-01T10:00:00Z') },
        ]);
        expect(await loadSupplierPrices(acme.id, [])).toEqual(new Map());
    });

    test('loadPlanCandidates is empty for a supplier with nothing active', async () => {
        const brand = await models.brand.create({ name: 'Bare' });
        const supplier = await models.supplier.create({ name: 'Bare Ltd' });
        await price((await priceList('Bare', 'ZAR', '2026-09-01T10:00:00Z', supplier.id)).id, (await product('OFF', brand.id, { isActive: false })).id, 1);
        expect(await loadPlanCandidates(supplier.id, NOW)).toEqual([]);
        expect(await loadPlanCandidates((await models.supplier.create({ name: 'No lists' })).id, NOW)).toEqual([]);
    });

    test('loadLatestUnitCosts puts undated bills last and handles an empty request', async () => {
        const brand = await models.brand.create({ name: 'Acme' });
        const product = await models.product.create({ name: 'P', sku: 'P', brandId: brand.id });
        const undated = await bill('U', null);
        const dated = await bill('D', new Date('2024-01-01'));
        await billLine(undated.id, product.id, 99, 1);
        await billLine(dated.id, product.id, 12, 1);

        expect(await loadLatestUnitCosts([product.id])).toEqual(new Map([[product.id, 12]]));
        expect(await loadLatestUnitCosts([])).toEqual(new Map());
    });

    test('loadLatestUnitCosts weights a product split over two lines of its latest bill', async () => {
        const brand = await models.brand.create({ name: 'Acme' });
        const product = await models.product.create({ name: 'P', sku: 'P', brandId: brand.id });
        const older = await bill('OLD', new Date('2024-01-01'));
        const latest = await bill('NEW', new Date('2025-01-01'));
        await billLine(older.id, product.id, 99, 10);
        // 30 @ 10 and 10 @ 14 → (300 + 140) / 40 = 11.
        await billLine(latest.id, product.id, 10, 30);
        await billLine(latest.id, product.id, 14, 10);

        expect(await loadLatestUnitCosts([product.id])).toEqual(new Map([[product.id, 11]]));
    });
});

describe('pickSupplierPrice', () => {
    const row = (priceListName: string, currencyCode: string, rate: number, modified: string) => ({
        rate,
        currencyCode,
        priceListName,
        priceListModifiedAt: new Date(modified),
    });

    test("takes the only list a product is on, whatever the supplier's currency", () => {
        expect(pickSupplierPrice([row('Farnell (GBP)', 'GBP', 12.85, '2026-10-05')], Currency.ZAR)).toEqual({ rate: 12.85, currency: Currency.GBP });
    });

    test("prefers a list in the supplier's own currency, then the most recently changed", () => {
        const rows = [
            row('Farnell (ZAR)', 'ZAR', 300, '2026-10-01'),
            row('Farnell (GBP) old', 'GBP', 12, '2026-01-01'),
            row('Farnell (GBP)', 'GBP', 12.85, '2026-10-05'),
        ];
        expect(pickSupplierPrice(rows, Currency.GBP)).toEqual({ rate: 12.85, currency: Currency.GBP });
        expect(pickSupplierPrice(rows, Currency.ZAR)).toEqual({ rate: 300, currency: Currency.ZAR });
        // No list in the supplier's currency: the newest list wins.
        expect(pickSupplierPrice(rows, Currency.USD)).toEqual({ rate: 12.85, currency: Currency.GBP });
    });

    test('breaks a tie on the list name, so the pick never varies between runs', () => {
        const rows = [row('B list', 'GBP', 2, '2026-10-05'), row('A list', 'GBP', 1, '2026-10-05')];
        expect(pickSupplierPrice(rows, null)).toEqual({ rate: 1, currency: Currency.GBP });
        expect(pickSupplierPrice([...rows].reverse(), null)).toEqual({ rate: 1, currency: Currency.GBP });
    });

    test("passes over a list in a currency the plan can't show, and gives nothing for no lists", () => {
        expect(pickSupplierPrice([row('Yen', 'JPY', 1000, '2026-10-05')], null)).toBeNull();
        expect(pickSupplierPrice([], Currency.GBP)).toBeNull();
    });
});
