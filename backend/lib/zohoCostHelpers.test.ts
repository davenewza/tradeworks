import { models, resetDatabase } from '@teamkeel/testing';
import { beforeEach, describe, expect, test } from 'vitest';
import {
    ZohoCostLine,
    ZohoBillDetail,
    ZohoLandedCost,
    buildCostLinesForBill,
    computeCostSyncPlan,
    applyCostSync,
} from './zohoCostHelpers';

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

// ─── buildCostLinesForBill (pure) ─────────────────────────────────────────────
// Fixtures mirror the real Zoho payloads captured from bill "Nicole20210322".

describe('buildCostLinesForBill', () => {
    const bill: ZohoBillDetail = {
        bill_id: 'b1',
        bill_number: 'Nicole20210322',
        date: '2021-03-22',
        vendor_name: 'Kuongshun Electronic Limited',
        allocated_landed_costs: [{ landed_cost_id: 'lc-freight' }, { landed_cost_id: 'lc-customs' }],
        line_items: [
            { line_item_id: 'li-1', sku: 'BREADBOARD', name: '400 Points Breadboard', rate: 9.03, quantity: 20 },
            { line_item_id: 'li-2', sku: 'SENSOR-KIT', name: '37-in-1 Sensor Kit', rate: 138.87, quantity: 9 },
            // A landed-cost expense line on the bill — must be excluded.
            { line_item_id: 'li-lc', name: 'Freight', rate: 2099.37, quantity: 1, is_landedcost: true },
        ],
    };

    test('sums allocations across landed costs and divides by quantity', () => {
        const landedCosts: ZohoLandedCost[] = [
            {
                landed_cost_id: 'lc-freight',
                cost_allocations: [
                    { bill_item_id: 'li-1', allocated_amount: 99.73 },
                    { bill_item_id: 'li-2', allocated_amount: 690.19 },
                ],
            },
            {
                landed_cost_id: 'lc-customs',
                cost_allocations: [
                    { bill_item_id: 'li-1', allocated_amount: 20.27 }, // extra freight on the same line
                    { bill_item_id: 'li-2', allocated_amount: 9.0 },
                ],
            },
        ];

        const lines = buildCostLinesForBill(bill, landedCosts);
        expect(lines).toHaveLength(2); // the is_landedcost line is excluded

        const bread = lines.find((l) => l.sku === 'BREADBOARD')!;
        // Stable per-(product, bill) key, not the Zoho line_item_id.
        expect(bread.zohoRecordId).toBe('b1::BREADBOARD');
        expect(bread.unitCost).toBe(9.03);
        // (99.73 + 20.27) / 20 = 6.00
        expect(bread.unitFreightIn).toBeCloseTo(6.0, 10);
        expect(bread.billNumber).toBe('Nicole20210322');
        expect(bread.vendorName).toBe('Kuongshun Electronic Limited');

        const kit = lines.find((l) => l.sku === 'SENSOR-KIT')!;
        // (690.19 + 9.0) / 9 = 77.688...
        expect(kit.unitFreightIn).toBeCloseTo(699.19 / 9, 8);
    });

    test('a line with no allocation gets zero freight', () => {
        const [bread] = buildCostLinesForBill(bill, [
            { landed_cost_id: 'lc-freight', cost_allocations: [{ bill_item_id: 'li-2', allocated_amount: 690.19 }] },
        ]);
        expect(bread.sku).toBe('BREADBOARD');
        expect(bread.unitFreightIn).toBe(0);
    });

    test('never divides by zero when quantity is zero', () => {
        const zeroQty: ZohoBillDetail = {
            ...bill,
            line_items: [{ line_item_id: 'li-1', sku: 'BREADBOARD', rate: 9.03, quantity: 0 }],
        };
        const [line] = buildCostLinesForBill(zeroQty, [
            { landed_cost_id: 'lc', cost_allocations: [{ bill_item_id: 'li-1', allocated_amount: 50 }] },
        ]);
        expect(line.unitFreightIn).toBe(0);
    });

    test('folds two lines of the same SKU into one (product, bill) cost line', () => {
        // The same product billed on two lines — different quantities, different
        // freight. Must collapse to a single line (quantities + freight summed,
        // unit cost quantity-weighted), matching @unique([product, supplierBill]).
        const twoLines: ZohoBillDetail = {
            ...bill,
            line_items: [
                { line_item_id: 'li-a', sku: 'BREADBOARD', rate: 10, quantity: 30 },
                { line_item_id: 'li-b', sku: 'BREADBOARD', rate: 14, quantity: 10 },
            ],
        };
        const lines = buildCostLinesForBill(twoLines, [
            {
                landed_cost_id: 'lc',
                cost_allocations: [
                    { bill_item_id: 'li-a', allocated_amount: 60 },
                    { bill_item_id: 'li-b', allocated_amount: 20 },
                ],
            },
        ]);

        expect(lines).toHaveLength(1);
        const line = lines[0];
        expect(line.zohoRecordId).toBe('b1::BREADBOARD');
        expect(line.quantity).toBe(40); // 30 + 10
        // Quantity-weighted unit cost: (10·30 + 14·10) / 40 = 11.
        expect(line.unitCost).toBeCloseTo(11, 10);
        // Freight per unit: (60 + 20) / 40 = 2.
        expect(line.unitFreightIn).toBeCloseTo(2, 10);
    });

    test('excludes lines without a SKU', () => {
        const noSku: ZohoBillDetail = {
            ...bill,
            line_items: [{ line_item_id: 'li-x', rate: 5, quantity: 1 }],
        };
        expect(buildCostLinesForBill(noSku, [])).toHaveLength(0);
    });
});

