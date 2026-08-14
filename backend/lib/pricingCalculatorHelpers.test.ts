import { models, resetDatabase } from '@teamkeel/testing';
import { FeeMethod } from '@teamkeel/sdk';
import { beforeEach, describe, expect, test } from 'vitest';
import {
    ProductPricingContext,
    buildPricingView,
    loadProductPricingContext,
} from './pricingCalculatorHelpers';

beforeEach(resetDatabase);

// ─── buildPricingView (pure) ──────────────────────────────────────────────────

// Context mirroring the screenshot product (UR-FS292): 11% success, R42 fulfilment,
// five bills with the quantities used to weight them.
const context: ProductPricingContext = {
    successRate: 0.11,
    fulfilmentFee: 42,
    hasFees: true,
    hasCostLines: true,
    bills: [
        { unitCost: 193.1, unitFreightIn: 60.02, quantity: 100, date: '2021-02-19', billNumber: '20210219001', dateLabel: '2021-02-19' },
        { unitCost: 184.41, unitFreightIn: 43.58, quantity: 150, date: '2023-02-15', billNumber: '20230215001', dateLabel: '2023-02-15' },
        { unitCost: 200.18, unitFreightIn: 61.82, quantity: 120, date: '2023-05-30', billNumber: '20230530001', dateLabel: '2023-05-30' },
        { unitCost: 193.1, unitFreightIn: 52.97, quantity: 200, date: '2023-09-21', billNumber: '20230921001', dateLabel: '2023-09-21' },
        { unitCost: 184.1, unitFreightIn: 68.37, quantity: 90, date: '2024-07-29', billNumber: '20240729001', dateLabel: '2024-07-29' },
    ],
};

describe('buildPricingView', () => {
    test('drives price from a 40% target margin on the weighted-average landed cost', () => {
        const view = buildPricingView(context, { lever: 'margin', marginPct: 40, priceIncl: null, roas: null, basis: 'weightedAverage' });
        expect(view.representativeLanded).toBeCloseTo(246.8, 1);
        expect(view.result.feasible).toBe(true);
        expect(view.result.grossMargin).toBeCloseTo(0.4, 6);
        expect(view.result.priceInclVat).toBeCloseTo(701.4, 0);
    });

    test('produces one sensitivity row per bill, each a valid margin at the chosen price', () => {
        const view = buildPricingView(context, { lever: 'margin', marginPct: 40, priceIncl: null, roas: null, basis: 'weightedAverage' });
        expect(view.sensitivity).toHaveLength(5);
        // Cheapest-landed bill yields the highest margin at a fixed price.
        const best = view.sensitivity.reduce((a, b) => (b.grossMargin > a.grossMargin ? b : a));
        expect(best.billNumber).toBe('20230215001');
        expect(best.netMargin).toBeNull(); // no ROAS → net margin omitted
    });

    test('worst-case (air) basis prices off the highest-freight bill', () => {
        const view = buildPricingView(context, { lever: 'margin', marginPct: 40, priceIncl: null, roas: null, basis: 'highestFreight' });
        expect(view.representativeLanded).toBeCloseTo(184.1 + 68.37, 2);
    });

    test('driving by price yields the margin back (inverse agrees)', () => {
        const view = buildPricingView(context, { lever: 'price', marginPct: 0, priceIncl: 701.41, roas: null, basis: 'weightedAverage' });
        expect(view.result.grossMargin).toBeCloseTo(0.4, 2);
    });

    test('ROAS carries through to net margin on the result and sensitivity', () => {
        const view = buildPricingView(context, { lever: 'margin', marginPct: 40, priceIncl: null, roas: 5, basis: 'weightedAverage' });
        expect(view.result.netMargin).toBeCloseTo(0.2, 6);
        expect(view.sensitivity.every((s) => s.netMargin != null)).toBe(true);
    });

    test('flags an infeasible margin', () => {
        const view = buildPricingView(context, { lever: 'margin', marginPct: 90, priceIncl: null, roas: null, basis: 'weightedAverage' });
        expect(view.result.feasible).toBe(false);
        expect(view.sensitivity).toHaveLength(0);
    });
});

// ─── loadProductPricingContext (DB) ───────────────────────────────────────────

describe('loadProductPricingContext', () => {
    test('resolves success rate, fulfilment fee and per-bill cost lines from synced data', async () => {
        const brand = await models.brand.create({ name: 'Test Brand' });
        const product = await models.product.create({ name: '86 Piece Rivet Nut Tool Kit', sku: 'UR-FS292', brandId: brand.id });

        const channel = await models.channel.create({ name: 'Takealot Marketplace' });
        const success = await models.channelFee.create({ channelId: channel.id, name: 'Tools', feeType: 'Success fee', method: FeeMethod.Commission, value: 11, zohoRecordId: 'z-succ' });
        const fulfil = await models.channelFee.create({ channelId: channel.id, name: 'Standard', feeType: 'Fulfilment fee', method: FeeMethod.Flat, value: 42, zohoRecordId: 'z-ful' });
        await models.productChannelFee.create({ productId: product.id, channelFeeId: success.id });
        await models.productChannelFee.create({ productId: product.id, channelFeeId: fulfil.id });

        const bill = await models.supplierBill.create({ billNumber: '20210219001', date: new Date('2021-02-19') });
        await models.productCostLine.create({ productId: product.id, supplierBillId: bill.id, unitCost: 193.1, unitFreightIn: 60.02, quantity: 100, zohoRecordId: 'c1' });

        const ctx = await loadProductPricingContext(product.id);

        expect(ctx.hasFees).toBe(true);
        expect(ctx.hasCostLines).toBe(true);
        expect(ctx.successRate).toBeCloseTo(0.11, 6);
        expect(ctx.fulfilmentFee).toBeCloseTo(42, 6);
        expect(ctx.bills).toHaveLength(1);
        expect(ctx.bills[0].billNumber).toBe('20210219001');
        expect(ctx.bills[0].unitCost).toBeCloseTo(193.1, 2);
        expect(ctx.bills[0].unitFreightIn).toBeCloseTo(60.02, 2);
    });

    test('is empty for a product with no fees or costs', async () => {
        const brand = await models.brand.create({ name: 'B' });
        const product = await models.product.create({ name: 'Bare', sku: 'BARE-1', brandId: brand.id });
        const ctx = await loadProductPricingContext(product.id);
        expect(ctx.hasFees).toBe(false);
        expect(ctx.hasCostLines).toBe(false);
        expect(ctx.successRate).toBe(0);
        expect(ctx.fulfilmentFee).toBe(0);
        expect(ctx.bills).toHaveLength(0);
    });
});
