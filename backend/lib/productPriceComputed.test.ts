import { models, resetDatabase } from '@teamkeel/testing';
import { FeeMethod } from '@teamkeel/sdk';
import { beforeEach, describe, expect, test } from 'vitest';

// Exercises the channel-scoped computed pricing chain on ProductPrice end-to-end
// (real migrations + DB triggers), not a lib function.

beforeEach(resetDatabase);

const num = (v: unknown) => Number(v);

// Product with a bill landing at 253.12/unit, 11% success + R42 fulfilment on the
// Takealot channel, plus a 20% success fee on a DIFFERENT channel (must be ignored).
async function seed() {
    const brand = await models.brand.create({ name: 'Brand' });
    const product = await models.product.create({ name: '86 Piece Rivet Nut Tool Kit', sku: 'UR-FS292', brandId: brand.id });

    const takealot = await models.channel.create({ name: 'Takealot Marketplace' });
    const other = await models.channel.create({ name: 'Other Channel' });

    const success = await models.channelFee.create({ channelId: takealot.id, name: 'Tools', feeType: 'Success fee', method: FeeMethod.Commission, value: 11, zohoRecordId: 'z-succ' });
    const fulfil = await models.channelFee.create({ channelId: takealot.id, name: 'Standard', feeType: 'Fulfilment fee', method: FeeMethod.Flat, value: 42, zohoRecordId: 'z-ful' });
    const otherSuccess = await models.channelFee.create({ channelId: other.id, name: 'Other', feeType: 'Success fee', method: FeeMethod.Commission, value: 20, zohoRecordId: 'z-other' });
    await models.productChannelFee.create({ productId: product.id, channelFeeId: success.id });
    await models.productChannelFee.create({ productId: product.id, channelFeeId: fulfil.id });
    await models.productChannelFee.create({ productId: product.id, channelFeeId: otherSuccess.id });

    const bill = await models.supplierBill.create({ billNumber: 'BILL-1', date: new Date('2021-02-19') });
    await models.productCostLine.create({ productId: product.id, supplierBillId: bill.id, unitCost: 193.1, unitFreightIn: 60.02, quantity: 100, zohoRecordId: 'c1' });

    return { product, takealot, other, success };
}

