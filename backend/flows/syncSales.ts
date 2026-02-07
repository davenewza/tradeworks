import { SyncSales, models } from '@teamkeel/sdk';

interface ZohoInvoice {
    invoice_id: string;
    invoice_number: string;
    date: string;
    line_items: ZohoLineItem[];
    custom_fields?: ZohoCustomField[];
}

interface ZohoCustomField {
    customfield_id: string;
    label: string;
    value: string;
}

interface ZohoLineItem {
    line_item_id: string;
    sku: string;
    name: string;
    quantity: number;
    rate: number;
}

interface ZohoInvoicesResponse {
    invoices: ZohoInvoice[];
    page_context: {
        page: number;
        per_page: number;
        has_more_page: boolean;
    };
}

interface ZohoInvoiceDetailResponse {
    invoice: ZohoInvoice;
}

// Concurrency limit for parallel API requests to avoid rate limiting
const INVOICE_FETCH_BATCH_SIZE = 5;
const INVOICE_FETCH_MAX_RETRIES = 3;
const INVOICE_FETCH_RETRY_BASE_MS = 250;

async function getZohoAccessToken(ctx: {
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

// Helper to extract channel from invoice custom fields
function getChannelFromInvoice(invoice: ZohoInvoice): string {
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

async function delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchInvoiceDetailsBatch(
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

function formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

export default SyncSales({}, async (ctx, inputs) => {
    const accessToken = await ctx.step("authenticate", async () => {
        return await getZohoAccessToken(ctx);
    });

    const startDate = formatDate(inputs.start);
    const endDate = formatDate(inputs.end);

    let totalInvoicesProcessed = 0;
    let salesCreated = 0;
    let salesUpdated = 0;

    // Cache for channel lookups by name
    const channelCache = new Map<string, { id: string }>();

    // Helper to get or create a channel
    async function getOrCreateChannel(channelName: string): Promise<{ id: string }> {
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

    // Fetch all invoices page by page
    let page = 1;
    let hasMorePages = true;
    let invoiceDetailFailures = 0;
    let salePersistFailures = 0;

    while (hasMorePages) {
        const currentPage = page;

        // Fetch and process a full page of invoices as one durable step
        const pageResult = await ctx.step(`sync-page-${currentPage}`, async () => {
            // Fetch invoice summaries
            const invoicesUrl = `${ctx.env.ZOHO_BOOKS_BASE_URL}/invoices?organization_id=${ctx.env.ZOHO_BOOKS_ORG_ID}&date_start=${startDate}&date_end=${endDate}&page=${currentPage}&per_page=200`;

            const invoicesResponse = await fetch(invoicesUrl, {
                method: 'GET',
                headers: {
                    'Authorization': `Zoho-oauthtoken ${accessToken}`,
                    'Content-Type': 'application/json',
                },
            });

            if (!invoicesResponse.ok) {
                const errorText = await invoicesResponse.text();
                throw new Error(`Failed to fetch invoices from Zoho: ${invoicesResponse.status} - ${errorText}`);
            }

            const invoicesData: ZohoInvoicesResponse = await invoicesResponse.json();

            // Fetch invoice details in batches
            const invoiceDetailResult = await fetchInvoiceDetailsBatch(
                invoicesData.invoices,
                ctx.env.ZOHO_BOOKS_BASE_URL,
                ctx.env.ZOHO_BOOKS_ORG_ID,
                accessToken
            );
            const invoices = invoiceDetailResult.invoices;

            let pageInvoicesProcessed = invoices.length;
            let pageCreated = 0;
            let pageUpdated = 0;
            let pageDetailFailures = invoiceDetailResult.failures;
            let pagePersistFailures = 0;

            // Collect all unique SKUs from this batch for batch product lookup
            const allSkus = new Set<string>();
            for (const invoice of invoices) {
                for (const lineItem of invoice.line_items) {
                    const sku = lineItem.sku?.trim();
                    if (sku) {
                        allSkus.add(sku);
                    }
                }
            }

            // Batch fetch all products by SKU
            const productMap = new Map<string, { id: string }>();
            if (allSkus.size > 0) {
                const products = await models.product.findMany({
                    where: { sku: { oneOf: Array.from(allSkus) } },
                });
                for (const product of products) {
                    productMap.set(product.sku, { id: product.id });
                }
            }

            // Collect all invoice numbers for batch existence check
            const allInvoiceNumbers = new Set<string>();
            for (const invoice of invoices) {
                allInvoiceNumbers.add(invoice.invoice_number);
            }

            // Batch fetch all existing sales for these invoices
            const existingSalesMap = new Map<string, { id: string; quantity: number; price: any; productId: string | null }>();
            if (allInvoiceNumbers.size > 0) {
                const existingSales = await models.sale.findMany({
                    where: { invoiceNumber: { oneOf: Array.from(allInvoiceNumbers) } },
                });
                for (const sale of existingSales) {
                    existingSalesMap.set(`${sale.invoiceNumber}-${sale.lineItemId}`, {
                        id: sale.id,
                        quantity: sale.quantity,
                        price: sale.price,
                        productId: sale.productId,
                    });
                }
            }

            // Pre-fetch/create channels for all invoices
            const channelNames = new Set<string>();
            for (const invoice of invoices) {
                channelNames.add(getChannelFromInvoice(invoice));
            }
            for (const channelName of channelNames) {
                await getOrCreateChannel(channelName);
            }

            // Process all invoices and their line items
            for (const invoice of invoices) {
                const channelName = getChannelFromInvoice(invoice);
                const channel = channelCache.get(channelName)!;

                for (const lineItem of invoice.line_items) {
                    const sku = lineItem.sku?.trim();
                    const product = sku ? productMap.get(sku) : undefined;
                    const productId = product?.id ?? null;

                    const existingSale = existingSalesMap.get(`${invoice.invoice_number}-${lineItem.line_item_id}`);

                    const saleDate = new Date(invoice.date);
                    const quantity = Math.round(lineItem.quantity);
                    const price = lineItem.rate;
                    const now = new Date();

                    try {
                        if (existingSale) {
                            const needsUpdate =
                                existingSale.quantity !== quantity ||
                                Number(existingSale.price) !== price ||
                                existingSale.productId !== productId;

                            if (needsUpdate) {
                                await models.sale.update(
                                    { id: existingSale.id },
                                    {
                                        quantity: quantity,
                                        price: price,
                                        productId: productId,
                                        date: saleDate,
                                        synchronisedAt: now,
                                    }
                                );
                                pageUpdated++;
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
                                product: productId ? { id: productId } : undefined,
                                quantity: quantity,
                                price: price,
                                synchronisedAt: now,
                            });
                            pageCreated++;
                        }
                    } catch (error) {
                        pagePersistFailures++;
                        console.error(
                            `Failed to persist sale for invoice ${invoice.invoice_number} line ${lineItem.line_item_id}:`,
                            error
                        );
                    }
                }
            }

            return {
                hasMorePages: invoicesData.page_context.has_more_page,
                invoicesProcessed: pageInvoicesProcessed,
                created: pageCreated,
                updated: pageUpdated,
                detailFailures: pageDetailFailures,
                persistFailures: pagePersistFailures,
            };
        });

        totalInvoicesProcessed += pageResult!.invoicesProcessed as number;
        salesCreated += pageResult!.created as number;
        salesUpdated += pageResult!.updated as number;
        invoiceDetailFailures += pageResult!.detailFailures as number;
        salePersistFailures += pageResult!.persistFailures as number;

        hasMorePages = pageResult!.hasMorePages as boolean;
        page++;
    }

    if (invoiceDetailFailures > 0 || salePersistFailures > 0) {
        console.error(
            `SyncSales completed with errors. Invoice detail failures: ${invoiceDetailFailures}. Sale persist failures: ${salePersistFailures}.`
        );
        throw new Error(
            `SyncSales completed with errors. Invoice detail failures: ${invoiceDetailFailures}. Sale persist failures: ${salePersistFailures}.`
        );
    }

    return ctx.complete({
        title: "Sales sync complete",
        content: [
            ctx.ui.display.keyValue({
                data: [
                    { key: "Invoices processed", value: totalInvoicesProcessed },
                    { key: "Sales created", value: salesCreated },
                    { key: "Sales updated", value: salesUpdated },
                ],
            }),
        ],
    });
});
