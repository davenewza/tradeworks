import { models, resetDatabase } from '@teamkeel/testing';
import { ChannelShipmentStatus } from '@teamkeel/sdk';
import { beforeEach, describe, expect, test } from 'vitest';
import {
    ExternalShipment,
    ExternalShipmentItem,
    applyShipmentSync,
    computeShipmentSyncPlan,
    openShipmentRefs,
} from './channelShipmentHelpers';
import { TAKEALOT_CHANNEL_NAME } from './zohoChannelFeeHelpers';

beforeEach(resetDatabase);

// ─── Fixtures ───────────────────────────────────────────────────────────────

function line(overrides: Partial<ExternalShipmentItem> = {}): ExternalShipmentItem {
    return {
        externalId: '91',
        listingRef: '12345',
        sku: 'ACME-001',
        quantityRequired: 40,
        quantitySending: 30,
        cancelled: false,
        labelledByChannel: false,
        code: null,
        ...overrides,
    };
}

function external(overrides: Partial<ExternalShipment> = {}): ExternalShipment {
    return {
        externalId: '5001',
        externalGroupId: null,
        reference: 'JHB-2026-08',
        status: ChannelShipmentStatus.Open,
        statusDescription: 'Awaiting delivery',
        destination: 'JHB',
        placedAt: '2026-08-20T08:30:00.000Z',
        dueDate: '2026-09-01',
        receivedAt: null,
        trackingInfo: null,
        isArchived: false,
        items: [line()],
        ...overrides,
    };
}

async function createProduct(sku: string, name = `Product ${sku}`) {
    const brands = await models.brand.findMany({ where: { name: 'Test Brand' } });
    const brand = brands.length > 0 ? brands[0] : await models.brand.create({ name: 'Test Brand' });
    return await models.product.create({ name, sku, brandId: brand.id });
}

// Run the whole sync the flow runs, so tests exercise plan and apply together.
async function sync(shipments: ExternalShipment[]) {
    const plan = await computeShipmentSyncPlan(TAKEALOT_CHANNEL_NAME, shipments);
    const result = await applyShipmentSync(plan);
    return { plan, result };
}

async function storedShipment(externalId = '5001') {
    const rows = await models.channelShipment.findMany({ where: { externalId } });
    return rows[0];
}

// ─── computeShipmentSyncPlan ────────────────────────────────────────────────

