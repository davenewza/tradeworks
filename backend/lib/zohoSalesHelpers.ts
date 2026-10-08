import { models } from '@teamkeel/sdk';

export interface ZohoInvoice {
    invoice_id: string;
    invoice_number: string;
    date: string;
    status?: string;
    // Zoho's last-modified timestamp, present on both the list and detail
    // responses. Used to skip the detail fetch for unchanged invoices.
    last_modified_time?: string;
    line_items: ZohoLineItem[];
    custom_fields?: ZohoCustomField[];
}

// True for a Postgres unique-constraint violation surfaced through the Keel
// model API — used to recover from a concurrent-create race (two webhook/sync
// invocations inserting the same (invoiceNumber, lineKey) at once).
export function isUniqueViolation(error: unknown): boolean {
    const message = String((error as { message?: unknown } | null)?.message ?? error);
    return message.includes('duplicate key value') || message.includes('unique constraint');
}

// Zoho's daily per-organisation API quota (error code 45 on a 429). Unlike a
// transient burst 429, a code-45 response keeps failing until the quota resets
// the next day — so callers must STOP rather than retry (retrying just burns
// more of a quota that's already gone).
export function isZohoDailyRateLimit(status: number, body: string): boolean {
    if (status !== 429) return false;
    return /"code"\s*:\s*45\b/.test(body) || /call rate limit/i.test(body);
}

// True when two last_modified_time values name the same instant. Compared as
// instants, not strings: the list API sends Zoho's own format
// ("2026-10-07T06:20:37+0200"), but a webhook delivery's value is stored in
// whatever form it reached us in — see normalizeWebhookInvoice — so the same
// moment can be spelled two ways.
export function isSameModifiedTime(stored: string, current: string): boolean {
    if (stored === current) return true;
    const storedMs = Date.parse(stored);
    return !Number.isNaN(storedMs) && storedMs === Date.parse(current);
}

// Split invoice summaries into those needing a detail fetch and those we can
// skip because we already hold their current version (a stored last_modified_time
// equal to Zoho's). Invoices with no stored time (never synced, or synced before
// the field existed) are always fetched. This is the main saving on the daily
// API quota: re-syncs stop re-fetching every unchanged invoice's detail.
export function partitionInvoicesByChange<T extends { invoice_number: string; last_modified_time?: string }>(
    summaries: T[],
    storedModifiedByInvoice: Map<string, string | null>
): { toFetch: T[]; skipped: number } {
    const toFetch: T[] = [];
    let skipped = 0;
    for (const summary of summaries) {
        const stored = storedModifiedByInvoice.get(summary.invoice_number);
        if (stored && summary.last_modified_time && isSameModifiedTime(stored, summary.last_modified_time)) {
            skipped++;
        } else {
            toFetch.push(summary);
        }
    }
    return { toFetch, skipped };
}

// Keel parses every date-like string in an `Any` input into a Date, so a webhook
// payload's invoice date ("2026-10-07") arrives as a Date at UTC midnight, and
// its last_modified_time as a Date too. Put both back into strings, so the
// webhook hands processInvoiceLineItems the same shape the REST API gives the
// syncs. The date round-trips exactly. last_modified_time comes back in ISO
// form rather than Zoho's own "+0200" spelling — the offset is lost in parsing
// — which is why the unchanged-skip compares instants (isSameModifiedTime).
export function normalizeWebhookInvoice(invoice: ZohoInvoice): ZohoInvoice {
    const parsed = invoice as unknown as { date: unknown; last_modified_time?: unknown };
    return {
        ...invoice,
        date: parsed.date instanceof Date ? parsed.date.toISOString().slice(0, 10) : invoice.date,
        last_modified_time:
            parsed.last_modified_time instanceof Date
                ? parsed.last_modified_time.toISOString()
                : invoice.last_modified_time,
    };
}

export interface ZohoCustomField {
    customfield_id: string;
    label: string;
    value: string;
}

export interface ZohoLineItem {
    line_item_id: string;
    sku: string;
    name: string;
    quantity: number;
    rate: number;
    // The channel integration stores the source order-line id here (Takealot
    // orderItemId, etc.) — stable across Zoho re-saves, unlike line_item_id.
    description?: string;
    // Realized line figures (net of discount). item_total is excl VAT; Zoho
    // exposes no per-line tax amount, so tax is derived from netAmount downstream.
    item_total?: number;
    discount_amount?: number;
}

