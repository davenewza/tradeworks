// Validation and normalisation for a new delivery tracking entry. Pure, so the
// mode/identifier rules are unit-tested directly rather than through the action.

import { DeliveryCarrier, DeliveryMode } from '@teamkeel/sdk';

export interface NewDeliveryInput {
    mode: DeliveryMode;
    carrier: DeliveryCarrier | null;
    trackingNumber: string | null;
    vesselName: string | null;
}

export interface NormalisedDelivery {
    carrier: DeliveryCarrier | null;
    trackingNumber: string | null;
    vesselName: string | null;
}

// Couriers print tracking numbers in grouped form ("7712 3456 7890"); carriers
// reject the spaces on lookup, so they are stripped on the way in. Case is
// normalised too — DHL Express numbers are alphanumeric and their API is
// case-sensitive.
export function normaliseTrackingNumber(trackingNumber: string): string {
    return trackingNumber.replace(/[\s-]+/g, '').toUpperCase();
}

// Enforce that the identifier matches the mode, and clear the fields belonging to
// the other mode so a switched-over entry can't keep a stale identifier that the
// refresh flow would then try to track.
export function normaliseNewDelivery(input: NewDeliveryInput): NormalisedDelivery | { error: string } {
    if (input.mode === DeliveryMode.AirCourier) {
        if (!input.carrier) {
            return { error: 'An air courier delivery needs a carrier (FedEx or DHL).' };
        }
        const trackingNumber = (input.trackingNumber ?? '').trim();
        if (trackingNumber === '') {
            return { error: 'An air courier delivery needs a tracking number.' };
        }
        return {
            carrier: input.carrier,
            trackingNumber: normaliseTrackingNumber(trackingNumber),
            vesselName: null,
        };
    }

    const vesselName = (input.vesselName ?? '').trim();
    if (vesselName === '') {
        return { error: 'A sea freight delivery needs a vessel name.' };
    }
    return {
        carrier: null,
        trackingNumber: null,
        vesselName,
    };
}
