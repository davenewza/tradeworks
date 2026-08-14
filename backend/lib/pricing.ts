// ─── Pricing engine ──────────────────────────────────────────────────────────
//
// The single source of truth for the product pricing calculator. Pure functions,
// no framework imports, so this module is safe to run under vitest here and to
// share with the Vue frontend (the interactive calculator drives entirely off
// these functions).
//
// The maths inverts one identity three ways, so the calculator can be driven
// from a sale price, a target margin, or a markup and always agree with itself:
//
//     grossProfit = priceExcl - costBase - successFee
//                 = priceExcl - costBase - successRate * priceIncl
//                 = priceExcl * (1 - successRate * (1 + VAT)) - costBase
//
// where costBase = landed unit cost + fulfilment fee (both excl VAT), and the
// success fee is a marketplace commission charged on the VAT-inclusive selling
// price (this matches how Takealot bills the success fee).
//
// VAT is treated as a pass-through, never as profit: revenue and every cost are
// handled excl VAT, and the success fee's own VAT is assumed reclaimable and so
// is not added on top of the commission.

export const VAT_RATE = 0.15;

/** Add VAT: excl-VAT amount → incl-VAT amount. */
export function toInclVat(exclVat: number, vatRate: number = VAT_RATE): number {
    return exclVat * (1 + vatRate);
}

/** Strip VAT: incl-VAT amount → excl-VAT amount. */
export function toExclVat(inclVat: number, vatRate: number = VAT_RATE): number {
    return inclVat / (1 + vatRate);
}

// ─── Landed cost across supplier bills ────────────────────────────────────────

// One product's cost as recorded on a single supplier bill. Freight-in varies
// per bill (air vs sea especially), which is the whole reason costs are tracked
// per bill rather than as a single figure on the product.
export interface CostLine {
    /** Unit cost of goods on this bill, excl VAT. */
    unitCost: number;
    /** Freight-in allocated per unit on this bill, excl VAT. */
    unitFreightIn: number;
    /** Units received on this bill — the weight for a weighted average. */
    quantity?: number;
    /** Bill date, used by the `latest` basis. ISO string or Date. */
    date?: string | Date;
}

/** Landed unit cost of a single line: cost of goods + freight-in (excl VAT). */
export function landedCost(line: CostLine): number {
    return line.unitCost + line.unitFreightIn;
}

// How to collapse a product's per-bill costs into the single representative
// landed cost the calculator prices off.
export type FreightBasis = 'weightedAverage' | 'latest' | 'highestFreight' | 'lowestFreight';

function toTime(date: string | Date | undefined): number {
    if (date == null) return 0;
    const t = date instanceof Date ? date.getTime() : new Date(date).getTime();
    return Number.isNaN(t) ? 0 : t;
}

// Reduce a product's supplier bills to one representative landed unit cost.
//
// `weightedAverage` (the default) weights each bill's landed cost by units
// received, falling back to a simple average when no quantities are recorded.
// `latest` takes the most recent bill; `highestFreight`/`lowestFreight` take the
// worst-/best-case freight bill (air vs sea) for conservative or optimistic
// pricing.
export function reduceLandedCost(lines: CostLine[], basis: FreightBasis = 'weightedAverage'): number {
    if (lines.length === 0) return 0;
    if (lines.length === 1) return landedCost(lines[0]);

    switch (basis) {
        case 'latest': {
            const latest = lines.reduce((a, b) => (toTime(b.date) >= toTime(a.date) ? b : a));
            return landedCost(latest);
        }
        case 'highestFreight':
            return landedCost(lines.reduce((a, b) => (b.unitFreightIn > a.unitFreightIn ? b : a)));
        case 'lowestFreight':
            return landedCost(lines.reduce((a, b) => (b.unitFreightIn < a.unitFreightIn ? b : a)));
        case 'weightedAverage':
        default: {
            const totalQty = lines.reduce((sum, l) => sum + (l.quantity ?? 0), 0);
            if (totalQty <= 0) {
                // No quantities recorded → fall back to a simple average.
                const sum = lines.reduce((s, l) => s + landedCost(l), 0);
                return sum / lines.length;
            }
            const weighted = lines.reduce((s, l) => s + landedCost(l) * (l.quantity ?? 0), 0);
            return weighted / totalQty;
        }
    }
}

// ─── Pricing ──────────────────────────────────────────────────────────────────

