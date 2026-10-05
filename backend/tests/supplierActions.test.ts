// Suppliers and their price lists: suppliers come from Zoho vendors (see
// lib/zohoVendorHelpers.test.ts) and purchase price lists from Zoho's price
// books (lib/zohoSupplierPriceListHelpers.test.ts). Operators set suppliers'
// lead times and link each price list to its supplier; a product's suppliers
// are the suppliers of the lists it is on.

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

    test('counts its price lists', async () => {
        const supplier = await models.supplier.create({ name: 'Distributor' });
        await priceList('GBP', supplier.id);
        await priceList('ZAR', supplier.id);
        await priceList('Unlinked', null);

        const fetched = await (await operator()).getSupplier({ id: supplier.id });
        expect(fetched!.totalPriceLists).toBe(2);
    });

    test('requires an operator', async () => {
        const supplier = await models.supplier.create({ name: 'Nope', zohoVendorId: 'zv-9' });
        await expect(actions.listSuppliers()).rejects.toThrow();
        await expect(actions.updateSupplier({ where: { id: supplier.id }, values: { notes: 'x' } })).rejects.toThrow();
    });
});

describe("a price list's supplier", () => {
    async function seed() {
        const brand = await models.brand.create({ name: 'Acme' });
        const supplier = await models.supplier.create({ name: 'Acme Ltd', currency: Currency.USD });
        const product = await models.product.create({ name: 'Widget', sku: 'W-1', brandId: brand.id });
        const list = await priceList('Acme (USD)', null);
        await models.supplierPriceListItem.create({ priceListId: list.id, productId: product.id, zohoItemId: 'zi-w1', rate: 12.5 });
        return { supplier, product, list };
    }

    test('links a price list to its supplier, and unlinks it', async () => {
        const { supplier, list } = await seed();
        const authed = await operator();

        const linked = await authed.updateSupplierPriceListSupplier({ where: { id: list.id }, values: { supplier: { id: supplier.id } } });
        expect(linked.supplierId).toBe(supplier.id);
        expect((await authed.listSupplierPriceLists({ where: { supplier: { id: { equals: supplier.id } } } })).results.map((l) => l.id)).toEqual([list.id]);

        const unlinked = await authed.updateSupplierPriceListSupplier({ where: { id: list.id }, values: { supplier: null } });
        expect(unlinked.supplierId).toBeNull();
    });

    test("makes the list's products the supplier's, and takes them off the without-a-supplier list", async () => {
        const { supplier, product, list } = await seed();
        const brand = await models.brand.create({ name: 'Off' });
        await models.product.create({ name: 'Retired', sku: 'R-1', brandId: brand.id, isActive: false });
        const authed = await operator();
        const supplierProducts = async () =>
            (await authed.listProducts({ where: { supplierPrices: { priceList: { supplier: { id: { equals: supplier.id } } } } } })).results.map((p) => p.sku);

        expect((await authed.listProductsWithoutSupplier()).results.map((p) => p.sku)).toEqual(['W-1']);
        expect(await supplierProducts()).toEqual([]);

        await authed.updateSupplierPriceListSupplier({ where: { id: list.id }, values: { supplier: { id: supplier.id } } });

        expect((await authed.listProductsWithoutSupplier()).results).toEqual([]);
        expect(await supplierProducts()).toEqual(['W-1']);
        expect((await models.product.findOne({ id: product.id }))!.leadTimeInDays).toBe(60);
    });

    test('requires an operator', async () => {
        const { supplier, list } = await seed();
        await expect(actions.updateSupplierPriceListSupplier({ where: { id: list.id }, values: { supplier: { id: supplier.id } } })).rejects.toThrow();
    });
});

async function priceList(name: string, supplierId: string | null) {
    return await models.supplierPriceList.create({ zohoPriceListId: `zpl-${name}`, name, currencyCode: 'USD', supplierId, zohoModifiedAt: new Date() });
}
