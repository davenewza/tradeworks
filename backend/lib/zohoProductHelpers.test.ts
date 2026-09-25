import { models, resetDatabase } from '@teamkeel/testing';
import { InlineFile } from '@teamkeel/sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
    applyProductSync,
    buildSyncCandidates,
    computeSyncCandidates,
    ExistingProduct,
    isItemInactive,
    PhotoFetcher,
    resolveSelectedCandidates,
    SyncCandidate,
    ZohoItem,
    ZohoProductCtx,
    zohoPhotoFetcher,
} from './zohoProductHelpers';

beforeEach(resetDatabase);
afterEach(() => vi.unstubAllGlobals());

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

// Build a SyncCandidate; the apply pass only reads sku/name/brand/action/reason,
// so the remaining fields are filled with representative values.
function candidate(overrides: Partial<SyncCandidate> & Pick<SyncCandidate, 'sku' | 'name' | 'brand'>): SyncCandidate {
    return {
        change: 'New',
        reason: 'Not in our catalogue yet',
        photo: '',
        imageName: null,
        isActive: true,
        zohoItemId: `zoho-${overrides.sku}`,
        action: 'create',
        ...overrides,
    };
}

// Build a Zoho item as /itemdetails returns it: active, with a Brand custom
// field, unless overridden.
function zohoItem(overrides: Partial<ZohoItem> & Pick<ZohoItem, 'sku' | 'name'>): ZohoItem {
    return {
        item_id: `zoho-${overrides.sku}`,
        status: 'active',
        custom_fields: [{ label: 'Brand', value: 'Acme' }],
        ...overrides,
    };
}

function existing(overrides: Partial<ExistingProduct> = {}): ExistingProduct {
    return { name: 'Widget', brandName: 'Acme', isActive: true, hasImage: false, ...overrides };
}

