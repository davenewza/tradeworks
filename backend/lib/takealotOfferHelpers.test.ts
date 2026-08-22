import { models, resetDatabase } from '@teamkeel/testing';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
    TakealotCtx,
    TakealotOffer,
    fetchOfferBySku,
    fetchAllOffers,
    computeBarcodeSyncPlan,
    applyBarcodeSync,
    syncProductBarcodeFromTakealot,
} from './takealotOfferHelpers';
import { TAKEALOT_CHANNEL_NAME } from './zohoChannelFeeHelpers';

beforeEach(resetDatabase);
afterEach(() => vi.unstubAllGlobals());

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ctx: TakealotCtx = {
    env: { TAKEALOT_API_BASE_URL: 'https://takealot.test' },
    secrets: { TAKEALOT_API_KEY: 'test-key' },
};

// The label barcode lives in product_label; the merchant `barcode` field is a
// distractor the sync must ignore (see mptalOffer).
function offer(sku: string, label: string | null): TakealotOffer {
    return { sku, product_label: label };
}

// An offer as Takealot actually returns it for placeholder-barcoded stock: the
// real label EAN in product_label, an MPTAL placeholder in barcode.
function mptalOffer(sku: string, label: string | null): TakealotOffer {
    return { sku, product_label: label, barcode: 'MPTAL75747951' };
}

async function createProduct(sku: string, name = `Product ${sku}`, isEnabled = true) {
    const brand = await models.brand.create({ name: 'Test Brand' });
    return await models.product.create({ name, sku, brandId: brand.id, isEnabled });
}

async function createTakealotChannel() {
    return await models.channel.create({ name: TAKEALOT_CHANNEL_NAME });
}

async function codesForProduct(productId: string) {
    return await models.productChannelCode.findMany({ where: { productId } });
}

// Stub global fetch, routing each request URL through a handler. 404s get an
// empty body, matching the API's not-found behaviour.
function stubFetch(handler: (url: string) => { status: number; body?: unknown }) {
    const impl = vi.fn(async (input: unknown) => {
        const { status, body } = handler(String(input));
        return new Response(status === 404 ? '' : JSON.stringify(body ?? {}), { status });
    });
    vi.stubGlobal('fetch', impl);
    return impl;
}

// ─── fetchOfferBySku ────────────────────────────────────────────────────────

describe('fetchOfferBySku', () => {
    test('returns the offer and encodes the SKU into the path', async () => {
        const impl = stubFetch(() => ({ status: 200, body: offer('SKU 1', '6001234567893') }));

        const result = await fetchOfferBySku(ctx, 'SKU 1');

        expect(result).toEqual({ sku: 'SKU 1', product_label: '6001234567893' });
        expect(impl).toHaveBeenCalledWith(
            'https://takealot.test/v1/offers/by_sku/SKU%201',
            expect.objectContaining({ headers: expect.objectContaining({ 'X-API-Key': 'test-key' }) })
        );
    });

    test('returns null on 404 — the product simply is not listed', async () => {
        stubFetch(() => ({ status: 404 }));

        expect(await fetchOfferBySku(ctx, 'MISSING')).toBeNull();
    });

    test('throws on any other error status', async () => {
        stubFetch(() => ({ status: 500, body: { error: 'boom' } }));

        await expect(fetchOfferBySku(ctx, 'SKU-1')).rejects.toThrow('500');
    });
});

// ─── fetchAllOffers ─────────────────────────────────────────────────────────

describe('fetchAllOffers', () => {
    test('walks continuation tokens across pages and aggregates the items', async () => {
        const impl = stubFetch((url) => {
            if (url.includes('continuation_token=page-2')) {
                return { status: 200, body: { items: [offer('C', '3')] } };
            }
            return {
                status: 200,
                body: { items: [offer('A', '1'), offer('B', '2')], continuation_token: 'page-2' },
            };
        });

        const offers = await fetchAllOffers(ctx);

        expect(offers.map((o) => o.sku)).toEqual(['A', 'B', 'C']);
        expect(impl).toHaveBeenCalledTimes(2);
    });

    test('throws when the listing fails', async () => {
        stubFetch(() => ({ status: 401, body: { error: 'bad key' } }));

        await expect(fetchAllOffers(ctx)).rejects.toThrow('401');
    });
});

// ─── computeBarcodeSyncPlan ─────────────────────────────────────────────────

