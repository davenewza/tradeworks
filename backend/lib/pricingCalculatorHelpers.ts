import { models, FeeMethod } from '@teamkeel/sdk';
import {
    CostLine,
    FreightBasis,
    PricingResult,
    VAT_RATE,
    landedCost,
    reduceLandedCost,
    priceFromMargin,
    priceFromInclVat,
} from './pricing';

// Business logic for the PricingCalculator flow. The flow only orchestrates UI;
// everything computable lives here so it can be unit-tested without a flow run.

export interface PricingProductOption {
    id: string;
    label: string;
}

// Enabled products for the picker, labelled "name — sku".
export async function loadPricingProducts(): Promise<PricingProductOption[]> {
    const products = await models.product.findMany({ where: { isEnabled: { equals: true } }, limit: 1000 });
    return products
        .map((p) => ({ id: p.id, label: `${p.name} — ${p.sku}` }))
        .sort((a, b) => a.label.localeCompare(b.label));
}

// A product's cost line carrying the bill it came from (for the sensitivity table).
export interface CostBill extends CostLine {
    billNumber: string;
    dateLabel: string;
}

// Everything the calculator needs about one product: its channel fees resolved
// to a success rate + fulfilment fee, and its per-bill landed costs.
export interface ProductPricingContext {
    successRate: number;
    fulfilmentFee: number;
    bills: CostBill[];
    hasFees: boolean;
    hasCostLines: boolean;
}

export async function loadProductPricingContext(productId: string): Promise<ProductPricingContext> {
    const fees = await models.productChannelFee.findMany({ where: { productId: { equals: productId } } });
    let successPct = 0;
    let fulfilmentFee = 0;
    for (const f of fees) {
        const value = Number(f.feeValue ?? 0);
        if (f.feeMethod === FeeMethod.Commission) successPct += value;
        else if (f.feeMethod === FeeMethod.Flat) fulfilmentFee += value;
    }

    const lines = await models.productCostLine.findMany({ where: { productId: { equals: productId } }, limit: 1000 });
    const bills: CostBill[] = lines.map((l) => ({
        unitCost: Number(l.unitCost ?? 0),
        unitFreightIn: Number(l.unitFreightIn ?? 0),
        quantity: l.quantity == null ? undefined : Number(l.quantity),
        date: l.billDate ?? undefined,
        billNumber: l.billNumber ?? '—',
        dateLabel: l.billDate ? new Date(l.billDate).toISOString().slice(0, 10) : '—',
    }));

    return {
        successRate: successPct / 100,
        fulfilmentFee,
        bills,
        hasFees: fees.length > 0,
        hasCostLines: lines.length > 0,
    };
}

export interface CalcInputs {
    lever: 'margin' | 'price';
    marginPct: number;
    priceIncl: number | null;
    roas: number | null;
    basis: FreightBasis;
}

export interface SensitivityRow {
    billNumber: string;
    dateLabel: string;
    unitCost: number;
    freightIn: number;
    landed: number;
    grossMargin: number;
    netMargin: number | null;
}

export interface PricingView {
    result: PricingResult;
    representativeLanded: number;
    roas: number;
    // Ceiling margin the success fee still leaves room under (for the warning).
    retentionCeiling: number;
    sensitivity: SensitivityRow[];
}

// Compute the full calculator view from a product context + the chosen inputs.
// Pure — the flow feeds it DB-loaded context and user inputs, and renders the result.
export function buildPricingView(context: ProductPricingContext, input: CalcInputs): PricingView {
    const representativeLanded = reduceLandedCost(context.bills, input.basis);
    const roas = input.roas && input.roas > 0 ? input.roas : 0;
    const pricingInputs = {
        landedCost: representativeLanded,
        fulfilmentFee: context.fulfilmentFee,
        successRate: context.successRate,
        roas,
    };

    const result =
        input.lever === 'price' && input.priceIncl && input.priceIncl > 0
            ? priceFromInclVat(input.priceIncl, pricingInputs)
            : priceFromMargin(input.marginPct / 100, pricingInputs);

    const sensitivity: SensitivityRow[] =
        result.feasible && Number.isFinite(result.priceInclVat)
            ? context.bills.map((b) => {
                  const r = priceFromInclVat(result.priceInclVat, {
                      landedCost: landedCost(b),
                      fulfilmentFee: context.fulfilmentFee,
                      successRate: context.successRate,
                      roas,
                  });
                  return {
                      billNumber: b.billNumber,
                      dateLabel: b.dateLabel,
                      unitCost: b.unitCost,
                      freightIn: b.unitFreightIn,
                      landed: landedCost(b),
                      grossMargin: r.grossMargin,
                      netMargin: roas > 0 ? r.netMargin : null,
                  };
              })
            : [];

    return {
        result,
        representativeLanded,
        roas,
        retentionCeiling: 1 - context.successRate * (1 + VAT_RATE),
        sensitivity,
    };
}