describe('applyProductSync', () => {
    test('creates new products and their brand', async () => {
        const result = await applyProductSync([
            candidate({ sku: 'A-1', name: 'Widget', brand: 'Acme' }),
            candidate({ sku: 'A-2', name: 'Gadget', brand: 'Acme' }),
        ]);

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
        ]);

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

        await applyProductSync([candidate({ sku: 'C-1', name: 'Thing', brand: 'Acme' })]);

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

        await applyProductSync([candidate({ sku: 'D-2', name: 'Synced', brand: 'Untouched Brand' })]);

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
            reporter
        );

        expect(state.total).toBe(3);
        expect(state.current).toBe(3); // one increment per product
        expect(state.logs).toHaveLength(3);
    });

    test('switches off a deactivated product, leaving its name and brand as they were', async () => {
        const brand = await models.brand.create({ name: 'Acme' });
        await models.product.create({ name: 'Widget', sku: 'F-1', brandId: brand.id });

        const result = await applyProductSync([
            candidate({
                sku: 'F-1',
                name: 'Widget',
                brand: 'Acme',
                change: 'Deactivate',
                reason: 'Inactive in Zoho',
                action: 'deactivate',
            }),
        ]);

        expect(result).toMatchObject({ created: 0, updated: 0, deactivated: 1 });
        expect(result.synced[0]).toMatchObject({ sku: 'F-1', change: 'Deactivate', reason: 'Inactive in Zoho' });

        const product = await models.product.findOne({ sku: 'F-1' });
        expect(product!.isActive).toBe(false);
        expect(product!.name).toBe('Widget');
        expect(product!.brandId).toBe(brand.id);
        expect(product!.synchronisedAt).not.toBeNull();
    });

    test('a deactivation never creates a brand', async () => {
        const brand = await models.brand.create({ name: 'Acme' });
        await models.product.create({ name: 'Widget', sku: 'G-1', brandId: brand.id });

        await applyProductSync([
            candidate({ sku: 'G-1', name: 'Widget', brand: 'Acme', change: 'Deactivate', action: 'deactivate' }),
        ]);

        expect(await models.brand.findMany({})).toHaveLength(1);
    });

    test('skips a deactivation whose product has since gone, without failing the run', async () => {
        const { reporter, state } = recordingProgress();

        const result = await applyProductSync(
            [
                candidate({ sku: 'H-1', name: 'Vanished', brand: 'Acme', change: 'Deactivate', action: 'deactivate' }),
                candidate({ sku: 'H-2', name: 'Added', brand: 'Acme' }),
            ],
            reporter
        );

        expect(result).toMatchObject({ created: 1, updated: 0, deactivated: 0 });
        expect(result.synced.map((s) => s.sku)).toEqual(['H-2']);
        expect(state.current).toBe(2); // both rows counted, one of them a skip
        expect(state.logs[0]).toContain('Skipped H-1');
    });

    test('creates an inactive item as an inactive product, counted apart', async () => {
        const result = await applyProductSync([
            candidate({ sku: 'H-9', name: 'Retired', brand: 'Acme', isActive: false }),
            candidate({ sku: 'H-8', name: 'Live', brand: 'Acme' }),
        ]);

        expect(result).toMatchObject({ created: 2, createdInactive: 1 });
        expect((await models.product.findOne({ sku: 'H-9' }))!.isActive).toBe(false);
        expect((await models.product.findOne({ sku: 'H-8' }))!.isActive).toBe(true);
    });

    test('reactivates a product, refreshing its name and brand on the way back', async () => {
        const oldBrand = await models.brand.create({ name: 'Old Brand' });
        await models.product.create({
            name: 'Old Name',
            sku: 'J-1',
            brandId: oldBrand.id,
            isActive: false,
        });

        const result = await applyProductSync([
            candidate({
                sku: 'J-1',
                name: 'New Name',
                brand: 'New Brand',
                change: 'Reactivate',
                reason: 'Active again in Zoho',
                action: 'reactivate',
            }),
        ]);

        expect(result).toMatchObject({ created: 0, updated: 0, reactivated: 1 });
        expect(result.synced[0]).toMatchObject({ sku: 'J-1', change: 'Reactivate' });

        const product = await models.product.findOne({ sku: 'J-1' });
        expect(product!.isActive).toBe(true);
        expect(product!.name).toBe('New Name');
    });

    test('an ordinary update never touches status', async () => {
        // A rename on a product that is off must not quietly switch it on.
        const brand = await models.brand.create({ name: 'Acme' });
        await models.product.create({ name: 'Old', sku: 'K-1', brandId: brand.id, isActive: false });

        await applyProductSync([
            candidate({ sku: 'K-1', name: 'Renamed', brand: 'Acme', change: 'Update', action: 'update' }),
        ]);

        const product = await models.product.findOne({ sku: 'K-1' });
        expect(product!.name).toBe('Renamed');
        expect(product!.isActive).toBe(false);
    });

    test('is idempotent — re-deactivating an off product is a no-op on its state', async () => {
        const brand = await models.brand.create({ name: 'Acme' });
        await models.product.create({ name: 'Widget', sku: 'I-1', brandId: brand.id });
        const selected = [
            candidate({ sku: 'I-1', name: 'Widget', brand: 'Acme', change: 'Deactivate', action: 'deactivate' }),
        ];

        await applyProductSync(selected);
        const second = await applyProductSync(selected);

        expect(second.deactivated).toBe(1);
        expect((await models.product.findOne({ sku: 'I-1' }))!.isActive).toBe(false);
    });

    test('is idempotent — re-running a create becomes an update, no duplicates', async () => {
        const selected = [candidate({ sku: 'E-1', name: 'First', brand: 'Acme' })];

        const first = await applyProductSync(selected);
        expect(first.created).toBe(1);

        const second = await applyProductSync(selected);
        expect(second.created).toBe(0);
        expect(second.updated).toBe(1);

        const products = await models.product.findMany({ where: { sku: { equals: 'E-1' } } });
        expect(products).toHaveLength(1);
    });
});

