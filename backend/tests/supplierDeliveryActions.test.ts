// Action-level coverage for supplier deliveries, exercised through the real
// actions (permissions, hooks and all) rather than the models API.
//
// The point of these is the create-time tracking check: it runs inside
// createSupplierDelivery's afterWrite hook, so a mistake there turns "log a
// delivery" into an error the user sees. In the test environment no provider
// secrets are set, which is exactly the case that must stay harmless — the row is
// written, the refresh skips, and the caller gets their delivery.

import { actions, models, resetDatabase } from '@teamkeel/testing';
import { DeliveryCarrier, DeliveryMode, DeliveryStatus, Team } from '@teamkeel/sdk';
import { beforeEach, describe, expect, test } from 'vitest';

// Roles come from team membership, which lives on User rather than Identity, so
// an operator is a User in the Warehouse team plus an Identity pointing at it.
let operatorSeq = 0;

async function operator() {
    const email = `ops-${++operatorSeq}@tradeworks.test`;
    const user = await models.user.create({ email, teams: [Team.Warehouse] });
    return await models.identity.create({ email, userId: user.id });
}

describe('createSupplierDelivery', () => {
    beforeEach(resetDatabase);

    test('creates a courier delivery and normalises the tracking number', async () => {
        const delivery = await actions.withIdentity(await operator()).createSupplierDelivery({
            mode: DeliveryMode.AirCourier,
            carrier: DeliveryCarrier.Dhl,
            trackingNumber: ' 9984 1098 92 ',
            reference: 'PO-1001',
            supplierName: 'Acme HK',
        });

        expect(delivery.trackingNumber).toBe('9984109892');
        expect(delivery.vesselName).toBeNull();
        expect(delivery.reference).toBe('PO-1001');
    });

    test('the create-time tracking check cannot fail the create', async () => {
        // No EASYPOST_API_KEY in the test environment, so the immediate refresh
        // has nothing to ask. The delivery must still be created and returned.
        const delivery = await actions.withIdentity(await operator()).createSupplierDelivery({
            mode: DeliveryMode.AirCourier,
            carrier: DeliveryCarrier.Ups,
            trackingNumber: '1Z12345E6605272234',
        });

        expect(delivery.id).toBeTruthy();

        const stored = await models.supplierDelivery.findOne({ id: delivery.id });
        expect(stored).not.toBeNull();
        // A skipped check leaves the row untouched, so it is still due for the
        // next scheduled run rather than looking freshly checked.
        expect(stored!.status).toBe(DeliveryStatus.Pending);
        expect(stored!.lastCheckedAt).toBeNull();
        expect(stored!.consecutiveFailures).toBe(0);
        expect(stored!.refreshError).toBeNull();
    });

    test('creates a sea freight delivery from a vessel name', async () => {
        const delivery = await actions.withIdentity(await operator()).createSupplierDelivery({
            mode: DeliveryMode.SeaFreight,
            vesselName: '  EVER GIVEN  ',
        });

        expect(delivery.vesselName).toBe('EVER GIVEN');
        expect(delivery.carrier).toBeNull();
        expect(delivery.trackingNumber).toBeNull();
    });

    test('rejects a courier with no tracking number', async () => {
        await expect(
            actions.withIdentity(await operator()).createSupplierDelivery({
                mode: DeliveryMode.AirCourier,
                carrier: DeliveryCarrier.Fedex,
            }),
        ).rejects.toThrow(/needs a tracking number/);
    });

    test('rejects a courier with no carrier', async () => {
        await expect(
            actions.withIdentity(await operator()).createSupplierDelivery({
                mode: DeliveryMode.AirCourier,
                trackingNumber: '9984109892',
            }),
        ).rejects.toThrow(/needs a carrier/);
    });

    test('rejects sea freight with no vessel name', async () => {
        await expect(
            actions.withIdentity(await operator()).createSupplierDelivery({
                mode: DeliveryMode.SeaFreight,
            }),
        ).rejects.toThrow(/needs a vessel name/);
    });

    test('requires an authenticated operator', async () => {
        await expect(
            actions.createSupplierDelivery({
                mode: DeliveryMode.SeaFreight,
                vesselName: 'EVER GIVEN',
            }),
        ).rejects.toThrow();
    });
});

describe('refreshSupplierDelivery', () => {
    beforeEach(resetDatabase);

    test('reports what happened rather than throwing when no provider is configured', async () => {
        const identity = await operator();
        const delivery = await actions.withIdentity(identity).createSupplierDelivery({
            mode: DeliveryMode.SeaFreight,
            vesselName: 'EVER GIVEN',
        });

        const result = await actions.withIdentity(identity).refreshSupplierDelivery({ id: delivery.id });

        expect(result.refreshed).toBe(false);
        expect(result.message).toMatch(/VESSEL_API_KEY/);
        expect(result.newEvents).toBe(0);
        // Echoes the delivery's current state so the Console needs no second call.
        expect(result.status).toBe(DeliveryStatus.Pending);
    });

    test('a skipped refresh leaves the delivery due, not freshly checked', async () => {
        const identity = await operator();
        const delivery = await actions.withIdentity(identity).createSupplierDelivery({
            mode: DeliveryMode.AirCourier,
            carrier: DeliveryCarrier.Dhl,
            trackingNumber: '9984109892',
        });

        await actions.withIdentity(identity).refreshSupplierDelivery({ id: delivery.id });

        const stored = await models.supplierDelivery.findOne({ id: delivery.id });
        expect(stored!.lastCheckedAt).toBeNull();
        expect(stored!.consecutiveFailures).toBe(0);
    });

    test('errors for an unknown delivery id', async () => {
        await expect(
            actions.withIdentity(await operator()).refreshSupplierDelivery({ id: '2Abc000000000000000000000000' }),
        ).rejects.toThrow(/not found/i);
    });

    test('requires an authenticated operator', async () => {
        const identity = await operator();
        const delivery = await actions.withIdentity(identity).createSupplierDelivery({
            mode: DeliveryMode.SeaFreight,
            vesselName: 'EVER GIVEN',
        });

        await expect(actions.refreshSupplierDelivery({ id: delivery.id })).rejects.toThrow();
    });
});
