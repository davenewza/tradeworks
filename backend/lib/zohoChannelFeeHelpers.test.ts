import { models, resetDatabase } from '@teamkeel/testing';
import { ChannelFeeType } from '@teamkeel/sdk';
import { beforeEach, describe, expect, test } from 'vitest';
import {
    TAKEALOT_CHANNEL_NAME,
    ZohoFeeCategory,
    ZohoItemFees,
    getItemFeeAssignment,
    computeFeeSyncPlan,
    applyFeeSync,
} from './zohoChannelFeeHelpers';

beforeEach(resetDatabase);

// ─── Fixtures ───────────────────────────────────────────────────────────────

function successCategory(overrides: Partial<ZohoFeeCategory> = {}): ZohoFeeCategory {
    return {
        zohoRecordId: 'z-success-1',
        feeType: ChannelFeeType.SuccessFee,
        name: 'Toys → Smart toys → STEM',
        percentage: 12,
        amount: null,
        sizeCategory: null,
        weightCategory: null,
        ...overrides,
    };
}

function fulfillmentCategory(overrides: Partial<ZohoFeeCategory> = {}): ZohoFeeCategory {
    return {
        zohoRecordId: 'z-fulfill-1',
        feeType: ChannelFeeType.FulfillmentFee,
        name: 'Standard (Baby) Light',
        percentage: null,
        amount: 30,
        sizeCategory: 'Standard: Stationery, Pets, Baby',
        weightCategory: 'Light: Less than 7kg',
        ...overrides,
    };
}

function itemFees(sku: string, successFeeZohoId: string | null, fulfillmentFeeZohoId: string | null): ZohoItemFees {
    return { sku, itemName: `Item ${sku}`, successFeeZohoId, fulfillmentFeeZohoId };
}

async function createProduct(sku: string, name = `Product ${sku}`) {
    const brand = await models.brand.create({ name: 'Test Brand' });
    return await models.product.create({ name, sku, brandId: brand.id });
}

// ─── getItemFeeAssignment ───────────────────────────────────────────────────

describe('getItemFeeAssignment', () => {
    test('extracts both fee record ids by placeholder, including the truncated fulfillment one', () => {
        const result = getItemFeeAssignment({
            item_id: '1',
            name: 'Widget',
            custom_fields: [
                { label: 'Brand', placeholder: 'cf_brand', value: 'Acme' },
                { label: 'TAL Success Fee Category', placeholder: 'cf_tal_success_fee_category', value: '111' },
                // Zoho truncates placeholders at 30 chars — no trailing "y".
                { label: 'TAL Fulfillment Fee Category', placeholder: 'cf_tal_fulfillment_fee_categor', value: '222' },
            ],
        });

        expect(result.successFeeZohoId).toBe('111');
        expect(result.fulfillmentFeeZohoId).toBe('222');
    });

    test('falls back to label matching when placeholders differ', () => {
        const result = getItemFeeAssignment({
            item_id: '1',
            name: 'Widget',
            custom_fields: [
                { label: 'TAL Success Fee Category', value: '111' },
                { label: 'TAL Fulfillment Fee Category', value: '222' },
            ],
        });

        expect(result.successFeeZohoId).toBe('111');
        expect(result.fulfillmentFeeZohoId).toBe('222');
    });

    test('returns nulls when fields are missing or empty', () => {
        expect(getItemFeeAssignment({ item_id: '1', name: 'No fields' })).toEqual({
            successFeeZohoId: null,
            fulfillmentFeeZohoId: null,
        });

        expect(
            getItemFeeAssignment({
                item_id: '2',
                name: 'Empty values',
                custom_fields: [
                    { label: 'TAL Success Fee Category', placeholder: 'cf_tal_success_fee_category', value: '' },
                    { label: 'TAL Fulfillment Fee Category', placeholder: 'cf_tal_fulfillment_fee_categor', value: '  ' },
                ],
            })
        ).toEqual({ successFeeZohoId: null, fulfillmentFeeZohoId: null });
    });
});

// ─── computeFeeSyncPlan ─────────────────────────────────────────────────────