describe('computeBarcodeSyncPlan', () => {
    test('plans a new code for a matched product without one', async () => {
        const product = await createProduct('SKU-1');

        const plan = await computeBarcodeSyncPlan([offer('SKU-1', '6001234567893')]);

        expect(plan.changes).toEqual([
            {
                sku: 'SKU-1',
                product: product.name,
                barcode: '6001234567893',
                replaces: '',
                change: 'New',
                productId: product.id,
            },
        ]);
        expect(plan.unchanged).toBe(0);
    });

    test('plans an update when the stored code differs, carrying the code it replaces', async () => {
        const product = await createProduct('SKU-1');
        const channel = await createTakealotChannel();
        await models.productChannelCode.create({ productId: product.id, channelId: channel.id, code: 'OLD-CODE' });

        const plan = await computeBarcodeSyncPlan([offer('SKU-1', '6001234567893')]);

        expect(plan.changes).toHaveLength(1);
        expect(plan.changes[0]).toMatchObject({ change: 'Update', barcode: '6001234567893', replaces: 'OLD-CODE' });
    });

    test('counts a matching stored code as unchanged', async () => {
        const product = await createProduct('SKU-1');
        const channel = await createTakealotChannel();
        await models.productChannelCode.create({ productId: product.id, channelId: channel.id, code: '6001234567893' });

        const plan = await computeBarcodeSyncPlan([offer('SKU-1', '6001234567893')]);

        expect(plan.changes).toHaveLength(0);
        expect(plan.unchanged).toBe(1);
    });

    test('a code on another channel is not treated as the Takealot code', async () => {
        const product = await createProduct('SKU-1');
        const amazon = await models.channel.create({ name: 'Amazon FBA' });
        await models.productChannelCode.create({ productId: product.id, channelId: amazon.id, code: 'X0000FNSKU' });

        const plan = await computeBarcodeSyncPlan([offer('SKU-1', '6001234567893')]);

        expect(plan.changes).toHaveLength(1);
        expect(plan.changes[0]).toMatchObject({ change: 'New', replaces: '' });
    });

    test('surfaces offers with no matching product', async () => {
        const plan = await computeBarcodeSyncPlan([offer('UNKNOWN', '6001234567893')]);

        expect(plan.changes).toHaveLength(0);
        expect(plan.offersWithoutProduct).toEqual(['UNKNOWN']);
    });

    test('leaves the stored code alone when the offer has no label barcode, and surfaces it', async () => {
        const product = await createProduct('SKU-1');
        const channel = await createTakealotChannel();
        await models.productChannelCode.create({ productId: product.id, channelId: channel.id, code: 'KEEP-ME' });

        const plan = await computeBarcodeSyncPlan([mptalOffer('SKU-1', ''), offer('SKU-1', null)]);

        expect(plan.changes).toHaveLength(0);
        expect(plan.offersWithoutBarcode).toEqual(['SKU-1']);
        const rows = await codesForProduct(product.id);
        expect(rows.map((r) => r.code)).toEqual(['KEEP-ME']);
    });

    test('stores the product_label, never the MPTAL merchant barcode', async () => {
        const product = await createProduct('SKU-1');

        const plan = await computeBarcodeSyncPlan([mptalOffer('SKU-1', '9901043896425')]);

        expect(plan.changes).toHaveLength(1);
        expect(plan.changes[0]).toMatchObject({ productId: product.id, barcode: '9901043896425' });
    });

    test('a stored MPTAL placeholder is planned for replacement by the label barcode', async () => {
        const product = await createProduct('SKU-1');
        const channel = await createTakealotChannel();
        await models.productChannelCode.create({ productId: product.id, channelId: channel.id, code: 'MPTAL75747951' });

        const plan = await computeBarcodeSyncPlan([mptalOffer('SKU-1', '9901043896425')]);

        expect(plan.changes).toHaveLength(1);
        expect(plan.changes[0]).toMatchObject({
            change: 'Update',
            barcode: '9901043896425',
            replaces: 'MPTAL75747951',
        });
    });

    test('duplicate offer SKUs warn and the last occurrence wins', async () => {
        const product = await createProduct('SKU-1');

        const plan = await computeBarcodeSyncPlan([offer('SKU-1', '1111111111111'), offer('SKU-1', '2222222222222')]);

        expect(plan.warnings).toEqual(['Duplicate SKU on Takealot: SKU-1 — using the last occurrence']);
        expect(plan.changes).toHaveLength(1);
        expect(plan.changes[0]).toMatchObject({ productId: product.id, barcode: '2222222222222' });
    });

    test('lists enabled products with no offer, leaving disabled ones out', async () => {
        await createProduct('ON-TAKEALOT');
        await createProduct('NOT-LISTED');
        await createProduct('DISABLED', 'Product DISABLED', false);

        const plan = await computeBarcodeSyncPlan([offer('ON-TAKEALOT', '6001234567893')]);

        expect(plan.productsWithoutOffer).toEqual(['NOT-LISTED']);
    });
});

