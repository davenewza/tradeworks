import { models, resetDatabase } from '@teamkeel/testing';
import { DeliveryMode, DeliveryStatus } from '@teamkeel/sdk';
import { beforeEach, describe, expect, test } from 'vitest';
import {
    BASE_REFRESH_INTERVAL_MS,
    SEA_REFRESH_INTERVAL_MS,
    TrackingEvent,
    dueForRefresh,
    eventKey,
    isFailure,
    isTerminal,
    latestEvent,
    newEvents,
    parseTimestamp,
    refreshIntervalMs,
    stalestFirst,
} from './deliveryTrackingHelpers';

const NOW = new Date('2026-08-20T12:00:00Z');
const HOUR = 60 * 60 * 1000;

function event(iso: string, description: string, location: string | null = null): TrackingEvent {
    return { occurredAt: new Date(iso), description, location, status: null };
}

describe('isTerminal', () => {
    test('delivered and cancelled stop being polled', () => {
        expect(isTerminal(DeliveryStatus.Delivered)).toBe(true);
        expect(isTerminal(DeliveryStatus.Cancelled)).toBe(true);
    });

    test('NotFound is not terminal — a fresh booking is often unknown to the carrier', () => {
        expect(isTerminal(DeliveryStatus.NotFound)).toBe(false);
        expect(isTerminal(DeliveryStatus.Exception)).toBe(false);
        expect(isTerminal(DeliveryStatus.Arrived)).toBe(false);
    });
});

describe('refreshIntervalMs', () => {
    const COURIER = DeliveryMode.AirCourier;
    const SEA = DeliveryMode.SeaFreight;

    test('a healthy courier is re-polled every run', () => {
        expect(refreshIntervalMs(0, COURIER)).toBe(BASE_REFRESH_INTERVAL_MS);
        expect(BASE_REFRESH_INTERVAL_MS).toBe(3 * HOUR);
    });

    test('sea freight is once a day — VesselAPI\'s free tier is only 150 calls/month', () => {
        expect(refreshIntervalMs(0, SEA)).toBe(SEA_REFRESH_INTERVAL_MS);
        expect(SEA_REFRESH_INTERVAL_MS).toBe(24 * HOUR);
        // A single sea delivery at the courier cadence would be 8 calls/day —
        // 240/month, over the whole allowance on its own.
        expect((24 / 3) * 30).toBeGreaterThan(150);
        // At a daily interval it is 30/month, so ~5 fit the free tier.
        expect(30 * 5).toBe(150);
    });

    test('courier failures double the wait, 3h → 6h → 12h → 24h → 48h', () => {
        expect(refreshIntervalMs(1, COURIER)).toBe(6 * HOUR);
        expect(refreshIntervalMs(2, COURIER)).toBe(12 * HOUR);
        expect(refreshIntervalMs(3, COURIER)).toBe(24 * HOUR);
        expect(refreshIntervalMs(4, COURIER)).toBe(48 * HOUR);
    });

    test('sea failures double off the daily base', () => {
        expect(refreshIntervalMs(1, SEA)).toBe(48 * HOUR);
        expect(refreshIntervalMs(4, SEA)).toBe(16 * 24 * HOUR);
    });

    test('the backoff is capped per mode', () => {
        expect(refreshIntervalMs(20, COURIER)).toBe(48 * HOUR);
        expect(refreshIntervalMs(20, SEA)).toBe(16 * 24 * HOUR);
        // Defensive: a negative counter must not shorten the interval.
        expect(refreshIntervalMs(-3, COURIER)).toBe(BASE_REFRESH_INTERVAL_MS);
    });
});

