import { DeliveryCarrier, DeliveryStatus } from '@teamkeel/sdk';
import { describe, expect, test } from 'vitest';
import { isFailure } from './deliveryTrackingHelpers';
import {
    EasypostTracker,
    easypostCarrierCode,
    hasEasypostCredentials,
    mapEasypostStatus,
    parseEasypostTracker,
    refreshEasypostTracker,
} from './easypostTrackingHelpers';

const ctx = {
    env: { EASYPOST_API_BASE_URL: 'https://api.easypost.com' },
    secrets: { EASYPOST_API_KEY: 'EZAKtest' },
};

function fakeFetch(status: number, body: unknown) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const impl = (async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => body,
            text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
        };
    }) as unknown as typeof fetch;
    return { impl, calls };
}

// Trimmed from the real production response for DHL waybill 9984109892 —
// a Hong Kong → Cape Town consignment, delivered at Somerset West. Retains the
// shapes that matter: the customs hold under an in_transit status, null
// est_delivery_date on a delivered parcel, and null state/country on
// international scans.
const LIVE_DHL_TRACKER: EasypostTracker = {
    id: 'trk_c7de82e203554e1483c04925c1a08aaa',
    mode: 'production',
    tracking_code: '9984109892',
    carrier: 'DHLExpress',
    status: 'delivered',
    status_detail: 'arrived_at_destination',
    est_delivery_date: null,
    signed_by: '',
    carrier_detail: {
        service: 'ExpressWorldwideNonDoc',
        origin_location: 'HONG KONG-HKG',
        destination_location: 'CAPE TOWN-ZAF',
    },
    tracking_details: [
        {
            message: 'Shipment information received',
            status: 'pre_transit',
            status_detail: 'status_update',
            datetime: '2026-06-24T15:53:24Z',
            tracking_location: { city: null, state: null, country: null, zip: null },
        },
        {
            message: 'Shipment picked up',
            status: 'pre_transit',
            status_detail: 'status_update',
            datetime: '2026-06-26T13:33:42Z',
            tracking_location: { city: 'Hong Kong-Hkg', state: null, country: null, zip: null },
        },
        {
            message: 'Shipment is on hold',
            status: 'in_transit',
            status_detail: 'held',
            datetime: '2026-06-29T12:09:48Z',
            tracking_location: { city: 'Cape Town-Zaf', state: null, country: null, zip: null },
        },
        {
            message: 'Shipment is out with courier for delivery',
            status: 'out_for_delivery',
            status_detail: 'out_for_delivery',
            datetime: '2026-06-30T08:08:57Z',
            tracking_location: { city: 'Cape Town-Zaf', state: null, country: null, zip: null },
        },
        {
            message: 'Delivered',
            status: 'delivered',
            status_detail: 'arrived_at_destination',
            datetime: '2026-06-30T12:36:47Z',
            tracking_location: { city: 'Somerset West-Zaf', state: null, country: null, zip: null },
        },
    ],
};

describe('easypostCarrierCode', () => {
    test('maps our carriers to the codes the live API accepts', () => {
        expect(easypostCarrierCode(DeliveryCarrier.Fedex)).toBe('FedEx');
        expect(easypostCarrierCode(DeliveryCarrier.Dhl)).toBe('DHLExpress');
        expect(easypostCarrierCode(DeliveryCarrier.Ups)).toBe('UPS');
    });
});

