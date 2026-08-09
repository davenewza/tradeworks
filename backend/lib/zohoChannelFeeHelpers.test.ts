import { models, resetDatabase } from '@teamkeel/testing';
import { FeeMethod } from '@teamkeel/sdk';
import { beforeEach, describe, expect, test } from 'vitest';
import {
    TAKEALOT_CHANNEL_NAME,
    ZohoChannelFee,
    ZohoItemFees,
    getItemFeeAssignment,
    computeFeeSyncPlan,
    applyFeeSync,
} from './zohoChannelFeeHelpers';

beforeEach(resetDatabase);

// ─── Fixtures ───────────────────────────────────────────────────────────────

function successFee(overrides: Partial<ZohoChannelFee> = {}): ZohoChannelFee {
    return {
        zohoRecordId: 'z-success-1',
        feeType: 'Success fee',
        name: 'Toys → Smart toys → STEM',
        method: FeeMethod.Commission,
        value: 12,
        ...overrides,
    };
}

function fulfilmentFee(overrides: Partial<ZohoChannelFee> = {}): ZohoChannelFee {
    return {
        zohoRecordId: 'z-fulfil-1',
        feeType: 'Fulfilment fee',
        name: 'Standard (Baby) Light',
        method: FeeMethod.Flat,
        value: 30,
        ...overrides,
    };
}

function itemFees(sku: string, ...feeZohoIds: string[]): ZohoItemFees {
    return { sku, itemName: `Item ${sku}`, feeZohoIds };
}

async function createProduct(sku: string, name = `Product ${sku}`) {
    const brand = await models.brand.create({ name: 'Test Brand' });
    return await models.product.create({ name, sku, brandId: brand.id });
}

async function takealotChannelId(): Promise<string> {
    const channels = await models.channel.findMany({ where: { name: { equals: TAKEALOT_CHANNEL_NAME } } });
    return channels[0].id;
}

async function feesForProduct(productId: string) {
    return await models.productChannelFee.findMany({ where: { productId } });
}

// ─── getItemFeeAssignment ───────────────────────────────────────────────────

describe('getItemFeeAssignment', () => {
    test('extracts every assigned fee id by placeholder, including the truncated fulfilment one', () => {
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

        expect(result).toEqual(['111', '222']);
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

        expect(result).toEqual(['111', '222']);
    });

    test('returns only the fees that are set', () => {
        const result = getItemFeeAssignment({
            item_id: '1',
            name: 'Widget',
            custom_fields: [
                { label: 'TAL Success Fee Category', placeholder: 'cf_tal_success_fee_category', value: '111' },
                { label: 'TAL Fulfillment Fee Category', placeholder: 'cf_tal_fulfillment_fee_categor', value: '  ' },
            ],
        });

        expect(result).toEqual(['111']);
    });

    test('returns an empty array when no fees are assigned', () => {
        expect(getItemFeeAssignment({ item_id: '1', name: 'No fields' })).toEqual([]);
    });
});

// ─── computeFeeSyncPlan ─────────────────────────────────────────────────────