describe('isItemInactive', () => {
    test('reads Zoho item status, tolerating case and padding', () => {
        expect(isItemInactive(zohoItem({ sku: 'A', name: 'A', status: 'inactive' }))).toBe(true);
        expect(isItemInactive(zohoItem({ sku: 'A', name: 'A', status: '  Inactive ' }))).toBe(true);
        expect(isItemInactive(zohoItem({ sku: 'A', name: 'A', status: 'active' }))).toBe(false);
        expect(isItemInactive(zohoItem({ sku: 'A', name: 'A', status: undefined }))).toBe(false);
    });
});

describe('buildSyncCandidates', () => {
    test('adds items we do not carry yet', () => {
        const candidates = buildSyncCandidates([zohoItem({ sku: 'A-1', name: 'Widget' })], new Map());

        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toMatchObject({
            sku: 'A-1',
            name: 'Widget',
            brand: 'Acme',
            change: 'New',
            action: 'create',
        });
    });

    test('updates a product whose name or brand moved on, and says which', () => {
        const items = [
            zohoItem({ sku: 'N-1', name: 'Renamed' }),
            zohoItem({
                sku: 'B-1',
                name: 'Widget',
                custom_fields: [{ label: 'Brand', value: 'Rebranded' }],
            }),
            zohoItem({
                sku: 'NB-1',
                name: 'Renamed',
                custom_fields: [{ label: 'Brand', value: 'Rebranded' }],
            }),
        ];
        const held = new Map<string, ExistingProduct>([
            ['N-1', existing()],
            ['B-1', existing()],
            ['NB-1', existing()],
        ]);

        expect(buildSyncCandidates(items, held).map((c) => [c.sku, c.change, c.reason])).toEqual([
            ['N-1', 'Update', 'Name changed in Zoho'],
            ['B-1', 'Update', 'Brand changed in Zoho'],
            ['NB-1', 'Update', 'Name and brand changed in Zoho'],
        ]);
    });

    test('produces nothing for a product that already matches Zoho', () => {
        const held = new Map<string, ExistingProduct>([['M-1', existing({ name: 'Widget', brandName: 'Acme' })]]);

        expect(buildSyncCandidates([zohoItem({ sku: 'M-1', name: 'Widget' })], held)).toEqual([]);
    });

    test('deactivates a product whose Zoho item has gone inactive', () => {
        const held = new Map<string, ExistingProduct>([['I-1', existing()]]);

        const candidates = buildSyncCandidates(
            [zohoItem({ sku: 'I-1', name: 'Widget', status: 'inactive' })],
            held
        );

        expect(candidates.map((c) => [c.sku, c.change, c.action, c.reason])).toEqual([
            ['I-1', 'Deactivate', 'deactivate', 'Inactive in Zoho'],
        ]);
    });

    test('a rename on an inactive item still only deactivates — the name is not worth syncing', () => {
        const held = new Map<string, ExistingProduct>([['I-3', existing({ name: 'Old Name' })]]);

        const candidates = buildSyncCandidates(
            [zohoItem({ sku: 'I-3', name: 'Renamed', status: 'inactive' })],
            held
        );

        expect(candidates.map((c) => c.change)).toEqual(['Deactivate']);
    });

    test('shows the brand we hold on a deactivation, not the one on the Zoho item', () => {
        // An obsolete item's brand custom field is often stale or cleared in
        // Zoho — our own record is the one to show.
        const item = zohoItem({ sku: 'I-2', name: 'Widget', status: 'inactive', custom_fields: [] });
        const held = new Map<string, ExistingProduct>([['I-2', existing({ brandName: 'Acme' })]]);

        expect(buildSyncCandidates([item], held)[0].brand).toBe('Acme');
    });

    test('imports an inactive item we do not carry, as an inactive product', () => {
        // Without the product row, every invoice line for this SKU is dropped
        // by the sales sync with "no product found".
        const candidates = buildSyncCandidates(
            [zohoItem({ sku: 'X-1', name: 'Retired', status: 'inactive' })],
            new Map()
        );

        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toMatchObject({
            sku: 'X-1',
            name: 'Retired',
            brand: 'Acme',
            change: 'New',
            action: 'create',
            isActive: false,
            reason: 'Inactive in Zoho — imported for its history',
        });
    });

    test('an inactive item we already hold as inactive produces nothing', () => {
        // It is a history record, not a catalogue entry — re-proposing it every
        // run would bury the real changes.
        const held = new Map<string, ExistingProduct>([['X-2', existing({ name: 'Old', isActive: false })]]);

        expect(buildSyncCandidates([zohoItem({ sku: 'X-2', name: 'Renamed', status: 'inactive' })], held)).toEqual([]);
    });

    test('reactivates a product whose Zoho item is active again, refreshing its name and brand', () => {
        const held = new Map<string, ExistingProduct>([
            ['R-9', existing({ name: 'Old Name', brandName: 'Old Brand', isActive: false })],
        ]);

        const candidates = buildSyncCandidates([zohoItem({ sku: 'R-9', name: 'New Name' })], held);

        expect(candidates).toHaveLength(1);
        expect(candidates[0]).toMatchObject({
            sku: 'R-9',
            name: 'New Name',
            brand: 'Acme',
            change: 'Reactivate',
            action: 'reactivate',
            isActive: true,
            reason: 'Active again in Zoho',
        });
    });

    test('skips items with no SKU — there is nothing to match them on', () => {
        expect(buildSyncCandidates([zohoItem({ sku: '   ', name: 'No SKU' })], new Map())).toEqual([]);
    });
});


