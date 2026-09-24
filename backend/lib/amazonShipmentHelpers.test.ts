import { ChannelShipmentStatus } from '@teamkeel/sdk';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
    AmazonShipment,
    AmazonShipmentItem,
    InboundPlanSummary,
    LOOKBACK_DAYS,
    amazonDestination,
    amazonStatus,
    amazonTracking,
    fetchAmazonShipments,
    fetchInboundPlans,
    fetchShipmentItems,
    toExternalItems,
    toExternalShipment,
} from './amazonShipmentHelpers';
import { AmazonCtx } from './amazonApi';

afterEach(() => vi.unstubAllGlobals());

// ─── Fixtures ───────────────────────────────────────────────────────────────

const MARKETPLACE = 'AE08WJ6YKNBMC';

const ctx: AmazonCtx = {
    env: {
        AMAZON_SP_API_BASE_URL: 'https://spapi.test',
        AMAZON_LWA_TOKEN_URL: 'https://lwa.test/auth/o2/token',
        AMAZON_MARKETPLACE_ID: MARKETPLACE,
        AMAZON_LWA_CLIENT_ID: 'amzn1.application-oa2-client.test',
    },
    secrets: {
        AMAZON_LWA_CLIENT_SECRET: 'shh',
        AMAZON_LWA_REFRESH_TOKEN: 'Atzr|refresh',
    },
};

// Retries and page pacing wait through this; tests make it instant.
const noWait = { sleep: async () => {} };

const TOKEN_OK = { status: 200, body: { access_token: 'Atza|access', expires_in: 3600 } };

const ACCESS_TOKEN = 'Atza|access';

// Somewhere comfortably inside the lookback window, and somewhere outside it.
const recently = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
const longAgo = new Date(Date.now() - (LOOKBACK_DAYS + 30) * 24 * 60 * 60 * 1000).toISOString();

function planSummary(overrides: Partial<InboundPlanSummary> = {}): InboundPlanSummary {
    return {
        inboundPlanId: 'wf1234abcd-1234-abcd-5678-1234abcd5678',
        name: 'FBA (09/01/2026, 12:01 PM)',
        status: 'ACTIVE',
        createdAt: '2026-09-01T12:01:00Z',
        lastUpdatedAt: recently,
        marketplaceIds: [MARKETPLACE],
        ...overrides,
    };
}

function shipment(overrides: Partial<AmazonShipment> = {}): AmazonShipment {
    return {
        shipmentId: 'sh1234abcd-1234-abcd-5678-1234abcd5678',
        shipmentConfirmationId: 'FBA1234ABCD',
        name: 'Shipment 1',
        status: 'READY_TO_SHIP',
        destination: { destinationType: 'AMAZON_WAREHOUSE', warehouseId: 'TTT1' },
        selectedDeliveryWindow: { startDate: '2026-09-20T08:00:00Z' },
        dates: { readyToShipWindow: { start: '2026-09-12T08:00:00Z' } },
        ...overrides,
    };
}

function item(overrides: Partial<AmazonShipmentItem> = {}): AmazonShipmentItem {
    return {
        msku: 'ACME-001',
        fnsku: 'X001ACME01',
        asin: 'B07ABCDEFG',
        quantity: 30,
        labelOwner: 'SELLER',
        ...overrides,
    };
}

// Stub global fetch, routing each request through a handler that sees the URL.
type Stubbed = { status: number; body?: unknown; text?: string };
function stubFetch(handler: (url: string, init: RequestInit | undefined, call: number) => Stubbed) {
    let calls = 0;
    const impl = vi.fn(async (input: unknown, init?: RequestInit) => {
        const { status, body, text } = handler(String(input), init, calls++);
        return new Response(text ?? JSON.stringify(body ?? {}), { status });
    });
    vi.stubGlobal('fetch', impl);
    return impl;
}