// ─── Fixtures ───────────────────────────────────────────────────────────────

function costLine(overrides: Partial<ZohoCostLine> = {}): ZohoCostLine {
    return {
        zohoRecordId: 'z-cost-1',
        sku: 'UR-FS292',
        billNumber: '20210219001',
        billDate: '2021-02-19',
        vendorName: 'Acme Imports',
        unitCost: 193.1,
        unitFreightIn: 60.02,
        quantity: 10,
        ...overrides,
    };
}

async function createProduct(sku: string, name = `Product ${sku}`) {
    const brand = await models.brand.create({ name: 'Test Brand' });
    return await models.product.create({ name, sku, brandId: brand.id });
}

async function linesForProduct(productId: string) {
    return await models.productCostLine.findMany({ where: { productId } });
}

// ─── computeCostSyncPlan (read-only diff) ─────────────────────────────────────

describe('computeCostSyncPlan', () => {
    test('flags a brand-new cost line and its bill', async () => {
        await createProduct('UR-FS292');

        const plan = await computeCostSyncPlan([costLine()]);

        expect(plan.costLines).toHaveLength(1);
        expect(plan.costLines[0].change).toBe('New');
        expect(plan.costLines[0].landed).toBe('253.12');
        expect(plan.billCount).toBe(1);
        expect(plan.unmatchedSkus).toEqual([]);
    });

    test('collects SKUs with no matching product instead of creating orphans', async () => {
        const plan = await computeCostSyncPlan([costLine({ sku: 'MISSING' })]);

        expect(plan.costLines).toHaveLength(0);
        expect(plan.unmatchedSkus).toEqual(['MISSING']);
    });

    test('skips records missing a SKU or bill number, with a warning', async () => {
        const plan = await computeCostSyncPlan([
            costLine({ zohoRecordId: 'a', sku: '' }),
            costLine({ zohoRecordId: 'b', billNumber: '' }),
        ]);

        expect(plan.costLines).toHaveLength(0);
        expect(plan.warnings).toHaveLength(2);
    });

    test('reports an unchanged line as unchanged, not a change', async () => {
        const product = await createProduct('UR-FS292');
        const bill = await models.supplierBill.create({ billNumber: '20210219001' });
        await models.productCostLine.create({
            zohoRecordId: 'z-cost-1',
            productId: product.id,
            supplierBillId: bill.id,
            unitCost: 193.1,
            unitFreightIn: 60.02,
            quantity: 10,
        });

        const plan = await computeCostSyncPlan([costLine()]);

        expect(plan.costLines).toHaveLength(0);
        expect(plan.unchangedCostLines).toBe(1);
    });

    test('detects a changed unit cost as an update', async () => {
        const product = await createProduct('UR-FS292');
        const bill = await models.supplierBill.create({ billNumber: '20210219001' });
        await models.productCostLine.create({
            zohoRecordId: 'z-cost-1',
            productId: product.id,
            supplierBillId: bill.id,
            unitCost: 193.1,
            unitFreightIn: 60.02,
            quantity: 10,
        });

        const plan = await computeCostSyncPlan([costLine({ unitCost: 200.0 })]);

        expect(plan.costLines).toHaveLength(1);
        expect(plan.costLines[0].change).toBe('Update');
        expect(plan.costLines[0].unitCostValue).toBe(200.0);
    });
});