describe('computeShipmentSyncPlan', () => {
    test('every shipment is new when nothing has been synced', async () => {
        await createProduct('ACME-001');

        const plan = await computeShipmentSyncPlan(TAKEALOT_CHANNEL_NAME, [external()]);

        expect(plan.changes).toHaveLength(1);
        expect(plan.changes[0]).toMatchObject({
            externalId: '5001',
            change: 'New',
            lines: 1,
            units: 30,
            unmatched: 0,
        });
        expect(plan.unchanged).toBe(0);
    });

    test('counts a line whose SKU matches no product as unmatched', async () => {
        const plan = await computeShipmentSyncPlan(TAKEALOT_CHANNEL_NAME, [external()]);

        expect(plan.changes[0].unmatched).toBe(1);
        expect(plan.unmatchedSkus).toEqual(['ACME-001']);
        expect(plan.unresolvedListings).toEqual([]);
    });

    test('reports a line with no SKU by its listing ref', async () => {
        const plan = await computeShipmentSyncPlan(TAKEALOT_CHANNEL_NAME, [
            external({ items: [line({ sku: null, listingRef: '999' })] }),
        ]);

        expect(plan.unresolvedListings).toEqual(['999']);
        expect(plan.unmatchedSkus).toEqual([]);
    });

    test('warns on a duplicate shipment id and keeps the last occurrence', async () => {
        const plan = await computeShipmentSyncPlan(TAKEALOT_CHANNEL_NAME, [
            external({ reference: 'first' }),
            external({ reference: 'second' }),
        ]);

        expect(plan.changes).toHaveLength(1);
        expect(plan.changes[0].reference).toBe('second');
        expect(plan.warnings[0]).toContain('Duplicate shipment id');
    });

    test('a re-run of an unchanged shipment reports no changes', async () => {
        await createProduct('ACME-001');
        await sync([external()]);

        const plan = await computeShipmentSyncPlan(TAKEALOT_CHANNEL_NAME, [external()]);

        // Also pins the date round-trip: if a stored timestamp came back
        // differently from what was written, this would report a change forever.
        expect(plan.changes).toEqual([]);
        expect(plan.unchanged).toBe(1);
    });

    test.each([
        ['the status moves on', { status: ChannelShipmentStatus.Shipped }],
        ['the reference is edited', { reference: 'JHB-2026-09' }],
        ['it is archived on the channel', { isArchived: true }],
        ['the due date moves', { dueDate: '2026-09-15' }],
        ['it is unloaded', { receivedAt: '2026-09-02T07:00:00.000Z' }],
    ])('detects an update when %s', async (_label, overrides) => {
        await createProduct('ACME-001');
        await sync([external()]);

        const plan = await computeShipmentSyncPlan(TAKEALOT_CHANNEL_NAME, [external(overrides)]);

        expect(plan.changes).toHaveLength(1);
        expect(plan.changes[0].change).toBe('Update');
    });

    test('detects a quantity change on a line', async () => {
        await createProduct('ACME-001');
        await sync([external()]);

        // The header is untouched here — only the units moved. Channels do not
        // reliably restamp a consignment for this, which is why the comparison
        // reads the lines rather than a timestamp.
        const plan = await computeShipmentSyncPlan(TAKEALOT_CHANNEL_NAME, [
            external({ items: [line({ quantitySending: 25 })] }),
        ]);

        expect(plan.changes).toHaveLength(1);
        expect(plan.changes[0].units).toBe(25);
    });

    test('detects a line being added or removed', async () => {
        await createProduct('ACME-001');
        await sync([external()]);

        const added = await computeShipmentSyncPlan(TAKEALOT_CHANNEL_NAME, [
            external({ items: [line(), line({ externalId: '92', sku: 'ACME-002' })] }),
        ]);
        expect(added.changes).toHaveLength(1);

        const removed = await computeShipmentSyncPlan(TAKEALOT_CHANNEL_NAME, [
            external({ items: [] }),
        ]);
        expect(removed.changes).toHaveLength(1);
    });

    test('detects a product appearing for a previously unmatched line', async () => {
        // Synced before the catalogue caught up, so the line stored no product.
        await sync([external()]);
        await createProduct('ACME-001');

        const plan = await computeShipmentSyncPlan(TAKEALOT_CHANNEL_NAME, [external()]);

        expect(plan.changes).toHaveLength(1);
        expect(plan.changes[0].unmatched).toBe(0);
    });
});

// ─── openShipmentRefs ───────────────────────────────────────────────────────

describe('openShipmentRefs', () => {
    test('returns nothing when the channel has never been synced', async () => {
        expect(await openShipmentRefs(TAKEALOT_CHANNEL_NAME)).toEqual([]);
    });

    test('lists consignments that have not finished, so they keep being refreshed', async () => {
        await createProduct('ACME-001');
        await sync([
            external({ externalId: '1', status: ChannelShipmentStatus.Open }),
            external({ externalId: '2', status: ChannelShipmentStatus.Shipped }),
            external({ externalId: '3', status: ChannelShipmentStatus.Received }),
            external({ externalId: '4', status: ChannelShipmentStatus.Cancelled }),
        ]);

        const refs = await openShipmentRefs(TAKEALOT_CHANNEL_NAME);

        // Open and Shipped still move; Received and Cancelled are terminal and
        // drop out, so they stop costing a lookup on every sync.
        expect(refs.map((r) => r.externalId).sort()).toEqual(['1', '2']);
    });

    test('carries the group id, without which a nested consignment cannot be re-fetched', async () => {
        await createProduct('ACME-001');
        await sync([external({ externalId: 'sh-1', externalGroupId: 'wf-1' })]);

        expect(await openShipmentRefs(TAKEALOT_CHANNEL_NAME)).toEqual([
            { externalId: 'sh-1', externalGroupId: 'wf-1' },
        ]);
    });

    test('does not leak ids from another channel', async () => {
        await sync([external({ externalId: '1' })]);
        const otherPlan = await computeShipmentSyncPlan('Amazon', [external({ externalId: '9' })]);
        await applyShipmentSync(otherPlan);

        expect((await openShipmentRefs(TAKEALOT_CHANNEL_NAME)).map((r) => r.externalId)).toEqual([
            '1',
        ]);
        expect((await openShipmentRefs('Amazon')).map((r) => r.externalId)).toEqual(['9']);
    });
});

// ─── applyShipmentSync ──────────────────────────────────────────────────────