describe('ProductPrice computed pricing', () => {
    test('computes fees, gross profit and margin scoped to the price list channel', async () => {
        const { product, takealot } = await seed();
        const priceList = await models.priceList.create({ name: 'Takealot', channelId: takealot.id });
        const created = await models.productPrice.create({ productId: product.id, priceListId: priceList.id, priceInclVat: 716.76 });

        const pp = await models.productPrice.findOne({ id: created.id });
        expect(num(pp!.unitCost)).toBeCloseTo(193.1, 2);
        expect(num(pp!.unitFreightIn)).toBeCloseTo(60.02, 2);
        expect(num(pp!.landedUnitCost)).toBeCloseTo(253.12, 2);
        // Only the Takealot fees — the other channel's 20% is excluded.
        expect(num(pp!.successFeePercentage)).toBeCloseTo(11, 6);
        expect(num(pp!.flatFeeTotal)).toBeCloseTo(42, 6);
        // (42 + 11% of 716.76) VAT-inclusive = 120.84, net of VAT = 105.08.
        expect(num(pp!.channelFees)).toBeCloseTo(105.08, 2);
        expect(num(pp!.price)).toBeCloseTo(623.27, 2);
        expect(num(pp!.grossProfit)).toBeCloseTo(265.07, 2);
        // Stored as a 0–1 ratio; the Console renders it as a rounded percentage.
        expect(num(pp!.grossProfitMargin)).toBeCloseTo(0.425, 3);
    });

    test('a price list with no channel resolves fees to zero', async () => {
        const { product } = await seed();
        const priceList = await models.priceList.create({ name: 'No channel' });
        const created = await models.productPrice.create({ productId: product.id, priceListId: priceList.id, priceInclVat: 716.76 });

        const pp = await models.productPrice.findOne({ id: created.id });
        expect(num(pp!.channelFees)).toBe(0);
        expect(num(pp!.grossProfit)).toBeCloseTo(623.27 - 253.12, 2);
    });

    test('a product with no cost lines has zero landed cost (no divide-by-zero)', async () => {
        const brand = await models.brand.create({ name: 'B' });
        const product = await models.product.create({ name: 'Bare', sku: 'BARE-1', brandId: brand.id });
        const takealot = await models.channel.create({ name: 'Takealot Marketplace' });
        const priceList = await models.priceList.create({ name: 'PL', channelId: takealot.id });
        const created = await models.productPrice.create({ productId: product.id, priceListId: priceList.id, priceInclVat: 100 });

        const pp = await models.productPrice.findOne({ id: created.id });
        expect(num(pp!.landedUnitCost)).toBe(0);
        expect(num(pp!.channelFees)).toBe(0);
    });

    test('editing a channel fee re-prices existing rows via triggers (no row write)', async () => {
        const { product, takealot, success } = await seed();
        const priceList = await models.priceList.create({ name: 'Takealot', channelId: takealot.id });
        const created = await models.productPrice.create({ productId: product.id, priceListId: priceList.id, priceInclVat: 716.76 });

        // Bump the success fee 11% → 15%, touching only the ChannelFee.
        await models.channelFee.update({ id: success.id }, { value: 15 });

        const pp = await models.productPrice.findOne({ id: created.id });
        expect(num(pp!.successFeePercentage)).toBeCloseTo(15, 6);
        // (42 + 15% of 716.76) net of VAT = 149.51 / 1.15 = 130.01
        expect(num(pp!.channelFees)).toBeCloseTo(130.01, 2);
    });

    test('an always-applied channel fee reaches a product with no per-product fees', async () => {
        const brand = await models.brand.create({ name: 'B' });
        const product = await models.product.create({ name: 'Bare', sku: 'BARE-2', brandId: brand.id });
        const channel = await models.channel.create({ name: 'CREATESPACE' });
        // A general 1% Shopify commission on the whole channel, not linked to the product.
        await models.channelFee.create({ channelId: channel.id, name: 'Shopify', method: FeeMethod.Commission, value: 1, alwaysApplied: true });
        const priceList = await models.priceList.create({ name: 'CS', channelId: channel.id });
        const created = await models.productPrice.create({ productId: product.id, priceListId: priceList.id, priceInclVat: 115 });

        const pp = await models.productPrice.findOne({ id: created.id });
        expect(num(pp!.alwaysCommissionPercentage)).toBeCloseTo(1, 6);
        // 1% of 115 incl VAT = 1.15, net of VAT = 1.00
        expect(num(pp!.channelFees)).toBeCloseTo(1.0, 2);
    });

    test('always-applied fees combine with per-product fees', async () => {
        const { product, takealot } = await seed();
        await models.channelFee.create({ channelId: takealot.id, name: 'Shopify', method: FeeMethod.Commission, value: 1, alwaysApplied: true });
        const priceList = await models.priceList.create({ name: 'Takealot', channelId: takealot.id });
        const created = await models.productPrice.create({ productId: product.id, priceListId: priceList.id, priceInclVat: 716.76 });

        const pp = await models.productPrice.findOne({ id: created.id });
        // per-product 11% + always 1% = 12% commission, plus R42 flat.
        expect(num(pp!.channelFees)).toBeCloseTo((42 + (12 / 100) * 716.76) / 1.15, 2);
    });

    test('adding an always-applied fee re-prices existing rows via triggers', async () => {
        const brand = await models.brand.create({ name: 'B' });
        const product = await models.product.create({ name: 'X', sku: 'X-1', brandId: brand.id });
        const channel = await models.channel.create({ name: 'CREATESPACE' });
        const priceList = await models.priceList.create({ name: 'CS', channelId: channel.id });
        const created = await models.productPrice.create({ productId: product.id, priceListId: priceList.id, priceInclVat: 115 });
        expect(num((await models.productPrice.findOne({ id: created.id }))!.channelFees)).toBe(0);

        // Add the channel-wide fee after the row already exists.
        await models.channelFee.create({ channelId: channel.id, name: 'Shopify', method: FeeMethod.Commission, value: 1, alwaysApplied: true });

        expect(num((await models.productPrice.findOne({ id: created.id }))!.channelFees)).toBeCloseTo(1.0, 2);
    });

    test('exposes the price list name (for the product-page prices view)', async () => {
        const { product, takealot } = await seed();
        const priceList = await models.priceList.create({ name: 'Takealot Retail', channelId: takealot.id });
        const created = await models.productPrice.create({ productId: product.id, priceListId: priceList.id, priceInclVat: 500 });

        const pp = await models.productPrice.findOne({ id: created.id });
        expect(pp!.priceListName).toBe('Takealot Retail');
        expect(pp!.priceListChannelName).toBe('Takealot Marketplace');
    });
});

