import { models, resetDatabase } from '@teamkeel/testing';
import { DeliveryCarrier, DeliveryMode, DeliveryStatus } from '@teamkeel/sdk';
import { beforeEach, describe, expect, test } from 'vitest';
import { RefreshCtx, applySnapshot, recordFailure, refreshDelivery, refreshDeliveryById } from './deliveryRefresh';
import { TrackingSnapshot } from './deliveryTrackingHelpers';

const NOW = new Date('2026-08-20T12:00:00Z');

// Credentials present but pointed at a host that is never reached: every test
// here either stops before the provider call (skip cases) or drives the
// persistence functions directly.
const configured: RefreshCtx = {
    env: {
        EASYPOST_API_BASE_URL: 'https://api.easypost.test',
        VESSEL_API_BASE_URL: 'https://api.vesselapi.test',
    },
    secrets: { EASYPOST_API_KEY: 'EZAKtest', VESSEL_API_KEY: 'vtest' },
};

const unconfigured: RefreshCtx = {
    env: {
        EASYPOST_API_BASE_URL: 'https://api.easypost.test',
        VESSEL_API_BASE_URL: 'https://api.vesselapi.test',
    },
    secrets: { EASYPOST_API_KEY: '', VESSEL_API_KEY: '' },
};

function snapshot(overrides: Partial<TrackingSnapshot> = {}): TrackingSnapshot {
    return {
        status: DeliveryStatus.InTransit,
        statusDescription: 'On its way',
        estimatedArrival: new Date('2026-08-25T10:00:00Z'),
        deliveredAt: null,
        destination: 'CAPE TOWN-ZAF',
        events: [],
        ...overrides,
    };
}

describe('refreshDelivery — nothing to ask', () => {
    beforeEach(resetDatabase);

    test('skips a courier when EasyPost is not configured, without touching the row', async () => {
        const delivery = await models.supplierDelivery.create({
            mode: DeliveryMode.AirCourier,
            carrier: DeliveryCarrier.Dhl,
            trackingNumber: '9984109892',
        });

        const outcome = await refreshDelivery(unconfigured, delivery, NOW);

        expect(outcome.kind).toBe('skipped');
        // A skip must not look like a check: lastCheckedAt stays null so the
        // delivery is still due, and the failure backoff is untouched.
        const after = await models.supplierDelivery.findOne({ id: delivery.id });
        expect(after!.lastCheckedAt).toBeNull();
        expect(after!.consecutiveFailures).toBe(0);
        expect(after!.status).toBe(DeliveryStatus.Pending);
    });

    test('skips sea freight when VesselAPI is not configured', async () => {
        const delivery = await models.supplierDelivery.create({
            mode: DeliveryMode.SeaFreight,
            vesselName: 'EVER GIVEN',
        });

        const outcome = await refreshDelivery(unconfigured, delivery, NOW);

        expect(outcome.kind).toBe('skipped');
        if (outcome.kind !== 'skipped') return;
        expect(outcome.reason).toMatch(/VESSEL_API_KEY/);
    });

    test('skips a courier with no tracking number rather than calling out', async () => {
        // Reachable by editing a row directly; createSupplierDelivery rejects it.
        const delivery = await models.supplierDelivery.create({ mode: DeliveryMode.AirCourier });

        const outcome = await refreshDelivery(configured, delivery, NOW);

        expect(outcome.kind).toBe('skipped');
        if (outcome.kind !== 'skipped') return;
        expect(outcome.reason).toMatch(/no carrier or tracking number/);
    });

    test('skips sea freight with no vessel identifier at all', async () => {
        const delivery = await models.supplierDelivery.create({ mode: DeliveryMode.SeaFreight });

        const outcome = await refreshDelivery(configured, delivery, NOW);

        expect(outcome.kind).toBe('skipped');
        if (outcome.kind !== 'skipped') return;
        expect(outcome.reason).toMatch(/no vessel name or IMO/);
    });
});

describe('recordFailure', () => {
    beforeEach(resetDatabase);

    test('records the reason and advances the backoff without disturbing known state', async () => {
        const delivery = await models.supplierDelivery.create({
            mode: DeliveryMode.AirCourier,
            carrier: DeliveryCarrier.Dhl,
            trackingNumber: 'X1',
            status: DeliveryStatus.InTransit,
            statusDescription: 'On its way',
            estimatedArrival: new Date('2026-08-25T10:00:00Z'),
            destination: 'CAPE TOWN-ZAF',
            consecutiveFailures: 1,
        });

        await recordFailure(delivery, 'EasyPost: 500 - upstream broke', NOW);

        const after = await models.supplierDelivery.findOne({ id: delivery.id });
        expect(after!.refreshError).toContain('500');
        expect(after!.consecutiveFailures).toBe(2);
        expect(after!.lastCheckedAt?.toISOString()).toBe(NOW.toISOString());
        // Last-known-good survives a bad afternoon at the carrier.
        expect(after!.status).toBe(DeliveryStatus.InTransit);
        expect(after!.estimatedArrival?.toISOString()).toBe('2026-08-25T10:00:00.000Z');
        expect(after!.destination).toBe('CAPE TOWN-ZAF');
    });

    test('truncates a runaway error message', async () => {
        const delivery = await models.supplierDelivery.create({
            mode: DeliveryMode.SeaFreight,
            vesselName: 'EVER GIVEN',
        });

        await recordFailure(delivery, 'x'.repeat(2000), NOW);

        const after = await models.supplierDelivery.findOne({ id: delivery.id });
        expect(after!.refreshError!.length).toBeLessThanOrEqual(500);
    });
});

