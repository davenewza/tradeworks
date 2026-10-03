// Suppliers and the supplier price on a product: suppliers come from Zoho
// vendors (see lib/zohoVendorHelpers.test.ts); operators set their lead times,
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
    test('an operator edits the lead time, currency and notes; the Zoho link and name stay put', async () => {
        const uk = await models.supplier.create({ name: 'UK Tools Ltd', zohoVendorId: 'zv-1', currency: Currency.GBP });
        expect(uk).toMatchObject({ currency: Currency.GBP, leadTimeInDays: 60 });
        const authed = await operator();

        const updated = await authed.updateSupplier({
            where: { id: uk.id },
            values: { leadTimeInDays: 75, notes: 'Sea freight', currency: Currency.EUR },
        });
        expect(updated).toMatchObject({
            name: 'UK Tools Ltd', zohoVendorId: 'zv-1', currency: Currency.EUR, leadTimeInDays: 75, notes: 'Sea freight',
        });
        expect(await ruleViolated(authed.updateSupplier({ where: { id: uk.id }, values: { leadTimeInDays: 0 } }))).toBe(
            "A supplier's lead time should be at least 1 day",
        );
    });

    test('a Zoho vendor links to at most one supplier', async () => {
        await models.supplier.create({ name: 'One', zohoVendorId: 'zv-1' });
        await expect(models.supplier.create({ name: 'Two', zohoVendorId: 'zv-1' })).rejects.toThrow();
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
        const supplier = await models.supplier.create({ name: 'Nope', zohoVendorId: 'zv-9' });
        await expect(actions.listSuppliers()).rejects.toThrow();
        await expect(actions.updateSupplier({ where: { id: supplier.id }, values: { notes: 'x' } })).rejects.toThrow();
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
