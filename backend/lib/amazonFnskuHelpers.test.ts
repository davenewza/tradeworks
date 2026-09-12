import { models, resetDatabase } from '@teamkeel/testing';
import { BarcodeSymbology, LabelStockSize } from '@teamkeel/sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
    AMAZON_CHANNEL_NAME,
    AmazonCtx,
    AmazonListing,
    amazonLabelSpecExists,
    computeAmazonFnskuPlan,
    fetchFbaInventory,
    getAmazonAccessToken,
    isNewCondition,
} from './amazonFnskuHelpers';
import { applyChannelCodeSync } from './channelCodeSync';

beforeEach(resetDatabase);
afterEach(() => vi.unstubAllGlobals());

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ctx: AmazonCtx = {
    env: {
        AMAZON_SP_API_BASE_URL: 'https://spapi.test',
        AMAZON_LWA_TOKEN_URL: 'https://lwa.test/auth/o2/token',
        AMAZON_MARKETPLACE_ID: 'AE08WJ6YKNBMC',
        AMAZON_LWA_CLIENT_ID: 'amzn1.application-oa2-client.test',
    },
    secrets: {
        AMAZON_LWA_CLIENT_SECRET: 'shh',
        AMAZON_LWA_REFRESH_TOKEN: 'Atzr|refresh',
    },
};

// Retries and page pacing wait through this; tests make it instant.
const noWait = { sleep: async () => {} };

const TOKEN_OK = { status: 200, body: { access_token: 'Atza|access', token_type: 'bearer', expires_in: 3600 } };

// An FBA Inventory API summary as the API returns it.
function summary(sellerSku: string, fnSku: string | null, asin = 'B0UNO00000', condition = 'NewItem', productName = `Product ${sellerSku}`) {
    return { asin, fnSku, sellerSku, condition, productName, totalQuantity: 12, lastUpdatedTime: '2026-09-10T08:00:00Z' };
}

function listing(sku: string, fnsku: string, extra: Partial<AmazonListing> = {}): AmazonListing {
    return { sku, fnsku, asin: 'B07ABCDEFG', condition: 'NewItem', productName: `Product ${sku}`, ...extra };
}

// Stub global fetch, routing each request through a handler that sees the URL
// and init so headers and bodies can be asserted.
type Stubbed = { status: number; body?: unknown; text?: string };
function stubFetch(handler: (url: string, init: RequestInit | undefined, call: number) => Stubbed) {
    let calls = 0;
    const impl = vi.fn(async (input: unknown, init?: RequestInit) => {
        const { status, body, text } = handler(String(input), init, calls++);
        return new Response(text ?? JSON.stringify(body ?? {}), { status });
    });
    vi.stubGlobal('fetch', impl);
    return impl;
}

async function createProduct(sku: string, name = `Product ${sku}`, isEnabled = true) {
    const brand = await models.brand.create({ name: 'Test Brand' });
    return await models.product.create({ name, sku, brandId: brand.id, isEnabled });
}

async function createAmazonChannel() {
    return await models.channel.create({ name: AMAZON_CHANNEL_NAME });
}

async function codesForProduct(productId: string) {
    return await models.productChannelCode.findMany({ where: { productId } });
}

// ─── getAmazonAccessToken ───────────────────────────────────────────────────

describe('getAmazonAccessToken', () => {
    test('posts the refresh-token grant as a form body and returns the access token', async () => {
        const impl = stubFetch(() => TOKEN_OK);

        expect(await getAmazonAccessToken(ctx)).toBe('Atza|access');

        expect(impl).toHaveBeenCalledTimes(1);
        const [url, init] = impl.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://lwa.test/auth/o2/token');
        expect(init.method).toBe('POST');
        expect((init.headers as Record<string, string>)['Content-Type']).toMatch(/^application\/x-www-form-urlencoded/);
        expect(new URLSearchParams(String(init.body))).toEqual(
            new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: 'Atzr|refresh',
                client_id: 'amzn1.application-oa2-client.test',
                client_secret: 'shh',
            })
        );
    });

    test('throws with the status and LWA error body when the exchange is refused', async () => {
        stubFetch(() => ({ status: 400, body: { error: 'invalid_grant', error_description: 'refresh token is invalid' } }));

        await expect(getAmazonAccessToken(ctx)).rejects.toThrow('400 - {"error":"invalid_grant"');
    });

    test('throws when the response carries no access token', async () => {
        stubFetch(() => ({ status: 200, body: { token_type: 'bearer' } }));

        await expect(getAmazonAccessToken(ctx)).rejects.toThrow('missing access_token');
    });
});