describe('Product purchase details', () => {
    test('summarises cost, freight and volumes across supplier bills', async () => {
        const brand = await models.brand.create({ name: 'B' });
        const product = await models.product.create({ name: 'Kit', sku: 'K-1', brandId: brand.id });
        const bill1 = await models.supplierBill.create({ billNumber: 'B1' });
        const bill2 = await models.supplierBill.create({ billNumber: 'B2' });
        // 10 @ 100/60 and 30 @ 120/20.
        await models.productCostLine.create({ productId: product.id, supplierBillId: bill1.id, unitCost: 100, unitFreightIn: 60, quantity: 10, zohoRecordId: 'c1' });
        await models.productCostLine.create({ productId: product.id, supplierBillId: bill2.id, unitCost: 120, unitFreightIn: 20, quantity: 30, zohoRecordId: 'c2' });

        const p = await models.product.findOne({ id: product.id });
        expect(num(p!.totalSupplierBills)).toBe(2);
        expect(num(p!.totalUnitsPurchased)).toBe(40);
        // (100*10 + 120*30)/40 = 115 ; (60*10 + 20*30)/40 = 30
        expect(num(p!.weightedUnitCost)).toBeCloseTo(115, 6);
        expect(num(p!.weightedFreightIn)).toBeCloseTo(30, 6);
        expect(num(p!.weightedLandedCost)).toBeCloseTo(145, 6);
    });

    test('is empty for a product with no bills', async () => {
        const brand = await models.brand.create({ name: 'B' });
        const product = await models.product.create({ name: 'Bare', sku: 'K-2', brandId: brand.id });
        const p = await models.product.findOne({ id: product.id });
        expect(num(p!.totalSupplierBills)).toBe(0);
        expect(num(p!.weightedUnitCost)).toBe(0);
    });
});

describe('Product sales details', () => {
    test('summarises units and net revenue (post-discount), not list price', async () => {
        const brand = await models.brand.create({ name: 'B' });
        const product = await models.product.create({ name: 'Kit', sku: 'S-1', brandId: brand.id });
        const channel = await models.channel.create({ name: 'Takealot' });
        // Line 1: list 1150/unit but net 800 after a discount (qty 2); line 2: net 1500 (qty 3).
        const s1 = await models.sale.create({ invoiceNumber: 'I1', lineItemId: 'L1', lineKey: 'L1', channelId: channel.id, date: new Date('2024-01-01'), productId: product.id, quantity: 2, price: 1150, netAmount: 800, discountAmount: 200, invoiceStatus: 'paid' });
        await models.sale.create({ invoiceNumber: 'I2', lineItemId: 'L2', lineKey: 'L2', channelId: channel.id, date: new Date('2024-02-01'), productId: product.id, quantity: 3, price: 575, netAmount: 1500, invoiceStatus: 'paid' });

        const p = await models.product.findOne({ id: product.id });
        expect(num(p!.totalUnitsSold)).toBe(5);
        // net revenue = 800 + 1500 = 2300 (NOT list 1150*2 + 575*3 = 4025)
        expect(num(p!.totalSalesValue)).toBeCloseTo(2300, 2);
        // avg net price = 2300 / 5 = 460
        expect(num(p!.averageSalePrice)).toBeCloseTo(460, 6);
        // tax is derived from netAmount: 800 * 0.15 = 120
        expect(num((await models.sale.findOne({ id: s1.id }))!.taxAmount)).toBeCloseTo(120, 6);
    });

    test('is empty for a product with no sales', async () => {
        const brand = await models.brand.create({ name: 'B' });
        const product = await models.product.create({ name: 'Bare', sku: 'S-2', brandId: brand.id });
        const p = await models.product.findOne({ id: product.id });
        expect(num(p!.totalUnitsSold)).toBe(0);
        expect(num(p!.averageSalePrice)).toBe(0);
    });
});