// ─── applyBarcodeSync ───────────────────────────────────────────────────────

describe('applyBarcodeSync', () => {
    test('creates the channel and codes, and a re-run plans nothing further', async () => {
        const product = await createProduct('SKU-1');
        const offers = [offer('SKU-1', '6001234567893')];

        const result = await applyBarcodeSync(await computeBarcodeSyncPlan(offers));

        expect(result).toEqual({ created: 1, updated: 0 });
        const channels = await models.channel.findMany({ where: { name: { equals: TAKEALOT_CHANNEL_NAME } } });
        expect(channels).toHaveLength(1);
        const rows = await codesForProduct(product.id);
        expect(rows).toHaveLength(1);
        expect(rows[0].code).toBe('6001234567893');
        expect(rows[0].channelId).toBe(channels[0].id);

        const replan = await computeBarcodeSyncPlan(offers);
        expect(replan.changes).toHaveLength(0);
        expect(replan.unchanged).toBe(1);
    });

    test('updates the existing row in place — never a second code for the pair', async () => {
        const product = await createProduct('SKU-1');
        const channel = await createTakealotChannel();
        await models.productChannelCode.create({ productId: product.id, channelId: channel.id, code: 'OLD-CODE' });

        const result = await applyBarcodeSync(await computeBarcodeSyncPlan([offer('SKU-1', '6001234567893')]));

        expect(result).toEqual({ created: 0, updated: 1 });
        const rows = await codesForProduct(product.id);
        expect(rows).toHaveLength(1);
        expect(rows[0].code).toBe('6001234567893');
    });

    test('re-applying the same plan is idempotent', async () => {
        const product = await createProduct('SKU-1');
        const plan = await computeBarcodeSyncPlan([offer('SKU-1', '6001234567893')]);

        await applyBarcodeSync(plan);
        const rerun = await applyBarcodeSync(plan);

        expect(rerun).toEqual({ created: 0, updated: 1 });
        expect(await codesForProduct(product.id)).toHaveLength(1);
    });
});

// ─── syncProductBarcodeFromTakealot ─────────────────────────────────────────

describe('syncProductBarcodeFromTakealot', () => {
    test('creates the channel code from the offer product_label, ignoring the MPTAL barcode', async () => {
        const product = await createProduct('SKU-1');
        stubFetch(() => ({ status: 200, body: mptalOffer('SKU-1', ' 9901043896425 ') }));

        const result = await syncProductBarcodeFromTakealot(ctx, product);

        expect(result).toEqual({ outcome: 'created', barcode: '9901043896425' });
        const rows = await codesForProduct(product.id);
        expect(rows).toHaveLength(1);
        expect(rows[0].code).toBe('9901043896425');
    });

    test('updates when the stored code differs and reports unchanged when it matches', async () => {
        const product = await createProduct('SKU-1');
        const channel = await createTakealotChannel();
        await models.productChannelCode.create({ productId: product.id, channelId: channel.id, code: 'OLD-CODE' });
        stubFetch(() => ({ status: 200, body: offer('SKU-1', '6001234567893') }));

        expect(await syncProductBarcodeFromTakealot(ctx, product)).toEqual({
            outcome: 'updated',
            barcode: '6001234567893',
        });
        expect(await syncProductBarcodeFromTakealot(ctx, product)).toEqual({
            outcome: 'unchanged',
            barcode: '6001234567893',
        });
        expect(await codesForProduct(product.id)).toHaveLength(1);
    });

    test('reports no_offer on 404 and touches nothing', async () => {
        const product = await createProduct('SKU-1');
        stubFetch(() => ({ status: 404 }));

        expect(await syncProductBarcodeFromTakealot(ctx, product)).toEqual({ outcome: 'no_offer' });
        expect(await codesForProduct(product.id)).toHaveLength(0);
    });

    test('reports no_barcode when the offer has no product_label — an MPTAL barcode does not count', async () => {
        const product = await createProduct('SKU-1');
        const channel = await createTakealotChannel();
        await models.productChannelCode.create({ productId: product.id, channelId: channel.id, code: 'KEEP-ME' });
        stubFetch(() => ({ status: 200, body: mptalOffer('SKU-1', '') }));

        expect(await syncProductBarcodeFromTakealot(ctx, product)).toEqual({ outcome: 'no_barcode' });
        const rows = await codesForProduct(product.id);
        expect(rows.map((r) => r.code)).toEqual(['KEEP-ME']);
    });
});
