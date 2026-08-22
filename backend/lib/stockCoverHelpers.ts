import { AbcClass, useDatabase } from '@teamkeel/sdk';
import { sql } from 'kysely';

// Per-product sales rollup that feeds the monthly estimate and the ABC class.
export interface SaleAggregate {
    productId: string;
    // Units sold in the trailing cover window (last 365 days).
    unitsLast365: number;
    // Realized revenue in the same window — netAmount (net of discount, excl
    // VAT), falling back to totalExclVat for rows synced before netAmount
    // existed. Feeds the ABC class.
    revenueLast365: number;
    // Earliest sale ever for this product, used to work out months active. Null
    // only defensively — a product in this list has at least one sale.
    firstSaleDate: Date | null;
}

const MS_PER_MONTH = (365.25 / 12) * 24 * 60 * 60 * 1000;

// How long a product has been selling, first sale → now, in months. Floored at 1
// (so a brand-new product isn't annualised off a few days of data) and capped at
// 12 (the trailing window). This is the divisor agreed for "trailing 12 months ÷
// months active": a product selling 4 months divides its window units by ~4, not
// 12, so its run-rate — and therefore its cover — isn't understated.
export function monthsActive(firstSaleDate: Date | null, now: Date): number {
    if (!firstSaleDate) return 1;
    const months = (now.getTime() - firstSaleDate.getTime()) / MS_PER_MONTH;
    if (months <= 1) return 1;
    if (months >= 12) return 12;
    return months;
}

// Estimated monthly sales = units sold in the last 365 days ÷ months active.
// Returns 0 when nothing sold in the window, which drives cover to blank (null)
// downstream — matching the sheet's behaviour for dormant products.
export function estimatedMonthlySale(agg: SaleAggregate, now: Date): number {
    if (agg.unitsLast365 <= 0) return 0;
    return agg.unitsLast365 / monthsActive(agg.firstSaleDate, now);
}

// Round to one decimal place — cover is shown to 1 dp.
export function round1(value: number): number {
    return Math.round(value * 10) / 10;
}

// Months of cover from stock and the (already whole-number) monthly estimate,
// each to 1 dp. Null when the estimate is 0/unknown or stock is unknown — the
// ratio is undefined and shown blank, matching the sheet. Total cover folds in
// the units on the way.
export function computeStockCover(
    stockAvailable: number | null,
    stockOnWay: number,
    estimate: number | null,
): { current: number | null; total: number | null } {
    if (estimate === null || estimate <= 0 || stockAvailable === null) {
        return { current: null, total: null };
    }
    return {
        current: round1(stockAvailable / estimate),
        total: round1((stockAvailable + stockOnWay) / estimate),
    };
}

// One grouped pass over the Sale table: trailing-window units, trailing-window
// revenue, and first-ever sale date per product. Aggregation isn't expressible
// via the generated models API, so we drop to Kysely (raw SQL) per the
// project's DB-query convention.
export async function loadSaleAggregates(windowStart: Date): Promise<SaleAggregate[]> {
    const db = useDatabase();
    // Query the DB's snake_case columns, but read camelCase result keys: Keel's
    // Kysely instance runs the CamelCasePlugin, which rewrites result columns
    // (product_id → productId) even for raw SQL.
    const result = await sql<{
        productId: string;
        unitsLast365: string | number | null;
        revenueLast365: string | number | null;
        firstSaleDate: string | Date | null;
    }>`
        select
            product_id,
            coalesce(sum(quantity) filter (where date >= ${windowStart}), 0) as units_last_365,
            coalesce(sum(coalesce(net_amount, total_excl_vat)) filter (where date >= ${windowStart}), 0) as revenue_last_365,
            min(date) as first_sale_date
        from sale
        group by product_id
    `.execute(db);

    return result.rows.map((row) => ({
        productId: row.productId,
        unitsLast365: Number(row.unitsLast365 ?? 0),
        revenueLast365: Number(row.revenueLast365 ?? 0),
        firstSaleDate: row.firstSaleDate ? new Date(row.firstSaleDate) : null,
    }));
}

// Cumulative-revenue shares at which the ABC classes cut over: A while the
// share of revenue ranked above a product is under 80%, B until 95%, then C —
// the same 80/15/5 defaults Zoho's ABC Classification report uses.
export const ABC_REVENUE_SHARE = { a: 0.8, b: 0.95 };

// Revenue-based ABC classification over the whole catalogue — a Pareto cut on
// trailing-window realized revenue. Products are ranked by revenue (ties broken
// by id, so equal-revenue runs classify deterministically) and graded by the
// cumulative share of revenue ranked *before* them. Grading on the share before
// — not including — each product keeps the product that crosses a boundary in
// the higher class: a single product carrying 85% of all revenue is A, not B.
// Products with no positive revenue in the window are left out of the map and
// end up unclassified (null), mirroring blank cover for dormant products.
export function classifyAbc(revenues: Array<{ productId: string; revenueLast365: number }>): Map<string, AbcClass> {
    const ranked = revenues
        .filter((r) => r.revenueLast365 > 0)
        .sort((x, y) => y.revenueLast365 - x.revenueLast365 || x.productId.localeCompare(y.productId));
    const total = ranked.reduce((sum, r) => sum + r.revenueLast365, 0);

    const classes = new Map<string, AbcClass>();
    let cumulative = 0;
    for (const r of ranked) {
        const shareBefore = cumulative / total;
        classes.set(
            r.productId,
            shareBefore < ABC_REVENUE_SHARE.a ? AbcClass.A : shareBefore < ABC_REVENUE_SHARE.b ? AbcClass.B : AbcClass.C,
        );
        cumulative += r.revenueLast365;
    }
    return classes;
}