describe('computeFeeSyncPlan', () => {
    test('plans new categories and new product fees on a fresh database', async () => {
        await createProduct('SKU-1');

        const plan = await computeFeeSyncPlan(
            [successCategory(), fulfillmentCategory()],
            [
                itemFees('SKU-1', 'z-success-1', 'z-fulfill-1'),
                itemFees('SKU-NOFEES', null, null), // no fees → ignored entirely
                itemFees('SKU-MISSING', 'z-success-1', null), // fees but no product
            ]
        );

        expect(plan.channelName).toBe(TAKEALOT_CHANNEL_NAME);
        expect(plan.categories).toHaveLength(2);
        expect(plan.categories.every((c) => c.change === 'New')).toBe(true);
        expect(plan.categories.map((c) => c.value).sort()).toEqual(['12%', 'R30.00']);

        expect(plan.productFees).toHaveLength(1);
        expect(plan.productFees[0]).toMatchObject({
            sku: 'SKU-1',
            change: 'New',
            successFeeZohoId: 'z-success-1',
            fulfillmentFeeZohoId: 'z-fulfill-1',
            successFee: 'Toys → Smart toys → STEM',
            fulfillmentFee: 'Standard (Baby) Light',
        });

        expect(plan.unmatchedSkus).toEqual(['SKU-MISSING']);
        expect(plan.unchangedCategories).toBe(0);
        expect(plan.unchangedProductFees).toBe(0);
    });

    test('is empty after a sync has been applied (idempotence)', async () => {
        await createProduct('SKU-1');
        const zohoCategories = [successCategory(), fulfillmentCategory()];
        const zohoItems = [itemFees('SKU-1', 'z-success-1', 'z-fulfill-1')];

        await applyFeeSync(await computeFeeSyncPlan(zohoCategories, zohoItems));
        const plan = await computeFeeSyncPlan(zohoCategories, zohoItems);

        expect(plan.categories).toHaveLength(0);
        expect(plan.productFees).toHaveLength(0);
        expect(plan.unchangedCategories).toBe(2);
        expect(plan.unchangedProductFees).toBe(1);
    });

    test('plans an update when a fee value changes in Zoho', async () => {
        await createProduct('SKU-1');
        const zohoItems = [itemFees('SKU-1', 'z-success-1', null)];
        await applyFeeSync(await computeFeeSyncPlan([successCategory()], zohoItems));

        const plan = await computeFeeSyncPlan([successCategory({ percentage: 15 })], zohoItems);

        expect(plan.categories).toHaveLength(1);
        expect(plan.categories[0]).toMatchObject({ change: 'Update', value: '15%', zohoRecordId: 'z-success-1' });
        // The assignment itself did not change.
        expect(plan.productFees).toHaveLength(0);
        expect(plan.unchangedProductFees).toBe(1);
    });

    test('plans an assignment update when an item moves to a different fee category', async () => {
        await createProduct('SKU-1');
        const zohoCategories = [
            successCategory(),
            successCategory({ zohoRecordId: 'z-success-2', name: 'Toys → Outdoor Play', percentage: 12 }),
        ];
        await applyFeeSync(await computeFeeSyncPlan(zohoCategories, [itemFees('SKU-1', 'z-success-1', null)]));

        const plan = await computeFeeSyncPlan(zohoCategories, [itemFees('SKU-1', 'z-success-2', null)]);

        expect(plan.categories).toHaveLength(0);
        expect(plan.productFees).toHaveLength(1);
        expect(plan.productFees[0]).toMatchObject({
            sku: 'SKU-1',
            change: 'Update',
            successFeeZohoId: 'z-success-2',
            fulfillmentFeeZohoId: null,
        });
    });

    test('plans a clearing update when fees are removed in Zoho, and skips rows already empty', async () => {
        await createProduct('SKU-1');
        const zohoCategories = [successCategory(), fulfillmentCategory()];
        await applyFeeSync(
            await computeFeeSyncPlan(zohoCategories, [itemFees('SKU-1', 'z-success-1', 'z-fulfill-1')])
        );

        // Fees removed from the item in Zoho.
        const plan = await computeFeeSyncPlan(zohoCategories, [itemFees('SKU-1', null, null)]);
        expect(plan.productFees).toHaveLength(1);
        expect(plan.productFees[0]).toMatchObject({
            change: 'Update',
            successFeeZohoId: null,
            fulfillmentFeeZohoId: null,
            successFee: '—',
            fulfillmentFee: '—',
        });

        // Once cleared, re-planning has nothing to do for that item.
        await applyFeeSync(plan);
        const rePlan = await computeFeeSyncPlan(zohoCategories, [itemFees('SKU-1', null, null)]);
        expect(rePlan.productFees).toHaveLength(0);
        expect(rePlan.unchangedProductFees).toBe(1);
    });

    test('treats references to unknown fee records as no fee, with a warning', async () => {
        await createProduct('SKU-1');

        const plan = await computeFeeSyncPlan([successCategory()], [itemFees('SKU-1', 'z-gone', null)]);

        expect(plan.warnings.some((w) => w.includes('z-gone'))).toBe(true);
        // Only the dangling reference remains → nothing worth recording.
        expect(plan.productFees).toHaveLength(0);
        expect(plan.unmatchedSkus).toHaveLength(0);
    });
});

// ─── applyFeeSync ───────────────────────────────────────────────────────────

