import { models, resetDatabase } from '@teamkeel/testing';
import { FeeMethod } from '@teamkeel/sdk';
import { beforeEach, describe, expect, test } from 'vitest';

// Exercises the channel-scoped computed pricing chain on ProductPrice end-to-end
// (real migrations + DB triggers), not a lib function.

beforeEach(resetDatabase);

const num = (v: unknown) => Number(v);

async function createBill(billNumber: string, date: Date | null = null) {
    return await models.supplierBill.create({ zohoBillId: `zb-${billNumber}`, billNumber, date, zohoModifiedAt: new Date() });
}

let lineCount = 0;
async function createBillLine(
    supplierBillId: string,
    productId: string | null,
    line: { unitCost: number; quantity: number; freightIn?: number; freightAllocated?: boolean; isLandedCost?: boolean }
) {
    lineCount++;
    return await models.supplierBillLine.create({ supplierBillId, productId, zohoLineItemId: `li-${lineCount}`, position: lineCount, ...line });
}

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

    // 100 units at 193.10, with 6002 of freight allocated across them (60.02 each).
    const bill = await createBill('BILL-1', new Date('2021-02-19'));
    await createBillLine(bill.id, product.id, { unitCost: 193.1, quantity: 100, freightIn: 6002, freightAllocated: true });

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
        // No ROI target on this price list, so ad spend is zero and total costs
        // are just landed cost + channel fees.
        expect(num(pp!.adSpend)).toBe(0);
        expect(num(pp!.totalCosts)).toBeCloseTo(253.12 + 105.08, 2);
        expect(num(pp!.grossProfit)).toBeCloseTo(265.07, 2);
        // Stored as a 0–1 ratio; the Console renders it as a rounded percentage.
        expect(num(pp!.grossProfitMargin)).toBeCloseTo(0.425, 3);
    });

    test('costs ad spend from the price list ROI target, off the incl-VAT price', async () => {
        const { product, takealot } = await seed();
        const priceList = await models.priceList.create({ name: 'Takealot', channelId: takealot.id, targetAdvertisingRoi: 6 });
        const created = await models.productPrice.create({ productId: product.id, priceListId: priceList.id, priceInclVat: 716.76 });

        const pp = await models.productPrice.findOne({ id: created.id });
        expect(num(pp!.targetAdvertisingRoi)).toBeCloseTo(6, 6);
        // 6:1 on the incl-VAT price = 716.76 / 6 = 119.46 of ad spend, which is
        // billed incl VAT, so 103.88 net of VAT.
        expect(num(pp!.adSpend)).toBeCloseTo(103.88, 2);
        // Cost of goods + freight-in + channel fees + ad spend.
        expect(num(pp!.totalCosts)).toBeCloseTo(253.12 + 105.08 + 103.88, 2);
        expect(num(pp!.grossProfit)).toBeCloseTo(623.27 - (253.12 + 105.08 + 103.88), 2);
        // Margin drops from 42.5% once ad spend is costed in.
        expect(num(pp!.grossProfitMargin)).toBeCloseTo(0.259, 3);
    });

    test('a decimal ROI target is honoured', async () => {
        const { product, takealot } = await seed();
        const priceList = await models.priceList.create({ name: 'Takealot', channelId: takealot.id, targetAdvertisingRoi: 4.5 });
        const created = await models.productPrice.create({ productId: product.id, priceListId: priceList.id, priceInclVat: 1150 });

        const pp = await models.productPrice.findOne({ id: created.id });
        // 1150 / 4.5 = 255.56 incl VAT = 222.22 net of VAT.
        expect(num(pp!.adSpend)).toBeCloseTo(222.22, 2);
    });

    test('setting the ROI target re-prices existing rows via triggers', async () => {
        const { product, takealot } = await seed();
        const priceList = await models.priceList.create({ name: 'Takealot', channelId: takealot.id });
        const created = await models.productPrice.create({ productId: product.id, priceListId: priceList.id, priceInclVat: 716.76 });
        expect(num((await models.productPrice.findOne({ id: created.id }))!.adSpend)).toBe(0);

        // Set the target on the price list only — the product price row isn't touched.
        await models.priceList.update({ id: priceList.id }, { targetAdvertisingRoi: 6 });

        const pp = await models.productPrice.findOne({ id: created.id });
        expect(num(pp!.adSpend)).toBeCloseTo(103.88, 2);

        // Clearing it again takes ad spend back out of the margin.
        await models.priceList.update({ id: priceList.id }, { targetAdvertisingRoi: null });
        const cleared = await models.productPrice.findOne({ id: created.id });
        expect(num(cleared!.adSpend)).toBe(0);
        expect(num(cleared!.grossProfit)).toBeCloseTo(265.07, 2);
    });

    test('a zero ROI target costs no ad spend (no divide-by-zero)', async () => {
        const { product, takealot } = await seed();
        const priceList = await models.priceList.create({ name: 'Takealot', channelId: takealot.id, targetAdvertisingRoi: 0 });
        const created = await models.productPrice.create({ productId: product.id, priceListId: priceList.id, priceInclVat: 716.76 });

        const pp = await models.productPrice.findOne({ id: created.id });
        expect(num(pp!.adSpend)).toBe(0);
        expect(num(pp!.grossProfit)).toBeCloseTo(265.07, 2);
    });

    test('a price list with no channel resolves fees to zero', async () => {
        const { product } = await seed();
        const priceList = await models.priceList.create({ name: 'No channel' });
        const created = await models.productPrice.create({ productId: product.id, priceListId: priceList.id, priceInclVat: 716.76 });

        const pp = await models.productPrice.findOne({ id: created.id });
        expect(num(pp!.channelFees)).toBe(0);
        expect(num(pp!.totalCosts)).toBeCloseTo(253.12, 2);
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
    async function kit(sku = 'K-1') {
        const brand = (await models.brand.findMany({ where: { name: { equals: 'B' } } }))[0] ?? (await models.brand.create({ name: 'B' }));
        return await models.product.create({ name: 'Kit', sku, brandId: brand.id });
    }

    test('summarises cost, freight and volumes across supplier bills', async () => {
        const product = await kit();
        // 10 @ 100 with 600 of freight (60 each), and 30 @ 120 with 600 (20 each).
        await createBillLine((await createBill('B1')).id, product.id, { unitCost: 100, quantity: 10, freightIn: 600, freightAllocated: true });
        await createBillLine((await createBill('B2')).id, product.id, { unitCost: 120, quantity: 30, freightIn: 600, freightAllocated: true });

        const p = await models.product.findOne({ id: product.id });
        expect(num(p!.totalSupplierBills)).toBe(2);
        expect(num(p!.totalUnitsPurchased)).toBe(40);
        // (100*10 + 120*30)/40 = 115 ; (600 + 600)/40 = 30
        expect(num(p!.weightedUnitCost)).toBeCloseTo(115, 6);
        expect(num(p!.weightedFreightIn)).toBeCloseTo(30, 6);
        expect(num(p!.weightedLandedCost)).toBeCloseTo(145, 6);
    });

    test('averages freight only over bills whose landed costs have been allocated', async () => {
        const product = await kit();
        await createBillLine((await createBill('B1')).id, product.id, { unitCost: 100, quantity: 10, freightIn: 600, freightAllocated: true });
        await createBillLine((await createBill('B2')).id, product.id, { unitCost: 120, quantity: 30, freightIn: 600, freightAllocated: true });
        // An import billed before its freight: its goods cost counts at once,
        // but it must not drag the freight average down as if it were free.
        await createBillLine((await createBill('B3')).id, product.id, { unitCost: 130, quantity: 40 });

        const p = await models.product.findOne({ id: product.id });
        // (1000 + 3600 + 5200) / 80 = 122.5 ; freight still (600 + 600) / 40 = 30
        expect(num(p!.weightedUnitCost)).toBeCloseTo(122.5, 6);
        expect(num(p!.weightedFreightIn)).toBeCloseTo(30, 6);
        expect(num(p!.weightedLandedCost)).toBeCloseTo(152.5, 6);
        expect(num(p!.totalUnitsPurchased)).toBe(80);
    });

    test('costs a product bought only on bills with no landed costs at its unit cost', async () => {
        // A local supplier: no freight is ever allocated.
        const product = await kit();
        await createBillLine((await createBill('L1')).id, product.id, { unitCost: 80, quantity: 5 });

        const p = await models.product.findOne({ id: product.id });
        expect(num(p!.weightedUnitCost)).toBe(80);
        expect(num(p!.weightedFreightIn)).toBe(0);
        expect(num(p!.weightedLandedCost)).toBe(80);
    });

    test('counts a product split across two lines of one bill as one purchase at their weighted cost', async () => {
        const product = await kit();
        const bill = await createBill('B1');
        await createBillLine(bill.id, product.id, { unitCost: 10, quantity: 30, freightIn: 60, freightAllocated: true });
        await createBillLine(bill.id, product.id, { unitCost: 14, quantity: 10, freightIn: 20, freightAllocated: true });

        const p = await models.product.findOne({ id: product.id });
        // (300 + 140) / 40 = 11 ; (60 + 20) / 40 = 2
        expect(num(p!.weightedUnitCost)).toBeCloseTo(11, 6);
        expect(num(p!.weightedFreightIn)).toBeCloseTo(2, 6);
        expect(num(p!.totalUnitsPurchased)).toBe(40);
    });

    test("ignores a bill's lines that aren't the product", async () => {
        const product = await kit();
        const bill = await createBill('B1');
        await createBillLine(bill.id, product.id, { unitCost: 50, quantity: 10, freightIn: 100, freightAllocated: true });
        // The bill's own customs charge, and another product's line.
        await createBillLine(bill.id, null, { unitCost: 300, quantity: 1, freightAllocated: true, isLandedCost: true });
        await createBillLine(bill.id, (await kit('K-2')).id, { unitCost: 999, quantity: 1, freightIn: 900, freightAllocated: true });

        const p = await models.product.findOne({ id: product.id });
        expect(num(p!.weightedUnitCost)).toBe(50);
        expect(num(p!.weightedFreightIn)).toBe(10);
        expect(num(p!.totalSupplierBills)).toBe(1);
    });

    test('feeds the bill lines through to the price', async () => {
        const product = await kit();
        await createBillLine((await createBill('B1')).id, product.id, { unitCost: 100, quantity: 10, freightIn: 250, freightAllocated: true });
        const priceList = await models.priceList.create({ name: 'Retail' });
        const created = await models.productPrice.create({ productId: product.id, priceListId: priceList.id, priceInclVat: 230 });

        const pp = await models.productPrice.findOne({ id: created.id });
        expect(num(pp!.unitCost)).toBe(100);
        expect(num(pp!.unitFreightIn)).toBe(25);
        expect(num(pp!.landedUnitCost)).toBe(125);
        // 230 incl VAT → 200 excl, less 125 landed and no channel or ad costs.
        expect(num(pp!.grossProfit)).toBeCloseTo(75, 6);
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
