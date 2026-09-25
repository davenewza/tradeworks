import { models } from '@teamkeel/sdk';

// Seeding suppliers from brands — see CreateSuppliersFromBrands. Most brands
// are bought straight from the brand owner, so a supplier named after the
// brand, with the brand's lead time, is the right starting point for most of
// the catalogue. The exceptions are fixed up per product afterwards.

export interface BrandSupplierCandidate {
    brandId: string;
    brand: string;
    leadTimeInDays: number;
    // Active products of this brand with no supplier yet.
    products: number;
    // 'Create' makes a new supplier; 'Reuse' assigns to the existing supplier
    // with the brand's name (its own lead time and currency are left alone).
    action: 'Create' | 'Reuse';
}

// One row per brand that still has active products without a supplier.
export async function planSuppliersFromBrands(): Promise<BrandSupplierCandidate[]> {
    const [brands, products, suppliers] = await Promise.all([
        models.brand.findMany({}),
        models.product.findMany({ where: { isActive: { equals: true }, supplierId: { equals: null } } }),
        models.supplier.findMany({}),
    ]);
    const unassigned = new Map<string, number>();
    for (const p of products) unassigned.set(p.brandId, (unassigned.get(p.brandId) ?? 0) + 1);
    const supplierNames = new Set(suppliers.map((s) => s.name));

    return brands
        .filter((b) => (unassigned.get(b.id) ?? 0) > 0)
        .map((b) => ({
            brandId: b.id,
            brand: b.name,
            leadTimeInDays: b.leadTimeInDays,
            products: unassigned.get(b.id)!,
            action: supplierNames.has(b.name) ? ('Reuse' as const) : ('Create' as const),
        }))
        .sort((a, b) => a.brand.localeCompare(b.brand));
}

export interface SuppliersFromBrandsResult {
    suppliersCreated: number;
    productsAssigned: number;
}

// For each chosen brand: find or create the supplier named after it, then
// assign it to the brand's active products that still have no supplier.
// Products that already have one are never moved, so re-running is harmless.
export async function applySuppliersFromBrands(brandIds: string[]): Promise<SuppliersFromBrandsResult> {
    let suppliersCreated = 0;
    let productsAssigned = 0;

    for (const brandId of brandIds) {
        const brand = await models.brand.findOne({ id: brandId });
        if (!brand) continue;

        let supplier = await models.supplier.findOne({ name: brand.name });
        if (!supplier) {
            supplier = await models.supplier.create({ name: brand.name, leadTimeInDays: brand.leadTimeInDays });
            suppliersCreated++;
        }

        const products = await models.product.findMany({
            where: { brandId: { equals: brandId }, isActive: { equals: true }, supplierId: { equals: null } },
        });
        for (const p of products) {
            await models.product.update({ id: p.id }, { supplierId: supplier.id });
            productsAssigned++;
        }
    }

    return { suppliersCreated, productsAssigned };
}
