import { models, resetDatabase } from '@teamkeel/testing';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { AMAZON_CHANNEL_NAME } from './amazonFnskuHelpers';
import { ChannelCodeSweepCtx, sweepChannelCodes } from './channelCodeSweep';
import { TAKEALOT_CHANNEL_NAME } from './zohoChannelFeeHelpers';

beforeEach(resetDatabase);
afterEach(() => vi.unstubAllGlobals());

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ctx: ChannelCodeSweepCtx = {
    env: {
        TAKEALOT_API_BASE_URL: 'https://takealot.test',
        AMAZON_SP_API_BASE_URL: 'https://spapi.test',
        AMAZON_LWA_TOKEN_URL: 'https://lwa.test/auth/o2/token',
        AMAZON_MARKETPLACE_ID: 'AE08WJ6YKNBMC',
        AMAZON_LWA_CLIENT_ID: 'amzn1.application-oa2-client.test',
    },
    secrets: {
        TAKEALOT_API_KEY: 'test-key',
        AMAZON_LWA_CLIENT_SECRET: 'shh',
        AMAZON_LWA_REFRESH_TOKEN: 'Atzr|refresh',
    },
};

// Page pacing and throttle backoff wait through this; tests make it instant.
const noWait = { sleep: async () => {} };

// A ctx with one channel's credentials removed.
function without(key: 'TAKEALOT_API_KEY' | 'AMAZON_LWA_REFRESH_TOKEN'): ChannelCodeSweepCtx {
    return { ...ctx, secrets: { ...ctx.secrets, [key]: '' } };
}

interface Responses {
    takealot?: { status: number; body?: unknown };
    amazon?: { status: number; body?: unknown };
}

// Route each channel's calls by host, so one channel can fail while the other
// answers normally.
function stubChannels({ takealot, amazon }: Responses) {
    const impl = vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.startsWith('https://lwa.test')) {
            return new Response(JSON.stringify({ access_token: 'Atza|access', expires_in: 3600 }), { status: 200 });
        }
        const answer = url.startsWith('https://takealot.test') ? takealot : amazon;
        if (!answer) throw new Error(`unexpected request to ${url}`);
        return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status });
    });
    vi.stubGlobal('fetch', impl);
    return impl;
}

function takealotOffers(offers: { sku: string; product_label: string }[]) {
    return { status: 200, body: { items: offers } };
}

function fbaListings(listings: { sellerSku: string; fnSku: string }[]) {
    return {
        status: 200,
        body: {
            payload: {
                inventorySummaries: listings.map((l) => ({ ...l, asin: 'B0UNO00000', condition: 'NewItem' })),
            },
        },
    };
}

async function createProduct(sku: string) {
    const brand = await models.brand.create({ name: 'Test Brand' });
    return await models.product.create({ name: `Product ${sku}`, sku, brandId: brand.id });
}