describe('mapEasypostStatus', () => {
    test('maps the coarse status set', () => {
        expect(mapEasypostStatus('pre_transit')).toBe(DeliveryStatus.InfoReceived);
        expect(mapEasypostStatus('in_transit')).toBe(DeliveryStatus.InTransit);
        expect(mapEasypostStatus('out_for_delivery')).toBe(DeliveryStatus.OutForDelivery);
        expect(mapEasypostStatus('available_for_pickup')).toBe(DeliveryStatus.Arrived);
        expect(mapEasypostStatus('delivered')).toBe(DeliveryStatus.Delivered);
        expect(mapEasypostStatus('return_to_sender')).toBe(DeliveryStatus.Exception);
        expect(mapEasypostStatus('failure')).toBe(DeliveryStatus.Exception);
        expect(mapEasypostStatus('cancelled')).toBe(DeliveryStatus.Cancelled);
        expect(mapEasypostStatus('error')).toBe(DeliveryStatus.NotFound);
        expect(mapEasypostStatus('unknown')).toBe(DeliveryStatus.Unknown);
    });

    test('normalises case and whitespace', () => {
        expect(mapEasypostStatus(' In_Transit ')).toBe(DeliveryStatus.InTransit);
    });

    test('an unmapped or missing status degrades to Unknown', () => {
        expect(mapEasypostStatus('some_new_status')).toBe(DeliveryStatus.Unknown);
        expect(mapEasypostStatus(null)).toBe(DeliveryStatus.Unknown);
        expect(mapEasypostStatus('')).toBe(DeliveryStatus.Unknown);
    });

    test('a customs hold beats the in_transit status it hides under', () => {
        // The real failure mode: our Cape Town parcel sat on hold for a day while
        // the coarse status still read in_transit.
        expect(mapEasypostStatus('in_transit', 'held')).toBe(DeliveryStatus.Exception);
        expect(mapEasypostStatus('in_transit')).toBe(DeliveryStatus.InTransit);
    });

    test('other actionable details also win over the coarse status', () => {
        expect(mapEasypostStatus('in_transit', 'delayed')).toBe(DeliveryStatus.Exception);
        expect(mapEasypostStatus('in_transit', 'lost')).toBe(DeliveryStatus.Exception);
        expect(mapEasypostStatus('in_transit', 'damaged')).toBe(DeliveryStatus.Exception);
        expect(mapEasypostStatus('in_transit', 'address_correction')).toBe(DeliveryStatus.Exception);
    });

    test('a benign status_detail leaves the coarse status alone', () => {
        expect(mapEasypostStatus('in_transit', 'arrived_at_facility')).toBe(DeliveryStatus.InTransit);
        expect(mapEasypostStatus('in_transit', 'departed_facility')).toBe(DeliveryStatus.InTransit);
        expect(mapEasypostStatus('delivered', 'arrived_at_destination')).toBe(DeliveryStatus.Delivered);
    });
});

describe('parseEasypostTracker', () => {
    test('parses the real DHL production payload', () => {
        const snapshot = parseEasypostTracker(LIVE_DHL_TRACKER);

        expect(snapshot.status).toBe(DeliveryStatus.Delivered);
        expect(snapshot.destination).toBe('CAPE TOWN-ZAF');
        // No explicit delivered-at field; taken from the delivered scan.
        expect(snapshot.deliveredAt?.toISOString()).toBe('2026-06-30T12:36:47.000Z');
        expect(snapshot.statusDescription).toBe('Delivered');
        expect(snapshot.events).toHaveLength(5);
    });

    test('a delivered parcel has no carrier ETA, and that must not be invented', () => {
        // DHL stops publishing an ETA once delivered, so this is null — and
        // applySnapshot then keeps whatever ETA was already known.
        expect(parseEasypostTracker(LIVE_DHL_TRACKER).estimatedArrival).toBeNull();
    });

    test('reads the carrier ETA when one is published', () => {
        const inFlight: EasypostTracker = {
            ...LIVE_DHL_TRACKER,
            status: 'in_transit',
            status_detail: 'in_transit',
            est_delivery_date: '2026-08-25T17:00:00Z',
        };
        expect(parseEasypostTracker(inFlight).estimatedArrival?.toISOString()).toBe('2026-08-25T17:00:00.000Z');
    });

    test('the customs hold surfaces as an Exception event in the history', () => {
        const hold = parseEasypostTracker(LIVE_DHL_TRACKER).events.find((e) => e.description === 'Shipment is on hold');
        expect(hold?.status).toBe(DeliveryStatus.Exception);
        expect(hold?.location).toBe('Cape Town-Zaf');
    });

    test('an in-flight hold makes the whole delivery an Exception', () => {
        const held: EasypostTracker = { ...LIVE_DHL_TRACKER, status: 'in_transit', status_detail: 'held' };
        expect(parseEasypostTracker(held).status).toBe(DeliveryStatus.Exception);
    });

    test('scans with no location at all yield null rather than an empty string', () => {
        const first = parseEasypostTracker(LIVE_DHL_TRACKER).events[0];
        expect(first.description).toBe('Shipment information received');
        expect(first.location).toBeNull();
    });

    test('joins whatever location parts the carrier gave', () => {
        const domestic: EasypostTracker = {
            ...LIVE_DHL_TRACKER,
            tracking_details: [
                {
                    message: 'ORIGIN SCAN',
                    status: 'in_transit',
                    datetime: '2026-07-21T08:05:42Z',
                    tracking_location: { city: 'SOUTH SAN FRANCISCO', state: 'CA', country: 'US', zip: null },
                },
            ],
        };
        expect(parseEasypostTracker(domestic).events[0].location).toBe('SOUTH SAN FRANCISCO, CA, US');
    });

    test('an undelivered parcel has no delivery time', () => {
        const inFlight: EasypostTracker = { ...LIVE_DHL_TRACKER, status: 'in_transit', status_detail: 'in_transit' };
        expect(parseEasypostTracker(inFlight).deliveredAt).toBeNull();
    });

    test('drops scans with unparseable timestamps', () => {
        const messy: EasypostTracker = {
            ...LIVE_DHL_TRACKER,
            tracking_details: [
                { message: 'Bad', status: 'in_transit', datetime: 'not-a-date' },
                { message: 'Good', status: 'in_transit', datetime: '2026-06-26T13:33:42Z' },
            ],
        };
        const events = parseEasypostTracker(messy).events;
        expect(events).toHaveLength(1);
        expect(events[0].description).toBe('Good');
    });

    test('survives an empty tracker without throwing', () => {
        const snapshot = parseEasypostTracker({});
        expect(snapshot.status).toBe(DeliveryStatus.Unknown);
        expect(snapshot.events).toEqual([]);
        expect(snapshot.estimatedArrival).toBeNull();
        expect(snapshot.destination).toBeNull();
    });
});

