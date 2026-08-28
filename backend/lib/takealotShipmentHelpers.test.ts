import { ChannelShipmentStatus } from '@teamkeel/sdk';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
    TakealotShipment,
    fetchShipments,
    fetchOfferSkuIndex,
    fetchTakealotShipments,
    takealotStatus,
    toExternalShipments,
} from './takealotShipmentHelpers';
import { TakealotCtx } from './takealotOfferHelpers';

afterEach(() => vi.unstubAllGlobals());

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ctx: TakealotCtx = {
    env: { TAKEALOT_API_BASE_URL: 'https://takealot.test' },
    secrets: { TAKEALOT_API_KEY: 'test-key' },
};

function shipment(overrides: Partial<TakealotShipment> = {}): TakealotShipment {
    return {
        shipment_id: 5001,
        reference: 'JHB-2026-08',
        destination_region: 'JHB',
        shipped: false,
        cancelled: false,
        archived: false,
        due_date: '2026-09-01',
        created_at: '2026-08-20T08:30:00Z',
        purchase_order_state: 'Awaiting delivery',
        shipment_items: [
            {
                shipment_item_id: 91,
                offer_id: 12345,
                cancelled: false,
                quantity_required: 40,
                quantity_sending: 30,
            },
        ],
        ...overrides,
    };
}

// Route request URLs through a handler, mirroring the offer helpers' test stub.
function stubFetch(handler: (url: string) => { status: number; body?: unknown }) {
    const impl = vi.fn(async (input: unknown) => {
        const { status, body } = handler(String(input));
        return new Response(JSON.stringify(body ?? {}), { status });
    });
    vi.stubGlobal('fetch', impl);
    return impl;
}

// ─── fetchShipments ─────────────────────────────────────────────────────────

describe('fetchShipments', () => {
    test('expands the lines and sends the API key', async () => {
        const impl = stubFetch(() => ({ status: 200, body: { items: [shipment()] } }));

        const result = await fetchShipments(ctx);

        expect(result).toHaveLength(1);
        expect(result[0].shipment_items).toHaveLength(1);
        const [url, init] = impl.mock.calls[0] as unknown as [string, RequestInit];
        // Without expands the listing returns headers only, which would mean a
        // request per shipment to find out what is on it.
        expect(url).toContain('expands=shipment_items');
        expect(url).toContain('limit=1000');
        expect((init.headers as Record<string, string>)['X-API-Key']).toBe('test-key');
    });

    test('walks continuation tokens until the listing is exhausted', async () => {
        const pages = [
            { items: [shipment({ shipment_id: 1 })], continuation_token: 'page-2' },
            { items: [shipment({ shipment_id: 2 })], continuation_token: null },
        ];
        let call = 0;
        const impl = stubFetch(() => ({ status: 200, body: pages[call++] }));

        const result = await fetchShipments(ctx);

        expect(result.map((s) => s.shipment_id)).toEqual([1, 2]);
        expect(impl).toHaveBeenCalledTimes(2);
        expect(String(impl.mock.calls[1][0])).toContain('continuation_token=page-2');
    });

    test('asks the API for unshipped consignments only, unless told otherwise', async () => {
        const impl = stubFetch(() => ({ status: 200, body: { items: [shipment()] } }));

        await fetchShipments(ctx);
        // Filtered server-side: Takealot keeps every consignment it has ever had,
        // and only the ones still to go out need labelling.
        expect(String(impl.mock.calls[0][0])).toContain('shipped=false');

        await fetchShipments(ctx, { includeShipped: true });
        expect(String(impl.mock.calls[1][0])).not.toContain('shipped=false');
    });

    test('refreshes tracked ids the unshipped filter would have excluded', async () => {
        const impl = stubFetch((url) =>
            url.includes('shipment_id__in')
                ? { status: 200, body: { items: [shipment({ shipment_id: 77, shipped: true })] } }
                : { status: 200, body: { items: [shipment({ shipment_id: 1 })] } }
        );

        const result = await fetchShipments(ctx, { alsoFetchIds: ['77'] });

        // Without this a consignment that shipped since the last sync would stop
        // coming back and sit at its stale status here forever.
        expect(result.map((s) => s.shipment_id).sort()).toEqual([1, 77]);
        expect(String(impl.mock.calls[1][0])).toContain('shipment_id__in=77');
    });

    test('does not re-fetch a tracked id the listing already returned', async () => {
        const impl = stubFetch(() => ({ status: 200, body: { items: [shipment({ shipment_id: 5 })] } }));

        const result = await fetchShipments(ctx, { alsoFetchIds: ['5'] });

        expect(result).toHaveLength(1);
        expect(impl).toHaveBeenCalledTimes(1);
    });

    test('drops archived shipments by default and keeps them when asked', async () => {
        const body = {
            items: [shipment({ shipment_id: 1 }), shipment({ shipment_id: 2, archived: true })],
        };
        stubFetch(() => ({ status: 200, body }));

        expect((await fetchShipments(ctx)).map((s) => s.shipment_id)).toEqual([1]);
        expect(
            (await fetchShipments(ctx, { includeArchived: true })).map((s) => s.shipment_id)
        ).toEqual([1, 2]);
    });

    test('throws with the response body when the API rejects the call', async () => {
        stubFetch(() => ({ status: 401, body: { message: 'bad key' } }));

        await expect(fetchShipments(ctx)).rejects.toThrow(/Failed to fetch Takealot shipments: 401/);
    });
});

