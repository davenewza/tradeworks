import { models, resetDatabase } from '@teamkeel/testing';
import { Currency } from '@teamkeel/sdk';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
    ZohoVendor,
    buildVendorCandidates,
    MAX_VENDOR_PAGES,
    fetchZohoVendors,
    importVendors,
    loadVendorCandidates,
    supportedCurrency,
} from './zohoVendorHelpers';

const CTX = { env: { ZOHO_BOOKS_BASE_URL: 'https://zoho.test/books/v3', ZOHO_BOOKS_ORG_ID: 'org1' } };

const vendor = (contact_id: string, contact_name: string, currency_code = 'ZAR', company_name = ''): ZohoVendor => ({
    contact_id,
    contact_name,
    contact_type: 'vendor',
    company_name,
    currency_code,
    status: 'active',
});

describe('supportedCurrency', () => {
    test('maps the currencies a supplier can carry, case-insensitively, and nothing else', () => {
        expect(supportedCurrency('GBP')).toBe(Currency.GBP);
        expect(supportedCurrency(' usd ')).toBe(Currency.USD);
        expect(supportedCurrency('AUD')).toBeNull();
        expect(supportedCurrency('')).toBeNull();
        expect(supportedCurrency(undefined)).toBeNull();
    });
});

describe('fetchZohoVendors', () => {
    afterEach(() => vi.unstubAllGlobals());

    test('asks the vendors listing for active vendors, follows the pages to the end, and keeps only vendors', async () => {
        const urls: string[] = [];
        const customer = { ...vendor('9', 'A buyer'), contact_type: 'customer' };
        const pages = [
            { code: 0, message: 'success', contacts: [vendor('1', 'Acme'), customer], page_context: { has_more_page: true } },
            { code: 0, message: 'success', contacts: [vendor('2', 'Bolt')], page_context: { has_more_page: false } },
        ];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => {
                urls.push(url);
                return new Response(JSON.stringify(pages[urls.length - 1]), { status: 200 });
            }),
        );

        const vendors = await fetchZohoVendors(CTX, 'token');

        expect(vendors.map((v) => v.contact_id)).toEqual(['1', '2']);
        expect(urls).toHaveLength(2);
        expect(urls[0]).toContain('/vendors?organization_id=org1&filter_by=Status.Active');
        // /vendors answers sort_column=contact_name with a 400 ("Invalid value
        // passed for sort_column"), failing every import.
        expect(urls[0]).not.toContain('sort_column');
        expect(urls[1]).toContain('&page=2&');
    });

    test('gives up after a bounded number of pages instead of draining the quota', async () => {
        const fetchMock = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({ code: 0, message: 'success', contacts: [vendor('1', 'Acme')], page_context: { has_more_page: true } }),
                    { status: 200 },
                ),
        );
        vi.stubGlobal('fetch', fetchMock);

        await expect(fetchZohoVendors(CTX, 'token')).rejects.toThrow(/ran past 25 pages/);
        expect(fetchMock).toHaveBeenCalledTimes(MAX_VENDOR_PAGES);
    });

    test('fails loudly on an HTTP error or a Zoho error code, e.g. the daily quota', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', { status: 429 })));
        await expect(fetchZohoVendors(CTX, 'token')).rejects.toThrow(/429 - slow down/);

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(JSON.stringify({ code: 57, message: 'Not authorized' }), { status: 200 })),
        );
        await expect(fetchZohoVendors(CTX, 'token')).rejects.toThrow(/Not authorized/);
    });
});

describe('buildVendorCandidates', () => {
    test('leaves out linked vendors, offers to link an unlinked supplier of the same name, and flags unsupported currencies', () => {
        const vendors = [
            vendor('3', 'Zeta Trading', 'AUD', 'Zeta Pty'),
            vendor('1', 'Acme', 'GBP'),
            vendor('2', 'Bolt', 'USD'),
            vendor('4', 'Cog', ''),
        ];
        const suppliers = [
            { name: 'Acme (renamed here)', zohoVendorId: '1' },
            { name: 'Bolt', zohoVendorId: null },
        ];

        expect(buildVendorCandidates(vendors, suppliers)).toEqual([
            { name: 'Bolt', company: '', currency: Currency.USD, action: 'Link', zohoVendorId: '2' },
            { name: 'Cog', company: '', currency: 'ZAR', action: 'Create', zohoVendorId: '4' },
            {
                name: 'Zeta Trading',
                company: 'Zeta Pty',
                currency: 'AUD (not supported — starts as ZAR)',
                action: 'Create',
                zohoVendorId: '3',
            },
        ]);
    });
});

describe('importVendors', () => {
    beforeEach(resetDatabase);

    test('creates linked suppliers in the vendor currency, links an existing unlinked one, and skips clashes', async () => {
        // Made before suppliers came from Zoho: no vendor, own settings, a price list.
        const legacy = await models.supplier.create({ name: 'Bolt', leadTimeInDays: 90, currency: Currency.ZAR });
        await models.supplierPriceList.create({ zohoPriceListId: 'zpl-bolt', name: 'Bolt', currencyCode: 'ZAR', supplierId: legacy.id, zohoModifiedAt: new Date() });
        // Same name as a vendor, but already linked to a different one.
        await models.supplier.create({ name: 'Cog', zohoVendorId: 'other' });

        const vendors = [vendor('1', 'Acme', 'GBP'), vendor('2', 'Bolt', 'USD'), vendor('3', 'Cog'), vendor('4', 'Dyna', 'AUD')];
        const candidates = await loadVendorCandidates(vendors);
        expect(candidates.map((c) => [c.name, c.action])).toEqual([
            ['Acme', 'Create'],
            ['Bolt', 'Link'],
            ['Cog', 'Create'],
            ['Dyna', 'Create'],
        ]);

        const result = await importVendors(candidates, vendors);

        expect(result).toEqual({
            created: [
                { name: 'Acme', currency: Currency.GBP },
                { name: 'Dyna', currency: Currency.ZAR },
            ],
            linked: [{ name: 'Bolt' }],
            skipped: [{ name: 'Cog', reason: 'A supplier of this name is linked to another Zoho vendor' }],
        });
        expect(await models.supplier.findOne({ zohoVendorId: '1' })).toMatchObject({ name: 'Acme', leadTimeInDays: 60 });
        // The linked supplier keeps its id (so its price lists), lead time and currency.
        expect(await models.supplier.findOne({ zohoVendorId: '2' })).toMatchObject({
            id: legacy.id, leadTimeInDays: 90, currency: Currency.ZAR, totalPriceLists: 1,
        });

        // Importing the same selection again changes nothing.
        expect(await importVendors(candidates.slice(0, 2), vendors)).toEqual({
            created: [],
            linked: [],
            skipped: [
                { name: 'Acme', reason: 'Already a supplier' },
                { name: 'Bolt', reason: 'Already a supplier' },
            ],
        });
        expect((await loadVendorCandidates(vendors)).map((c) => c.name)).toEqual(['Cog']);
    });
});
