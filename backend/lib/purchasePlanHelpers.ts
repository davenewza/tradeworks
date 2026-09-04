import { AbcClass, StockCoverStatus, models, useDatabase } from '@teamkeel/sdk';
import { sql } from 'kysely';
import { COVER_WINDOW_DAYS, estimatedMonthlySale, loadSaleAggregates, round1 } from './stockCoverHelpers';

// Purchase planning for one brand — see docs/purchase-planning.md.
//
// The idea: every product is topped up to the SAME cover horizon. A purchase
// order that leaves one SKU with six months of stock and another with three
// forces a top-up order in three months, so the plan asks "how many units does
// each product need so that, when this order lands, it has N months of cover?"
// and answers it per product from that product's own sales rate. The horizon
// (arrival + N months) is common; the quantities differ.
//
// All of it is pure arithmetic over figures the stock-cover feature already
// derives, so a plan costs no Zoho API calls.

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// One month, in days, when turning a monthly run-rate into a daily one. The
// same 365.25/12 the months-active divisor uses, so a product selling 120 units
// in a year is 10/month and 10/30.44 a day, not 10/30.
export const DAYS_PER_MONTH = 365.25 / 12;

export function addDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * MS_PER_DAY);
}

// Fractional days from one instant to another (negative when `to` is earlier).
export function daysBetween(from: Date, to: Date): number {
    return (to.getTime() - from.getTime()) / MS_PER_DAY;
}

