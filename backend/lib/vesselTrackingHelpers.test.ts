import { DeliveryStatus } from '@teamkeel/sdk';
import { describe, expect, test } from 'vitest';
import { isFailure } from './deliveryTrackingHelpers';
import {
    deriveSeaFreightStatus,
    hasVesselCredentials,
    parseVesselEta,
    resolveVesselFromSearch,
    trackVessel,
} from './vesselTrackingHelpers';

const ctx = {
    env: { VESSEL_API_BASE_URL: 'https://api.vesselapi.com' },
    secrets: { VESSEL_API_KEY: 'key' },
};

const NOW = new Date('2026-08-20T12:00:00Z');

// Serves a different body per URL, so the two-call resolve-then-ETA path can be
// exercised end to end.
function routedFetch(routes: { match: string; status?: number; body: unknown }[]) {
    const calls: string[] = [];
    const impl = (async (url: unknown) => {
        const target = String(url);
        calls.push(target);
        const route = routes.find((r) => target.includes(r.match));
        const status = route?.status ?? (route ? 200 : 404);
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => route?.body ?? {},
            text: async () => JSON.stringify(route?.body ?? {}),
        };
    }) as unknown as typeof fetch;
    return { impl, calls };
}

describe('resolveVesselFromSearch', () => {
    test('an exact name match wins even among partial matches', () => {
        const resolved = resolveVesselFromSearch(
            {
                vessels: [
                    { name: 'EVER GIVEN II', imo: 111, mmsi: 222 },
                    { name: 'EVER GIVEN', imo: 9811000, mmsi: 353136000 },
                ],
            },
            'Ever Given',
        );

        if ('error' in resolved) throw new Error(resolved.error);
        expect(resolved.vessel.imo).toBe('9811000');
        expect(resolved.vessel.mmsi).toBe('353136000');
    });

    test('a single result is accepted even without an exact name match', () => {
        const resolved = resolveVesselFromSearch({ vessels: [{ name: 'MSC AURORA I', imo: 9321483 }] }, 'MSC Aurora');
        if ('error' in resolved) throw new Error(resolved.error);
        expect(resolved.vessel.imo).toBe('9321483');
    });

    test('an ambiguous name is refused rather than silently tracking the wrong ship', () => {
        const resolved = resolveVesselFromSearch(
            {
                vessels: [
                    { name: 'MSC AURORA I', imo: 1 },
                    { name: 'MSC AURORA II', imo: 2 },
                ],
            },
            'MSC Aurora',
        );

        expect('error' in resolved).toBe(true);
        if (!('error' in resolved)) return;
        expect(resolved.error).toMatch(/ambiguous \(2 matches\)/);
    });

    test('several ships sharing one exact name are refused too', () => {
        const resolved = resolveVesselFromSearch(
            {
                vessels: [
                    { name: 'AURORA', imo: 1 },
                    { name: 'AURORA', imo: 2 },
                ],
            },
            'Aurora',
        );

        expect('error' in resolved).toBe(true);
        if (!('error' in resolved)) return;
        expect(resolved.error).toMatch(/matches 2 vessels/);
    });

    test('no results, or results with no usable identifier, are an error', () => {
        expect('error' in resolveVesselFromSearch({ vessels: [] }, 'Nothing')).toBe(true);
        expect('error' in resolveVesselFromSearch({}, 'Nothing')).toBe(true);
        // A vessel with neither IMO nor MMSI cannot be tracked.
        expect('error' in resolveVesselFromSearch({ vessels: [{ name: 'GHOST' }] }, 'Ghost')).toBe(true);
        // 0 and empty strings are not valid identifiers.
        expect('error' in resolveVesselFromSearch({ vessels: [{ name: 'GHOST', imo: 0, mmsi: '' }] }, 'Ghost')).toBe(
            true,
        );
    });

    // Captured verbatim from VesselAPI on 2026-08-20 (trimmed to the fields we
    // read). The live registry keeps retired hulls, so the real "EVER GIVEN"
    // comes back alongside a 1986 namesake marked decommissioned_lost.
    const LIVE_EVER_GIVEN_SEARCH = {
        vessels: [
            {
                imo: 9811000,
                mmsi: 353136000,
                name: 'EVER GIVEN',
                vessel_type: 'Cargo A',
                year_built: 2018,
                operating_status: 'Active',
            },
            {
                imo: 8320901,
                name: 'EVER GIVEN',
                vessel_type: 'Container ship',
                year_built: 1986,
                operating_status: 'decommissioned_lost',
            },
        ],
    };

    test('resolves a real live payload whose name is shared with a scrapped hull', () => {
        // Without the retired filter this reads as "matches 2 vessels" and one of
        // the most recognisable ships afloat becomes untrackable.
        const resolved = resolveVesselFromSearch(LIVE_EVER_GIVEN_SEARCH, 'EVER GIVEN');

        if ('error' in resolved) throw new Error(resolved.error);
        expect(resolved.vessel.imo).toBe('9811000');
        expect(resolved.vessel.mmsi).toBe('353136000');
    });

    test('genuine ambiguity between two *active* ships is still refused', () => {
        const resolved = resolveVesselFromSearch(
            {
                vessels: [
                    { name: 'AURORA', imo: 1, operating_status: 'Active' },
                    { name: 'AURORA', imo: 2, operating_status: 'Active' },
                ],
            },
            'AURORA',
        );

        expect('error' in resolved).toBe(true);
    });

    test('only-retired matches get their own message, not "no vessel found"', () => {
        const resolved = resolveVesselFromSearch(
            { vessels: [{ name: 'OLD BOAT', imo: 8320901, operating_status: 'decommissioned_lost' }] },
            'OLD BOAT',
        );

        expect('error' in resolved).toBe(true);
        if (!('error' in resolved)) return;
        expect(resolved.error).toMatch(/Only decommissioned vessels/);
    });

    test('an unknown or absent operating_status is not treated as retired', () => {
        const resolved = resolveVesselFromSearch({ vessels: [{ name: 'NEW BOAT', imo: 123 }] }, 'NEW BOAT');
        if ('error' in resolved) throw new Error(resolved.error);
        expect(resolved.vessel.imo).toBe('123');
    });

    test('falls back to MMSI when the vessel has no IMO', () => {
        const resolved = resolveVesselFromSearch({ vessels: [{ name: 'BARGE', mmsi: 636019 }] }, 'Barge');
        if ('error' in resolved) throw new Error(resolved.error);
        expect(resolved.vessel.imo).toBeNull();
        expect(resolved.vessel.mmsi).toBe('636019');
    });
});