describe('dueForRefresh', () => {
    const open = {
        mode: DeliveryMode.AirCourier,
        status: DeliveryStatus.InTransit,
        isArchived: false,
        consecutiveFailures: 0,
    };

    test('a never-checked delivery is due immediately', () => {
        expect(dueForRefresh({ ...open, lastCheckedAt: null }, NOW)).toBe(true);
    });

    test('archived and terminal deliveries are never due', () => {
        expect(dueForRefresh({ ...open, isArchived: true, lastCheckedAt: null }, NOW)).toBe(false);
        expect(
            dueForRefresh({ ...open, status: DeliveryStatus.Delivered, lastCheckedAt: null }, NOW),
        ).toBe(false);
        expect(
            dueForRefresh({ ...open, status: DeliveryStatus.Cancelled, lastCheckedAt: null }, NOW),
        ).toBe(false);
    });

    test('respects the interval since the last check', () => {
        const justChecked = new Date(NOW.getTime() - 1 * HOUR);
        const staleCheck = new Date(NOW.getTime() - 4 * HOUR);
        expect(dueForRefresh({ ...open, lastCheckedAt: justChecked }, NOW)).toBe(false);
        expect(dueForRefresh({ ...open, lastCheckedAt: staleCheck }, NOW)).toBe(true);
    });

    test('a failing delivery waits out its backoff', () => {
        const fourHoursAgo = new Date(NOW.getTime() - 4 * HOUR);
        // Healthy at 4h: due. Two failures means a 12h wait, so not yet.
        expect(dueForRefresh({ ...open, lastCheckedAt: fourHoursAgo, consecutiveFailures: 0 }, NOW)).toBe(true);
        expect(dueForRefresh({ ...open, lastCheckedAt: fourHoursAgo, consecutiveFailures: 2 }, NOW)).toBe(false);

        const thirteenHoursAgo = new Date(NOW.getTime() - 13 * HOUR);
        expect(dueForRefresh({ ...open, lastCheckedAt: thirteenHoursAgo, consecutiveFailures: 2 }, NOW)).toBe(true);
    });

    test('a NotFound delivery keeps being retried', () => {
        expect(
            dueForRefresh(
                {
                    mode: DeliveryMode.AirCourier,
                    status: DeliveryStatus.NotFound,
                    isArchived: false,
                    consecutiveFailures: 0,
                    lastCheckedAt: null,
                },
                NOW,
            ),
        ).toBe(true);
    });
});

describe('stalestFirst', () => {
    const at = (iso: string | null) => ({ lastCheckedAt: iso ? new Date(iso) : null });

    test('never-checked deliveries come first, then oldest check first', () => {
        const ordered = stalestFirst([
            at('2026-08-20T11:00:00Z'),
            at(null),
            at('2026-08-19T11:00:00Z'),
            at(null),
        ]);

        expect(ordered.map((d) => d.lastCheckedAt?.toISOString() ?? 'never')).toEqual([
            'never',
            'never',
            '2026-08-19T11:00:00.000Z',
            '2026-08-20T11:00:00.000Z',
        ]);
    });

    test('this is what stops the per-run caps starving the same tail every run', () => {
        // 3 deliveries, a cap of 2: the two stalest are served, the freshest waits.
        const deliveries = [
            { id: 'fresh', lastCheckedAt: new Date('2026-08-20T11:00:00Z') },
            { id: 'stale', lastCheckedAt: new Date('2026-08-19T11:00:00Z') },
            { id: 'never', lastCheckedAt: null },
        ];

        expect(stalestFirst(deliveries).slice(0, 2).map((d) => d.id)).toEqual(['never', 'stale']);
    });

    test('does not mutate the input', () => {
        const input = [at('2026-08-20T11:00:00Z'), at(null)];
        const before = [...input];
        stalestFirst(input);
        expect(input).toEqual(before);
    });

    test('handles empty and single-item lists', () => {
        expect(stalestFirst([])).toEqual([]);
        expect(stalestFirst([at(null)])).toHaveLength(1);
    });
});

