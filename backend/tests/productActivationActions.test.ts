// Action-level coverage for what an inactive product means at the API boundary.
//
// isActive belongs to Zoho: no action writes it, only SyncProducts does. So
// these tests set it through the models API — as the sync does — and pin the
// consequence, which is that the product leaves every list and count an
// operator works from while staying readable on its own page.

import { actions, models, resetDatabase } from '@teamkeel/testing';
import { Team } from '@teamkeel/sdk';
import { beforeEach, describe, expect, test } from 'vitest';

// Roles come from team membership, which lives on User rather than Identity, so
// an operator is a User in the Warehouse team plus an Identity pointing at it.
let operatorSeq = 0;

async function operator() {
    const email = `ops-${++operatorSeq}@tradeworks.test`;
    const user = await models.user.create({ email, teams: [Team.Warehouse] });
    return await models.identity.create({ email, userId: user.id });
}

describe('product activation', () => {
    beforeEach(resetDatabase);

    test('a deactivated product leaves listProducts and turns up in listInactiveProducts', async () => {
        const authed = actions.withIdentity(await operator());
        const brand = await models.brand.create({ name: 'Acme' });
        const widget = await models.product.create({ name: 'Widget', sku: 'A-1', brandId: brand.id });
        await models.product.create({ name: 'Gadget', sku: 'A-2', brandId: brand.id });

        await models.product.update({ id: widget.id }, { isActive: false });

        const live = await authed.listProducts({});
        expect(live.results.map((p) => p.sku)).toEqual(['A-2']);

        const inactive = await authed.listInactiveProducts({});
        expect(inactive.results.map((p) => p.sku)).toEqual(['A-1']);
    });

    test('updateProduct cannot be used to change status', async () => {
        // The only guard that matters: no action exposes isActive, so a rename
        // through the API leaves an inactive product inactive. (Passing
        // isActive here would not compile — updateProduct does not accept it.)
        const authed = actions.withIdentity(await operator());
        const brand = await models.brand.create({ name: 'Acme' });
        const widget = await models.product.create({
            name: 'Widget',
            sku: 'B-1',
            brandId: brand.id,
            isActive: false,
        });

        await authed.updateProduct({ where: { id: widget.id }, values: { name: 'Renamed' } });

        const stored = await models.product.findOne({ id: widget.id });
        expect(stored!.name).toBe('Renamed');
        expect(stored!.isActive).toBe(false);
        expect((await authed.listProducts({})).results).toEqual([]);
    });

    test('listInactiveProducts filters within the inactive set, never outside it', async () => {
        const authed = actions.withIdentity(await operator());
        const acme = await models.brand.create({ name: 'Acme' });
        const other = await models.brand.create({ name: 'Other' });
        await models.product.create({ name: 'Off Acme', sku: 'C-1', brandId: acme.id, isActive: false });
        await models.product.create({ name: 'Off Other', sku: 'C-2', brandId: other.id, isActive: false });
        // Active, and on the brand being filtered for — must not appear.
        await models.product.create({ name: 'Live Acme', sku: 'C-3', brandId: acme.id });

        const byBrand = await authed.listInactiveProducts({ where: { brand: { id: { equals: acme.id } } } });
        expect(byBrand.results.map((p) => p.sku)).toEqual(['C-1']);
    });

    test("a brand's product count drops when one of its products is deactivated", async () => {
        const authed = actions.withIdentity(await operator());
        const brand = await models.brand.create({ name: 'Acme' });
        const widget = await models.product.create({ name: 'Widget', sku: 'D-1', brandId: brand.id });
        await models.product.create({ name: 'Gadget', sku: 'D-2', brandId: brand.id });

        expect((await authed.getBrand({ id: brand.id }))!.totalProducts).toBe(2);

        await models.product.update({ id: widget.id }, { isActive: false });

        expect((await authed.getBrand({ id: brand.id }))!.totalProducts).toBe(1);
    });

    test('an inactive product drops out of the price list view and its count', async () => {
        const authed = actions.withIdentity(await operator());
        const brand = await models.brand.create({ name: 'Acme' });
        const widget = await models.product.create({ name: 'Widget', sku: 'E-1', brandId: brand.id });
        const gadget = await models.product.create({ name: 'Gadget', sku: 'E-2', brandId: brand.id });
        const priceList = await models.priceList.create({ name: 'Retail' });
        await models.productPrice.create({ productId: widget.id, priceListId: priceList.id, priceInclVat: 100 });
        await models.productPrice.create({ productId: gadget.id, priceListId: priceList.id, priceInclVat: 200 });

        await models.product.update({ id: widget.id }, { isActive: false });

        const prices = await authed.listProductPrices({ where: { priceList: { id: { equals: priceList.id } } } });
        expect(prices.results.map((p) => p.productSku)).toEqual(['E-2']);

        expect((await authed.getPriceList({ id: priceList.id }))!.numberOfProducts).toBe(1);
    });

    test("an inactive product's own page still shows its prices", async () => {
        // The product page is the one place an inactive product is meant to be
        // readable — otherwise there is no way to see what it was priced at
        // before deciding whether to bring it back.
        const authed = actions.withIdentity(await operator());
        const brand = await models.brand.create({ name: 'Acme' });
        const widget = await models.product.create({
            name: 'Widget',
            sku: 'F-1',
            brandId: brand.id,
            isActive: false,
        });
        const priceList = await models.priceList.create({ name: 'Retail' });
        await models.productPrice.create({ productId: widget.id, priceListId: priceList.id, priceInclVat: 100 });

        const prices = await authed.listProductPricesForProduct({ where: { product: { id: { equals: widget.id } } } });
        expect(prices.results).toHaveLength(1);
    });
});
