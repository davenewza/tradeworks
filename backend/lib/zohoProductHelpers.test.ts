import { models, resetDatabase } from '@teamkeel/testing';
import { beforeEach, describe, expect, test } from 'vitest';
import {
    applyProductSync,
    buildSyncCandidates,
    ExistingProduct,
    isItemInactive,
    resolveSelectedCandidates,
    SyncCandidate,
    ZohoItem,
} from './zohoProductHelpers';

beforeEach(resetDatabase);

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
    return { name: 'Widget', brandName: 'Acme', isActive: true, ...overrides };
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