describe('computeFeeSyncPlan', () => {
    test('plans new fees and new product assignments on a fresh database', async () => {
        await createProduct('SKU-1');

        const plan = await computeFeeSyncPlan(
            [successFee(), fulfilmentFee()],
            [
                itemFees('SKU-1', 'z-success-1', 'z-fulfil-1'),
                itemFees('SKU-NOFEES'), // no fees → ignored entirely
                itemFees('SKU-MISSING', 'z-success-1'), // fees but no product
            ]
        );

        expect(plan.channelName).toBe(TAKEALOT_CHANNEL_NAME);
        expect(plan.fees).toHaveLength(2);
        expect(plan.fees.every((f) => f.change === 'New')).toBe(true);
        expect(plan.fees.map((f) => f.value).sort()).toEqual(['12%', 'R30.00']);
        expect(plan.fees.map((f) => f.feeType).sort()).toEqual(['Fulfilment fee', 'Success fee']);

        expect(plan.productFees).toHaveLength(1);
        expect(plan.productFees[0]).toMatchObject({
            sku: 'SKU-1',
            change: 'New',
            feeZohoIds: ['z-success-1', 'z-fulfil-1'],
        });
        expect(plan.productFees[0].fees).toContain('Toys → Smart toys → STEM');
        expect(plan.productFees[0].fees).toContain('Standard (Baby) Light');

        expect(plan.unmatchedSkus).toEqual(['SKU-MISSING']);
        expect(plan.unchangedFees).toBe(0);
        expect(plan.unchangedProductFees).toBe(0);
    });

    test('is empty after a sync has been applied (idempotence)', async () => {
        await createProduct('SKU-1');
        const zohoFees = [successFee(), fulfilmentFee()];
        const zohoItems = [itemFees('SKU-1', 'z-success-1', 'z-fulfil-1')];

        await applyFeeSync(await computeFeeSyncPlan(zohoFees, zohoItems));
        const plan = await computeFeeSyncPlan(zohoFees, zohoItems);

        expect(plan.fees).toHaveLength(0);
        expect(plan.productFees).toHaveLength(0);
        expect(plan.unchangedFees).toBe(2);
        expect(plan.unchangedProductFees).toBe(1);
    });

    test('plans an update when a fee value changes in Zoho', async () => {
        await createProduct('SKU-1');
        const zohoItems = [itemFees('SKU-1', 'z-success-1')];
        await applyFeeSync(await computeFeeSyncPlan([successFee()], zohoItems));

        const plan = await computeFeeSyncPlan([successFee({ value: 15 })], zohoItems);

        expect(plan.fees).toHaveLength(1);
        expect(plan.fees[0]).toMatchObject({ change: 'Update', value: '15%', zohoRecordId: 'z-success-1' });
        // The assignment itself did not change.
        expect(plan.productFees).toHaveLength(0);
        expect(plan.unchangedProductFees).toBe(1);
    });

    test('plans an assignment change when an item moves to a different fee', async () => {
        await createProduct('SKU-1');
        const feeA = successFee();
        const feeB = successFee({ zohoRecordId: 'z-success-2', name: 'Toys → Outdoor Play' });
        await applyFeeSync(await computeFeeSyncPlan([feeA, feeB], [itemFees('SKU-1', 'z-success-1')]));

        const plan = await computeFeeSyncPlan([feeA, feeB], [itemFees('SKU-1', 'z-success-2')]);

        expect(plan.fees).toHaveLength(0);
        expect(plan.productFees).toHaveLength(1);
        expect(plan.productFees[0]).toMatchObject({
            sku: 'SKU-1',
            change: 'Update',
            feeZohoIds: ['z-success-2'],
        });
    });

    test('plans a clearing change when fees are removed in Zoho, then nothing once cleared', async () => {
        await createProduct('SKU-1');
        const zohoFees = [successFee(), fulfilmentFee()];
        await applyFeeSync(await computeFeeSyncPlan(zohoFees, [itemFees('SKU-1', 'z-success-1', 'z-fulfil-1')]));

        const plan = await computeFeeSyncPlan(zohoFees, [itemFees('SKU-1')]); // fees removed in Zoho
        expect(plan.productFees).toHaveLength(1);
        expect(plan.productFees[0]).toMatchObject({ change: 'Update', feeZohoIds: [], fees: '—' });

        await applyFeeSync(plan);
        const rePlan = await computeFeeSyncPlan(zohoFees, [itemFees('SKU-1')]);
        expect(rePlan.productFees).toHaveLength(0);
        expect(rePlan.unchangedProductFees).toBe(0); // no fees, nothing to count
    });

    test('treats references to unknown fee records as no fee, with a warning', async () => {
        await createProduct('SKU-1');

        const plan = await computeFeeSyncPlan([successFee()], [itemFees('SKU-1', 'z-gone')]);

        expect(plan.warnings.some((w) => w.includes('z-gone'))).toBe(true);
        expect(plan.productFees).toHaveLength(0); // only a dangling ref → nothing to record
        expect(plan.unmatchedSkus).toHaveLength(0);
    });
});

// ─── applyFeeSync ───────────────────────────────────────────────────────────

