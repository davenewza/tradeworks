// Action-level coverage for Inventory → View stock and cover: the reorder grid
// lists every active product's stock and cover figures, filters by brand, SKU,
// name, ABC class, status and either cover, and sorts on every column. The
// figures themselves are written by ScheduledSyncStock (covered alongside the
// lib helpers), so the rows are seeded here directly.

import { actions, models, resetDatabase } from '@teamkeel/testing';
import { AbcClass, StockCoverStatus, Team } from '@teamkeel/sdk';
import type { ListStockAndCoverWhere } from '@teamkeel/sdk';
import { beforeEach, describe, expect, test } from 'vitest';

beforeEach(resetDatabase);

// Roles come from team membership on User, so an operator is a User in the
// Warehouse team plus an Identity pointing at it.
async function operator() {
    const email = 'ops@tradeworks.test';
    const user = await models.user.create({ email, teams: [Team.Warehouse] });
    return actions.withIdentity(await models.identity.create({ email, userId: user.id }));
}

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

// Two brands whose lead times differ, so the same cover grades differently.
// Acme's 60 days is L = 2 months: Shortfall < 2, Low 2–3, Good 3–5, Oversupply ≥ 5.
// Bolt's 30 days is L = 1 month: Shortfall < 1, Low 1–1.5, Good 1.5–2.5, Oversupply ≥ 2.5.
// Cover = stock ÷ estimate, as the nightly job writes it. Values are distinct
// per column wherever a sort needs one right answer.
async function seed() {
    const acme = await models.brand.create({ name: 'Acme', leadTimeInDays: 60 });
    const bolt = await models.brand.create({ name: 'Bolt', leadTimeInDays: 30 });
    const channel = await models.channel.create({ name: 'Shop' });

    const anvil = await models.product.create({ name: 'Anvil', sku: 'ACME-A', brandId: acme.id, abcClass: AbcClass.A, stockAvailable: 10, stockOnWay: 0, estimatedMonthlySale: 10, currentStockCover: 1.0, totalStockCover: 1.0 });
    await models.product.create({ name: 'Bellows', sku: 'ACME-B', brandId: acme.id, abcClass: AbcClass.B, stockAvailable: 50, stockOnWay: 10, estimatedMonthlySale: 20, currentStockCover: 2.5, totalStockCover: 3.0 });
    await models.product.create({ name: 'Crate', sku: 'ACME-C', brandId: acme.id, abcClass: AbcClass.C, stockAvailable: 20, stockOnWay: 5, estimatedMonthlySale: 5, currentStockCover: 4.0, totalStockCover: 5.0 });
    const drill = await models.product.create({ name: 'Drill', sku: 'BOLT-D', brandId: bolt.id, abcClass: AbcClass.A, stockAvailable: 135, stockOnWay: 60, estimatedMonthlySale: 30, currentStockCover: 4.5, totalStockCover: 6.5 });
    // Never sold: no estimate, so cover, class and status are all blank.
    await models.product.create({ name: 'Edger', sku: 'BOLT-E', brandId: bolt.id, stockAvailable: 3 });
    // Inactive products never appear, however alarming their figures.
    await models.product.create({ name: 'Zombie', sku: 'ACME-Z', brandId: acme.id, isActive: false, currentStockCover: 0.5, totalStockCover: 0.5 });

    // Lifetime sales feed the "Total sales" column.
    await models.sale.create({ invoiceNumber: 'I1', lineItemId: 'L1', lineKey: 'L1', channelId: channel.id, date: daysAgo(30), productId: anvil.id, quantity: 12, price: 10 });
    await models.sale.create({ invoiceNumber: 'I2', lineItemId: 'L2', lineKey: 'L2', channelId: channel.id, date: daysAgo(20), productId: drill.id, quantity: 3, price: 10 });

    return { acme, bolt };
}

type Operator = Awaited<ReturnType<typeof operator>>;

async function skus(authed: Operator, where: ListStockAndCoverWhere) {
    const { results } = await authed.listStockAndCover({ where });
    return results.map((r) => r.sku);
}

// Every column the grid can be ordered by — must match the action's @sortable.
const SORTABLE = [
    'sku',
    'name',
    'abcClass',
    'totalUnitsSold',
    'stockAvailable',
    'stockOnWay',
    'estimatedMonthlySale',
    'currentStockCover',
    'totalStockCover',
    'stockCoverStatus',
] as const;