describe('eventKey', () => {
    test('is stable across cosmetic differences in the carrier\'s wording', () => {
        const a = event('2026-08-19T08:00:00Z', 'Arrived at FedEx location');
        const b = event('2026-08-19T08:00:00Z', '  ARRIVED  at   FedEx location ');
        expect(eventKey(a)).toBe(eventKey(b));
    });

    test('distinguishes different times and different descriptions', () => {
        expect(eventKey(event('2026-08-19T08:00:00Z', 'Departed'))).not.toBe(
            eventKey(event('2026-08-19T09:00:00Z', 'Departed')),
        );
        expect(eventKey(event('2026-08-19T08:00:00Z', 'Departed'))).not.toBe(
            eventKey(event('2026-08-19T08:00:00Z', 'Arrived')),
        );
    });

    test('is capped so the unique index stays narrow', () => {
        const key = eventKey(event('2026-08-19T08:00:00Z', 'x'.repeat(500)));
        expect(key.length).toBeLessThanOrEqual(200);
    });
});

describe('newEvents', () => {
    test('drops events already stored and returns the rest oldest-first', () => {
        const stored = event('2026-08-18T08:00:00Z', 'Picked up');
        const events = [
            event('2026-08-19T10:00:00Z', 'Out for delivery'),
            stored,
            event('2026-08-19T06:00:00Z', 'In transit'),
        ];

        const fresh = newEvents(events, new Set([eventKey(stored)]));

        expect(fresh.map((f) => f.event.description)).toEqual(['In transit', 'Out for delivery']);
    });

    test('collapses duplicates within one payload (FedEx repeats scans per piece)', () => {
        const repeated = event('2026-08-19T06:00:00Z', 'In transit');
        const fresh = newEvents([repeated, repeated, repeated], new Set());
        expect(fresh).toHaveLength(1);
    });

    test('a second poll of an unchanged history adds nothing', () => {
        const events = [event('2026-08-19T06:00:00Z', 'In transit'), event('2026-08-19T10:00:00Z', 'Delivered')];
        const known = new Set(newEvents(events, new Set()).map((f) => f.key));
        expect(newEvents(events, known)).toEqual([]);
    });
});

describe('parseTimestamp', () => {
    test('parses ISO timestamps, with and without a zone', () => {
        expect(parseTimestamp('2026-08-19T08:00:00Z')?.toISOString()).toBe('2026-08-19T08:00:00.000Z');
        // DHL omits the offset on some services — still parseable, not rejected.
        expect(parseTimestamp('2019-08-30T08:59:00')).toBeInstanceOf(Date);
    });

    test('returns null rather than an Invalid Date for missing or junk values', () => {
        expect(parseTimestamp(undefined)).toBeNull();
        expect(parseTimestamp(null)).toBeNull();
        expect(parseTimestamp('')).toBeNull();
        expect(parseTimestamp('   ')).toBeNull();
        expect(parseTimestamp('not a date')).toBeNull();
        expect(parseTimestamp(12345)).toBeNull();
    });
});

describe('latestEvent', () => {
    test('finds the most recent event regardless of input order', () => {
        const events = [
            event('2026-08-19T06:00:00Z', 'In transit'),
            event('2026-08-19T10:00:00Z', 'Delivered', 'Cape Town'),
            event('2026-08-19T08:00:00Z', 'Out for delivery'),
        ];
        expect(latestEvent(events)?.description).toBe('Delivered');
        expect(latestEvent(events)?.location).toBe('Cape Town');
    });

    test('is null for an empty history', () => {
        expect(latestEvent([])).toBeNull();
    });
});

describe('isFailure', () => {
    test('separates failures from snapshots', () => {
        expect(isFailure({ error: 'boom' })).toBe(true);
        expect(
            isFailure({
                status: DeliveryStatus.InTransit,
                statusDescription: null,
                estimatedArrival: null,
                deliveredAt: null,
                destination: null,
                events: [],
            }),
        ).toBe(false);
    });
});

// ─── Live-DB behaviour ──────────────────────────────────────────────────────