// The costs and marketplace fees a price is built on. All amounts excl VAT.
export interface PricingInputs {
    /** Representative landed unit cost (cost of goods + freight-in), excl VAT. */
    landedCost: number;
    /** Flat fulfilment fee charged by the channel, excl VAT (0 if none). */
    fulfilmentFee: number;
    /** Success-fee commission as a fraction of the incl-VAT price (0.11 = 11%). */
    successRate: number;
    /**
     * Return on ad spend: revenue earned per rand of marketing spend. Marketing
     * cost = priceExcl / roas. Omit or set 0 to model no marketing spend.
     */
    roas?: number;
    /** VAT rate as a fraction. Defaults to the SA standard rate (0.15). */
    vatRate?: number;
}

// A fully resolved price with every derived figure the calculator displays.
export interface PricingResult {
    priceExclVat: number;
    priceInclVat: number;
    /** landedCost + fulfilmentFee, excl VAT. */
    costBase: number;
    successFee: number;
    grossProfit: number;
    /** Gross profit as a fraction of excl-VAT revenue (the primary lever). */
    grossMargin: number;
    /** Gross profit as a fraction of cost base (shown for reference). */
    markup: number;
    marketingCost: number;
    netProfit: number;
    /** Net (after-marketing) profit as a fraction of excl-VAT revenue. */
    netMargin: number;
    /**
     * False when the requested margin is unreachable — the success fee alone
     * consumes it. Callers should surface this rather than show a negative or
     * infinite price.
     */
    feasible: boolean;
}

// The fraction of every excl-VAT rand of revenue that survives the success fee.
// Costs and profit are recovered out of what remains, so this caps the margin.
function revenueRetention(successRate: number, vatRate: number): number {
    return 1 - successRate * (1 + vatRate);
}

// Build the full breakdown from a settled excl-VAT price.
function resolveFromPriceExcl(priceExclVat: number, inputs: PricingInputs, feasible: boolean): PricingResult {
    const vatRate = inputs.vatRate ?? VAT_RATE;
    const costBase = inputs.landedCost + inputs.fulfilmentFee;
    const priceInclVat = toInclVat(priceExclVat, vatRate);
    const successFee = inputs.successRate * priceInclVat;
    const grossProfit = priceExclVat - costBase - successFee;
    const roas = inputs.roas ?? 0;
    const marketingCost = roas > 0 ? priceExclVat / roas : 0;
    const netProfit = grossProfit - marketingCost;

    return {
        priceExclVat,
        priceInclVat,
        costBase,
        successFee,
        grossProfit,
        grossMargin: priceExclVat === 0 ? 0 : grossProfit / priceExclVat,
        markup: costBase === 0 ? 0 : grossProfit / costBase,
        marketingCost,
        netProfit,
        netMargin: priceExclVat === 0 ? 0 : netProfit / priceExclVat,
        feasible,
    };
}

// Price so that gross profit is `targetMargin` of excl-VAT revenue.
//
//     priceExcl = costBase / (1 - successRate*(1+VAT) - targetMargin)
//
// The target is infeasible once it meets the revenue left after the success fee
// (the denominator hits zero): there is no finite price that yields it, so the
// result is flagged infeasible and priced at the margin's ceiling instead.
export function priceFromMargin(targetMargin: number, inputs: PricingInputs): PricingResult {
    const vatRate = inputs.vatRate ?? VAT_RATE;
    const costBase = inputs.landedCost + inputs.fulfilmentFee;
    const retention = revenueRetention(inputs.successRate, vatRate);
    const denominator = retention - targetMargin;

    if (denominator <= 0) {
        return resolveFromPriceExcl(Number.POSITIVE_INFINITY, inputs, false);
    }

    return resolveFromPriceExcl(costBase / denominator, inputs, true);
}

// Derive the full breakdown from a chosen VAT-inclusive sale price — the other
// direction of the two-way calculator (drag the price, read the margin).
export function priceFromInclVat(priceInclVat: number, inputs: PricingInputs): PricingResult {
    const vatRate = inputs.vatRate ?? VAT_RATE;
    return resolveFromPriceExcl(toExclVat(priceInclVat, vatRate), inputs, true);
}

// Price from a markup on cost base (grossProfit / costBase). Kept for parity
// with the old markup-slider tool and shown alongside margin.
//
//     priceExcl = costBase * (1 + markup) / (1 - successRate*(1+VAT))
export function priceFromMarkup(markup: number, inputs: PricingInputs): PricingResult {
    const vatRate = inputs.vatRate ?? VAT_RATE;
    const costBase = inputs.landedCost + inputs.fulfilmentFee;
    const retention = revenueRetention(inputs.successRate, vatRate);

    if (retention <= 0) {
        return resolveFromPriceExcl(Number.POSITIVE_INFINITY, inputs, false);
    }

    return resolveFromPriceExcl((costBase * (1 + markup)) / retention, inputs, true);
}