// A whole Amazon API, answering every call one fetchAmazonShipments run makes.
function stubApi(options: {
    plans?: InboundPlanSummary[];
    shipmentsByPlan?: Record<string, { shipmentId: string; status?: string }[]>;
    shipments?: Record<string, AmazonShipment>;
    items?: Record<string, AmazonShipmentItem[]>;
    planOverrides?: Record<string, Partial<InboundPlanSummary>>;
}) {
    return stubFetch((url) => {
        if (url.includes('/auth/o2/token')) return TOKEN_OK;

        const items = /\/shipments\/([^/?]+)\/items/.exec(url);
        if (items) return { status: 200, body: { items: options.items?.[items[1]] ?? [] } };

        const one = /\/inboundPlans\/([^/?]+)\/shipments\/([^/?]+)$/.exec(url);
        if (one) return { status: 200, body: options.shipments?.[one[2]] ?? shipment({ shipmentId: one[2] }) };

        const plan = /\/inboundPlans\/([^/?]+)$/.exec(url);
        if (plan) {
            const id = plan[1];
            const summary = (options.plans ?? []).find((p) => p.inboundPlanId === id);
            return {
                status: 200,
                body: {
                    ...(summary ?? { inboundPlanId: id }),
                    ...(options.planOverrides?.[id] ?? {}),
                    shipments: options.shipmentsByPlan?.[id] ?? [],
                },
            };
        }

        return { status: 200, body: { inboundPlans: options.plans ?? [] } };
    });
}

// ─── fetchInboundPlans ──────────────────────────────────────────────────────

