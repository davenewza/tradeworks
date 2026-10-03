import { models, resetDatabase } from '@teamkeel/testing';
import { Currency } from '@teamkeel/sdk';
import { beforeEach, describe, expect, test } from 'vitest';
import { applySuppliersFromBrands, planSuppliersFromBrands } from './supplierHelpers';

beforeEach(resetDatabase);

describe('suppliers from brands', () => {
    async function seed() {
        const acme = await models.brand.create({ name: 'Acme', leadTimeInDays: 45 });
        const bolt = await models.brand.create({ name: 'Bolt' });
        const done = await models.brand.create({ name: 'Done' });
        const distributor = await models.supplier.create({ name: 'Distributor', currency: Currency.USD });
        // An existing supplier sharing a brand's name is reused, not duplicated.
        const boltSupplier = await models.supplier.create({ name: 'Bolt', currency: Currency.GBP, leadTimeInDays: 90 });

        const a1 = await models.product.create({ name: 'A1', sku: 'A1', brandId: acme.id });
        const a2 = await models.product.create({ name: 'A2', sku: 'A2', brandId: acme.id });
        // Already assigned elsewhere: never moved.
        const a3 = await models.product.create({ name: 'A3', sku: 'A3', brandId: acme.id, supplierId: distributor.id });
        // Inactive: not planned, not assigned.
        const a4 = await models.product.create({ name: 'A4', sku: 'A4', brandId: acme.id, isActive: false });
        const b1 = await models.product.create({ name: 'B1', sku: 'B1', brandId: bolt.id });
        await models.product.create({ name: 'D1', sku: 'D1', brandId: done.id, supplierId: distributor.id });

        return { acme, bolt, distributor, boltSupplier, a1, a2, a3, a4, b1 };
    }

    test('plans one row per brand that still has active products without a supplier', async () => {
        const { acme, bolt } = await seed();
        expect(await planSuppliersFromBrands()).toEqual([
            { brandId: acme.id, brand: 'Acme', leadTimeInDays: 45, products: 2, action: 'Create' },
            { brandId: bolt.id, brand: 'Bolt', leadTimeInDays: 60, products: 1, action: 'Reuse' },
        ]);
    });

    test('creates or reuses the supplier and assigns only the unassigned active products', async () => {
        const { acme, bolt, distributor, boltSupplier, a1, a2, a3, a4, b1 } = await seed();

        expect(await applySuppliersFromBrands([acme.id, bolt.id])).toEqual({ suppliersCreated: 1, productsAssigned: 3 });

        const acmeSupplier = await models.supplier.findOne({ name: 'Acme' });
        expect(acmeSupplier).toMatchObject({ leadTimeInDays: 45, currency: Currency.ZAR });
        const supplierOf = async (id: string) => (await models.product.findOne({ id }))!.supplierId;
        expect(await supplierOf(a1.id)).toBe(acmeSupplier!.id);
        expect(await supplierOf(a2.id)).toBe(acmeSupplier!.id);
        expect(await supplierOf(a3.id)).toBe(distributor.id);
        expect(await supplierOf(a4.id)).toBeNull();
        expect(await supplierOf(b1.id)).toBe(boltSupplier.id);
        // The reused supplier keeps its own settings.
        expect(await models.supplier.findOne({ id: boltSupplier.id })).toMatchObject({ currency: Currency.GBP, leadTimeInDays: 90 });

        // Nothing left to do, and running it again changes nothing.
        expect(await planSuppliersFromBrands()).toEqual([]);
        expect(await applySuppliersFromBrands([acme.id, bolt.id])).toEqual({ suppliersCreated: 0, productsAssigned: 0 });
    });
});