describe('deriveSeaFreightStatus', () => {
    test('a future ETA means the ship is still sailing', () => {
        expect(deriveSeaFreightStatus(new Date('2026-08-25T00:00:00Z'), NOW)).toBe(DeliveryStatus.InTransit);
    });

    test('a past ETA means the ship should be in port', () => {
        expect(deriveSeaFreightStatus(new Date('2026-08-18T00:00:00Z'), NOW)).toBe(DeliveryStatus.Arrived);
    });

    test('no reported ETA is Unknown, not a guess', () => {
        expect(deriveSeaFreightStatus(null, NOW)).toBe(DeliveryStatus.Unknown);
    });

    test('is stateless, so an intermediate-port arrival is not latched', () => {
        // A vessel bound for Cape Town reports SINGAPORE for the first leg. That
        // ETA passes → Arrived. It then reports the next leg with a future ETA,
        // and the status must go back to InTransit on its own rather than being
        // stuck at Arrived — this is why Arrived does not stop the polling.
        const intermediateEta = new Date('2026-08-18T00:00:00Z');
        expect(deriveSeaFreightStatus(intermediateEta, NOW)).toBe(DeliveryStatus.Arrived);

        const nextLegEta = new Date('2026-09-02T00:00:00Z');
        expect(deriveSeaFreightStatus(nextLegEta, NOW)).toBe(DeliveryStatus.InTransit);
    });
});