// ─── fetchOfferSkuIndex ─────────────────────────────────────────────────────

describe('fetchOfferSkuIndex', () => {
    test('indexes offer ids to SKUs, asking only for the two fields it needs', async () => {
        const impl = stubFetch(() => ({
            status: 200,
            body: { items: [{ offer_id: 12345, sku: 'ACME-001' }, { offer_id: 6, sku: ' B-2 ' }] },
        }));

        const index = await fetchOfferSkuIndex(ctx);

        expect(index.get('12345')).toBe('ACME-001');
        // Trimmed, so a padded SKU still matches the catalogue.
        expect(index.get('6')).toBe('B-2');
        const url = String(impl.mock.calls[0][0]);
        expect(url).toContain('fields=offer_id');
        expect(url).toContain('fields=sku');
    });

    test('skips entries missing either half of the mapping', async () => {
        stubFetch(() => ({
            status: 200,
            body: {
                items: [
                    { offer_id: 1, sku: null },
                    { offer_id: null, sku: 'ORPHAN' },
                    { offer_id: 2, sku: 'GOOD' },
                ],
            },
        }));

        const index = await fetchOfferSkuIndex(ctx);

        expect([...index.entries()]).toEqual([['2', 'GOOD']]);
    });
});

// ─── takealotStatus ─────────────────────────────────────────────────────────

describe('takealotStatus', () => {
    test('an untouched consignment is Open', () => {
        expect(takealotStatus(shipment())).toBe(ChannelShipmentStatus.Open);
    });

    test('shipped without an unload date is Shipped', () => {
        expect(takealotStatus(shipment({ shipped: true }))).toBe(ChannelShipmentStatus.Shipped);
    });

    test('an unload date wins over the shipped flag', () => {
        // Takealot leaves `shipped` true once the FC unloads, so the more
        // advanced state has to be checked first.
        const received = shipment({ shipped: true, date_unloaded: '2026-08-25T11:00:00Z' });
        expect(takealotStatus(received)).toBe(ChannelShipmentStatus.Received);
    });

    test('cancelled wins over everything', () => {
        const cancelled = shipment({
            cancelled: true,
            shipped: true,
            date_unloaded: '2026-08-25T11:00:00Z',
        });
        expect(takealotStatus(cancelled)).toBe(ChannelShipmentStatus.Cancelled);
    });
});