// What ctx.ui.select.table() actually hands back. Its processTableData() keeps
// only the keys named in `columns` before the rows are sent to the browser, so
// the selection returns with `action`, `isActive` and `zohoItemId` missing.
// Checked against the real runtime rather than inferred: driving
// ctx.ui.select.table() with a full candidate emits exactly these five keys.
const PICKER_COLUMNS = ['sku', 'name', 'brand', 'change', 'reason'] as const;

function throughPicker(candidates: SyncCandidate[]): { sku: string }[] {
    return candidates.map(
        (c) => Object.fromEntries(Object.entries(c).filter(([k]) => PICKER_COLUMNS.includes(k as never))) as { sku: string }
    );
}

describe('resolveSelectedCandidates', () => {
    test('restores the fields the picker stripped', () => {
        const candidates = buildSyncCandidates(
            [zohoItem({ sku: 'S-1', name: 'Widget', status: 'inactive' })],
            new Map([['S-1', existing()]])
        );

        // Precondition: the picker really does drop them.
        const rows = throughPicker(candidates);
        expect(rows[0]).not.toHaveProperty('action');
        expect(rows[0]).not.toHaveProperty('isActive');

        expect(resolveSelectedCandidates(candidates, rows)).toEqual(candidates);
    });

    test('returns only the ticked rows, and tolerates one that no longer matches', () => {
        const candidates = buildSyncCandidates(
            [zohoItem({ sku: 'S-1', name: 'One' }), zohoItem({ sku: 'S-2', name: 'Two' })],
            new Map()
        );

        const resolved = resolveSelectedCandidates(candidates, [{ sku: 'S-2' }, { sku: 'GONE' }]);
        expect(resolved.map((c) => c.sku)).toEqual(['S-2']);
    });
});

describe('the picker round trip', () => {
    beforeEach(resetDatabase);

    test('a deactivation ticked in the picker really switches the product off', async () => {
        // The regression: applying the picker's rows directly left `action`
        // undefined, so the row fell through to the update path — the product
        // was renamed, counted as updated, and never deactivated.
        const brand = await models.brand.create({ name: 'Acme' });
        await models.product.create({ name: 'Widget', sku: 'RT-1', brandId: brand.id });

        const candidates = buildSyncCandidates(
            [zohoItem({ sku: 'RT-1', name: 'Widget', status: 'inactive' })],
            new Map([['RT-1', existing()]])
        );
        expect(candidates[0].change).toBe('Deactivate');

        const result = await applyProductSync(resolveSelectedCandidates(candidates, throughPicker(candidates)));

        expect(result).toMatchObject({ deactivated: 1, updated: 0 });
        expect((await models.product.findOne({ sku: 'RT-1' }))!.isActive).toBe(false);
    });

    test('applying the picker rows unresolved fails loudly rather than renaming', async () => {
        const brand = await models.brand.create({ name: 'Acme' });
        await models.product.create({ name: 'Widget', sku: 'RT-2', brandId: brand.id });

        const candidates = buildSyncCandidates(
            [zohoItem({ sku: 'RT-2', name: 'Renamed', status: 'inactive' })],
            new Map([['RT-2', existing()]])
        );

        await expect(applyProductSync(throughPicker(candidates) as SyncCandidate[])).rejects.toThrow(
            /no recognised action/
        );

        // And nothing was written on the way to that error.
        const product = await models.product.findOne({ sku: 'RT-2' });
        expect(product!.name).toBe('Widget');
        expect(product!.isActive).toBe(true);
    });
});

