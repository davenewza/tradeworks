// Covers the Product measures behind the Stock cover dashboard — stockCover
// (pooled months of cover) and stockValue (capital tied up at landed cost) —
// through the stockCoverByClass aggregate, which renders the same measures the
// dashboard's charts query.

import { actions, models, resetDatabase } from '@teamkeel/testing';
import { AbcClass, Team } from '@teamkeel/sdk';
import { beforeEach, describe, expect, test } from 'vitest';

beforeEach(resetDatabase);

async function operator() {
    const email = 'ops@tradeworks.test';
    const user = await models.user.create({ email, teams: [Team.Warehouse] });
    return actions.withIdentity(await models.identity.create({ email, userId: user.id }));
}

// One supplier bill per product, so its weighted landed cost is that bill's unit cost.
async function costAt(productId: string, unitCost: number) {
    const bill = await models.supplierBill.create({ billNumber: `B-${productId}`, date: new Date() });
    await models.productCostLine.create({ productId, supplierBillId: bill.id, unitCost, quantity: 100, zohoRecordId: `z-${productId}` });
}

//  class  product  brand  stock  est/month  landed cost  value
//  A      Anvil    Acme      10         10            5     50
//  A      Drill    Bolt     135         30            2    270
//  B      Bellows  Acme      50         20           10    500
//  B      Bent     Acme      -5          5           10      —  (negative stock holds no capital)
//  C      Crate    Acme      20          0            —      0  (no sales rate, no cost history)
//  —      Edger    Bolt       3          —            —      0
//  A      Zombie   Acme    1000          1            9      —  (disabled: never counted)
async function seed() {
    const acme = await models.brand.create({ name: 'Acme' });
    const bolt = await models.brand.create({ name: 'Bolt' });
    const product = (name: string, brandId: string, abcClass: AbcClass | null, stockAvailable: number, estimatedMonthlySale: number | null, isActive = true) =>
        models.product.create({ name, sku: name.toUpperCase(), brandId, abcClass, stockAvailable, estimatedMonthlySale, isActive });

    await costAt((await product('Anvil', acme.id, AbcClass.A, 10, 10)).id, 5);
    await costAt((await product('Drill', bolt.id, AbcClass.A, 135, 30)).id, 2);
    await costAt((await product('Bellows', acme.id, AbcClass.B, 50, 20)).id, 10);
    await costAt((await product('Bent', acme.id, AbcClass.B, -5, 5)).id, 10);
    await product('Crate', acme.id, AbcClass.C, 20, 0);
    await product('Edger', bolt.id, null, 3, null);
    await costAt((await product('Zombie', acme.id, AbcClass.A, 1000, 1, false)).id, 9);

    return { acme, bolt };
}

type Row = { group: unknown[]; measures: { stockCover: number | null; stockValue: number | null } };

function byClass(res: { results: Row[] }) {
    return Object.fromEntries(res.results.map((r) => [String(r.group[0]), r.measures]));
}

describe('stockCoverByClass', () => {
    test('pools cover across a class as total stock ÷ total monthly sales', async () => {
        await seed();
        const classes = byClass(await (await operator()).stockCoverByClass({ where: {} }));

        expect(Object.keys(classes)).toEqual(['A', 'B', 'C', 'null']);
        // 145 ÷ 40, not the 2.75 mean of Anvil's 1.0 and Drill's 4.5 months.
        expect(Number(classes.A.stockCover)).toBeCloseTo(145 / 40, 6);
        // Negative stock still counts against cover: (50 − 5) ÷ 25.
        expect(Number(classes.B.stockCover)).toBeCloseTo(45 / 25, 6);
        // No sales rate means no cover, rather than a division-by-zero error.
        expect(classes.C.stockCover).toBeNull();
        expect(classes.null.stockCover).toBeNull();
    });

    test('values stock on hand at landed cost, leaving out negative stock', async () => {
        await seed();
        const classes = byClass(await (await operator()).stockCoverByClass({ where: {} }));

        expect(Number(classes.A.stockValue)).toBeCloseTo(50 + 270, 6);
        expect(Number(classes.B.stockValue)).toBeCloseTo(500, 6);
        expect(Number(classes.C.stockValue)).toBeCloseTo(0, 6);
    });

    test('narrows to one brand', async () => {
        const { bolt } = await seed();
        const classes = byClass(await (await operator()).stockCoverByClass({ where: { brand: { id: { equals: bolt.id } } } }));

        expect(Object.keys(classes)).toEqual(['A', 'null']);
        expect(Number(classes.A.stockCover)).toBeCloseTo(135 / 30, 6);
        expect(Number(classes.A.stockValue)).toBeCloseTo(270, 6);
    });

    test('is for operators only', async () => {
        await seed();
        await expect(actions.stockCoverByClass({ where: {} })).toHaveAuthorizationError();
    });
});