async function codeFor(productId: string, channelName: string) {
    const channels = await models.channel.findMany({ where: { name: { equals: channelName } } });
    if (channels.length === 0) return null;
    const rows = await models.productChannelCode.findMany({ where: { productId, channelId: channels[0].id } });
    return rows.length > 0 ? rows[0].code : null;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('sweepChannelCodes', () => {
    test('applies both channels without a review step and reports each one', async () => {
        const product = await createProduct('CS-UNO');
        stubChannels({
            takealot: takealotOffers([{ sku: 'CS-UNO', product_label: '6001234567893' }]),
            amazon: fbaListings([{ sellerSku: 'CS-UNO', fnSku: 'X001UNO000' }]),
        });

        const results = await sweepChannelCodes(ctx, noWait);

        expect(results.map((r) => [r.channel, r.status, r.created, r.updated])).toEqual([
            ['Takealot', 'applied', 1, 0],
            ['Amazon', 'applied', 1, 0],
        ]);
        expect(await codeFor(product.id, TAKEALOT_CHANNEL_NAME)).toBe('6001234567893');
        expect(await codeFor(product.id, AMAZON_CHANNEL_NAME)).toBe('X001UNO000');
    });

    test('picks up a code that changed on the channel after the product was created', async () => {
        // The gap the per-product subscribers cannot close: the SKU never
        // changes, so only a sweep notices the channel reissued the code.
        const product = await createProduct('CS-UNO');
        const amazon = await models.channel.create({ name: AMAZON_CHANNEL_NAME });
        await models.productChannelCode.create({ productId: product.id, channelId: amazon.id, code: 'X000OLD000' });
        stubChannels({
            takealot: takealotOffers([]),
            amazon: fbaListings([{ sellerSku: 'CS-UNO', fnSku: 'X001NEW000' }]),
        });

        const results = await sweepChannelCodes(ctx, noWait);

        expect(results[1]).toMatchObject({ channel: 'Amazon', status: 'applied', created: 0, updated: 1 });
        expect(await codeFor(product.id, AMAZON_CHANNEL_NAME)).toBe('X001NEW000');
    });

    test('counts SKUs the channel lists that match no product here', async () => {
        stubChannels({
            takealot: takealotOffers([{ sku: 'CS-GHOST', product_label: '6001234567893' }]),
            amazon: fbaListings([]),
        });

        const [takealot] = await sweepChannelCodes(ctx, noWait);

        expect(takealot).toMatchObject({ status: 'applied', created: 0, unmatchedSkus: 1 });
    });

    test('skips a channel whose credentials are not set and still syncs the other', async () => {
        const product = await createProduct('CS-UNO');
        stubChannels({ amazon: fbaListings([{ sellerSku: 'CS-UNO', fnSku: 'X001UNO000' }]) });

        const results = await sweepChannelCodes(without('TAKEALOT_API_KEY'), noWait);

        expect(results[0]).toMatchObject({ channel: 'Takealot', status: 'skipped', detail: 'TAKEALOT_API_KEY is not set' });
        expect(results[1]).toMatchObject({ channel: 'Amazon', status: 'applied', created: 1 });
        expect(await codeFor(product.id, AMAZON_CHANNEL_NAME)).toBe('X001UNO000');
    });

    test('skips Amazon when its credentials are not set', async () => {
        stubChannels({ takealot: takealotOffers([]) });

        const results = await sweepChannelCodes(without('AMAZON_LWA_REFRESH_TOKEN'), noWait);

        expect(results[1]).toMatchObject({
            channel: 'Amazon',
            status: 'skipped',
            detail: 'Amazon credentials are not set',
        });
    });

    test('one channel failing does not stop the other from applying', async () => {
        const product = await createProduct('CS-UNO');
        stubChannels({
            takealot: { status: 503, body: { message: 'Takealot is down' } },
            amazon: fbaListings([{ sellerSku: 'CS-UNO', fnSku: 'X001UNO000' }]),
        });

        const results = await sweepChannelCodes(ctx, noWait);

        expect(results[0].status).toBe('failed');
        expect(results[0].detail).toContain('503');
        expect(results[1]).toMatchObject({ channel: 'Amazon', status: 'applied', created: 1 });
        expect(await codeFor(product.id, AMAZON_CHANNEL_NAME)).toBe('X001UNO000');
        expect(await codeFor(product.id, TAKEALOT_CHANNEL_NAME)).toBeNull();
    });

    test('never blanks a stored code when the channel reports the SKU without one', async () => {
        const product = await createProduct('CS-UNO');
        const takealot = await models.channel.create({ name: TAKEALOT_CHANNEL_NAME });
        await models.productChannelCode.create({ productId: product.id, channelId: takealot.id, code: 'KEEP-ME' });
        stubChannels({
            takealot: takealotOffers([{ sku: 'CS-UNO', product_label: '' }]),
            amazon: fbaListings([]),
        });

        const results = await sweepChannelCodes(ctx, noWait);

        expect(results[0]).toMatchObject({ status: 'applied', created: 0, updated: 0 });
        expect(await codeFor(product.id, TAKEALOT_CHANNEL_NAME)).toBe('KEEP-ME');
    });
});