// 'YYYY-MM-DD' (or anything Date can parse) → UTC midnight of that day. Null
// when it isn't a date at all, so a page validator can say so.
export function parseDay(value: string | null | undefined): Date | null {
    if (!value) return null;
    const iso = /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : value;
    const parsed = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
    if (Number.isNaN(parsed.getTime())) return null;
    return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

// ─── Parameters ─────────────────────────────────────────────────────────────

export interface PurchasePlanParams {
    // The day stock levels and sales rates are "as of" — the plan projects
    // forward from here. Always the day the plan is run.
    today: Date;
    // When the order will be placed with the supplier. Stock keeps selling
    // between today and then, and then for the whole lead time.
    purchaseDate: Date;
    // Days from purchase to the stock being on the shelf. Defaults to the
    // brand's setting; overridable per plan (air vs sea, a known delay).
    leadTimeInDays: number;
    // Months of cover every product should have the day the order lands. This
    // is the common horizon — see defaultTargetCoverMonths.
    targetCoverMonths: number;
}

export function arrivalDate(params: PurchasePlanParams): Date {
    return addDays(params.purchaseDate, params.leadTimeInDays);
}

// The date every product should stay in stock until: arrival + target cover.
export function coverHorizon(params: PurchasePlanParams): Date {
    return addDays(arrivalDate(params), params.targetCoverMonths * DAYS_PER_MONTH);
}

// Lead time in months as the status bands define it (days ÷ 30, matching the
// stockCoverStatus expression in products.keel).
export function leadTimeMonths(leadTimeInDays: number): number {
    return leadTimeInDays / 30;
}

// Default target: 2 × lead time — the middle of the Good band (1.5L–2.5L).
// Landing there means the order neither arrives already Low nor tips into
// Oversupply, and stock then decays through Good before the next order is
// due. Rounded to 1 dp so the input reads as a sensible number (60 days → 4).
export function defaultTargetCoverMonths(leadTimeInDays: number): number {
    return round1(2 * leadTimeMonths(leadTimeInDays));
}

// The status bands from products.keel, in TypeScript, so the plan can show what
// each product's status WILL be when the order lands. Keep in step with the
// stockCoverStatus @computed expression.
export function coverStatus(coverMonths: number | null, leadTimeInDays: number): StockCoverStatus | null {
    if (coverMonths === null) return null;
    const l = leadTimeMonths(leadTimeInDays);
    if (coverMonths < l) return StockCoverStatus.InsufficientSupply;
    if (coverMonths < l * 1.5) return StockCoverStatus.LowSupply;
    if (coverMonths < l * 2.5) return StockCoverStatus.GoodSupply;
    return StockCoverStatus.Oversupply;
}

// ─── Per-product planning ───────────────────────────────────────────────────

// What the plan needs to know about a product. Loaded once per run
// (loadPlanCandidates) and JSON-serialisable, so it survives a flow step.
export interface PlanCandidate {
    productId: string;
    sku: string;
    name: string;
    abcClass: AbcClass | null;
    // Zoho stock_on_hand from the last stock sync. Null when the product has
    // never had a reading — planned as 0 and flagged, since a missing reading
    // is not the same as an empty shelf.
    stockAvailable: number | null;
    stockOnWay: number;
    // Monthly run-rate, UNROUNDED: trailing-window units ÷ months active. The
    // stored estimatedMonthlySale is rounded to a whole number for display,
    // which would zero out a product selling 5 a year — over a six-month
    // horizon that is 2–3 units the order should carry. Null when nothing
    // sold in the window.
    monthlyDemand: number | null;
    // Cost of goods per unit (excl VAT, excl freight) on the product's most
    // recent supplier bill — the best guess at what the supplier will charge.
    // Null when the product has never been billed.
    unitCost: number | null;
}

// Why a product got the quantity it did. Drives the "Why" column and the
// ordering of the grid: the products in trouble come first.
export type PlanReason =
    // Current stock runs out before this order can land. The plan orders the
    // full target (nothing left to count), and the flow flags it — only a
    // faster shipment fixes the gap.
    | 'StockoutBeforeArrival'
    // Stock outlasts the lead time but not the horizon: order the difference.
    | 'Reorder'
    // Stock already lasts past the horizon: nothing to order.
    | 'Covered'
    // No stock reading has ever been synced. Planned as if the shelf were
    // empty, and flagged.
    | 'StockUnknown'
    // Nothing sold in the trailing window, so there is no rate to project.
    // Left at 0 for the buyer to decide.
    | 'NoForecast';

export interface PlanLine extends PlanCandidate {
    // On hand + on the way — what will be there to sell, absent this order.
    stockPosition: number;
    // Units expected to sell between today and the order landing.
    demandToArrival: number;
    // stockPosition − demandToArrival. Negative means a stockout in transit.
    projectedAtArrival: number;
    // When the current position runs dry at the run-rate; today if it already
    // has. Null without a forecast.
    runsOutOn: Date | null;
    // What the arithmetic says to order.
    suggestedQuantity: number;
    // What will actually be ordered — the suggestion unless the buyer edited it.
    orderQuantity: number;
    // Cover the day the order lands, given orderQuantity, 1 dp. Null without
    // a forecast.
    coverAtArrivalMonths: number | null;
    // Arrival + that cover: the date this product stays in stock until.
    coveredUntil: Date | null;
    statusAtArrival: StockCoverStatus | null;
    // orderQuantity × unitCost; null when the cost is unknown.
    lineValue: number | null;
    reason: PlanReason;
}

// The whole calculation for one product. `quantityOverride` re-runs the cover
// arithmetic for a quantity the buyer typed, leaving the suggestion intact so
// both can be shown side by side.
export function planLine(
    candidate: PlanCandidate,
    params: PurchasePlanParams,
    quantityOverride?: number,
): PlanLine {
    const stockUnknown = candidate.stockAvailable === null;
    const stockPosition = (candidate.stockAvailable ?? 0) + candidate.stockOnWay;
    const arrival = arrivalDate(params);
    const daysToArrival = Math.max(0, daysBetween(params.today, arrival));
    const demand = candidate.monthlyDemand;

    const lineValue = (quantity: number) =>
        candidate.unitCost === null ? null : round2(quantity * candidate.unitCost);

    if (demand === null || demand <= 0) {
        const orderQuantity = Math.max(0, quantityOverride ?? 0);
        return {
            ...candidate,
            stockPosition,
            demandToArrival: 0,
            projectedAtArrival: stockPosition,
            runsOutOn: null,
            suggestedQuantity: 0,
            orderQuantity,
            coverAtArrivalMonths: null,
            coveredUntil: null,
            statusAtArrival: null,
            lineValue: lineValue(orderQuantity),
            reason: 'NoForecast',
        };
    }

    const daily = demand / DAYS_PER_MONTH;
    const demandToArrival = daily * daysToArrival;
    const projectedAtArrival = stockPosition - demandToArrival;
    const runsOutOn = stockPosition <= 0 ? params.today : addDays(params.today, stockPosition / daily);

    // Units already sold that stock cannot cover (Zoho on-hand goes negative
    // when sales are billed ahead of stock). Those are spoken for, so the order
    // carries them on top of the target.
    const backorders = Math.max(0, -stockPosition);
    // Whatever is projected to be left when the order lands counts towards the
    // target; a projected stockout counts as zero, not as negative — the sales
    // that would have happened in the gap are lost, not deferred, so buying
    // stock for them would just overshoot the target.
    const remainingAtArrival = Math.max(0, projectedAtArrival);
    const targetUnits = demand * params.targetCoverMonths;
    const suggestedQuantity = Math.max(0, Math.ceil(targetUnits - remainingAtArrival + backorders - 1e-9));

    const orderQuantity = Math.max(0, quantityOverride ?? suggestedQuantity);
    const unitsAtArrival = Math.max(0, remainingAtArrival + orderQuantity - backorders);
    const coverAtArrivalMonths = round1(unitsAtArrival / demand);

    const reason: PlanReason = stockUnknown
        ? 'StockUnknown'
        : projectedAtArrival < 0
          ? 'StockoutBeforeArrival'
          : suggestedQuantity > 0
            ? 'Reorder'
            : 'Covered';

    return {
        ...candidate,
        stockPosition,
        demandToArrival,
        projectedAtArrival,
        runsOutOn,
        suggestedQuantity,
        orderQuantity,
        coverAtArrivalMonths,
        coveredUntil: addDays(arrival, unitsAtArrival / daily),
        statusAtArrival: coverStatus(coverAtArrivalMonths, params.leadTimeInDays),
        lineValue: lineValue(orderQuantity),
        reason,
    };
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

// ─── The whole plan ─────────────────────────────────────────────────────────

export interface PurchasePlanSummary {
    products: number;
    // Lines with an order quantity above zero.
    linesToOrder: number;
    totalUnits: number;
    // Goods value of the ordered lines whose cost is known (excl VAT, excl
    // freight). Read alongside linesWithoutCost.
    totalValue: number;
    linesWithoutCost: number;
    stockouts: number;
    stockUnknown: number;
    noForecast: number;
    arrival: Date;
    horizon: Date;
    // Ordered lines that, at their order quantity, run dry before the horizon
    // — only possible after the buyer trims a suggestion. These are the
    // top-up orders the plan exists to avoid, so the flow calls them out.
    shortOfHorizon: PlanLine[];
}

export interface PurchasePlan {
    lines: PlanLine[];
    summary: PurchasePlanSummary;
}

const REASON_ORDER: Record<PlanReason, number> = {
    StockoutBeforeArrival: 0,
    Reorder: 1,
    StockUnknown: 2,
    NoForecast: 3,
    Covered: 4,
};

// Plan every candidate and order them for the buyer: the products that run
// out soonest first, then the ones with nothing to decide. `overrides` are
// quantities the buyer has typed, by product id.
export function buildPurchasePlan(
    candidates: PlanCandidate[],
    params: PurchasePlanParams,
    overrides: Record<string, number> = {},
): PurchasePlan {
    const lines = candidates
        .map((c) => planLine(c, params, overrides[c.productId]))
        .sort(compareLines);

    const ordered = lines.filter((l) => l.orderQuantity > 0);
    const horizon = coverHorizon(params);
    // A day's grace: coveredUntil is a fractional-day projection, and a
    // quantity rounded down by one unit shouldn't read as a shortfall.
    const graceMs = MS_PER_DAY;

    return {
        lines,
        summary: {
            products: lines.length,
            linesToOrder: ordered.length,
            totalUnits: ordered.reduce((sum, l) => sum + l.orderQuantity, 0),
            totalValue: round2(ordered.reduce((sum, l) => sum + (l.lineValue ?? 0), 0)),
            linesWithoutCost: ordered.filter((l) => l.lineValue === null).length,
            stockouts: lines.filter((l) => l.reason === 'StockoutBeforeArrival').length,
            stockUnknown: lines.filter((l) => l.reason === 'StockUnknown').length,
            noForecast: lines.filter((l) => l.reason === 'NoForecast').length,
            arrival: arrivalDate(params),
            horizon,
            shortOfHorizon: ordered.filter(
                (l) => l.coveredUntil !== null && l.coveredUntil.getTime() < horizon.getTime() - graceMs,
            ),
        },
    };
}

function compareLines(a: PlanLine, b: PlanLine): number {
    const byReason = REASON_ORDER[a.reason] - REASON_ORDER[b.reason];
    if (byReason !== 0) return byReason;
    // Within a group, whoever runs out first. Products with no run-out date
    // (no forecast) fall back to the name.
    const aOut = a.runsOutOn?.getTime() ?? Number.POSITIVE_INFINITY;
    const bOut = b.runsOutOn?.getTime() ?? Number.POSITIVE_INFINITY;
    if (aOut !== bOut) return aOut - bOut;
    return a.name.localeCompare(b.name);
}

// ─── Loading ────────────────────────────────────────────────────────────────

export interface PlannableBrand {
    brandId: string;
    name: string;
    leadTimeInDays: number;
    productCount: number;
}

// Brands with at least one enabled product, for the picker. A brand with
// nothing enabled has nothing to plan.
export async function loadPlannableBrands(): Promise<PlannableBrand[]> {
    const [brands, products] = await Promise.all([
        models.brand.findMany({}),
        models.product.findMany({ where: { isEnabled: { equals: true } } }),
    ]);
    const counts = new Map<string, number>();
    for (const p of products) counts.set(p.brandId, (counts.get(p.brandId) ?? 0) + 1);

    return brands
        .filter((b) => (counts.get(b.id) ?? 0) > 0)
        .map((b) => ({
            brandId: b.id,
            name: b.name,
            leadTimeInDays: b.leadTimeInDays,
            productCount: counts.get(b.id)!,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

// Everything the plan needs for one brand's enabled products, as of `now`:
// the stock figures the daily sync wrote, an unrounded run-rate from the same
// sales window that sync uses, and the latest cost per product. Pure local
// reads — nothing here touches Zoho.
export async function loadPlanCandidates(brandId: string, now: Date): Promise<PlanCandidate[]> {
    const products = await models.product.findMany({
        where: { brandId: { equals: brandId }, isEnabled: { equals: true } },
    });
    if (products.length === 0) return [];

    const productIds = products.map((p) => p.id);
    const windowStart = addDays(now, -COVER_WINDOW_DAYS);
    const [aggregates, unitCosts] = await Promise.all([
        loadSaleAggregates(windowStart, productIds),
        loadLatestUnitCosts(productIds),
    ]);
    const demandById = new Map(aggregates.map((a) => [a.productId, estimatedMonthlySale(a, now)]));

    return products
        .map((p) => {
            const demand = demandById.get(p.id) ?? 0;
            return {
                productId: p.id,
                sku: p.sku,
                name: p.name,
                abcClass: p.abcClass ?? null,
                stockAvailable: p.stockAvailable ?? null,
                stockOnWay: p.stockOnWay ?? 0,
                monthlyDemand: demand > 0 ? demand : null,
                unitCost: unitCosts.get(p.id) ?? null,
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

// Cost of goods per unit on each product's most recent supplier bill. Bills
// with no date sort last; ties on date break on the line's own creation
// order. One DISTINCT ON query rather than a fetch per product.
export async function loadLatestUnitCosts(productIds: string[]): Promise<Map<string, number>> {
    if (productIds.length === 0) return new Map();
    const db = useDatabase();
    const result = await sql<{ productId: string; unitCost: string | number }>`
        select distinct on (pcl.product_id)
            pcl.product_id,
            pcl.unit_cost
        from product_cost_line pcl
        join supplier_bill sb on sb.id = pcl.supplier_bill_id
        where pcl.product_id = any(${productIds})
        order by pcl.product_id, sb.date desc nulls last, pcl.created_at desc
    `.execute(db);

    return new Map(result.rows.map((row) => [row.productId, Number(row.unitCost)]));
}
