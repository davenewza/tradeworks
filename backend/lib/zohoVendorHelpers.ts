import { Currency, models } from '@teamkeel/sdk';

// Suppliers come from Zoho Books vendors — see ImportSuppliers. A vendor is a
// Zoho contact with contact_type "vendor"; its contact_id is the link we keep.

// The fields of a Zoho vendor (a contact, from GET /contacts) we read.
export interface ZohoVendor {
    contact_id: string;
    contact_name: string;
    contact_type?: string;
    company_name?: string;
    currency_code?: string;
    status?: string;
}

interface ZohoContactsResponse {
    code: number;
    message: string;
    contacts?: ZohoVendor[];
    page_context?: { has_more_page: boolean };
}

export interface ZohoVendorCtx {
    env: { ZOHO_BOOKS_BASE_URL: string; ZOHO_BOOKS_ORG_ID: string };
}

// The scope the vendor listing needs.
export const ZOHO_CONTACTS_SCOPE = 'ZohoBooks.contacts.READ';

// Far more pages than any real vendor list. Hitting it means the listing is not
// what we think it is, and every further page would spend the shared Zoho
// quota for nothing.
export const MAX_VENDOR_PAGES = 25;

// Every active vendor in Zoho, paged 200 at a time. Unsorted: /vendors
// rejects sort_column=contact_name with a 400, and the candidates are sorted
// by name here anyway.
//
// From /vendors, not /contacts: Zoho ignores contact_type=vendor on /contacts
// and returns every contact, which here means thousands of customers (one per
// channel buyer) — paging through those is what timed the first import out.
export async function fetchZohoVendors(ctx: ZohoVendorCtx, accessToken: string): Promise<ZohoVendor[]> {
    const vendors: ZohoVendor[] = [];
    for (let page = 1; ; page++) {
        if (page > MAX_VENDOR_PAGES) {
            throw new Error(
                `Zoho's vendor listing ran past ${MAX_VENDOR_PAGES} pages of 200 — stopping rather than spend more of the API quota`,
            );
        }
        const url =
            `${ctx.env.ZOHO_BOOKS_BASE_URL}/vendors?organization_id=${ctx.env.ZOHO_BOOKS_ORG_ID}` +
            `&filter_by=Status.Active&page=${page}&per_page=200`;
        const response = await fetch(url, {
            method: 'GET',
            headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch vendors from Zoho: ${response.status} - ${await response.text()}`);
        }
        const data: ZohoContactsResponse = await response.json();
        if (data.code !== 0) throw new Error(`Zoho vendor listing failed: ${data.message}`);

        // Only vendors can be suppliers, whatever the listing hands back.
        vendors.push(...(data.contacts ?? []).filter((c) => c.contact_type === 'vendor'));
        if (!data.page_context?.has_more_page) return vendors;
    }
}

// The vendor's currency, when it is one a supplier can carry. Null otherwise —
// the supplier then starts in rand and the import says so.
export function supportedCurrency(code: string | undefined): Currency | null {
    const upper = code?.trim().toUpperCase();
    return upper && (Object.values(Currency) as string[]).includes(upper) ? (upper as Currency) : null;
}

// A vendor offered for import. JSON-serialisable for ctx.step(). `name` is
// the key the picker hands back: ctx.ui.select.table returns only the columns
// it shows, and Zoho keeps contact names unique within an organisation.
export interface VendorCandidate {
    name: string;
    company: string;
    currency: string;
    // 'Create' makes a new supplier; 'Link' attaches the vendor to the existing
    // supplier of the same name that has no Zoho vendor yet (one made before
    // suppliers came from Zoho), keeping its price lists, lead time and currency.
    action: 'Create' | 'Link';
    zohoVendorId: string;
}

export interface ExistingSupplier {
    name: string;
    zohoVendorId: string | null;
}

// Active vendors that aren't linked to a supplier yet. A vendor already linked
// by its id is left out, whatever it is called now.
export function buildVendorCandidates(vendors: ZohoVendor[], suppliers: ExistingSupplier[]): VendorCandidate[] {
    const linked = new Set(suppliers.map((s) => s.zohoVendorId).filter((id): id is string => !!id));
    const unlinkedNames = new Set(suppliers.filter((s) => !s.zohoVendorId).map((s) => s.name));
    return vendors
        .filter((v) => !linked.has(v.contact_id))
        .map((v) => {
            const name = v.contact_name.trim();
            const code = v.currency_code?.trim().toUpperCase() ?? '';
            const supported = supportedCurrency(code);
            return {
                name,
                company: v.company_name?.trim() ?? '',
                currency: supported ?? (code ? `${code} (not supported — starts as ZAR)` : 'ZAR'),
                action: unlinkedNames.has(name) ? ('Link' as const) : ('Create' as const),
                zohoVendorId: v.contact_id,
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadVendorCandidates(vendors: ZohoVendor[]): Promise<VendorCandidate[]> {
    const suppliers = await models.supplier.findMany({});
    return buildVendorCandidates(
        vendors,
        suppliers.map((s) => ({ name: s.name, zohoVendorId: s.zohoVendorId ?? null })),
    );
}

export interface ImportResult {
    created: { name: string; currency: Currency }[];
    linked: { name: string }[];
    // Ticked, but by now linked already (another run got there first) or
    // clashing with a supplier of that name linked to a different vendor.
    skipped: { name: string; reason: string }[];
}

// Creates a supplier per ticked vendor, linked by its Zoho contact id, in the
// vendor's currency where supported; lead time starts at the default. An
// unlinked supplier of the same name is linked instead, and keeps its own
// settings.
export async function importVendors(selected: VendorCandidate[], vendors: ZohoVendor[]): Promise<ImportResult> {
    const byId = new Map(vendors.map((v) => [v.contact_id, v]));
    const result: ImportResult = { created: [], linked: [], skipped: [] };

    for (const candidate of selected) {
        if (await models.supplier.findOne({ zohoVendorId: candidate.zohoVendorId })) {
            result.skipped.push({ name: candidate.name, reason: 'Already a supplier' });
            continue;
        }
        const sameName = await models.supplier.findOne({ name: candidate.name });
        if (sameName?.zohoVendorId) {
            result.skipped.push({ name: candidate.name, reason: 'A supplier of this name is linked to another Zoho vendor' });
            continue;
        }
        if (sameName) {
            await models.supplier.update({ id: sameName.id }, { zohoVendorId: candidate.zohoVendorId });
            result.linked.push({ name: candidate.name });
            continue;
        }
        const currency = supportedCurrency(byId.get(candidate.zohoVendorId)?.currency_code) ?? Currency.ZAR;
        await models.supplier.create({ name: candidate.name, zohoVendorId: candidate.zohoVendorId, currency });
        result.created.push({ name: candidate.name, currency });
    }
    return result;
}