describe('applyShipmentSync', () => {
    test('creates the shipment, its lines, and the channel if needed', async () => {
        const product = await createProduct('ACME-001', 'Acme Widget');

        const { result } = await sync([external()]);

        expect(result).toMatchObject({ created: 1, updated: 0, linesWritten: 1, linesRemoved: 0 });

        const shipment = await storedShipment();
        expect(shipment).toMatchObject({
            externalId: '5001',
            reference: 'JHB-2026-08',
            status: ChannelShipmentStatus.Open,
            destination: 'JHB',
            isArchived: false,
        });
        expect(shipment.synchronisedAt).not.toBeNull();

        const channel = await models.channel.findOne({ id: shipment.channelId });
        expect(channel?.name).toBe(TAKEALOT_CHANNEL_NAME);

        const items = await models.channelShipmentItem.findMany({
            where: { shipmentId: shipment.id },
        });
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
            externalId: '91',
            listingRef: '12345',
            sku: 'ACME-001',
            productId: product.id,
            quantityRequired: 40,
            quantitySending: 30,
            cancelled: false,
        });
    });

    test('computes the shipment totals from its lines', async () => {
        await createProduct('ACME-001');

        await sync([
            external({
                items: [line(), line({ externalId: '92', sku: 'NOT-IN-CATALOGUE', quantitySending: 5 })],
            }),
        ]);

        const shipment = await storedShipment();
        expect(shipment.totalLines).toBe(2);
        expect(Number(shipment.totalUnits)).toBe(35);
        expect(shipment.matchedLines).toBe(1);
    });

    test('stores an unmatched line with its identifiers and no product', async () => {
        await sync([external({ items: [line({ sku: null, listingRef: '999' })] })]);

        const shipment = await storedShipment();
        const items = await models.channelShipmentItem.findMany({
            where: { shipmentId: shipment.id },
        });
        expect(items[0]).toMatchObject({ productId: null, sku: null, listingRef: '999' });
    });

    test('is idempotent — re-applying the same plan updates in place', async () => {
        await createProduct('ACME-001');
        const plan = await computeShipmentSyncPlan(TAKEALOT_CHANNEL_NAME, [external()]);

        await applyShipmentSync(plan);
        // A retried step replays the same plan; the unique [channel, externalId]
        // pair means it lands on the same row rather than minting a second.
        const second = await applyShipmentSync(plan);

        expect(second).toMatchObject({ created: 0, updated: 1 });
        expect(await models.channelShipment.findMany({})).toHaveLength(1);
        expect(await models.channelShipmentItem.findMany({})).toHaveLength(1);
    });

    test('deletes a line the channel no longer lists', async () => {
        await createProduct('ACME-001');
        await createProduct('ACME-002');
        await sync([external({ items: [line(), line({ externalId: '92', sku: 'ACME-002' })] })]);

        const { result } = await sync([external({ items: [line()] })]);

        expect(result.linesRemoved).toBe(1);
        const shipment = await storedShipment();
        const items = await models.channelShipmentItem.findMany({
            where: { shipmentId: shipment.id },
        });
        expect(items.map((i) => i.externalId)).toEqual(['91']);
    });

    test('links the product once the catalogue catches up', async () => {
        await sync([external()]);
        const product = await createProduct('ACME-001');

        await sync([external()]);

        const shipment = await storedShipment();
        const items = await models.channelShipmentItem.findMany({
            where: { shipmentId: shipment.id },
        });
        expect(items[0].productId).toBe(product.id);
        expect(items[0].productName).toBe('Product ACME-001');
    });

    test('keeps shipments belonging to different channels apart', async () => {
        await createProduct('ACME-001');
        await sync([external()]);
        // The same channel-side id on another platform is a different shipment.
        const otherPlan = await computeShipmentSyncPlan('Amazon', [external()]);
        await applyShipmentSync(otherPlan);

        const rows = await models.channelShipment.findMany({ where: { externalId: '5001' } });
        expect(rows).toHaveLength(2);
        expect(new Set(rows.map((r) => r.channelId)).size).toBe(2);
    });
});

// ─── Nested consignments ────────────────────────────────────────────────────

describe('externalGroupId', () => {
    test('is stored, so a platform that nests consignments can re-fetch one', async () => {
        await createProduct('ACME-001');

        await sync([external({ externalGroupId: 'wf-1' })]);

        expect((await storedShipment()).externalGroupId).toBe('wf-1');
    });

    test('a consignment moving to another group is a change, not a match', async () => {
        await createProduct('ACME-001');
        await sync([external({ externalGroupId: 'wf-1' })]);

        const plan = await computeShipmentSyncPlan(TAKEALOT_CHANNEL_NAME, [
            external({ externalGroupId: 'wf-2' }),
        ]);

        expect(plan.changes).toHaveLength(1);
        expect(plan.changes[0].change).toBe('Update');
    });
});

