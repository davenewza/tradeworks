import { describe, expect, test } from 'vitest';
import {
    VAT_RATE,
    toInclVat,
    toExclVat,
    landedCost,
    reduceLandedCost,
    priceFromMargin,
    priceFromInclVat,
    priceFromMarkup,
    CostLine,
    PricingInputs,
} from './pricing';

// ─── VAT helpers ──────────────────────────────────────────────────────────────

describe('VAT helpers', () => {
    test('toInclVat adds VAT and toExclVat strips it', () => {
        expect(toInclVat(100)).toBeCloseTo(115, 10);
        expect(toExclVat(115)).toBeCloseTo(100, 10);
    });

    test('are exact inverses of each other', () => {
        expect(toExclVat(toInclVat(623.27))).toBeCloseTo(623.27, 10);
    });

    test('respect a custom VAT rate', () => {
        expect(toInclVat(100, 0.2)).toBeCloseTo(120, 10);
    });
});

// ─── Landed cost across bills ─────────────────────────────────────────────────

describe('reduceLandedCost', () => {
    const lines: CostLine[] = [
        { unitCost: 100, unitFreightIn: 60, quantity: 10, date: '2021-02-19' }, // air, landed 160
        { unitCost: 100, unitFreightIn: 20, quantity: 30, date: '2024-07-29' }, // sea, landed 120
    ];

    test('landedCost sums cost of goods and freight', () => {
        expect(landedCost(lines[0])).toBe(160);
    });

    test('weighted average weights by quantity received', () => {
        // (160*10 + 120*30) / 40 = 5200/40 = 130
        expect(reduceLandedCost(lines, 'weightedAverage')).toBeCloseTo(130, 10);
    });

    test('weighted average falls back to a simple average without quantities', () => {
        const noQty = lines.map(({ quantity, ...rest }) => rest);
        // (160 + 120) / 2 = 140
        expect(reduceLandedCost(noQty, 'weightedAverage')).toBeCloseTo(140, 10);
    });

    test('latest picks the most recent bill', () => {
        expect(reduceLandedCost(lines, 'latest')).toBe(120);
    });

    test('highestFreight picks the worst-case (air) bill', () => {
        expect(reduceLandedCost(lines, 'highestFreight')).toBe(160);
    });

    test('lowestFreight picks the best-case (sea) bill', () => {
        expect(reduceLandedCost(lines, 'lowestFreight')).toBe(120);
    });

    test('defaults to weighted average', () => {
        expect(reduceLandedCost(lines)).toBe(reduceLandedCost(lines, 'weightedAverage'));
    });

    test('handles single line and empty', () => {
        expect(reduceLandedCost([lines[0]])).toBe(160);
        expect(reduceLandedCost([])).toBe(0);
    });
});

// ─── Pricing ────────────────────────────────────────────────────────────────

// The worked example from the design discussion (screenshot row 1):
// landed 253.12 (cost 193.10 + freight 60.02), fulfilment 42.00, success 11%.
const example: PricingInputs = {
    landedCost: 193.1 + 60.02,
    fulfilmentFee: 42.0,
    successRate: 0.11,
};

describe('priceFromMargin', () => {
    test('prices a 40% margin-on-revenue correctly', () => {
        const r = priceFromMargin(0.4, example);
        expect(r.feasible).toBe(true);
        expect(r.costBase).toBeCloseTo(295.12, 2);
        expect(r.priceExclVat).toBeCloseTo(623.27, 2);
        expect(r.priceInclVat).toBeCloseTo(716.76, 2);
        expect(r.successFee).toBeCloseTo(78.84, 2);
        expect(r.grossProfit).toBeCloseTo(249.31, 2);
        expect(r.grossMargin).toBeCloseTo(0.4, 6);
    });

    test('the resulting price actually yields the requested margin', () => {
        const r = priceFromMargin(0.4, example);
        // Reconstruct gross profit from first principles.
        const successFee = 0.11 * r.priceInclVat;
        const gp = r.priceExclVat - r.costBase - successFee;
        expect(gp / r.priceExclVat).toBeCloseTo(0.4, 10);
    });

    test('reports markup alongside margin', () => {
        const r = priceFromMargin(0.4, example);
        expect(r.markup).toBeCloseTo(r.grossProfit / r.costBase, 10);
    });

    test('flags an infeasible margin instead of returning a bad price', () => {
        // Retention ceiling is 1 - 0.11*1.15 = 0.8735; 0.90 is unreachable.
        const r = priceFromMargin(0.9, example);
        expect(r.feasible).toBe(false);
        expect(Number.isFinite(r.priceExclVat)).toBe(false);
    });

    test('a margin exactly at the retention ceiling is infeasible', () => {
        const ceiling = 1 - example.successRate * (1 + VAT_RATE);
        expect(priceFromMargin(ceiling, example).feasible).toBe(false);
    });
});

describe('priceFromInclVat', () => {
    test('is the inverse of priceFromMargin (two-way calculator agrees)', () => {
        const fromMargin = priceFromMargin(0.4, example);
        const fromPrice = priceFromInclVat(fromMargin.priceInclVat, example);
        expect(fromPrice.grossMargin).toBeCloseTo(0.4, 10);
        expect(fromPrice.priceExclVat).toBeCloseTo(fromMargin.priceExclVat, 8);
        expect(fromPrice.grossProfit).toBeCloseTo(fromMargin.grossProfit, 8);
    });

    test('derives a full breakdown from a chosen sale price', () => {
        const r = priceFromInclVat(716.76, example);
        expect(r.priceExclVat).toBeCloseTo(623.27, 1);
        expect(r.successFee).toBeCloseTo(78.84, 2);
        expect(r.grossMargin).toBeCloseTo(0.4, 3);
    });
});

describe('priceFromMarkup', () => {
    test('matches the cleaned old-system formula (no markup in the denominator)', () => {
        // priceExcl = costBase*(1+markup) / (1 - successRate*(1+VAT))
        const markup = 0.65;
        const r = priceFromMarkup(markup, example);
        const expected = (295.12 * (1 + markup)) / (1 - 0.11 * 1.15);
        expect(r.priceExclVat).toBeCloseTo(expected, 4);
        expect(r.markup).toBeCloseTo(markup, 6);
    });
});

// ─── Marketing (ROAS) ─────────────────────────────────────────────────────────

describe('ROAS marketing adjustor', () => {
    test('halves net profit vs gross when ROAS = 5x on a 40% gross margin', () => {
        const r = priceFromMargin(0.4, { ...example, roas: 5 });
        // Ad spend = priceExcl / 5; net margin = gross - (1/5).
        expect(r.marketingCost).toBeCloseTo(r.priceExclVat / 5, 8);
        expect(r.netProfit).toBeCloseTo(r.grossProfit - r.priceExclVat / 5, 8);
        expect(r.netMargin).toBeCloseTo(0.4 - 0.2, 6); // 20%
    });

    test('no marketing spend when ROAS is omitted or zero', () => {
        expect(priceFromMargin(0.4, example).marketingCost).toBe(0);
        expect(priceFromMargin(0.4, { ...example, roas: 0 }).marketingCost).toBe(0);
        const r = priceFromMargin(0.4, example);
        expect(r.netMargin).toBeCloseTo(r.grossMargin, 10);
    });

    test('a higher ROAS costs less marketing and lifts net margin', () => {
        const low = priceFromMargin(0.4, { ...example, roas: 3 });
        const high = priceFromMargin(0.4, { ...example, roas: 10 });
        expect(high.marketingCost).toBeLessThan(low.marketingCost);
        expect(high.netMargin).toBeGreaterThan(low.netMargin);
    });
});