// ─── toExternalShipments ────────────────────────────────────────────────────

describe('toExternalShipments', () => {
    const index = new Map([['12345', 'ACME-001']]);

    test('normalises a shipment and resolves its lines to SKUs', () => {
        const [external] = toExternalShipments([shipment()], index);

        expect(external).toEqual({
            externalId: '5001',
            reference: 'JHB-2026-08',
            status: ChannelShipmentStatus.Open,
            statusDescription: 'Awaiting delivery',
            destination: 'JHB',
            placedAt: '2026-08-20T08:30:00.000Z',
            dueDate: '2026-09-01',
            receivedAt: null,
            trackingInfo: null,
            isArchived: false,
            items: [
                {
                    externalId: '91',
                    listingRef: '12345',
                    sku: 'ACME-001',
                    quantityRequired: 40,
                    quantitySending: 30,
                    cancelled: false,
                },
            ],
        });
    });

    test('keeps a line whose offer is not in the index, with a null SKU', () => {
        const orphan = shipment({
            shipment_items: [
                { shipment_item_id: 92, offer_id: 999, quantity_required: 5, quantity_sending: 5 },
            ],
        });

        const [external] = toExternalShipments([orphan], index);

        // Dropping it would silently remove units from the consignment; the
        // listing ref is kept so it can be traced in the seller portal.
        expect(external.items).toEqual([
            {
                externalId: '92',
                listingRef: '999',
                sku: null,
                quantityRequired: 5,
                quantitySending: 5,
                cancelled: false,
            },
        ]);
    });

    test('skips shipments and lines with no id to key an upsert on', () => {
        const noIds = [
            shipment({ shipment_id: null }),
            shipment({
                shipment_id: 7,
                shipment_items: [
                    { shipment_item_id: null, offer_id: 12345 },
                    { shipment_item_id: 93, offer_id: 12345, quantity_sending: 2 },
                ],
            }),
        ];

        const external = toExternalShipments(noIds, index);

        expect(external.map((s) => s.externalId)).toEqual(['7']);
        expect(external[0].items.map((i) => i.externalId)).toEqual(['93']);
    });

    test('missing quantities become zero and blank strings become null', () => {
        const sparse = shipment({
            reference: '   ',
            purchase_order_state: null,
            destination_region: null,
            due_date: null,
            created_at: 'not a date',
            shipment_items: [{ shipment_item_id: 94, offer_id: 12345 }],
        });

        const [external] = toExternalShipments([sparse], index);

        expect(external.reference).toBeNull();
        expect(external.statusDescription).toBeNull();
        expect(external.destination).toBeNull();
        expect(external.dueDate).toBeNull();
        // An unparseable date is null rather than an Invalid Date that would
        // only blow up at write time.
        expect(external.placedAt).toBeNull();
        expect(external.items[0]).toMatchObject({ quantityRequired: 0, quantitySending: 0 });
    });
});

// ─── fetchTakealotShipments ─────────────────────────────────────────────────

describe('fetchTakealotShipments', () => {
    test('fetches the offer index and applies it to the lines', async () => {
        const impl = stubFetch((url) =>
            url.includes('/v1/offers')
                ? { status: 200, body: { items: [{ offer_id: 12345, sku: 'ACME-001' }] } }
                : { status: 200, body: { items: [shipment()] } }
        );

        const external = await fetchTakealotShipments(ctx);

        expect(external[0].items[0].sku).toBe('ACME-001');
        expect(impl).toHaveBeenCalledTimes(2);
    });

    test('skips the offer index entirely when no shipment has lines', async () => {
        const impl = stubFetch(() => ({
            status: 200,
            body: { items: [shipment({ shipment_items: [] })] },
        }));

        const external = await fetchTakealotShipments(ctx);

        expect(external).toHaveLength(1);
        // One request: there is nothing to resolve, so the index is not worth
        // paging through.
        expect(impl).toHaveBeenCalledTimes(1);
    });
});