describe('applyFeeSync', () => {
    test('creates the channel, categories and product fees', async () => {
        const product = await createProduct('SKU-1');

        const result = await applyFeeSync(
            await computeFeeSyncPlan(
                [successCategory(), fulfillmentCategory()],
                [itemFees('SKU-1', 'z-success-1', 'z-fulfill-1')]
            )
        );

        expect(result).toEqual({
            categoriesCreated: 2,
            categoriesUpdated: 0,
            productFeesCreated: 1,
            productFeesUpdated: 0,
        });

        const channels = await models.channel.findMany({ where: { name: { equals: TAKEALOT_CHANNEL_NAME } } });
        expect(channels).toHaveLength(1);

        const success = await models.channelFeeCategory.findOne({ zohoRecordId: 'z-success-1' });
        expect(success).not.toBeNull();
        expect(success!.channelId).toBe(channels[0].id);
        expect(success!.feeType).toBe(ChannelFeeType.SuccessFee);
        expect(Number(success!.percentage)).toBe(12);
        expect(success!.amount).toBeNull();
        expect(success!.synchronisedAt).not.toBeNull();

        const fulfillment = await models.channelFeeCategory.findOne({ zohoRecordId: 'z-fulfill-1' });
        expect(fulfillment!.feeType).toBe(ChannelFeeType.FulfillmentFee);
        expect(Number(fulfillment!.amount)).toBe(30);
        expect(fulfillment!.sizeCategory).toBe('Standard: Stationery, Pets, Baby');
        expect(fulfillment!.weightCategory).toBe('Light: Less than 7kg');

        const rows = await models.productChannelFee.findMany({ where: { channelId: channels[0].id } });
        expect(rows).toHaveLength(1);
        expect(rows[0].productId).toBe(product.id);
        expect(rows[0].successFeeCategoryId).toBe(success!.id);
        expect(rows[0].fulfillmentFeeCategoryId).toBe(fulfillment!.id);
        expect(rows[0].synchronisedAt).not.toBeNull();
    });

    test('reuses an existing channel instead of creating a duplicate', async () => {
        const existingChannel = await models.channel.create({ name: TAKEALOT_CHANNEL_NAME });

        await applyFeeSync(await computeFeeSyncPlan([successCategory()], []));

        const channels = await models.channel.findMany({ where: { name: { equals: TAKEALOT_CHANNEL_NAME } } });
        expect(channels).toHaveLength(1);
        expect(channels[0].id).toBe(existingChannel.id);

        const category = await models.channelFeeCategory.findOne({ zohoRecordId: 'z-success-1' });
        expect(category!.channelId).toBe(existingChannel.id);
    });

    test('is idempotent — re-applying the same plan updates instead of duplicating', async () => {
        await createProduct('SKU-1');
        const plan = await computeFeeSyncPlan(
            [successCategory()],
            [itemFees('SKU-1', 'z-success-1', null)]
        );

        const first = await applyFeeSync(plan);
        expect(first.categoriesCreated).toBe(1);
        expect(first.productFeesCreated).toBe(1);

        const second = await applyFeeSync(plan);
        expect(second).toEqual({
            categoriesCreated: 0,
            categoriesUpdated: 1,
            productFeesCreated: 0,
            productFeesUpdated: 1,
        });

        const categories = await models.channelFeeCategory.findMany({
            where: { zohoRecordId: { equals: 'z-success-1' } },
        });
        expect(categories).toHaveLength(1);

        const channels = await models.channel.findMany({ where: { name: { equals: TAKEALOT_CHANNEL_NAME } } });
        const rows = await models.productChannelFee.findMany({ where: { channelId: channels[0].id } });
        expect(rows).toHaveLength(1);
    });

    test('updates category values and clears product fee references', async () => {
        const product = await createProduct('SKU-1');
        const zohoCategories = [successCategory(), fulfillmentCategory()];
        await applyFeeSync(
            await computeFeeSyncPlan(zohoCategories, [itemFees('SKU-1', 'z-success-1', 'z-fulfill-1')])
        );

        // Percentage changes and the item loses its fulfillment fee.
        await applyFeeSync(
            await computeFeeSyncPlan(
                [successCategory({ percentage: 15 }), fulfillmentCategory()],
                [itemFees('SKU-1', 'z-success-1', null)]
            )
        );

        const category = await models.channelFeeCategory.findOne({ zohoRecordId: 'z-success-1' });
        expect(Number(category!.percentage)).toBe(15);

        const rows = await models.productChannelFee.findMany({ where: { productId: product.id } });
        expect(rows).toHaveLength(1);
        expect(rows[0].successFeeCategoryId).not.toBeNull();
        expect(rows[0].fulfillmentFeeCategoryId).toBeNull();
    });
});