// ─── Photos ─────────────────────────────────────────────────────────────────

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

describe('buildSyncCandidates — photos', () => {
    const pictured = (overrides: Partial<ZohoItem> = {}) =>
        zohoItem({ sku: 'W-1', name: 'Widget', image_name: 'w1.jpg', ...overrides });

    test('offers a photo-only change to a product that has none when Zoho has one', () => {
        const [c] = buildSyncCandidates([pictured()], new Map([['W-1', existing()]]));
        expect(c).toMatchObject({ change: 'Photo', action: 'update', photo: 'Add', imageName: 'w1.jpg' });
    });

    test('never offers a photo to a product that already has one', () => {
        const candidates = buildSyncCandidates([pictured()], new Map([['W-1', existing({ hasImage: true })]]));
        expect(candidates).toEqual([]);
    });

    test('a rename of a product with a photo is an ordinary update', () => {
        const [c] = buildSyncCandidates(
            [pictured({ name: 'Renamed' })],
            new Map([['W-1', existing({ hasImage: true })]])
        );
        expect(c).toMatchObject({ change: 'Update', photo: '' });
    });

    test('a rename of a product without a photo carries the photo along', () => {
        const [c] = buildSyncCandidates([pictured({ name: 'Renamed' })], new Map([['W-1', existing()]]));
        expect(c).toMatchObject({ change: 'Update', photo: 'Add' });
    });

    test('new and reactivated products are offered the photo', () => {
        const candidates = buildSyncCandidates(
            [pictured({ sku: 'N-1' }), pictured({ sku: 'R-1' })],
            new Map([['R-1', existing({ isActive: false })]])
        );
        expect(candidates.map((c) => [c.change, c.photo])).toEqual([
            ['New', 'Add'],
            ['Reactivate', 'Add'],
        ]);
    });

    test('inactive items never get a photo — they are out of the catalogue', () => {
        const candidates = buildSyncCandidates(
            [pictured({ sku: 'I-1', status: 'inactive' }), pictured({ sku: 'I-2', status: 'inactive' })],
            new Map([['I-2', existing()]])
        );
        expect(candidates.map((c) => [c.change, c.photo])).toEqual([
            ['New', ''],
            ['Deactivate', ''],
        ]);
    });

    test('no photo is offered when Zoho has none', () => {
        const candidates = buildSyncCandidates([zohoItem({ sku: 'W-1', name: 'Widget' })], new Map([['W-1', existing()]]));
        expect(candidates).toEqual([]);
    });

    test('the photo survives the picker round trip', () => {
        const candidates = buildSyncCandidates([pictured()], new Map([['W-1', existing()]]));
        const [resolved] = resolveSelectedCandidates(candidates, throughPicker(candidates));
        expect(resolved).toMatchObject({ photo: 'Add', imageName: 'w1.jpg', zohoItemId: 'zoho-W-1' });
    });
});