// ─── fetchFbaInventory ──────────────────────────────────────────────────────

describe('fetchFbaInventory', () => {
    test('gets a token, then walks nextToken pages with the marketplace granularity and the token header', async () => {
        const impl = stubFetch((url, _init, call) => {
            if (call === 0) return TOKEN_OK;
            if (url.includes('nextToken=page-2')) {
                return { status: 200, body: { payload: { inventorySummaries: [summary('C', 'X003')] }, pagination: {} } };
            }
            return {
                status: 200,
                body: {
                    payload: { inventorySummaries: [summary('A', 'X001'), summary('B', 'X002')] },
                    pagination: { nextToken: 'page-2' },
                },
            };
        });

        const listings = await fetchFbaInventory(ctx, undefined, noWait);

        expect(listings.map((l) => l.sku)).toEqual(['A', 'B', 'C']);
        expect(impl).toHaveBeenCalledTimes(3);

        const [firstUrl, firstInit] = impl.mock.calls[1] as [string, RequestInit];
        const params = new URL(firstUrl).searchParams;
        expect(firstUrl.startsWith('https://spapi.test/fba/inventory/v1/summaries?')).toBe(true);
        expect(params.get('granularityType')).toBe('Marketplace');
        expect(params.get('granularityId')).toBe('AE08WJ6YKNBMC');
        expect(params.get('marketplaceIds')).toBe('AE08WJ6YKNBMC');
        expect(params.has('nextToken')).toBe(false);
        expect((firstInit.headers as Record<string, string>)['x-amz-access-token']).toBe('Atza|access');

        const [secondUrl] = impl.mock.calls[2] as [string, RequestInit];
        expect(new URL(secondUrl).searchParams.get('nextToken')).toBe('page-2');
    });

    test('maps each summary to a listing, trimming, blanking a missing FNSKU and skipping rows with no seller SKU', async () => {
        stubFetch((_url, _init, call) =>
            call === 0
                ? TOKEN_OK
                : {
                      status: 200,
                      body: {
                          payload: {
                              inventorySummaries: [
                                  summary(' CS-UNO ', ' X001UNO000 ', ' B0UNO00000 ', 'NewItem', ' Arduino UNO '),
                                  summary('CS-BLANK', null, 'B0BLANK000'),
                                  { asin: 'B0LOST0000', fnSku: 'X001LOST00', sellerSku: '' },
                                  { asin: 'B0NOSKU000', fnSku: 'X001NOSKU0' },
                              ],
                          },
                      },
                  }
        );

        const listings = await fetchFbaInventory(ctx, undefined, noWait);

        expect(listings).toEqual([
            { sku: 'CS-UNO', fnsku: 'X001UNO000', asin: 'B0UNO00000', condition: 'NewItem', productName: 'Arduino UNO' },
            { sku: 'CS-BLANK', fnsku: '', asin: 'B0BLANK000', condition: 'NewItem', productName: 'Product CS-BLANK' },
        ]);
    });

    test('returns nothing for an empty inventory', async () => {
        stubFetch((_url, _init, call) => (call === 0 ? TOKEN_OK : { status: 200, body: { payload: { inventorySummaries: [] } } }));

        expect(await fetchFbaInventory(ctx, undefined, noWait)).toEqual([]);
    });

    test('backs off and retries when Amazon throttles, then carries on', async () => {
        const waits: number[] = [];
        const impl = stubFetch((_url, _init, call) => {
            if (call === 0) return TOKEN_OK;
            if (call <= 2) return { status: 429, body: { errors: [{ code: 'QuotaExceeded', message: 'slow down' }] } };
            return { status: 200, body: { payload: { inventorySummaries: [summary('A', 'X001')] } } };
        });

        const listings = await fetchFbaInventory(ctx, undefined, { sleep: async (ms) => void waits.push(ms) });

        expect(listings.map((l) => l.sku)).toEqual(['A']);
        expect(impl).toHaveBeenCalledTimes(4);
        expect(waits).toEqual([1000, 2000]);
    });

    test('gives up after the retries are spent, surfacing the throttle', async () => {
        stubFetch((_url, _init, call) => (call === 0 ? TOKEN_OK : { status: 429, body: { errors: [{ code: 'QuotaExceeded' }] } }));

        await expect(fetchFbaInventory(ctx, undefined, noWait)).rejects.toThrow('429');
    });

    test('throws on any other error status with the body Amazon sent', async () => {
        stubFetch((_url, _init, call) =>
            call === 0 ? TOKEN_OK : { status: 403, body: { errors: [{ code: 'Unauthorized', message: 'Access to requested resource is denied.' }] } }
        );

        await expect(fetchFbaInventory(ctx, undefined, noWait)).rejects.toThrow('403 - {"errors":[{"code":"Unauthorized"');
    });

    test('a failed token exchange stops the sync before any inventory call', async () => {
        const impl = stubFetch(() => ({ status: 401, body: { error: 'invalid_client' } }));

        await expect(fetchFbaInventory(ctx, undefined, noWait)).rejects.toThrow('Failed to get Amazon access token');
        expect(impl).toHaveBeenCalledTimes(1);
    });
});