describe('applySnapshot', () => {
    beforeEach(resetDatabase);

    test('writes status, ETA, destination and events, and clears any prior error', async () => {
        const delivery = await models.supplierDelivery.create({
            mode: DeliveryMode.AirCourier,
            carrier: DeliveryCarrier.Dhl,
            trackingNumber: 'X1',
            refreshError: 'previous failure',
            consecutiveFailures: 3,
        });

        const added = await applySnapshot(
            delivery,
            snapshot({
                events: [
                    {
                        occurredAt: new Date('2026-08-19T08:00:00Z'),
                        description: 'Departed Hong Kong',
                        location: 'Hong Kong-Hkg',
                        status: DeliveryStatus.InTransit,
                    },
                ],
            }),
            NOW,
            'trk_abc',
        );

        expect(added).toBe(1);
        const after = await models.supplierDelivery.findOne({ id: delivery.id });
        expect(after!.status).toBe(DeliveryStatus.InTransit);
        expect(after!.statusDescription).toBe('On its way');
        expect(after!.estimatedArrival?.toISOString()).toBe('2026-08-25T10:00:00.000Z');
        expect(after!.destination).toBe('CAPE TOWN-ZAF');
        expect(after!.easypostTrackerId).toBe('trk_abc');
        expect(after!.lastEventAt?.toISOString()).toBe('2026-08-19T08:00:00.000Z');
        expect(after!.lastEventLocation).toBe('Hong Kong-Hkg');
        // A success resets the backoff and clears the recorded problem.
        expect(after!.refreshError).toBeNull();
        expect(after!.consecutiveFailures).toBe(0);
    });

    test('a null ETA from the provider does not erase one we already knew', async () => {
        const delivery = await models.supplierDelivery.create({
            mode: DeliveryMode.AirCourier,
            carrier: DeliveryCarrier.Dhl,
            trackingNumber: 'X1',
            estimatedArrival: new Date('2026-08-25T10:00:00Z'),
            destination: 'CAPE TOWN-ZAF',
        });

        // Exactly what a delivered EasyPost tracker looks like: the carrier stops
        // publishing an ETA once it has arrived.
        await applySnapshot(
            delivery,
            snapshot({ status: DeliveryStatus.Delivered, estimatedArrival: null, destination: null }),
            NOW,
            null,
        );

        const after = await models.supplierDelivery.findOne({ id: delivery.id });
        expect(after!.estimatedArrival?.toISOString()).toBe('2026-08-25T10:00:00.000Z');
        expect(after!.destination).toBe('CAPE TOWN-ZAF');
        expect(after!.status).toBe(DeliveryStatus.Delivered);
    });

    test('keeps an existing tracker id when a refresh does not report one', async () => {
        const delivery = await models.supplierDelivery.create({
            mode: DeliveryMode.AirCourier,
            carrier: DeliveryCarrier.Dhl,
            trackingNumber: 'X1',
            easypostTrackerId: 'trk_existing',
        });

        await applySnapshot(delivery, snapshot(), NOW, null);

        const after = await models.supplierDelivery.findOne({ id: delivery.id });
        expect(after!.easypostTrackerId).toBe('trk_existing');
    });

    test('re-applying the same snapshot adds no duplicate events', async () => {
        const delivery = await models.supplierDelivery.create({
            mode: DeliveryMode.AirCourier,
            carrier: DeliveryCarrier.Dhl,
            trackingNumber: 'X1',
        });

        const withEvents = snapshot({
            events: [
                {
                    occurredAt: new Date('2026-08-19T08:00:00Z'),
                    description: 'Departed Hong Kong',
                    location: 'Hong Kong-Hkg',
                    status: DeliveryStatus.InTransit,
                },
                {
                    occurredAt: new Date('2026-08-19T18:00:00Z'),
                    description: 'Arrived Cape Town',
                    location: 'Cape Town-Zaf',
                    status: DeliveryStatus.InTransit,
                },
            ],
        });

        expect(await applySnapshot(delivery, withEvents, NOW, null)).toBe(2);
        // A manual "Check now" right after a scheduled run replays the history.
        const reloaded = await models.supplierDelivery.findOne({ id: delivery.id });
        expect(await applySnapshot(reloaded!, withEvents, NOW, null)).toBe(0);
        expect(await models.deliveryEvent.findMany({})).toHaveLength(2);
    });
});

describe('refreshDeliveryById', () => {
    beforeEach(resetDatabase);

    test('returns null for an id that does not exist', async () => {
        expect(await refreshDeliveryById(configured, '2Abc000000000000000000000000', NOW)).toBeNull();
    });

    test('resolves the row and refreshes it', async () => {
        const delivery = await models.supplierDelivery.create({
            mode: DeliveryMode.SeaFreight,
            vesselName: 'EVER GIVEN',
        });

        const outcome = await refreshDeliveryById(unconfigured, delivery.id, NOW);

        expect(outcome).not.toBeNull();
        expect(outcome!.kind).toBe('skipped');
    });
});