describe('event storage', () => {
    beforeEach(resetDatabase);

    test('the (delivery, eventKey) unique constraint stops a re-poll duplicating events', async () => {
        const delivery = await models.supplierDelivery.create({
            mode: DeliveryMode.SeaFreight,
            vesselName: 'EVER GIVEN',
        });

        const scan = event('2026-08-19T08:00:00Z', 'Arrived at port');
        const key = eventKey(scan);

        await models.deliveryEvent.create({
            deliveryId: delivery.id,
            occurredAt: scan.occurredAt,
            description: scan.description,
            location: null,
            eventKey: key,
        });

        await expect(
            models.deliveryEvent.create({
                deliveryId: delivery.id,
                occurredAt: scan.occurredAt,
                description: scan.description,
                location: null,
                eventKey: key,
            }),
        ).rejects.toThrow();

        // The same scan against a *different* delivery is a separate event.
        const other = await models.supplierDelivery.create({
            mode: DeliveryMode.SeaFreight,
            vesselName: 'EVER GIVEN',
        });
        await models.deliveryEvent.create({
            deliveryId: other.id,
            occurredAt: scan.occurredAt,
            description: scan.description,
            location: null,
            eventKey: key,
        });

        expect(await models.deliveryEvent.findMany({})).toHaveLength(2);
    });

    test('newEvents against stored keys is what makes a re-poll idempotent', async () => {
        const delivery = await models.supplierDelivery.create({
            mode: DeliveryMode.SeaFreight,
            vesselName: 'MSC AURORA',
        });

        const history = [
            event('2026-08-18T06:00:00Z', 'Departed Shanghai'),
            event('2026-08-19T06:00:00Z', 'At sea'),
        ];

        for (const { event: e, key } of newEvents(history, new Set())) {
            await models.deliveryEvent.create({
                deliveryId: delivery.id,
                occurredAt: e.occurredAt,
                description: e.description,
                location: e.location,
                eventKey: key,
            });
        }

        // Second poll: same two events plus one new one.
        const stored = await models.deliveryEvent.findMany({ where: { delivery: { id: delivery.id } } });
        const fresh = newEvents(
            [...history, event('2026-08-20T06:00:00Z', 'Arrived Cape Town')],
            new Set(stored.map((s) => s.eventKey)),
        );

        expect(fresh).toHaveLength(1);
        expect(fresh[0].event.description).toBe('Arrived Cape Town');
    });

    test('a new delivery starts Pending and unchecked, so it is due at once', async () => {
        const delivery = await models.supplierDelivery.create({
            mode: DeliveryMode.SeaFreight,
            vesselName: 'EVER GIVEN',
        });

        expect(delivery.status).toBe(DeliveryStatus.Pending);
        expect(delivery.lastCheckedAt).toBeNull();
        expect(delivery.consecutiveFailures).toBe(0);
        expect(delivery.isArchived).toBe(false);
        expect(
            dueForRefresh(
                {
                    mode: delivery.mode,
                    status: delivery.status,
                    isArchived: delivery.isArchived,
                    lastCheckedAt: delivery.lastCheckedAt,
                    consecutiveFailures: delivery.consecutiveFailures,
                },
                NOW,
            ),
        ).toBe(true);
    });

    test('totalEvents counts the delivery\'s stored events', async () => {
        const delivery = await models.supplierDelivery.create({
            mode: DeliveryMode.SeaFreight,
            vesselName: 'MSC AURORA',
        });

        for (const e of [event('2026-08-18T06:00:00Z', 'A'), event('2026-08-19T06:00:00Z', 'B')]) {
            await models.deliveryEvent.create({
                deliveryId: delivery.id,
                occurredAt: e.occurredAt,
                description: e.description,
                location: null,
                eventKey: eventKey(e),
            });
        }

        const reloaded = await models.supplierDelivery.findOne({ id: delivery.id });
        expect(Number(reloaded!.totalEvents)).toBe(2);
    });
});