// ─── isNewCondition ─────────────────────────────────────────────────────────

describe('isNewCondition', () => {
    test('accepts the New conditions the API reports', () => {
        for (const condition of ['NewItem', 'NewWithWarranty', 'NewOEM', 'NewOpenBox', 'New', ' new ']) {
            expect(isNewCondition(condition)).toBe(true);
        }
    });

    test('rejects anything else, including used-like-new', () => {
        for (const condition of ['UsedLikeNew', 'UsedGood', 'Refurbished', 'CollectibleLikeNew', 'Club', '']) {
            expect(isNewCondition(condition)).toBe(false);
        }
    });
});

// ─── computeAmazonFnskuPlan ─────────────────────────────────────────────────

describe('computeAmazonFnskuPlan', () => {
    test('plans a new code for a matched product without one', async () => {
        const product = await createProduct('CS-UNO');

        const plan = await computeAmazonFnskuPlan([listing('CS-UNO', 'X001UNO000')]);

        expect(plan.channelName).toBe(AMAZON_CHANNEL_NAME);
        expect(plan.changes).toEqual([
            {
                sku: 'CS-UNO',
                product: product.name,
                code: 'X001UNO000',
                replaces: '',
                change: 'New',
                productId: product.id,
            },
        ]);
        expect(plan.unchanged).toBe(0);
        expect(plan.manufacturerBarcodeSkus).toEqual([]);
        expect(plan.nonNewConditions).toEqual([]);
    });

    test('plans an update when the stored FNSKU differs, carrying the code it replaces', async () => {
        const product = await createProduct('CS-UNO');
        const channel = await createAmazonChannel();
        await models.productChannelCode.create({ productId: product.id, channelId: channel.id, code: 'X00OLD0000' });

        const plan = await computeAmazonFnskuPlan([listing('CS-UNO', 'X001UNO000')]);

        expect(plan.changes).toHaveLength(1);
        expect(plan.changes[0]).toMatchObject({ change: 'Update', code: 'X001UNO000', replaces: 'X00OLD0000' });
    });

    test('counts a matching stored code as unchanged', async () => {
        const product = await createProduct('CS-UNO');
        const channel = await createAmazonChannel();
        await models.productChannelCode.create({ productId: product.id, channelId: channel.id, code: 'X001UNO000' });

        const plan = await computeAmazonFnskuPlan([listing('CS-UNO', ' X001UNO000 ')]);

        expect(plan.changes).toHaveLength(0);
        expect(plan.unchanged).toBe(1);
    });

    test('a Takealot code on the same product is not treated as the Amazon code', async () => {
        const product = await createProduct('CS-UNO');
        const takealot = await models.channel.create({ name: 'Takealot Marketplace' });
        await models.productChannelCode.create({ productId: product.id, channelId: takealot.id, code: '9901043896425' });

        const plan = await computeAmazonFnskuPlan([listing('CS-UNO', 'X001UNO000')]);

        expect(plan.changes).toHaveLength(1);
        expect(plan.changes[0]).toMatchObject({ change: 'New', replaces: '' });
    });

    test('surfaces listings with no matching product', async () => {
        const plan = await computeAmazonFnskuPlan([listing('UNKNOWN', 'X001UNO000')]);

        expect(plan.changes).toHaveLength(0);
        expect(plan.skusWithoutProduct).toEqual(['UNKNOWN']);
    });

    test('leaves the stored code alone when the listing has no FNSKU, and surfaces it', async () => {
        const product = await createProduct('CS-UNO');
        const channel = await createAmazonChannel();
        await models.productChannelCode.create({ productId: product.id, channelId: channel.id, code: 'KEEP-ME' });

        const plan = await computeAmazonFnskuPlan([listing('CS-UNO', '')]);

        expect(plan.changes).toHaveLength(0);
        expect(plan.skusWithoutCode).toEqual(['CS-UNO']);
        expect(plan.productsWithoutSource).toEqual([]);
        expect((await codesForProduct(product.id)).map((r) => r.code)).toEqual(['KEEP-ME']);
    });

    test('a listing on the manufacturer barcode — FNSKU equal to ASIN — is noted, never stored', async () => {
        const product = await createProduct('CS-UNO');
        const channel = await createAmazonChannel();
        await models.productChannelCode.create({ productId: product.id, channelId: channel.id, code: 'X00OLD0000' });

        const plan = await computeAmazonFnskuPlan([listing('CS-UNO', 'B0UNO00000', { asin: 'B0UNO00000' })]);

        expect(plan.changes).toHaveLength(0);
        expect(plan.manufacturerBarcodeSkus).toEqual(['CS-UNO']);
        // It has its own note: it is neither "missing an FNSKU" nor "not on Amazon".
        expect(plan.skusWithoutCode).toEqual([]);
        expect(plan.productsWithoutSource).toEqual([]);
        expect((await codesForProduct(product.id)).map((r) => r.code)).toEqual(['X00OLD0000']);
    });

    test('a condition other than New is flagged, but the FNSKU is still synced', async () => {
        await createProduct('CS-UNO');

        const plan = await computeAmazonFnskuPlan([listing('CS-UNO', 'X001UNO000', { condition: 'UsedLikeNew' })]);

        expect(plan.changes).toHaveLength(1);
        expect(plan.nonNewConditions).toEqual([{ sku: 'CS-UNO', condition: 'UsedLikeNew' }]);
    });

    test('duplicate SKUs warn and the last occurrence wins', async () => {
        const product = await createProduct('CS-UNO');

        const plan = await computeAmazonFnskuPlan([listing('CS-UNO', 'X001FIRST0'), listing('CS-UNO', 'X001SECOND')]);

        expect(plan.warnings).toEqual(['Duplicate SKU on Amazon: CS-UNO — using the last occurrence']);
        expect(plan.changes).toHaveLength(1);
        expect(plan.changes[0]).toMatchObject({ productId: product.id, code: 'X001SECOND' });
    });

    test('lists enabled products with no FBA listing, leaving disabled ones out', async () => {
        await createProduct('ON-AMAZON');
        await createProduct('NOT-LISTED');
        await createProduct('DISABLED', 'Product DISABLED', false);

        const plan = await computeAmazonFnskuPlan([listing('ON-AMAZON', 'X001UNO000')]);

        expect(plan.productsWithoutSource).toEqual(['NOT-LISTED']);
    });

    test('applying the plan creates the Amazon channel and codes, and a re-plan finds nothing further', async () => {
        const product = await createProduct('CS-UNO');
        const listings = [listing('CS-UNO', 'X001UNO000')];

        const result = await applyChannelCodeSync(await computeAmazonFnskuPlan(listings));

        expect(result).toEqual({ created: 1, updated: 0 });
        const channels = await models.channel.findMany({ where: { name: { equals: AMAZON_CHANNEL_NAME } } });
        expect(channels).toHaveLength(1);
        const codes = await codesForProduct(product.id);
        expect(codes).toHaveLength(1);
        expect(codes[0]).toMatchObject({ channelId: channels[0].id, code: 'X001UNO000' });

        const replan = await computeAmazonFnskuPlan(listings);
        expect(replan.changes).toHaveLength(0);
        expect(replan.unchanged).toBe(1);
    });
});

// ─── amazonLabelSpecExists ──────────────────────────────────────────────────

describe('amazonLabelSpecExists', () => {
    test('is false without the channel, without a spec, and with only a disabled spec', async () => {
        expect(await amazonLabelSpecExists()).toBe(false);

        const channel = await createAmazonChannel();
        expect(await amazonLabelSpecExists()).toBe(false);

        await models.channelLabelSpec.create({
            channelId: channel.id,
            symbology: BarcodeSymbology.Code128,
            defaultStock: LabelStockSize.Size50x30,
            isEnabled: false,
        });
        expect(await amazonLabelSpecExists()).toBe(false);
    });

    test('is true once the channel has an enabled spec', async () => {
        const channel = await createAmazonChannel();
        await models.channelLabelSpec.create({
            channelId: channel.id,
            symbology: BarcodeSymbology.Code128,
            defaultStock: LabelStockSize.Size50x30,
            isEnabled: true,
        });

        expect(await amazonLabelSpecExists()).toBe(true);
    });
});
