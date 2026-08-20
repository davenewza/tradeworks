import { DeliveryCarrier, DeliveryMode } from '@teamkeel/sdk';
import { describe, expect, test } from 'vitest';
import { normaliseNewDelivery, normaliseTrackingNumber } from './deliveryInputHelpers';

describe('normaliseTrackingNumber', () => {
    test('strips the grouping carriers print on labels', () => {
        expect(normaliseTrackingNumber('7712 3456 7890')).toBe('771234567890');
        expect(normaliseTrackingNumber('JJD-0039-0005-8930')).toBe('JJD003900058930');
    });

    test('upper-cases alphanumeric numbers (DHL Express lookups are case-sensitive)', () => {
        expect(normaliseTrackingNumber('jjd000390005893028175')).toBe('JJD000390005893028175');
    });
});

describe('normaliseNewDelivery — air courier', () => {
    test('accepts a carrier plus a tracking number, and normalises the number', () => {
        const result = normaliseNewDelivery({
            mode: DeliveryMode.AirCourier,
            carrier: DeliveryCarrier.Fedex,
            trackingNumber: ' 7712 3456 7890 ',
            vesselName: null,
        });

        expect(result).toEqual({
            carrier: DeliveryCarrier.Fedex,
            trackingNumber: '771234567890',
            vesselName: null,
        });
    });

    test('requires a carrier', () => {
        const result = normaliseNewDelivery({
            mode: DeliveryMode.AirCourier,
            carrier: null,
            trackingNumber: '771234567890',
            vesselName: null,
        });

        expect(result).toEqual({ error: 'An air courier delivery needs a carrier (FedEx or DHL).' });
    });

    test('requires a tracking number, treating blank as missing', () => {
        for (const trackingNumber of [null, '', '   ']) {
            expect(
                normaliseNewDelivery({
                    mode: DeliveryMode.AirCourier,
                    carrier: DeliveryCarrier.Dhl,
                    trackingNumber,
                    vesselName: null,
                }),
            ).toEqual({ error: 'An air courier delivery needs a tracking number.' });
        }
    });

    test('clears a stray vessel name so the refresh flow cannot try to track it', () => {
        const result = normaliseNewDelivery({
            mode: DeliveryMode.AirCourier,
            carrier: DeliveryCarrier.Dhl,
            trackingNumber: 'JJD0123',
            vesselName: 'EVER GIVEN',
        });

        expect(result).toEqual({
            carrier: DeliveryCarrier.Dhl,
            trackingNumber: 'JJD0123',
            vesselName: null,
        });
    });
});

describe('normaliseNewDelivery — sea freight', () => {
    test('accepts a vessel name and trims it', () => {
        const result = normaliseNewDelivery({
            mode: DeliveryMode.SeaFreight,
            carrier: null,
            trackingNumber: null,
            vesselName: '  EVER GIVEN  ',
        });

        expect(result).toEqual({ carrier: null, trackingNumber: null, vesselName: 'EVER GIVEN' });
    });

    test('requires a vessel name, treating blank as missing', () => {
        for (const vesselName of [null, '', '   ']) {
            expect(
                normaliseNewDelivery({
                    mode: DeliveryMode.SeaFreight,
                    carrier: null,
                    trackingNumber: null,
                    vesselName,
                }),
            ).toEqual({ error: 'A sea freight delivery needs a vessel name.' });
        }
    });

    test('clears a stray carrier and tracking number', () => {
        const result = normaliseNewDelivery({
            mode: DeliveryMode.SeaFreight,
            carrier: DeliveryCarrier.Fedex,
            trackingNumber: '771234567890',
            vesselName: 'MSC AURORA',
        });

        expect(result).toEqual({ carrier: null, trackingNumber: null, vesselName: 'MSC AURORA' });
    });

    test('vessel-name case is preserved — AIS name matching is case-insensitive anyway', () => {
        const result = normaliseNewDelivery({
            mode: DeliveryMode.SeaFreight,
            carrier: null,
            trackingNumber: null,
            vesselName: 'Ever Given',
        });

        expect(result).toEqual({ carrier: null, trackingNumber: null, vesselName: 'Ever Given' });
    });
});
