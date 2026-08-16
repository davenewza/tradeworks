import { models, resetDatabase } from '@teamkeel/testing';
import { beforeEach, describe, expect, test } from 'vitest';
import { applyProductSync, SyncCandidate } from './zohoProductHelpers';

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

// Build a SyncCandidate; the apply pass only reads sku/name/brand, so the
// display/hidden fields are filled with representative values.
function candidate(overrides: Partial<SyncCandidate> & Pick<SyncCandidate, 'sku' | 'name' | 'brand'>): SyncCandidate {
    return {
        change: 'New',
        zohoItemId: `zoho-${overrides.sku}`,
        action: 'create',
        ...overrides,
    };
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
