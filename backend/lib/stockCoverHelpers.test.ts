import { models, resetDatabase } from '@teamkeel/testing';
import { beforeEach, describe, expect, test } from 'vitest';
import { estimatedMonthlySale, loadSaleAggregates, monthsActive } from './stockCoverHelpers';

const num = (v: unknown) => Number(v);
const NOW = new Date('2026-08-19T00:00:00Z');

describe('monthsActive', () => {
    test('floors at 1 month for brand-new or unknown products', () => {
        expect(monthsActive(null, NOW)).toBe(1);
        expect(monthsActive(new Date('2026-08-15T00:00:00Z'), NOW)).toBe(1); // 4 days
    });

    test('caps at 12 months for long-established products', () => {
        expect(monthsActive(new Date('2020-01-01T00:00:00Z'), NOW)).toBe(12);
    });

    test('is the elapsed months in between', () => {
        // ~3 months of history → divide the window by ~3, not 12.
        expect(monthsActive(new Date('2026-05-19T00:00:00Z'), NOW)).toBeCloseTo(3, 1);
    });
});

describe('estimatedMonthlySale', () => {
    test('established product: window units ÷ 12', () => {
        expect(
            estimatedMonthlySale({ productId: 'x', unitsLast365: 120, firstSaleDate: new Date('2020-01-01T00:00:00Z') }, NOW),
        ).toBeCloseTo(10, 6);
    });

    test('new product: window units ÷ its shorter active span (not understated)', () => {
        const firstSale = new Date('2026-05-19T00:00:00Z');
        expect(estimatedMonthlySale({ productId: 'x', unitsLast365: 60, firstSaleDate: firstSale }, NOW)).toBeCloseTo(
            60 / monthsActive(firstSale, NOW),
            6,
        );
        // Sold only a few days → floored to 1 month, so the estimate is the raw units.
        expect(
            estimatedMonthlySale({ productId: 'x', unitsLast365: 20, firstSaleDate: new Date('2026-08-15T00:00:00Z') }, NOW),
        ).toBe(20);
    });

    test('nothing sold in the window → 0 (drives cover to blank)', () => {
        expect(
            estimatedMonthlySale({ productId: 'x', unitsLast365: 0, firstSaleDate: new Date('2020-01-01T00:00:00Z') }, NOW),
        ).toBe(0);
    });
});

describe('loadSaleAggregates', () => {
    beforeEach(resetDatabase);

    test('sums only in-window units and finds the earliest sale per product', async () => {
        const brand = await models.brand.create({ name: 'B' });
        const p1 = await models.product.create({ name: 'P1', sku: 'AGG-1', brandId: brand.id });
        const p2 = await models.product.create({ name: 'P2', sku: 'AGG-2', brandId: brand.id });
        const channel = await models.channel.create({ name: 'C' });

        const windowStart = new Date(NOW.getTime() - 365 * 24 * 60 * 60 * 1000); // ~2025-08-19

        // p1: an old sale (outside the window) plus one inside it.
        await models.sale.create({ invoiceNumber: 'I1', lineItemId: 'L1', lineKey: 'L1', channelId: channel.id, date: new Date('2023-01-01'), productId: p1.id, quantity: 100, price: 1 });
        await models.sale.create({ invoiceNumber: 'I2', lineItemId: 'L2', lineKey: 'L2', channelId: channel.id, date: new Date('2026-06-01'), productId: p1.id, quantity: 5, price: 1 });
        // p2: two sales, both inside the window.
        await models.sale.create({ invoiceNumber: 'I3', lineItemId: 'L3', lineKey: 'L3', channelId: channel.id, date: new Date('2026-01-10'), productId: p2.id, quantity: 2, price: 1 });
        await models.sale.create({ invoiceNumber: 'I4', lineItemId: 'L4', lineKey: 'L4', channelId: channel.id, date: new Date('2026-03-10'), productId: p2.id, quantity: 3, price: 1 });

        const byId = new Map((await loadSaleAggregates(windowStart)).map((a) => [a.productId, a]));

        // p1: the 100-unit sale predates the window and is excluded; first sale is still the old date.
        expect(num(byId.get(p1.id)!.unitsLast365)).toBe(5);
        expect(byId.get(p1.id)!.firstSaleDate!.getTime()).toBeLessThan(windowStart.getTime());
        // p2: both sales counted; first sale falls inside the window.
        expect(num(byId.get(p2.id)!.unitsLast365)).toBe(5);
        expect(byId.get(p2.id)!.firstSaleDate!.getTime()).toBeGreaterThanOrEqual(windowStart.getTime());
    });
});

describe('Product stock cover (computed schema fields)', () => {
    beforeEach(resetDatabase);

    test('current cover = available ÷ estimate; total cover adds stock on way', async () => {
        const brand = await models.brand.create({ name: 'B' });
        const product = await models.product.create({
            name: 'P', sku: 'SC-1', brandId: brand.id,
            stockAvailable: 76, estimatedMonthlySale: 6, stockOnWay: 12,
        });

        const p = await models.product.findOne({ id: product.id });
        expect(num(p!.currentStockCover)).toBeCloseTo(76 / 6, 4);
        expect(num(p!.totalStockCover)).toBeCloseTo((76 + 12) / 6, 4);
    });

    test('a zero monthly estimate yields null cover (no divide-by-zero)', async () => {
        const brand = await models.brand.create({ name: 'B' });
        const product = await models.product.create({
            name: 'P', sku: 'SC-2', brandId: brand.id,
            stockAvailable: 20, estimatedMonthlySale: 0,
        });

        const p = await models.product.findOne({ id: product.id });
        expect(p!.currentStockCover).toBeNull();
        expect(p!.totalStockCover).toBeNull();
    });

    test('unknown stock leaves cover null even with an estimate', async () => {
        const brand = await models.brand.create({ name: 'B' });
        const product = await models.product.create({
            name: 'P', sku: 'SC-3', brandId: brand.id,
            estimatedMonthlySale: 5,
        });

        const p = await models.product.findOne({ id: product.id });
        expect(p!.currentStockCover).toBeNull();
        expect(p!.totalStockCover).toBeNull();
    });
});