describe('hasEasypostCredentials', () => {
    test('needs a non-empty key', () => {
        expect(hasEasypostCredentials(ctx)).toBe(true);
        expect(hasEasypostCredentials({ ...ctx, secrets: { EASYPOST_API_KEY: '' } })).toBe(false);
    });
});

describe('refreshEasypostTracker', () => {
    const courier = {
        carrier: DeliveryCarrier.Dhl,
        trackingNumber: '9984109892',
        easypostTrackerId: null as string | null,
    };

    test('creates the tracker on first contact and returns its id to store', async () => {
        const { impl, calls } = fakeFetch(201, LIVE_DHL_TRACKER);

        const result = await refreshEasypostTracker(ctx, courier, impl);

        expect(calls[0].url).toBe('https://api.easypost.com/v2/trackers');
        expect(calls[0].init?.method).toBe('POST');
        const body = String(calls[0].init?.body);
        expect(body).toContain('tracker%5Btracking_code%5D=9984109892');
        expect(body).toContain('tracker%5Bcarrier%5D=DHLExpress');
        // Basic auth: key as username, empty password.
        expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe(
            `Basic ${Buffer.from('EZAKtest:').toString('base64')}`,
        );
        expect(result.trackerId).toBe('trk_c7de82e203554e1483c04925c1a08aaa');
    });

    test('reads the stored tracker instead of re-creating it — EasyPost bills per create', async () => {
        const { impl, calls } = fakeFetch(200, LIVE_DHL_TRACKER);

        await refreshEasypostTracker(
            ctx,
            { ...courier, easypostTrackerId: 'trk_c7de82e203554e1483c04925c1a08aaa' },
            impl,
        );

        expect(calls[0].init?.method).toBe('GET');
        expect(calls[0].url).toBe('https://api.easypost.com/v2/trackers/trk_c7de82e203554e1483c04925c1a08aaa');
    });

    test('an untrackable code is NotFound, not a failure, so it keeps being retried', async () => {
        const { impl } = fakeFetch(422, {
            error: { code: 'TRACKER.INVALID_TEST_CODE', message: 'In test mode, only test tracking numbers are valid' },
        });

        const result = await refreshEasypostTracker(ctx, courier, impl);

        expect(isFailure(result)).toBe(false);
        if (isFailure(result)) return;
        expect(result.status).toBe(DeliveryStatus.NotFound);
    });

    test('other errors are failures, so last-known-good state is preserved', async () => {
        const { impl } = fakeFetch(500, { error: { code: 'INTERNAL', message: 'Something broke' } });

        const result = await refreshEasypostTracker(ctx, courier, impl);

        expect(isFailure(result)).toBe(true);
        if (!isFailure(result)) return;
        expect(result.error).toContain('EasyPost: INTERNAL');
    });

    test('a non-JSON error body is still reported readably', async () => {
        const { impl } = fakeFetch(502, '<html>Bad Gateway</html>');

        const result = await refreshEasypostTracker(ctx, courier, impl);

        expect(isFailure(result)).toBe(true);
        if (!isFailure(result)) return;
        expect(result.error).toContain('502');
    });

    test('tolerates a base URL with a trailing slash', async () => {
        const { impl, calls } = fakeFetch(201, LIVE_DHL_TRACKER);
        await refreshEasypostTracker({ ...ctx, env: { EASYPOST_API_BASE_URL: 'https://api.easypost.com/' } }, courier, impl);
        expect(calls[0].url).toBe('https://api.easypost.com/v2/trackers');
    });
});
