import { models } from '@teamkeel/sdk';

export interface ZohoInvoice {
    invoice_id: string;
    invoice_number: string;
    date: string;
    line_items: ZohoLineItem[];
    custom_fields?: ZohoCustomField[];
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
): Promise<{ invoices: ZohoInvoice[]; failures: number }> {
    const results: ZohoInvoice[] = [];
    let failures = 0;

    for (let i = 0; i < invoiceSummaries.length; i += INVOICE_FETCH_BATCH_SIZE) {
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
        failures += batchResults.length - successful.length;
    }

    return { invoices: results, failures };
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
        existingSalesMap?: Map<string, { id: string; quantity: number; price: any; productId: string | null }>;
    }
): Promise<ProcessInvoiceResult> {
    const result: ProcessInvoiceResult = { created: 0, updated: 0, skipped: 0, errors: [] };

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

        // Look up existing sale from pre-populated map or query directly
        let existingSale: { id: string; quantity: number; price: any; productId: string | null } | undefined;
        const saleKey = `${invoice.invoice_number}-${lineItem.line_item_id}`;
        if (options?.existingSalesMap) {
            existingSale = options.existingSalesMap.get(saleKey);
        } else {
            const found = await models.sale.findMany({
                where: {
                    invoiceNumber: { equals: invoice.invoice_number },
                    lineItemId: { equals: lineItem.line_item_id },
                },
            });
            existingSale = found.length > 0
                ? { id: found[0].id, quantity: found[0].quantity, price: found[0].price, productId: found[0].productId }
                : undefined;
        }

        const saleDate = new Date(invoice.date);
        const quantity = Math.round(lineItem.quantity);
        const price = lineItem.rate;
        const now = new Date();

        try {
            if (existingSale) {
                const needsUpdate =
                    existingSale.quantity !== quantity ||
                    Number(existingSale.price) !== price ||
                    existingSale.productId !== product.id;

                if (needsUpdate) {
                    await models.sale.update(
                        { id: existingSale.id },
                        {
                            quantity: quantity,
                            price: price,
                            productId: product.id,
                            date: saleDate,
                            synchronisedAt: now,
                        }
                    );
                    result.updated++;
                } else {
                    await models.sale.update(
                        { id: existingSale.id },
                        { synchronisedAt: now }
                    );
                }
            } else {
                await models.sale.create({
                    invoiceNumber: invoice.invoice_number,
                    lineItemId: lineItem.line_item_id,
                    channel: { id: channel.id },
                    date: saleDate,
                    product: { id: product.id },
                    quantity: quantity,
                    price: price,
                    synchronisedAt: now,
                });
                result.created++;
            }
        } catch (error) {
            result.skipped++;
            result.errors.push(
                `Failed to persist sale for invoice ${invoice.invoice_number} line ${lineItem.line_item_id}: ${error}`
            );
        }
    }

    return result;
}