// True when the invoice is maintained by a channel integration (ManagedByWebhook
// custom field). Only these invoices carry a stable source line id in `description`.
export function isManagedByWebhook(invoice: ZohoInvoice): boolean {
    return (invoice.custom_fields ?? []).some(
        (cf) => cf.label?.trim().toLowerCase() === 'managedbywebhook' && String(cf.value).trim().toLowerCase() === 'true'
    );
}

// The stable per-line identity used to dedup sales. For integration-managed
// invoices it's the source order-line id (carried in `description`); otherwise
// it falls back to the Zoho line_item_id (stable for manually-kept invoices).
export function getLineKey(invoice: ZohoInvoice, lineItem: ZohoLineItem): { orderItemId: string | null; lineKey: string } {
    const orderItemId = isManagedByWebhook(invoice) ? lineItem.description?.trim() || null : null;
    return { orderItemId, lineKey: orderItemId ?? lineItem.line_item_id };
}

// Read the invoice's "On Promotion" custom field, if present.
export function getOnPromotionFromInvoice(invoice: ZohoInvoice): boolean | null {
    const field = (invoice.custom_fields ?? []).find(
        (cf) => cf.label?.trim().toLowerCase() === 'on promotion'
    );
    if (!field) return null;
    const value = String(field.value ?? '').trim().toLowerCase();
    if (value === 'true' || value === 'yes') return true;
    if (value === 'false' || value === 'no') return false;
    return null;
}

export interface ZohoInvoicesResponse {
    invoices: ZohoInvoice[];
    page_context: {
        page: number;
        per_page: number;
        has_more_page: boolean;
    };
}

export interface ZohoInvoiceDetailResponse {
    invoice: ZohoInvoice;
}

export interface ProcessInvoiceResult {
    created: number;
    updated: number;
    skipped: number;
    errors: string[];
    // Calendar days ('YYYY-MM-DD') the persisted sales now sit on — plus, for a
    // sale whose date changed, the day it moved off — so the caller can rebuild
    // the cumulative sales months they belong to.
    touchedDays: string[];
}

// The existing-sale fields processInvoiceLineItems needs, whether looked up per
// line or handed in pre-fetched by a batch sync.
export interface ExistingSale {
    id: string;
    quantity: number;
    price: any;
    productId: string | null;
    date: Date;
}

