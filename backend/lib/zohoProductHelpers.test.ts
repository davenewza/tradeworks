import { models, resetDatabase } from '@teamkeel/testing';
import { InlineFile } from '@teamkeel/sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
    applyProductSync,
    computeSyncCandidates,
    PhotoFetcher,
    SyncCandidate,
    ZohoProductCtx,
    zohoPhotoFetcher,
} from './zohoProductHelpers';

beforeEach(resetDatabase);
afterEach(() => vi.unstubAllGlobals());

// For tests that don't exercise photos: fails loudly if the apply pass asks.
const noPhotos: PhotoFetcher = async () => {
    throw new Error('unexpected photo download');
};

function pngFile(filename = 'photo.png'): InlineFile {
    const file = new InlineFile({ filename, contentType: 'image/png' });
    file.write(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return file;
}

// Records which Zoho items the apply pass downloaded a photo for.
function recordingFetcher() {
    const calls: string[] = [];
    const fetcher: PhotoFetcher = async (zohoItemId) => {
        calls.push(zohoItemId);
        return pngFile();
    };
    return { fetcher, calls };
}

// A ProgressReporter that records what a step reported, so tests can assert the
// per-item progress without a live flow runtime.
function recordingProgress() {
    const state = { total: undefined as number | undefined, current: 0, logs: [] as string[] };
    const reporter = {
        set(patch: { total?: number; current?: number }) {
            if (patch.total !== undefined) state.total = patch.total;
            if (patch.current !== undefined) state.current = patch.current;
        },
        increment(n = 1) {
            state.current += n;
        },
        log(message: string) {
            state.logs.push(message);
        },
    };
    return { reporter, state };
}

// Build a SyncCandidate; tests override the fields they care about, and the
// rest are filled with representative values.
function candidate(overrides: Partial<SyncCandidate> & Pick<SyncCandidate, 'sku' | 'name' | 'brand'>): SyncCandidate {
    return {
        change: 'New',
        photo: '',
        zohoItemId: `zoho-${overrides.sku}`,
        action: 'create',
        imageName: null,
        ...overrides,
    };
}

describe('applyProductSync', () => {
    test('creates new products and their brand', async () => {
        const result = await applyProductSync([
            candidate({ sku: 'A-1', name: 'Widget', brand: 'Acme' }),
            candidate({ sku: 'A-2', name: 'Gadget', brand: 'Acme' }),
        ], noPhotos);

        expect(result.created).toBe(2);
        expect(result.updated).toBe(0);
        expect(result.synced).toHaveLength(2);
        expect(result.synced.every((s) => s.change === 'New')).toBe(true);

        // Brand created exactly once and shared by both products.
        const brands = await models.brand.findMany({ where: { name: { equals: 'Acme' } } });
        expect(brands).toHaveLength(1);

        const productA = await models.product.findOne({ sku: 'A-1' });
        expect(productA).not.toBeNull();
        expect(productA!.name).toBe('Widget');
        expect(productA!.brandId).toBe(brands[0].id);
        expect(productA!.synchronisedAt).not.toBeNull();

        const productB = await models.product.findOne({ sku: 'A-2' });
        expect(productB!.brandId).toBe(brands[0].id);
    });

    test('updates an existing product name and brand, stamping synchronisedAt', async () => {
        const oldBrand = await models.brand.create({ name: 'Old Brand' });
        await models.product.create({
            name: 'Old Name',
            sku: 'B-1',
            brandId: oldBrand.id,
        });

        const result = await applyProductSync([
            candidate({ sku: 'B-1', name: 'New Name', brand: 'New Brand', action: 'update', change: 'Update' }),
        ], noPhotos);

        expect(result.created).toBe(0);
        expect(result.updated).toBe(1);
        expect(result.synced[0].change).toBe('Update');

        const product = await models.product.findOne({ sku: 'B-1' });
        expect(product!.name).toBe('New Name');
        expect(product!.synchronisedAt).not.toBeNull();

        // Brand switched to the newly-created 'New Brand'.
        const newBrands = await models.brand.findMany({ where: { name: { equals: 'New Brand' } } });
        expect(newBrands).toHaveLength(1);
        expect(product!.brandId).toBe(newBrands[0].id);
    });

    test('reuses an existing brand instead of creating a duplicate', async () => {
        const existingBrand = await models.brand.create({ name: 'Acme' });

        await applyProductSync([candidate({ sku: 'C-1', name: 'Thing', brand: 'Acme' })], noPhotos);

        const brands = await models.brand.findMany({ where: { name: { equals: 'Acme' } } });
        expect(brands).toHaveLength(1);
        expect(brands[0].id).toBe(existingBrand.id);

        const product = await models.product.findOne({ sku: 'C-1' });
        expect(product!.brandId).toBe(existingBrand.id);
    });

    test('only touches the products passed in', async () => {
        const brand = await models.brand.create({ name: 'Untouched Brand' });
        const untouched = await models.product.create({
            name: 'Untouched',
            sku: 'D-1',
            brandId: brand.id,
        });

        await applyProductSync([candidate({ sku: 'D-2', name: 'Synced', brand: 'Untouched Brand' })], noPhotos);

        const after = await models.product.findOne({ sku: 'D-1' });
        expect(after!.name).toBe('Untouched');
        expect(after!.synchronisedAt).toBeNull();
        expect(after!.id).toBe(untouched.id);
    });

    test('reports progress: sets the total once and increments per product', async () => {
        const { reporter, state } = recordingProgress();

        await applyProductSync(
            [
                candidate({ sku: 'PR-1', name: 'One', brand: 'Acme' }),
                candidate({ sku: 'PR-2', name: 'Two', brand: 'Acme' }),
                candidate({ sku: 'PR-3', name: 'Three', brand: 'Acme' }),
            ],
            noPhotos,
            reporter
        );

        expect(state.total).toBe(3);
        expect(state.current).toBe(3); // one increment per product
        expect(state.logs).toHaveLength(3);
    });

    test('is idempotent — re-running a create becomes an update, no duplicates', async () => {
        const selected = [candidate({ sku: 'E-1', name: 'First', brand: 'Acme' })];

        const first = await applyProductSync(selected, noPhotos);
        expect(first.created).toBe(1);

        const second = await applyProductSync(selected, noPhotos);
        expect(second.created).toBe(0);
        expect(second.updated).toBe(1);

        const products = await models.product.findMany({ where: { sku: { equals: 'E-1' } } });
        expect(products).toHaveLength(1);
    });

    test('adds a photo to a new product when Zoho has one', async () => {
        const { fetcher, calls } = recordingFetcher();

        const result = await applyProductSync(
            [candidate({ sku: 'P-1', name: 'Pictured', brand: 'Acme', photo: 'Add', imageName: 'p1.png' })],
            fetcher
        );

        expect(calls).toEqual(['zoho-P-1']);
        expect(result.photosAdded).toBe(1);
        expect(result.synced[0].photo).toBe('Added');
        const product = await models.product.findOne({ sku: 'P-1' });
        expect(product!.image).not.toBeNull();
        expect(product!.image!.contentType).toBe('image/png');
    });

    test('never downloads a photo for a product that already has one', async () => {
        // The photo was uploaded by hand between the review page and apply.
        const brand = await models.brand.create({ name: 'Acme' });
        await models.product.create({ name: 'Mine', sku: 'P-2', brandId: brand.id, image: pngFile('mine.png') });
        const { fetcher, calls } = recordingFetcher();

        const result = await applyProductSync(
            [candidate({ sku: 'P-2', name: 'Mine', brand: 'Acme', change: 'Photo', action: 'update', photo: 'Add' })],
            fetcher
        );

        expect(calls).toEqual([]);
        expect(result.photosAdded).toBe(0);
        const product = await models.product.findOne({ sku: 'P-2' });
        expect(product!.image!.filename).toBe('mine.png');
    });

    test("only downloads photos for candidates flagged 'Add'", async () => {
        const { fetcher, calls } = recordingFetcher();

        await applyProductSync(
            [
                candidate({ sku: 'P-3', name: 'With', brand: 'Acme', photo: 'Add' }),
                candidate({ sku: 'P-4', name: 'Without', brand: 'Acme' }),
            ],
            fetcher
        );

        expect(calls).toEqual(['zoho-P-3']);
        expect((await models.product.findOne({ sku: 'P-4' }))!.image).toBeNull();
    });

    test('a failed photo download is reported without undoing the product sync', async () => {
        const failing: PhotoFetcher = async () => {
            throw new Error('Zoho rate limit');
        };

        const result = await applyProductSync(
            [
                candidate({ sku: 'P-5', name: 'Broken', brand: 'Acme', photo: 'Add' }),
                candidate({ sku: 'P-6', name: 'Fine', brand: 'Acme' }),
            ],
            failing
        );

        expect(result.created).toBe(2);
        expect(result.photosAdded).toBe(0);
        expect(result.photoFailures).toEqual([{ sku: 'P-5', error: 'Zoho rate limit' }]);
        expect(result.synced.find((s) => s.sku === 'P-5')!.photo).toBe('Failed');
        expect((await models.product.findOne({ sku: 'P-5' }))!.name).toBe('Broken');
    });

    test('a photo-only candidate is reported as a Photo change', async () => {
        const brand = await models.brand.create({ name: 'Acme' });
        await models.product.create({ name: 'Bare', sku: 'P-7', brandId: brand.id });
        const { fetcher } = recordingFetcher();

        const result = await applyProductSync(
            [candidate({ sku: 'P-7', name: 'Bare', brand: 'Acme', change: 'Photo', action: 'update', photo: 'Add' })],
            fetcher
        );

        expect(result.synced[0]).toMatchObject({ change: 'Photo', photo: 'Added' });
        expect((await models.product.findOne({ sku: 'P-7' }))!.image).not.toBeNull();
    });
});

const zohoCtx: ZohoProductCtx = {
    env: {
        ZOHO_ACCOUNTS_BASE_URL: 'https://accounts.example',
        ZOHO_CLIENT_ID: 'client',
        ZOHO_BOOKS_BASE_URL: 'https://books.example/v3',
        ZOHO_BOOKS_ORG_ID: 'org',
    },
    secrets: { ZOHO_CLIENT_SECRET: 'secret' },
};

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('computeSyncCandidates', () => {
    // Stubs Zoho's /items and /itemdetails with the given items (only details
    // carry custom fields and image fields) and records every URL requested.
    function stubZoho(items: Record<string, unknown>[]) {
        const urls: string[] = [];
        vi.stubGlobal('fetch', async (url: string) => {
            urls.push(url);
            if (url.includes('/itemdetails')) return jsonResponse({ items });
            if (url.includes('/items?')) {
                return jsonResponse({
                    items: items.map(({ item_id, name, sku, status }) => ({ item_id, name, sku, status })),
                    page_context: { page: 1, per_page: 200, has_more_page: false },
                });
            }
            throw new Error(`unexpected Zoho request: ${url}`);
        });
        return urls;
    }

    const brandField = { customfield_id: 'cf', label: 'Brand', value: 'Acme' };

    test('offers a photo only to products without one, without downloading any', async () => {
        const brand = await models.brand.create({ name: 'Acme' });
        await models.product.create({ name: 'Has photo', sku: 'S-1', brandId: brand.id, image: pngFile() });
        await models.product.create({ name: 'No photo', sku: 'S-2', brandId: brand.id });
        await models.product.create({ name: 'Zoho has none', sku: 'S-3', brandId: brand.id });

        const urls = stubZoho([
            { item_id: 'z1', name: 'Has photo', sku: 'S-1', status: 'active', custom_fields: [brandField], image_name: 's1.png' },
            { item_id: 'z2', name: 'No photo', sku: 'S-2', status: 'active', custom_fields: [brandField], image_name: 's2.jpg' },
            { item_id: 'z3', name: 'Zoho has none', sku: 'S-3', status: 'active', custom_fields: [brandField] },
            { item_id: 'z4', name: 'Brand new', sku: 'S-4', status: 'active', custom_fields: [brandField], image_name: 's4.png' },
        ]);

        const candidates = await computeSyncCandidates(zohoCtx, 'token');

        expect(candidates.map((c) => [c.sku, c.change, c.photo, c.imageName])).toEqual([
            ['S-2', 'Photo', 'Add', 's2.jpg'],
            ['S-4', 'New', 'Add', 's4.png'],
        ]);
        // The diff pass never downloads an image.
        expect(urls.some((u) => u.includes('/image'))).toBe(false);
    });

    test('a name change on a product that has a photo does not offer a new one', async () => {
        const brand = await models.brand.create({ name: 'Acme' });
        await models.product.create({ name: 'Old', sku: 'S-5', brandId: brand.id, image: pngFile() });
        stubZoho([{ item_id: 'z5', name: 'Renamed', sku: 'S-5', status: 'active', custom_fields: [brandField], image_name: 'x.png' }]);

        const candidates = await computeSyncCandidates(zohoCtx, 'token');

        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toMatchObject({ change: 'Update', photo: '' });
    });
});

describe('zohoPhotoFetcher', () => {
    test('downloads the item image as a file named after the Zoho image', async () => {
        const requested: string[] = [];
        vi.stubGlobal('fetch', async (url: string) => {
            requested.push(url);
            return new Response(Buffer.from([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
        });

        const file = await zohoPhotoFetcher(zohoCtx, 'token')('z9', 'widget.jpg');

        expect(requested).toEqual(['https://books.example/v3/items/z9/image?organization_id=org']);
        expect(file!.filename).toBe('widget.jpg');
        expect(file!.contentType).toBe('image/jpeg');
        expect([...(await file!.read())]).toEqual([1, 2, 3]);
    });

    test('returns null when Zoho has no image', async () => {
        vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
        expect(await zohoPhotoFetcher(zohoCtx, 'token')('z9', null)).toBeNull();
    });

    test('treats a JSON reply (e.g. a rate-limit error) as a failure, not a photo', async () => {
        vi.stubGlobal('fetch', async () => jsonResponse({ code: 1070, message: 'rate limit exceeded' }));
        await expect(zohoPhotoFetcher(zohoCtx, 'token')('z9', null)).rejects.toThrow(/instead of an image/);
    });
});