describe('fetchInboundPlans', () => {
    test('asks for active plans newest-updated first, and sends the access token', async () => {
        const impl = stubFetch(() => ({ status: 200, body: { inboundPlans: [planSummary()] } }));

        const plans = await fetchInboundPlans(ctx, ACCESS_TOKEN, {}, noWait);

        expect(plans).toHaveLength(1);
        const url = String(impl.mock.calls[0][0]);
        expect(url).toContain('/inbound/fba/2024-03-20/inboundPlans');
        expect(url).toContain('status=ACTIVE');
        expect(url).toContain('sortBy=LAST_UPDATED_TIME');
        expect(url).toContain('sortOrder=DESC');
        const headers = (impl.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
        expect(headers['x-amz-access-token']).toBe(ACCESS_TOKEN);
    });

    test('walks every page', async () => {
        const impl = stubFetch((_url, _init, call) =>
            call === 0
                ? {
                      status: 200,
                      body: {
                          inboundPlans: [planSummary({ inboundPlanId: 'wf-1' })],
                          pagination: { nextToken: 'page-2' },
                      },
                  }
                : { status: 200, body: { inboundPlans: [planSummary({ inboundPlanId: 'wf-2' })] } }
        );

        const plans = await fetchInboundPlans(ctx, ACCESS_TOKEN, {}, noWait);

        expect(plans.map((p) => p.inboundPlanId)).toEqual(['wf-1', 'wf-2']);
        expect(String(impl.mock.calls[1][0])).toContain('paginationToken=page-2');
    });

    test('drops plans belonging to another marketplace on the same account', async () => {
        stubFetch(() => ({
            status: 200,
            body: {
                inboundPlans: [
                    planSummary({ inboundPlanId: 'wf-ours' }),
                    planSummary({ inboundPlanId: 'wf-theirs', marketplaceIds: ['A1PA6795UKMFR9'] }),
                ],
            },
        }));

        const plans = await fetchInboundPlans(ctx, ACCESS_TOKEN, {}, noWait);

        // The listing has no marketplace filter, so a seller listing in several
        // countries would otherwise pull consignments from all of them.
        expect(plans.map((p) => p.inboundPlanId)).toEqual(['wf-ours']);
    });

    test('stops at the lookback window and does not ask for another page', async () => {
        const impl = stubFetch(() => ({
            status: 200,
            body: {
                inboundPlans: [
                    planSummary({ inboundPlanId: 'wf-recent' }),
                    planSummary({ inboundPlanId: 'wf-stale', lastUpdatedAt: longAgo }),
                ],
                pagination: { nextToken: 'page-2' },
            },
        }));

        const plans = await fetchInboundPlans(ctx, ACCESS_TOKEN, {}, noWait);

        // Sorted newest-updated first, so the first stale plan means every later
        // one is stale too — an abandoned plan stays ACTIVE on Amazon forever.
        expect(plans.map((p) => p.inboundPlanId)).toEqual(['wf-recent']);
        expect(impl).toHaveBeenCalledTimes(1);
    });

    test('a full history lifts the window and walks the finished statuses too', async () => {
        const impl = stubFetch(() => ({
            status: 200,
            body: { inboundPlans: [planSummary({ lastUpdatedAt: longAgo })] },
        }));

        const plans = await fetchInboundPlans(ctx, ACCESS_TOKEN, { includeShipped: true }, noWait);

        expect(plans).toHaveLength(3);
        const statuses = impl.mock.calls.map((c) => new URL(String(c[0])).searchParams.get('status'));
        expect(statuses).toEqual(['ACTIVE', 'SHIPPED', 'VOIDED']);
    });

    test('keeps a plan whose last-updated stamp cannot be read', async () => {
        stubFetch(() => ({
            status: 200,
            body: { inboundPlans: [planSummary({ lastUpdatedAt: 'not a date' })] },
        }));

        // Dropping it would silently lose a consignment over a date we could
        // not parse.
        expect(await fetchInboundPlans(ctx, ACCESS_TOKEN, {}, noWait)).toHaveLength(1);
    });
});

// ─── fetchShipmentItems ─────────────────────────────────────────────────────

describe('fetchShipmentItems', () => {
    test('walks every page of lines', async () => {
        const impl = stubFetch((_url, _init, call) =>
            call === 0
                ? {
                      status: 200,
                      body: { items: [item()], pagination: { nextToken: 'page-2' } },
                  }
                : { status: 200, body: { items: [item({ msku: 'ACME-002' })] } }
        );

        const items = await fetchShipmentItems(ctx, ACCESS_TOKEN, 'wf-1', 'sh-1', noWait);

        expect(items.map((i) => i.msku)).toEqual(['ACME-001', 'ACME-002']);
        expect(String(impl.mock.calls[1][0])).toContain('paginationToken=page-2');
    });

    test('retries a throttled page rather than giving up on the consignment', async () => {
        const impl = stubFetch((_url, _init, call) =>
            call === 0 ? { status: 429, text: '' } : { status: 200, body: { items: [item()] } }
        );

        const items = await fetchShipmentItems(ctx, ACCESS_TOKEN, 'wf-1', 'sh-1', noWait);

        expect(items).toHaveLength(1);
        expect(impl).toHaveBeenCalledTimes(2);
    });

    test('names the shipment when a call fails for good', async () => {
        stubFetch(() => ({ status: 403, text: 'Access denied' }));

        await expect(fetchShipmentItems(ctx, ACCESS_TOKEN, 'wf-1', 'sh-1', noWait)).rejects.toThrow(
            /items of shipment sh-1: 403 - Access denied/
        );
    });
});

// ─── amazonStatus ───────────────────────────────────────────────────────────

describe('amazonStatus', () => {
    test('maps the states where nothing has gone out yet to Open', () => {
        for (const status of ['UNCONFIRMED', 'WORKING', 'READY_TO_SHIP']) {
            expect(amazonStatus(status)).toBe(ChannelShipmentStatus.Open);
        }
    });

    test('maps the states in motion to Shipped', () => {
        for (const status of ['SHIPPED', 'IN_TRANSIT', 'DELIVERED', 'MIXED']) {
            expect(amazonStatus(status)).toBe(ChannelShipmentStatus.Shipped);
        }
    });

    test('maps only the states where the centre has the stock to Received', () => {
        for (const status of ['CHECKED_IN', 'RECEIVING', 'CLOSED']) {
            expect(amazonStatus(status)).toBe(ChannelShipmentStatus.Received);
        }
    });

    test('DELIVERED is not Received, so the consignment keeps being refreshed', () => {
        // Received is terminal here: treating "the carrier dropped it off" as
        // received would freeze the consignment before the centre checked it in.
        expect(amazonStatus('DELIVERED')).toBe(ChannelShipmentStatus.Shipped);
    });

    test('maps the dead states to Cancelled', () => {
        for (const status of ['CANCELLED', 'ABANDONED', 'DELETED']) {
            expect(amazonStatus(status)).toBe(ChannelShipmentStatus.Cancelled);
        }
    });

    test('an unknown or missing state stays Open rather than quietly retiring', () => {
        expect(amazonStatus('SOMETHING_NEW')).toBe(ChannelShipmentStatus.Open);
        expect(amazonStatus(null)).toBe(ChannelShipmentStatus.Open);
    });
});

// ─── amazonDestination / amazonTracking ─────────────────────────────────────

describe('amazonDestination', () => {
    test('prefers the fulfilment centre code', () => {
        expect(amazonDestination(shipment())).toBe('TTT1');
    });

    test('falls back to the city, and is blank when the placement is not settled', () => {
        expect(
            amazonDestination(
                shipment({ destination: { destinationType: 'AMAZON_WAREHOUSE', address: { city: 'Kempton Park' } } })
            )
        ).toBe('Kempton Park');
        expect(
            amazonDestination(shipment({ destination: { destinationType: 'AMAZON_OPTIMIZED' } }))
        ).toBeNull();
    });
});

describe('amazonTracking', () => {
    test('caps small-parcel tracking ids and says how many boxes there are', () => {
        const spdTrackingItems = Array.from({ length: 7 }, (_, i) => ({ trackingId: `TRK${i}` }));

        const tracking = amazonTracking(shipment({ trackingDetails: { spdTrackingDetail: { spdTrackingItems } } }));

        expect(tracking).toBe('TRK0, TRK1, TRK2, TRK3, TRK4, … (7 boxes)');
    });

    test('reads less-than-truckload paperwork instead', () => {
        const tracking = amazonTracking(
            shipment({
                trackingDetails: {
                    ltlTrackingDetail: { billOfLadingNumber: 'BOL-9', freightBillNumber: ['FB-1', 'FB-2'] },
                },
            })
        );

        expect(tracking).toBe('BOL BOL-9 · Freight bill FB-1, FB-2');
    });

    test('is blank when the consignment has no tracking yet', () => {
        expect(amazonTracking(shipment())).toBeNull();
    });
});

// ─── toExternalItems ────────────────────────────────────────────────────────

describe('toExternalItems', () => {
    test('names the line by our own SKU and carries the FNSKU as its code', () => {
        expect(toExternalItems([item()])).toEqual([
            {
                externalId: 'ACME-001',
                listingRef: 'X001ACME01',
                sku: 'ACME-001',
                quantityRequired: 30,
                quantitySending: 30,
                cancelled: false,
                labelledByChannel: false,
                code: 'X001ACME01',
            },
        ]);
    });

    test('sums the packages of one SKU into a single line', () => {
        const items = toExternalItems([item({ quantity: 30 }), item({ quantity: 12 })]);

        // Amazon returns item packages, so a label run has to add them up — it
        // cares about the units of a SKU going in, not how they are boxed.
        expect(items).toHaveLength(1);
        expect(items[0].quantitySending).toBe(42);
        expect(items[0].quantityRequired).toBe(42);
    });

    test('keeps units of one SKU apart when their expiry or lot code differs', () => {
        const items = toExternalItems([
            item({ expiration: '2027-01-31' }),
            item({ expiration: '2027-06-30' }),
            item({ manufacturingLotCode: 'LOT-9' }),
        ]);

        // Those cannot share a box on Amazon's side, so they are genuinely
        // different lines and each needs its own stable id.
        expect(items.map((i) => i.externalId)).toEqual([
            'ACME-001|2027-01-31',
            'ACME-001|2027-06-30',
            'ACME-001|LOT-9',
        ]);
    });

    test('refuses an FNSKU that is really the ASIN, and keeps the line', () => {
        const items = toExternalItems([item({ fnsku: 'B07ABCDEFG', asin: 'B07ABCDEFG' })]);

        // Amazon reports the FNSKU as the ASIN for a manufacturer-barcode
        // listing; storing that would print a label nobody wants.
        expect(items[0].code).toBeNull();
        expect(items[0].listingRef).toBe('B07ABCDEFG');
        expect(items[0].sku).toBe('ACME-001');
    });

    test('flags a line whose label Amazon applies, or that needs no label at all', () => {
        expect(toExternalItems([item({ labelOwner: 'AMAZON' })])[0].labelledByChannel).toBe(true);
        expect(toExternalItems([item({ labelOwner: 'NONE' })])[0].labelledByChannel).toBe(true);
        expect(toExternalItems([item({ labelOwner: 'SELLER' })])[0].labelledByChannel).toBe(false);
        // Absent means ours, which is the ordinary case.
        expect(toExternalItems([item({ labelOwner: null })])[0].labelledByChannel).toBe(false);
    });

    test('skips a line with no SKU, which nothing could key an upsert on', () => {
        expect(toExternalItems([item({ msku: null }), item()])).toHaveLength(1);
    });
});

// ─── toExternalShipment ─────────────────────────────────────────────────────

describe('toExternalShipment', () => {
    test('normalises a shipment onto the channel-generic shape', () => {
        const external = toExternalShipment(planSummary(), shipment(), [item()]);

        expect(external).toMatchObject({
            externalId: 'sh1234abcd-1234-abcd-5678-1234abcd5678',
            // The plan id, without which Amazon cannot be asked for this
            // shipment again.
            externalGroupId: 'wf1234abcd-1234-abcd-5678-1234abcd5678',
            reference: 'FBA1234ABCD',
            status: ChannelShipmentStatus.Open,
            statusDescription: 'READY_TO_SHIP',
            destination: 'TTT1',
            placedAt: '2026-09-01T12:01:00.000Z',
            dueDate: '2026-09-20',
            // Amazon exposes no unload timestamp and has no archive flag.
            receivedAt: null,
            isArchived: false,
            trackingInfo: null,
        });
        expect(external?.items).toHaveLength(1);
    });

    test('falls back to the shipment name when Amazon has not confirmed an id', () => {
        const external = toExternalShipment(planSummary(), shipment({ shipmentConfirmationId: null }), []);

        expect(external?.reference).toBe('Shipment 1');
    });

    test('falls back to the ship-by date before a delivery window is chosen', () => {
        const external = toExternalShipment(
            planSummary(),
            shipment({ selectedDeliveryWindow: null }),
            []
        );

        expect(external?.dueDate).toBe('2026-09-12');
    });

    test('a voided plan cancels its shipments whatever they each say', () => {
        const external = toExternalShipment(
            planSummary({ status: 'VOIDED' }),
            shipment({ status: 'WORKING' }),
            []
        );

        expect(external?.status).toBe(ChannelShipmentStatus.Cancelled);
    });

    test('skips a shipment with no id to key an upsert on', () => {
        expect(toExternalShipment(planSummary(), shipment({ shipmentId: null }), [])).toBeNull();
        expect(toExternalShipment(planSummary({ inboundPlanId: null }), shipment(), [])).toBeNull();
    });
});

// ─── fetchAmazonShipments ───────────────────────────────────────────────────

describe('fetchAmazonShipments', () => {
    test('walks plans, their shipments and their lines', async () => {
        stubApi({
            plans: [planSummary({ inboundPlanId: 'wf-1' })],
            shipmentsByPlan: { 'wf-1': [{ shipmentId: 'sh-1' }] },
            shipments: { 'sh-1': shipment({ shipmentId: 'sh-1' }) },
            items: { 'sh-1': [item()] },
        });

        const external = await fetchAmazonShipments(ctx, {}, undefined, noWait);

        expect(external).toHaveLength(1);
        expect(external[0].externalId).toBe('sh-1');
        expect(external[0].externalGroupId).toBe('wf-1');
        expect(external[0].items[0].sku).toBe('ACME-001');
    });

    test('skips a plan whose placement has not been confirmed', async () => {
        stubApi({
            plans: [planSummary({ inboundPlanId: 'wf-1' })],
            shipmentsByPlan: { 'wf-1': [] },
        });

        // A plan still being built lists no shipments — there is nothing to
        // label yet, and nothing to record.
        expect(await fetchAmazonShipments(ctx, {}, undefined, noWait)).toEqual([]);
    });

    test('fetches the plan of a tracked consignment the filters would have missed', async () => {
        const impl = stubApi({
            plans: [],
            shipmentsByPlan: { 'wf-tracked': [{ shipmentId: 'sh-tracked' }] },
            shipments: { 'sh-tracked': shipment({ shipmentId: 'sh-tracked', status: 'CLOSED' }) },
            items: { 'sh-tracked': [item()] },
            planOverrides: { 'wf-tracked': { status: 'SHIPPED', createdAt: '2026-06-01T00:00:00Z' } },
        });

        const external = await fetchAmazonShipments(
            ctx,
            { alsoFetch: [{ externalId: 'sh-tracked', externalGroupId: 'wf-tracked' }] },
            undefined,
            noWait
        );

        // Without this, a consignment that shipped since the last sync would
        // stop coming back and sit at its stale status here forever.
        expect(external).toHaveLength(1);
        expect(external[0].status).toBe(ChannelShipmentStatus.Received);
        expect(impl.mock.calls.some((c) => String(c[0]).includes('wf-tracked'))).toBe(true);
    });

    test('does not fetch a tracked plan twice when the listing already returned it', async () => {
        const impl = stubApi({
            plans: [planSummary({ inboundPlanId: 'wf-1' })],
            shipmentsByPlan: { 'wf-1': [{ shipmentId: 'sh-1' }] },
            items: { 'sh-1': [item()] },
        });

        await fetchAmazonShipments(
            ctx,
            { alsoFetch: [{ externalId: 'sh-1', externalGroupId: 'wf-1' }] },
            undefined,
            noWait
        );

        const planCalls = impl.mock.calls.filter((c) => /\/inboundPlans\/wf-1$/.test(String(c[0])));
        expect(planCalls).toHaveLength(1);
    });

    test('ignores a tracked consignment that names no plan', async () => {
        stubApi({ plans: [] });

        // A Takealot-shaped row would have no group id; nothing to ask Amazon.
        expect(
            await fetchAmazonShipments(
                ctx,
                { alsoFetch: [{ externalId: 'sh-1', externalGroupId: null }] },
                undefined,
                noWait
            )
        ).toEqual([]);
    });

    test('exchanges the refresh token before reading anything', async () => {
        const impl = stubApi({ plans: [] });

        await fetchAmazonShipments(ctx, {}, undefined, noWait);

        expect(String(impl.mock.calls[0][0])).toBe('https://lwa.test/auth/o2/token');
        const body = String((impl.mock.calls[0][1] as RequestInit).body);
        expect(body).toContain('grant_type=refresh_token');
    });
});

// ─── A plan that has gone ───────────────────────────────────────────────────

describe('a tracked plan Amazon no longer has', () => {
    test('is skipped rather than wedging every future sync', async () => {
        stubFetch((url) => {
            if (url.includes('/auth/o2/token')) return TOKEN_OK;
            if (/\/inboundPlans\/wf-gone$/.test(url)) return { status: 404, text: 'Not found' };
            return { status: 200, body: { inboundPlans: [] } };
        });

        const external = await fetchAmazonShipments(
            ctx,
            { alsoFetch: [{ externalId: 'sh-gone', externalGroupId: 'wf-gone' }] },
            undefined,
            noWait
        );

        // The stored consignment keeps its row and its history; letting the 404
        // through would break the sync on the same dead plan forever.
        expect(external).toEqual([]);
    });

    test('a plan the listing named is not skipped — that failure is real', async () => {
        stubFetch((url) => {
            if (url.includes('/auth/o2/token')) return TOKEN_OK;
            if (/\/inboundPlans\/wf-1$/.test(url)) return { status: 404, text: 'Not found' };
            return { status: 200, body: { inboundPlans: [planSummary({ inboundPlanId: 'wf-1' })] } };
        });

        await expect(fetchAmazonShipments(ctx, {}, undefined, noWait)).rejects.toThrow(/404/);
    });

    test('an expired credential still stops the sync', async () => {
        stubFetch((url) => {
            if (url.includes('/auth/o2/token')) return TOKEN_OK;
            if (/\/inboundPlans\/wf-gone$/.test(url)) return { status: 403, text: 'Unauthorized' };
            return { status: 200, body: { inboundPlans: [] } };
        });

        await expect(
            fetchAmazonShipments(
                ctx,
                { alsoFetch: [{ externalId: 'sh-gone', externalGroupId: 'wf-gone' }] },
                undefined,
                noWait
            )
        ).rejects.toThrow(/403/);
    });
});