// ─── Lines the channel labels itself ────────────────────────────────────────

describe('labelledByChannel', () => {
    test('is stored on the line', async () => {
        await createProduct('ACME-001');

        await sync([external({ items: [line({ labelledByChannel: true })] })]);

        const shipment = await storedShipment();
        const items = await models.channelShipmentItem.findMany({
            where: { shipmentId: shipment.id },
        });
        expect(items[0].labelledByChannel).toBe(true);
    });

    test('a line that changes hands is a change, not a match', async () => {
        await createProduct('ACME-001');
        await sync([external()]);

        // Switching a listing to Amazon-applied labels mid-consignment has to
        // land, or a print run would keep offering labels nobody wants.
        const plan = await computeShipmentSyncPlan(TAKEALOT_CHANNEL_NAME, [
            external({ items: [line({ labelledByChannel: true })] }),
        ]);

        expect(plan.changes).toHaveLength(1);
    });
});

// ─── Label codes stated on the lines ────────────────────────────────────────

describe('codes stated by a consignment', () => {
    async function storedCode(sku: string) {
        const products = await models.product.findMany({ where: { sku } });
        const codes = await models.productChannelCode.findMany({
            where: { productId: products[0].id },
        });
        return codes.length > 0 ? codes[0].code : null;
    }

    test('a code on a line becomes the matched product’s channel code', async () => {
        await createProduct('ACME-001');

        const { result } = await sync([external({ items: [line({ code: 'X001ACME01' })] })]);

        expect(result.codesCreated).toBe(1);
        expect(await storedCode('ACME-001')).toBe('X001ACME01');
    });

    test('a code that has drifted is fixed even when no consignment moved', async () => {
        await createProduct('ACME-001');
        await sync([external({ items: [line({ code: 'X001OLD000' })] })]);

        // The consignment itself is identical; only the code Amazon states has
        // changed, and that is still worth applying before anything is printed.
        const { plan, result } = await sync([external({ items: [line({ code: 'X001NEW000' })] })]);

        expect(plan.changes).toHaveLength(0);
        expect(plan.codePlan.changes).toHaveLength(1);
        expect(result.codesUpdated).toBe(1);
        expect(await storedCode('ACME-001')).toBe('X001NEW000');
    });

    test('a channel that states no codes writes none', async () => {
        await createProduct('ACME-001');

        const { plan, result } = await sync([external()]);

        expect(plan.codePlan.changes).toEqual([]);
        expect(result.codesCreated + result.codesUpdated).toBe(0);
        expect(await storedCode('ACME-001')).toBeNull();
    });

    test('one SKU across several consignments is not a duplicate to warn about', async () => {
        await createProduct('ACME-001');

        const { plan } = await sync([
            external({ externalId: '1', items: [line({ code: 'X001ACME01' })] }),
            external({ externalId: '2', items: [line({ code: 'X001ACME01' })] }),
        ]);

        // Ordinary — the same product goes into more than one consignment.
        expect(plan.warnings).toEqual([]);
        expect(plan.codePlan.changes).toHaveLength(1);
    });

    test('consignments that disagree about a code warn, and the most recent wins', async () => {
        await createProduct('ACME-001');

        // Newest first, the order an adapter returns them in: taking them as
        // they come would let the older consignment overwrite the newer code.
        const { plan } = await sync([
            external({
                externalId: '2',
                placedAt: '2026-09-01T00:00:00.000Z',
                items: [line({ code: 'X001NEW000' })],
            }),
            external({
                externalId: '1',
                placedAt: '2026-06-01T00:00:00.000Z',
                items: [line({ code: 'X001OLD000' })],
            }),
        ]);

        expect(plan.warnings).toEqual([
            'Consignments disagree on the label code for ACME-001 — using the most recent one (X001NEW000)',
        ]);
        expect(await storedCode('ACME-001')).toBe('X001NEW000');
    });

    test('a code on a line that matches no product writes nothing', async () => {
        const { result } = await sync([
            external({ items: [line({ sku: 'NOT-IN-CATALOGUE', code: 'X001ACME01' })] }),
        ]);

        expect(result.codesCreated + result.codesUpdated).toBe(0);
    });
});