describe('parseVesselEta', () => {
    // Field-for-field the live VesselAPI /eta payload for IMO 9811000, captured
    // 2026-08-20 (only the ETA date is brought forward so the fixture stays in
    // the future relative to NOW). Numeric imo/mmsi and the "GB FLX" style of
    // free-text destination are exactly what the API returns.
    const payload = {
        vesselEta: {
            destination: 'CAPE TOWN',
            destination_port: 'ZACPT',
            eta: '2026-08-25T06:00:00Z',
            draught: 14.5,
            imo: 9811000,
            mmsi: 353136000,
            timestamp: '2026-08-20T09:00:00Z',
            vessel_name: 'EVER GIVEN',
        },
    };

    test('parses the live payload shape as returned by the API', () => {
        const live = {
            vesselEta: {
                mmsi: 353136000,
                imo: 9811000,
                vessel_name: 'EVER GIVEN',
                destination: 'GB FLX',
                destination_port: 'GBFLX',
                draught: 15.4,
                eta: '2026-09-09T16:00:00Z',
                timestamp: '2026-08-19T23:35:15Z',
            },
        };

        const result = parseVesselEta(live, NOW);
        if (isFailure(result)) throw new Error(result.error);

        expect(result.status).toBe(DeliveryStatus.InTransit);
        expect(result.estimatedArrival?.toISOString()).toBe('2026-09-09T16:00:00.000Z');
        expect(result.destination).toBe('GB FLX');
        expect(result.vesselImo).toBe('9811000');
        expect(result.vesselMmsi).toBe('353136000');
        expect(result.events).toHaveLength(1);
        expect(result.events[0].occurredAt.toISOString()).toBe('2026-08-19T23:35:15.000Z');
    });

    test('reads ETA, destination and the resolved identifiers', () => {
        const result = parseVesselEta(payload, NOW);
        if (isFailure(result)) throw new Error(result.error);

        expect(result.status).toBe(DeliveryStatus.InTransit);
        expect(result.estimatedArrival?.toISOString()).toBe('2026-08-25T06:00:00.000Z');
        expect(result.destination).toBe('CAPE TOWN');
        expect(result.statusDescription).toBe('Reported destination CAPE TOWN');
        expect(result.vesselImo).toBe('9811000');
        expect(result.vesselMmsi).toBe('353136000');
    });

    test('never infers delivery — arrival of the ship is not delivery of the goods', () => {
        const arrived = parseVesselEta(
            { vesselEta: { ...payload.vesselEta, eta: '2026-08-18T06:00:00Z' } },
            NOW,
        );
        if (isFailure(arrived)) throw new Error(arrived.error);
        expect(arrived.status).toBe(DeliveryStatus.Arrived);
        expect(arrived.deliveredAt).toBeNull();
    });

    test('one AIS report becomes one event, keyed on the report time', () => {
        const result = parseVesselEta(payload, NOW);
        if (isFailure(result)) throw new Error(result.error);

        expect(result.events).toHaveLength(1);
        expect(result.events[0].occurredAt.toISOString()).toBe('2026-08-20T09:00:00.000Z');
        expect(result.events[0].description).toContain('CAPE TOWN');
        expect(result.events[0].status).toBe(DeliveryStatus.InTransit);
    });

    test('falls back to the port code when the crew reported no destination text', () => {
        const result = parseVesselEta(
            { vesselEta: { ...payload.vesselEta, destination: '  ' } },
            NOW,
        );
        if (isFailure(result)) throw new Error(result.error);
        expect(result.destination).toBe('ZACPT');
    });

    test('no report timestamp means no event rather than an invalid one', () => {
        const result = parseVesselEta({ vesselEta: { ...payload.vesselEta, timestamp: null } }, NOW);
        if (isFailure(result)) throw new Error(result.error);
        expect(result.events).toEqual([]);
    });

    test('a payload with no ETA block is a failure', () => {
        expect(isFailure(parseVesselEta({}, NOW))).toBe(true);
    });

    test('a vessel reporting no ETA is Unknown but still a snapshot', () => {
        const result = parseVesselEta({ vesselEta: { destination: 'CAPE TOWN', eta: null } }, NOW);
        if (isFailure(result)) throw new Error(result.error);
        expect(result.status).toBe(DeliveryStatus.Unknown);
        expect(result.estimatedArrival).toBeNull();
    });
});