// ─── applyCostSync ────────────────────────────────────────────────────────────

describe('applyCostSync', () => {
    test('creates the bill and cost line on first sync', async () => {
        const product = await createProduct('UR-FS292');
        const plan = await computeCostSyncPlan([costLine()]);

        const result = await applyCostSync(plan);

        expect(result.billsCreated).toBe(1);
        expect(result.costLinesCreated).toBe(1);

        const lines = await linesForProduct(product.id);
        expect(lines).toHaveLength(1);
        expect(Number(lines[0].unitCost)).toBeCloseTo(193.1, 2);
        expect(Number(lines[0].unitFreightIn)).toBeCloseTo(60.02, 2);
        expect(Number(lines[0].landedUnitCost)).toBeCloseTo(253.12, 2);
    });

    test('reuses one bill across multiple products on the same bill number', async () => {
        await createProduct('UR-FS292');
        await createProduct('UR-FS400');
        const plan = await computeCostSyncPlan([
            costLine({ zohoRecordId: 'z-a', sku: 'UR-FS292' }),
            costLine({ zohoRecordId: 'z-b', sku: 'UR-FS400' }),
        ]);

        const result = await applyCostSync(plan);

        expect(result.costLinesCreated).toBe(2);
        expect(result.billsCreated).toBe(1); // same bill number, created once
        const bills = await models.supplierBill.findMany({ where: {} });
        expect(bills).toHaveLength(1);
    });

    test('is idempotent — re-running the same plan changes nothing', async () => {
        const product = await createProduct('UR-FS292');

        const firstPlan = await computeCostSyncPlan([costLine()]);
        await applyCostSync(firstPlan);

        // A fresh diff now sees the line as unchanged.
        const secondPlan = await computeCostSyncPlan([costLine()]);
        expect(secondPlan.costLines).toHaveLength(0);
        expect(secondPlan.unchangedCostLines).toBe(1);

        const lines = await linesForProduct(product.id);
        expect(lines).toHaveLength(1);
    });

    test('reports progress: sets the total once and increments per cost line', async () => {
        await createProduct('UR-FS292');
        await createProduct('UR-FS400');
        const plan = await computeCostSyncPlan([
            costLine({ zohoRecordId: 'z-a', sku: 'UR-FS292' }),
            costLine({ zohoRecordId: 'z-b', sku: 'UR-FS400' }),
        ]);

        const { reporter, state } = recordingProgress();
        await applyCostSync(plan, reporter);

        expect(state.total).toBe(2);
        expect(state.current).toBe(2); // one increment per cost line
        expect(state.logs).toHaveLength(2);
    });

    test('updates an existing line in place rather than duplicating it', async () => {
        const product = await createProduct('UR-FS292');
        await applyCostSync(await computeCostSyncPlan([costLine()]));

        // Freight-in changes (e.g. re-costed as air), same Zoho record.
        await applyCostSync(await computeCostSyncPlan([costLine({ unitFreightIn: 90.0 })]));

        const lines = await linesForProduct(product.id);
        expect(lines).toHaveLength(1);
        expect(Number(lines[0].unitFreightIn)).toBeCloseTo(90.0, 2);
    });

    test('a rotated Zoho record id for the same (product, bill) updates, not duplicates', async () => {
        // Regression for the production error
        // (product_cost_line_product_supplier_bill_udx): Zoho rotates line ids when
        // a bill is re-saved, so the second sync arrives with a different
        // zohoRecordId for a (product, bill) that already has a line. Matching on
        // (product, bill) must update it, not create a second row and hit the
        // unique constraint.
        const product = await createProduct('UR-FS292');
        await applyCostSync(await computeCostSyncPlan([costLine({ zohoRecordId: 'b1::UR-FS292' })]));

        // Same bill + product, brand-new record id (as if the bill was re-saved).
        const result = await applyCostSync(
            await computeCostSyncPlan([costLine({ zohoRecordId: 'b2::UR-FS292', unitFreightIn: 75.0 })])
        );

        expect(result.costLinesCreated).toBe(0);
        expect(result.costLinesUpdated).toBe(1);

        const lines = await linesForProduct(product.id);
        expect(lines).toHaveLength(1); // no duplicate, no constraint violation
        expect(Number(lines[0].unitFreightIn)).toBeCloseTo(75.0, 2);
        expect(lines[0].zohoRecordId).toBe('b2::UR-FS292'); // refreshed to the latest
    });
});
