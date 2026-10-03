// Suppliers and the supplier price on a product: operators create suppliers,
// assign products to them and record what each charges, in its own currency.

import { actions, models, resetDatabase } from '@teamkeel/testing';
import { Currency, Team } from '@teamkeel/sdk';
import { beforeEach, describe, expect, test } from 'vitest';

beforeEach(resetDatabase);

// A model-level @validate rejects with a generic message; the rule's own
// message rides in data.errors.
async function ruleViolated(call: Promise<unknown>): Promise<string> {
    const err: any = await call.then(
        () => {
            throw new Error('expected the write to be rejected');
        },
        (e) => e,
    );
    expect(err.code).toBe('ERR_CONFLICT');
    return err.data.errors[0].error;
}

// Roles come from team membership on User, so an operator is a User in the
// Warehouse team plus an Identity pointing at it.
async function operator() {
    const email = 'ops@tradeworks.test';
    const user = await models.user.create({ email, teams: [Team.Warehouse] });
    return actions.withIdentity(await models.identity.create({ email, userId: user.id }));
}

describe('suppliers', () => {
    test('an operator creates a supplier, defaulting to rand and a 60-day lead time', async () => {
        const authed = await operator();
        const local = await authed.createSupplier({ name: 'Local Co' });
        expect(local).toMatchObject({ currency: Currency.ZAR, leadTimeInDays: 60 });

        const uk = await authed.createSupplier({ name: 'UK Tools Ltd', currency: Currency.GBP, leadTimeInDays: 90 });
        const updated = await authed.updateSupplier({ where: { id: uk.id }, values: { leadTimeInDays: 75, notes: 'Sea freight' } });
        expect(updated).toMatchObject({ currency: Currency.GBP, leadTimeInDays: 75, notes: 'Sea freight' });

        const { results } = await authed.listSuppliers();
        expect(results.map((s) => s.name)).toEqual(['Local Co', 'UK Tools Ltd']);
    });

    test('names are unique and lead times must be at least a day', async () => {
        const authed = await operator();
        await authed.createSupplier({ name: 'Dup' });
        await expect(authed.createSupplier({ name: 'Dup' })).rejects.toThrow();
        expect(await ruleViolated(authed.createSupplier({ name: 'Zero', leadTimeInDays: 0 }))).toBe(
            "A supplier's lead time should be at least 1 day",
        );
    });

    test('counts its active products, whichever brand they are', async () => {
        const supplier = await models.supplier.create({ name: 'Distributor' });
        const a = await models.brand.create({ name: 'A' });
        const b = await models.brand.create({ name: 'B' });
        await models.product.create({ name: 'A1', sku: 'A1', brandId: a.id, supplierId: supplier.id });
        await models.product.create({ name: 'B1', sku: 'B1', brandId: b.id, supplierId: supplier.id });
        await models.product.create({ name: 'B2', sku: 'B2', brandId: b.id, supplierId: supplier.id, isActive: false });

        const fetched = await (await operator()).getSupplier({ id: supplier.id });
        expect(fetched!.totalProducts).toBe(2);
    });

    test('requires an operator', async () => {
        await expect(actions.listSuppliers()).rejects.toThrow();
        await expect(actions.createSupplier({ name: 'Nope' })).rejects.toThrow();
    });
});

describe('updateProductSupplier', () => {
    async function seed() {
        const brand = await models.brand.create({ name: 'Acme' });
        const supplier = await models.supplier.create({ name: 'Acme Ltd', currency: Currency.USD });
        const product = await models.product.create({ name: 'Widget', sku: 'W-1', brandId: brand.id });
        return { supplier, product };
    }

    test('assigns a supplier and records its price with a currency', async () => {
        const { supplier, product } = await seed();
        const updated = await (await operator()).updateProductSupplier({
            where: { id: product.id },
            values: { supplier: { id: supplier.id }, supplierUnitCost: 12.5, supplierCurrency: Currency.USD },
        });
        expect(updated).toMatchObject({ supplierId: supplier.id, supplierUnitCost: 12.5, supplierCurrency: Currency.USD });
    });

    test('rejects a price without a currency, and a negative price', async () => {
        const { supplier, product } = await seed();
        const authed = await operator();

        expect(
            await ruleViolated(
                authed.updateProductSupplier({ where: { id: product.id }, values: { supplier: { id: supplier.id }, supplierUnitCost: 12.5 } }),
            ),
        ).toBe('A supplier price should have a currency');
        expect(
            await ruleViolated(
                authed.updateProductSupplier({ where: { id: product.id }, values: { supplierUnitCost: -1, supplierCurrency: Currency.USD } }),
            ),
        ).toBe('A supplier price should not be negative');
    });

    test('products without a supplier are listed until one is assigned', async () => {
        const { supplier, product } = await seed();
        const brand = await models.brand.create({ name: 'Off' });
        await models.product.create({ name: 'Retired', sku: 'R-1', brandId: brand.id, isActive: false });
        const authed = await operator();

        expect((await authed.listProductsWithoutSupplier()).results.map((p) => p.sku)).toEqual(['W-1']);
        await authed.updateProductSupplier({ where: { id: product.id }, values: { supplier: { id: supplier.id } } });
        expect((await authed.listProductsWithoutSupplier()).results).toEqual([]);
    });
});