describe('trackVessel', () => {
    const etaBody = {
        vesselEta: {
            destination: 'CAPE TOWN',
            eta: '2026-08-25T06:00:00Z',
            imo: 9811000,
            timestamp: '2026-08-20T09:00:00Z',
        },
    };

    test('resolves the name on first use, then reads the ETA', async () => {
        const { impl, calls } = routedFetch([
            { match: '/v1/search/vessels', body: { vessels: [{ name: 'EVER GIVEN', imo: 9811000 }] } },
            { match: '/eta', body: etaBody },
        ]);

        const result = await trackVessel(
            ctx,
            { vesselName: 'EVER GIVEN', vesselImo: null, vesselMmsi: null },
            NOW,
            impl,
        );

        expect(calls[0]).toContain('filter.name=EVER%20GIVEN');
        expect(calls[1]).toContain('/v1/vessel/9811000/eta?filter.idType=imo');
        if (isFailure(result)) throw new Error(result.error);
        expect(result.vesselImo).toBe('9811000');
    });

    test('skips the name search entirely once the IMO is cached', async () => {
        const { impl, calls } = routedFetch([{ match: '/eta', body: etaBody }]);

        const result = await trackVessel(
            ctx,
            { vesselName: 'EVER GIVEN', vesselImo: '9811000', vesselMmsi: null },
            NOW,
            impl,
        );

        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain('/v1/vessel/9811000/eta');
        expect(isFailure(result)).toBe(false);
    });

    test('uses MMSI when that is the only cached identifier', async () => {
        const { impl, calls } = routedFetch([{ match: '/eta', body: { vesselEta: { eta: null } } }]);

        await trackVessel(ctx, { vesselName: 'BARGE', vesselImo: null, vesselMmsi: '636019' }, NOW, impl);

        expect(calls[0]).toContain('/v1/vessel/636019/eta?filter.idType=mmsi');
    });

    test('persists the resolved id even when the ETA payload omits it', async () => {
        const { impl } = routedFetch([
            { match: '/v1/search/vessels', body: { vessels: [{ name: 'BARGE', mmsi: 636019 }] } },
            { match: '/eta', body: { vesselEta: { eta: '2026-08-25T06:00:00Z' } } },
        ]);

        const result = await trackVessel(ctx, { vesselName: 'BARGE', vesselImo: null, vesselMmsi: null }, NOW, impl);

        if (isFailure(result)) throw new Error(result.error);
        // Otherwise the next poll would repeat the name search every time.
        expect(result.vesselMmsi).toBe('636019');
    });

    test('an ambiguous name fails without calling the ETA endpoint', async () => {
        const { impl, calls } = routedFetch([
            {
                match: '/v1/search/vessels',
                body: {
                    vessels: [
                        { name: 'AURORA I', imo: 1 },
                        { name: 'AURORA II', imo: 2 },
                    ],
                },
            },
        ]);

        const result = await trackVessel(ctx, { vesselName: 'AURORA', vesselImo: null, vesselMmsi: null }, NOW, impl);

        expect(isFailure(result)).toBe(true);
        expect(calls).toHaveLength(1);
    });

    test('a delivery with nothing to track is a clear failure', async () => {
        const { impl, calls } = routedFetch([]);

        const result = await trackVessel(ctx, { vesselName: null, vesselImo: null, vesselMmsi: null }, NOW, impl);

        expect(isFailure(result)).toBe(true);
        if (!isFailure(result)) return;
        expect(result.error).toMatch(/no vessel name or IMO/);
        expect(calls).toHaveLength(0);
    });

    test('a search HTTP error is reported as a failure', async () => {
        const { impl } = routedFetch([{ match: '/v1/search/vessels', status: 401, body: 'unauthorized' }]);

        const result = await trackVessel(ctx, { vesselName: 'EVER GIVEN', vesselImo: null, vesselMmsi: null }, NOW, impl);

        expect(isFailure(result)).toBe(true);
        if (!isFailure(result)) return;
        expect(result.error).toContain('VesselAPI search: 401');
    });
});

describe('hasVesselCredentials', () => {
    test('needs a non-empty key', () => {
        expect(hasVesselCredentials(ctx)).toBe(true);
        expect(hasVesselCredentials({ ...ctx, secrets: { VESSEL_API_KEY: '' } })).toBe(false);
    });
});
