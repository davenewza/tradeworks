// Action-level coverage for the product page's "Prices by channel" view. The
// Console embeds listProductPricesForProduct on the product page and links to it
// from "View all prices", so what matters here is the shape the Console relies
// on: only that product's rows, grouped by channel and then price list.

import { actions, models, resetDatabase } from '@teamkeel/testing';
import { beforeEach, describe, expect, test } from 'vitest';

beforeEach(resetDatabase);

// Two products priced across two channels plus a channel-less price list. Names
// are chosen so alphabetical order is unambiguous under any collation.
async function seed() {
    const brand = await models.brand.create({ name: 'Brand' });
    const product = await models.product.create({ name: 'Rivet Nut Kit', sku: 'UR-FS292', brandId: brand.id });
    const other = await models.product.create({ name: 'Other product', sku: 'OTHER-1', brandId: brand.id });

    const takealot = await models.channel.create({ name: 'Takealot Marketplace' });
    const direct = await models.channel.create({ name: 'Direct Store' });

    const takealotRetail = await models.priceList.create({ name: 'Takealot Retail', channelId: takealot.id });
    const takealotPromo = await models.priceList.create({ name: 'Takealot Promo', channelId: takealot.id });
    const directList = await models.priceList.create({ name: 'Direct Retail', channelId: direct.id });
    const noChannel = await models.priceList.create({ name: 'Wholesale' });

    await models.productPrice.create({ productId: product.id, priceListId: takealotRetail.id, priceInclVat: 716.76 });
    await models.productPrice.create({ productId: product.id, priceListId: takealotPromo.id, priceInclVat: 650 });
    await models.productPrice.create({ productId: product.id, priceListId: directList.id, priceInclVat: 600 });
    await models.productPrice.create({ productId: product.id, priceListId: noChannel.id, priceInclVat: 500 });
    // Same price list, different product — must not appear on this product's page.
    await models.productPrice.create({ productId: other.id, priceListId: takealotRetail.id, priceInclVat: 99 });

    const identity = await models.identity.create({ email: 'ops@tradeworks.test' });
    return { product, identity };
}

describe('listProductPricesForProduct', () => {
    test('returns only that product\'s prices, grouped by channel then price list', async () => {
        const { product, identity } = await seed();

        const { results } = await actions.withIdentity(identity).listProductPricesForProduct({
            where: { product: { id: { equals: product.id } } },
        });

        expect(results.every((r) => r.productId === product.id)).toBe(true);
        // Channels alphabetically, price lists alphabetically within a channel, and
        // price lists with no channel last.
        expect(results.map((r) => [r.priceListChannelName, r.priceListName])).toEqual([
            ['Direct Store', 'Direct Retail'],
            ['Takealot Marketplace', 'Takealot Promo'],
            ['Takealot Marketplace', 'Takealot Retail'],
            [null, 'Wholesale'],
        ]);
        expect(results.map((r) => Number(r.priceInclVat))).toEqual([600, 650, 716.76, 500]);
    });

    test('requires an authenticated caller', async () => {
        const { product } = await seed();
        await expect(
            actions.listProductPricesForProduct({ where: { product: { id: { equals: product.id } } } }),
        ).rejects.toThrow();
    });
});