describe('applyFeeSync', () => {
    test('creates the channel, fees and product assignments', async () => {
        const product = await createProduct('SKU-1');

        const result = await applyFeeSync(
            await computeFeeSyncPlan([successFee(), fulfilmentFee()], [itemFees('SKU-1', 'z-success-1', 'z-fulfil-1')])
        );

        expect(result).toMatchObject({
            feesCreated: 2,
            feesUpdated: 0,
            assignmentsAdded: 2,
            assignmentsRemoved: 0,
            productsChanged: 1,
        });

        const channels = await models.channel.findMany({ where: { name: { equals: TAKEALOT_CHANNEL_NAME } } });
        expect(channels).toHaveLength(1);

        const success = await models.channelFee.findOne({ zohoRecordId: 'z-success-1' });
        expect(success!.channelId).toBe(channels[0].id);
        expect(success!.feeType).toBe('Success fee');
        expect(success!.method).toBe(FeeMethod.Commission);
        expect(Number(success!.value)).toBe(12);

        const fulfilment = await models.channelFee.findOne({ zohoRecordId: 'z-fulfil-1' });
        expect(fulfilment!.feeType).toBe('Fulfilment fee');
        expect(fulfilment!.method).toBe(FeeMethod.Flat);
        expect(Number(fulfilment!.value)).toBe(30);

        const rows = await feesForProduct(product.id);
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.channelFeeId).sort()).toEqual([success!.id, fulfilment!.id].sort());
    });

    test('reuses an existing channel instead of creating a duplicate', async () => {
        const existingChannel = await models.channel.create({ name: TAKEALOT_CHANNEL_NAME });

        await applyFeeSync(await computeFeeSyncPlan([successFee()], []));

        const channels = await models.channel.findMany({ where: { name: { equals: TAKEALOT_CHANNEL_NAME } } });
        expect(channels).toHaveLength(1);
        expect(channels[0].id).toBe(existingChannel.id);

        const fee = await models.channelFee.findOne({ zohoRecordId: 'z-success-1' });
        expect(fee!.channelId).toBe(existingChannel.id);
    });

    test('is idempotent — re-applying the same plan makes no further assignment changes', async () => {
        await createProduct('SKU-1');
        const plan = await computeFeeSyncPlan([successFee()], [itemFees('SKU-1', 'z-success-1')]);

        const first = await applyFeeSync(plan);
        expect(first).toMatchObject({ feesCreated: 1, assignmentsAdded: 1, assignmentsRemoved: 0 });

        const second = await applyFeeSync(plan);
        expect(second).toMatchObject({ feesCreated: 0, feesUpdated: 1, assignmentsAdded: 0, assignmentsRemoved: 0 });

        const fees = await models.channelFee.findMany({ where: { zohoRecordId: { equals: 'z-success-1' } } });
        expect(fees).toHaveLength(1);
        const product = await models.product.findOne({ sku: 'SKU-1' });
        expect(await feesForProduct(product!.id)).toHaveLength(1);
    });

    test('adds and removes assignments so a product mirrors Zoho', async () => {
        const product = await createProduct('SKU-1');
        const feeA = successFee();
        const feeB = successFee({ zohoRecordId: 'z-success-2', name: 'Toys → Outdoor Play' });
        await applyFeeSync(await computeFeeSyncPlan([feeA, feeB], [itemFees('SKU-1', 'z-success-1')]));

        // Item moves from feeA to feeB in Zoho.
        const result = await applyFeeSync(await computeFeeSyncPlan([feeA, feeB], [itemFees('SKU-1', 'z-success-2')]));
        expect(result).toMatchObject({ assignmentsAdded: 1, assignmentsRemoved: 1 });

        const rows = await feesForProduct(product.id);
        expect(rows).toHaveLength(1);
        const feeBId = (await models.channelFee.findOne({ zohoRecordId: 'z-success-2' }))!.id;
        expect(rows[0].channelFeeId).toBe(feeBId);
    });

    test('clears all assignments when the item loses its fees', async () => {
        const product = await createProduct('SKU-1');
        const zohoFees = [successFee(), fulfilmentFee()];
        await applyFeeSync(await computeFeeSyncPlan(zohoFees, [itemFees('SKU-1', 'z-success-1', 'z-fulfil-1')]));
        expect(await feesForProduct(product.id)).toHaveLength(2);

        await applyFeeSync(await computeFeeSyncPlan(zohoFees, [itemFees('SKU-1')]));
        expect(await feesForProduct(product.id)).toHaveLength(0);
    });

    test('leaves another channel\'s assignments untouched', async () => {
        const product = await createProduct('SKU-1');
        // A fee + assignment on a different channel.
        const otherChannel = await models.channel.create({ name: 'Amazon Marketplace' });
        const otherFee = await models.channelFee.create({
            channelId: otherChannel.id,
            name: 'Referral fee',
            feeType: 'Referral fee',
            method: FeeMethod.Commission,
            value: 15,
            zohoRecordId: 'z-amazon-1',
        });
        await models.productChannelFee.create({ productId: product.id, channelFeeId: otherFee.id });

        // Sync Takealot: give the product a Takealot fee, then clear it.
        await applyFeeSync(await computeFeeSyncPlan([successFee()], [itemFees('SKU-1', 'z-success-1')]));
        await applyFeeSync(await computeFeeSyncPlan([successFee()], [itemFees('SKU-1')]));

        const rows = await feesForProduct(product.id);
        expect(rows).toHaveLength(1);
        expect(rows[0].channelFeeId).toBe(otherFee.id); // Amazon assignment survived
    });
});

// ─── Computed display fields ─────────────────────────────────────────────────

// These power the fees table in the product Console tool — they must resolve
// the linked fee's details (channel, name, type) and its method + value.
describe('ProductChannelFee computed display fields', () => {
    test('surface the channel, fee name/type and the method + value', async () => {
        const product = await createProduct('SKU-1');
        await applyFeeSync(
            await computeFeeSyncPlan([successFee(), fulfilmentFee()], [itemFees('SKU-1', 'z-success-1', 'z-fulfil-1')])
        );

        const rows = await feesForProduct(product.id);
        const success = rows.find((r) => r.feeType === 'Success fee')!;
        const fulfilment = rows.find((r) => r.feeType === 'Fulfilment fee')!;

        expect(success.channelName).toBe(TAKEALOT_CHANNEL_NAME);
        expect(success.feeName).toBe('Toys → Smart toys → STEM');
        expect(success.feeMethod).toBe(FeeMethod.Commission);
        expect(Number(success.feeValue)).toBe(12);

        expect(fulfilment.channelName).toBe(TAKEALOT_CHANNEL_NAME);
        expect(fulfilment.feeName).toBe('Standard (Baby) Light');
        expect(fulfilment.feeMethod).toBe(FeeMethod.Flat);
        expect(Number(fulfilment.feeValue)).toBe(30);
    });
});