// A stored Sale.date as 'YYYY-MM-DD'. Keel reads a Date column back at LOCAL
// midnight, so the local getters give the calendar day that is actually stored;
// toISOString would report the previous day on any host east of UTC.
export function storedCalendarDay(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

const INVOICE_FETCH_BATCH_SIZE = 5;
const INVOICE_FETCH_MAX_RETRIES = 3;
const INVOICE_FETCH_RETRY_BASE_MS = 250;

export async function delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

// Zoho's `last_modified_time` filter wants YYYY-MM-DDTHH:MM:SS with a timezone
// offset (no colon in the offset). We emit UTC. The `+` must be percent-encoded
// as %2B in the query string.
export function formatModifiedSince(date: Date): string {
    return date.toISOString().slice(0, 19) + '+0000';
}

export async function getZohoAccessToken(ctx: {
    env: { ZOHO_ACCOUNTS_BASE_URL: string; ZOHO_CLIENT_ID: string };
    secrets: { ZOHO_CLIENT_SECRET: string };
}): Promise<string> {
    const accountsBase = ctx.env.ZOHO_ACCOUNTS_BASE_URL.replace(/\/$/, '');
    const clientId = ctx.env.ZOHO_CLIENT_ID;
    const clientSecret = ctx.secrets.ZOHO_CLIENT_SECRET;

    const url = `${accountsBase}/oauth/v2/token?client_id=${encodeURIComponent(
        clientId
    )}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials&scope=${encodeURIComponent(
        'ZohoBooks.invoices.READ'
    )}`;

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
        },
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to get Zoho access token: ${response.status} - ${errorText}`);
    }

    const tokenData = await response.json();
    if (!tokenData.access_token) {
        throw new Error(`Zoho OAuth token response missing access_token: ${JSON.stringify(tokenData)}`);
    }
    return tokenData.access_token;
}

export function getChannelFromInvoice(invoice: ZohoInvoice): string {
    if (!invoice.custom_fields || invoice.custom_fields.length === 0) {
        return 'Other';
    }
    const channelField = invoice.custom_fields.find(
        (cf) => cf.label?.toLowerCase() === 'sales channel' ||
                cf.label?.toLowerCase() === 'cf_sales_channel' ||
                cf.label?.toLowerCase().includes('sales channel')
    );
    const value = channelField?.value;
    if (typeof value === 'string' && value.trim()) {
        return value.trim();
    }
    return 'Other';
}

export async function fetchInvoiceDetailsBatch(
    invoiceSummaries: Array<{ invoice_id: string; invoice_number: string }>,
    baseUrl: string,
    orgId: string,
    accessToken: string
): Promise<{ invoices: ZohoInvoice[]; failures: number; rateLimited: boolean }> {
    const results: ZohoInvoice[] = [];
    let failures = 0;
    let rateLimited = false;

    for (let i = 0; i < invoiceSummaries.length; i += INVOICE_FETCH_BATCH_SIZE) {
        // Quota's gone — stop firing calls; the run will pause and resume next time.
        if (rateLimited) break;
        const batch = invoiceSummaries.slice(i, i + INVOICE_FETCH_BATCH_SIZE);

        const batchResults = await Promise.all(
            batch.map(async (summary) => {
                const url = `${baseUrl}/invoices/${summary.invoice_id}?organization_id=${orgId}`;
                for (let attempt = 1; attempt <= INVOICE_FETCH_MAX_RETRIES; attempt++) {
                    try {
                        const response = await fetch(url, {
                            method: 'GET',
                            headers: {
                                'Authorization': `Zoho-oauthtoken ${accessToken}`,
                                'Content-Type': 'application/json',
                            },
                        });

                        if (response.ok) {
                            const data: ZohoInvoiceDetailResponse = await response.json();
                            return data.invoice;
                        }

                        const errorText = await response.text();
                        // A daily-quota 429 won't recover today — don't waste the
                        // remaining retries; flag it and let the run pause.
                        if (isZohoDailyRateLimit(response.status, errorText)) {
                            rateLimited = true;
                            return null;
                        }
                        console.error(
                            `Failed to fetch invoice ${summary.invoice_number} (attempt ${attempt}/${INVOICE_FETCH_MAX_RETRIES}): ${response.status} - ${errorText}`
                        );
                    } catch (error) {
                        console.error(
                            `Error fetching invoice ${summary.invoice_number} (attempt ${attempt}/${INVOICE_FETCH_MAX_RETRIES}):`,
                            error
                        );
                    }

                    if (attempt < INVOICE_FETCH_MAX_RETRIES) {
                        await delay(INVOICE_FETCH_RETRY_BASE_MS * Math.pow(2, attempt - 1));
                    }
                }

                return null;
            })
        );

        const successful = batchResults.filter((inv): inv is ZohoInvoice => inv !== null);
        results.push(...successful);
        // When rate-limited, the nulls in this batch are the quota casualties, not
        // data failures — don't count them (they're re-fetched next run).
        if (rateLimited) break;
        failures += batchResults.length - successful.length;
    }

    return { invoices: results, failures, rateLimited };
}

export async function getOrCreateChannel(
    channelName: string,
    channelCache: Map<string, { id: string }>
): Promise<{ id: string }> {
    const cached = channelCache.get(channelName);
    if (cached) return cached;

    const existing = await models.channel.findMany({ where: { name: channelName } });
    if (existing.length > 0) {
        const selected = { id: existing[0].id };
        channelCache.set(channelName, selected);
        return selected;
    }

    const created = await models.channel.create({ name: channelName });
    const selected = { id: created.id };
    channelCache.set(channelName, selected);
    return selected;
}

// Process a single invoice's line items into Sale records.
// For batch sync, callers can pre-populate productMap and existingSalesMap for efficiency.
// When these maps are not provided, lookups are done per line item.
export async function processInvoiceLineItems(
    invoice: ZohoInvoice,
    channelCache: Map<string, { id: string }>,
    options?: {
        productMap?: Map<string, { id: string }>;
        existingSalesMap?: Map<string, ExistingSale>;
    }
): Promise<ProcessInvoiceResult> {
    const result: ProcessInvoiceResult = { created: 0, updated: 0, skipped: 0, errors: [], touchedDays: [] };
    const touchedDays = new Set<string>();
    const invoiceDay = invoice.date.slice(0, 10);

    const channelName = getChannelFromInvoice(invoice);
    const channel = await getOrCreateChannel(channelName, channelCache);

    for (const lineItem of invoice.line_items) {
        const sku = lineItem.sku?.trim();
        if (!sku) {
            result.skipped++;
            result.errors.push(
                `Skipping line item ${lineItem.line_item_id} on invoice ${invoice.invoice_number}: no SKU provided`
            );
            continue;
        }

        // Look up product from pre-populated map or query directly
        let product: { id: string } | undefined;
        if (options?.productMap) {
            product = options.productMap.get(sku);
        } else {
            const found = await models.product.findMany({ where: { sku: { equals: sku } } });
            product = found.length > 0 ? { id: found[0].id } : undefined;
        }

        if (!product) {
            result.skipped++;
            result.errors.push(
                `Skipping line item ${lineItem.line_item_id} on invoice ${invoice.invoice_number}: no product found for SKU "${sku}"`
            );
            continue;
        }

        // Stable dedup key — orderItemId (source line id) if the invoice is
        // integration-managed, else the Zoho line_item_id.
        const { orderItemId, lineKey } = getLineKey(invoice, lineItem);

        // Look up existing sale from pre-populated map or query directly
        let existingSale: ExistingSale | undefined;
        const saleKey = `${invoice.invoice_number}-${lineKey}`;
        if (options?.existingSalesMap) {
            existingSale = options.existingSalesMap.get(saleKey);
        } else {
            const found = await models.sale.findMany({
                where: {
                    invoiceNumber: { equals: invoice.invoice_number },
                    lineKey: { equals: lineKey },
                },
            });
            existingSale = found.length > 0
                ? { id: found[0].id, quantity: found[0].quantity, price: found[0].price, productId: found[0].productId, date: found[0].date }
                : undefined;
        }

        const saleDate = new Date(invoice.date);
        const quantity = Math.round(lineItem.quantity);
        const price = lineItem.rate;
        const now = new Date();

        // Realized line figures (net of discount) + invoice-level attributes.
        // Always written so a re-sync backfills these onto existing rows.
        const realized = {
            netAmount: lineItem.item_total ?? null,
            discountAmount: lineItem.discount_amount ?? null,
            invoiceStatus: invoice.status ?? null,
            onPromotion: getOnPromotionFromInvoice(invoice),
            // Stored so the next sync can skip this invoice's detail fetch while
            // it's unchanged (see partitionInvoicesByChange).
            zohoModifiedTime: invoice.last_modified_time ?? null,
        };

        // The mutable fields, shared by the update and the race-recovery update.
        // Refresh line_item_id too — Zoho rotates it on re-save.
        const updatePayload = {
            lineItemId: lineItem.line_item_id,
            orderItemId: orderItemId,
            quantity: quantity,
            price: price,
            productId: product.id,
            date: saleDate,
            ...realized,
            synchronisedAt: now,
        };

        try {
            if (existingSale) {
                await models.sale.update({ id: existingSale.id }, updatePayload);
                result.updated++;
                touchedDays.add(storedCalendarDay(existingSale.date));
            } else {
                try {
                    await models.sale.create({
                        invoiceNumber: invoice.invoice_number,
                        lineItemId: lineItem.line_item_id,
                        orderItemId: orderItemId,
                        lineKey: lineKey,
                        channel: { id: channel.id },
                        date: saleDate,
                        product: { id: product.id },
                        quantity: quantity,
                        price: price,
                        ...realized,
                        synchronisedAt: now,
                    });
                    result.created++;
                } catch (error) {
                    // Concurrent create: another webhook/sync inserted this
                    // (invoiceNumber, lineKey) between our lookup and this insert.
                    // Recover by updating the row that now exists, so this
                    // delivery's data still lands (idempotent under races).
                    if (!isUniqueViolation(error)) throw error;
                    const raced = await models.sale.findMany({
                        where: {
                            invoiceNumber: { equals: invoice.invoice_number },
                            lineKey: { equals: lineKey },
                        },
                    });
                    if (raced.length === 0) throw error;
                    await models.sale.update({ id: raced[0].id }, updatePayload);
                    result.updated++;
                    touchedDays.add(storedCalendarDay(raced[0].date));
                }
            }
            touchedDays.add(invoiceDay);
        } catch (error) {
            result.skipped++;
            result.errors.push(
                `Failed to persist sale for invoice ${invoice.invoice_number} line ${lineItem.line_item_id}: ${error}`
            );
        }
    }

    result.touchedDays = [...touchedDays];
    return result;
}