describe('listStockAndCover', () => {
    test('lists every active product by name, with cover graded against its brand lead time', async () => {
        await seed();
        const { results } = await (await operator()).listStockAndCover();

        expect(results.map((r) => [r.sku, r.currentStockCover, r.totalStockCover, r.stockCoverStatus])).toEqual([
            ['ACME-A', 1, 1, StockCoverStatus.InsufficientSupply],
            ['ACME-B', 2.5, 3, StockCoverStatus.LowSupply],
            ['ACME-C', 4, 5, StockCoverStatus.GoodSupply],
            ['BOLT-D', 4.5, 6.5, StockCoverStatus.Oversupply],
            ['BOLT-E', null, null, null],
        ]);
        const bySku = Object.fromEntries(results.map((r) => [r.sku, r]));
        expect(bySku['ACME-A'].totalUnitsSold).toBe(12);
        expect(bySku['BOLT-D'].totalUnitsSold).toBe(3);
    });

    test('filters by brand, SKU and name', async () => {
        const { acme } = await seed();
        const authed = await operator();

        expect(await skus(authed, { brand: { id: { equals: acme.id } } })).toEqual(['ACME-A', 'ACME-B', 'ACME-C']);
        expect(await skus(authed, { sku: { startsWith: 'BOLT' } })).toEqual(['BOLT-D', 'BOLT-E']);
        expect(await skus(authed, { name: { contains: 'ell' } })).toEqual(['ACME-B']);
    });

    test('filters by ABC class and by the computed cover status', async () => {
        await seed();
        const authed = await operator();

        expect(await skus(authed, { abcClass: { equals: AbcClass.A } })).toEqual(['ACME-A', 'BOLT-D']);
        expect(await skus(authed, { abcClass: { oneOf: [AbcClass.B, AbcClass.C] } })).toEqual(['ACME-B', 'ACME-C']);
        expect(await skus(authed, { stockCoverStatus: { equals: StockCoverStatus.InsufficientSupply } })).toEqual(['ACME-A']);
        expect(
            await skus(authed, { stockCoverStatus: { oneOf: [StockCoverStatus.InsufficientSupply, StockCoverStatus.LowSupply] } }),
        ).toEqual(['ACME-A', 'ACME-B']);
    });

    test('filters by current and total cover, alone and combined with a brand', async () => {
        const { bolt } = await seed();
        const authed = await operator();

        // A product with no estimate has no cover, so a cover filter leaves it out.
        expect(await skus(authed, { currentStockCover: { lessThan: 3 } })).toEqual(['ACME-A', 'ACME-B']);
        expect(await skus(authed, { totalStockCover: { greaterThanOrEquals: 5 } })).toEqual(['ACME-C', 'BOLT-D']);
        expect(await skus(authed, { currentStockCover: { greaterThanOrEquals: 2, lessThan: 4.5 } })).toEqual(['ACME-B', 'ACME-C']);
        expect(await skus(authed, { brand: { id: { equals: bolt.id } }, currentStockCover: { greaterThan: 4 } })).toEqual(['BOLT-D']);
    });

    test('orders by shortest cover first, the reorder view\'s natural sort', async () => {
        await seed();
        const { results } = await (await operator()).listStockAndCover({ orderBy: [{ currentStockCover: 'asc' }] });
        expect(results.filter((r) => r.currentStockCover !== null).map((r) => r.sku)).toEqual(['ACME-A', 'ACME-B', 'ACME-C', 'BOLT-D']);
    });

    test.each(SORTABLE)('orders by %s in either direction', async (field) => {
        await seed();
        const authed = await operator();

        for (const direction of ['asc', 'desc'] as const) {
            const { results } = await authed.listStockAndCover({ orderBy: [{ [field]: direction } as any] });
            expect(results).toHaveLength(5);
            // Blank cells may land at either end depending on direction, so the
            // check is on the ordering of the values that are present.
            const values = results.map((r) => r[field]).filter((v) => v !== null && v !== undefined);
            const expected = [...values].sort((a, b) => (a! < b! ? -1 : a! > b! ? 1 : 0));
            if (direction === 'desc') expected.reverse();
            expect(values).toEqual(expected);
        }
    });

    test('requires an operator', async () => {
        await seed();
        await expect(actions.listStockAndCover()).rejects.toThrow();
        const stranger = await models.identity.create({ email: 'stranger@tradeworks.test' });
        await expect(actions.withIdentity(stranger).listStockAndCover()).rejects.toThrow();
    });
});