describe('applyProductSync — photos', () => {
    test('adds a photo to a new product when Zoho has one', async () => {
        const { fetcher, calls } = recordingFetcher();

        const result = await applyProductSync(
            [candidate({ sku: 'P-1', name: 'Pictured', brand: 'Acme', photo: 'Add', imageName: 'p1.png' })],
            undefined,
            fetcher
        );

        expect(calls).toEqual(['zoho-P-1']);
        expect(result.photosAdded).toBe(1);
        expect(result.synced[0].photo).toBe('Added');
        const product = await models.product.findOne({ sku: 'P-1' });
        expect(product!.image!.contentType).toBe('image/png');
    });

    test('never downloads a photo for a product that already has one', async () => {
        // The photo was uploaded by hand between the review page and apply.
        const brand = await models.brand.create({ name: 'Acme' });
        await models.product.create({ name: 'Mine', sku: 'P-2', brandId: brand.id, image: pngFile('mine.png') });
        const { fetcher, calls } = recordingFetcher();

        const result = await applyProductSync(
            [candidate({ sku: 'P-2', name: 'Mine', brand: 'Acme', change: 'Photo', action: 'update', photo: 'Add' })],
            undefined,
            fetcher
        );

        expect(calls).toEqual([]);
        expect(result.photosAdded).toBe(0);
        expect((await models.product.findOne({ sku: 'P-2' }))!.image!.filename).toBe('mine.png');
    });

    test("only downloads photos for candidates flagged 'Add'", async () => {
        const { fetcher, calls } = recordingFetcher();

        await applyProductSync(
            [
                candidate({ sku: 'P-3', name: 'With', brand: 'Acme', photo: 'Add' }),
                candidate({ sku: 'P-4', name: 'Without', brand: 'Acme' }),
            ],
            undefined,
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
            undefined,
            failing
        );

        expect(result.created).toBe(2);
        expect(result.photosAdded).toBe(0);
        expect(result.photoFailures).toEqual([{ sku: 'P-5', error: 'Zoho rate limit' }]);
        expect(result.synced.find((s) => s.sku === 'P-5')!.photo).toBe('Failed');
    });

    test('a photo-only change is reported as Photo and not counted as an update', async () => {
        const brand = await models.brand.create({ name: 'Acme' });
        await models.product.create({ name: 'Bare', sku: 'P-7', brandId: brand.id });
        const { fetcher } = recordingFetcher();

        const result = await applyProductSync(
            [candidate({ sku: 'P-7', name: 'Bare', brand: 'Acme', change: 'Photo', action: 'update', photo: 'Add' })],
            undefined,
            fetcher
        );

        expect(result.updated).toBe(0);
        expect(result.photosAdded).toBe(1);
        expect(result.synced[0]).toMatchObject({ change: 'Photo', photo: 'Added' });
    });

    test('fails loudly when a photo is wanted but no fetcher was given', async () => {
        await expect(
            applyProductSync([candidate({ sku: 'P-8', name: 'Orphan', brand: 'Acme', photo: 'Add' })])
        ).rejects.toThrow(/no photo fetcher/);
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

describe('computeSyncCandidates — photos', () => {
    test('reads which products already have a photo, and downloads no images', async () => {
        const brand = await models.brand.create({ name: 'Acme' });
        await models.product.create({ name: 'Has photo', sku: 'S-1', brandId: brand.id, image: pngFile() });
        await models.product.create({ name: 'No photo', sku: 'S-2', brandId: brand.id });

        const details = [
            zohoItem({ sku: 'S-1', name: 'Has photo', image_name: 's1.png' }),
            zohoItem({ sku: 'S-2', name: 'No photo', image_name: 's2.png' }),
        ];
        const urls: string[] = [];
        vi.stubGlobal('fetch', async (url: string) => {
            urls.push(url);
            if (url.includes('/itemdetails')) return jsonResponse({ items: details });
            if (url.includes('/items?')) {
                return jsonResponse({
                    items: details.map(({ item_id, name, sku, status }) => ({ item_id, name, sku, status })),
                    page_context: { page: 1, per_page: 200, has_more_page: false },
                });
            }
            throw new Error(`unexpected Zoho request: ${url}`);
        });

        const candidates = await computeSyncCandidates(zohoCtx, 'token');

        expect(candidates.map((c) => [c.sku, c.change, c.photo])).toEqual([['S-2', 'Photo', 'Add']]);
        expect(urls.some((u) => u.includes('/image'))).toBe(false);
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
