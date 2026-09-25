// Action-level coverage for the Console's products list: its search box finds
// a product by SKU or by name, narrows alongside the other filters, and never
// reaches past the active catalogue.

import { actions, models, resetDatabase } from '@teamkeel/testing';
import { AbcClass, Team } from '@teamkeel/sdk';
import { beforeEach, describe, expect, test } from 'vitest';

beforeEach(resetDatabase);

// Roles come from team membership on User, so an operator is a User in the
// Warehouse team plus an Identity pointing at it.
async function operator() {
    const email = 'ops@tradeworks.test';
    const user = await models.user.create({ email, teams: [Team.Warehouse] });
    return actions.withIdentity(await models.identity.create({ email, userId: user.id }));
}

async function seed() {
    const brand = await models.brand.create({ name: 'Acme' });
    await models.product.create({ name: 'Cast Iron Anvil', sku: 'ANV-100', brandId: brand.id, abcClass: AbcClass.A });
    await models.product.create({ name: 'Leather Bellows', sku: 'BLW-200', brandId: brand.id, abcClass: AbcClass.B });
    await models.product.create({ name: 'Pine Crate', sku: 'CRT-300', brandId: brand.id, abcClass: AbcClass.C });
    await models.product.create({ name: 'Iron Tongs', sku: 'TNG-400', brandId: brand.id, abcClass: AbcClass.C });
    // Inactive: must never come back from a search, however well it matches.
    await models.product.create({ name: 'Old Anvil', sku: 'ANV-999', brandId: brand.id, isActive: false });
}

type Operator = Awaited<ReturnType<typeof operator>>;

async function search(authed: Operator, term: string, where = {}) {
    const { results } = await authed.listProducts({ search: term, where });
    return results.map((r) => r.sku);
}

describe('listProducts search', () => {
    test('finds a product by its SKU', async () => {
        await seed();
        expect(await search(await operator(), 'BLW-200')).toEqual(['BLW-200']);
    });

    test('finds a product by a word in its name', async () => {
        await seed();
        expect(await search(await operator(), 'bellows')).toEqual(['BLW-200']);
    });

    test('a name match spans every active product sharing the word, in name order', async () => {
        await seed();
        expect(await search(await operator(), 'iron')).toEqual(['ANV-100', 'TNG-400']);
    });

    test('combines with the ABC class filter', async () => {
        await seed();
        const authed = await operator();
        expect(await search(authed, 'iron', { abcClass: { equals: AbcClass.C } })).toEqual(['TNG-400']);
    });

    test('leaves inactive products out', async () => {
        await seed();
        expect(await search(await operator(), 'anvil')).toEqual(['ANV-100']);
    });
});

describe('listProducts ABC class', () => {
    test('returns each product’s class and filters by it', async () => {
        await seed();
        const authed = await operator();

        const all = await authed.listProducts({});
        expect(Object.fromEntries(all.results.map((r) => [r.sku, r.abcClass]))).toEqual({
            'ANV-100': AbcClass.A,
            'BLW-200': AbcClass.B,
            'CRT-300': AbcClass.C,
            'TNG-400': AbcClass.C,
        });

        const classC = await authed.listProducts({ where: { abcClass: { equals: AbcClass.C } } });
        expect(classC.results.map((r) => r.sku)).toEqual(['TNG-400', 'CRT-300']);
    });
});
