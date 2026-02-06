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
const INVOICE_FETCH_BATCH_SIZE = 10;

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
    console.log('Zoho token response:', JSON.stringify(tokenData));
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
    // Look for channel field - check label case-insensitively
    const channelField = invoice.custom_fields.find(
        (cf) => cf.label?.toLowerCase() === 'sales channel' ||
                cf.label?.toLowerCase() === 'cf_sales_channel' ||
                cf.label?.toLowerCase().includes('sales channel')
    );
    // Ensure value is a string before trimming
    const value = channelField?.value;
    if (typeof value === 'string' && value.trim()) {
        return value.trim();
    }
    return 'Other';
}

// Fetch invoice details in parallel batches
async function fetchInvoiceDetailsBatch(
    invoiceSummaries: Array<{ invoice_id: string; invoice_number: string }>,
    baseUrl: string,
    orgId: string,
    accessToken: string
): Promise<ZohoInvoice[]> {
    const results: ZohoInvoice[] = [];

    for (let i = 0; i < invoiceSummaries.length; i += INVOICE_FETCH_BATCH_SIZE) {
        const batch = invoiceSummaries.slice(i, i + INVOICE_FETCH_BATCH_SIZE);

        const batchResults = await Promise.all(
            batch.map(async (summary) => {
                const url = `${baseUrl}/invoices/${summary.invoice_id}?organization_id=${orgId}`;
                try {
                    const response = await fetch(url, {
                        method: 'GET',
                        headers: {
                            'Authorization': `Zoho-oauthtoken ${accessToken}`,
                            'Content-Type': 'application/json',
                        },
                    });

                    if (!response.ok) {
                        console.warn(`Failed to fetch invoice ${summary.invoice_number}, skipping`);
                        return null;
                    }

                    const data: ZohoInvoiceDetailResponse = await response.json();
                    return data.invoice;
                } catch (error) {
                    console.warn(`Error fetching invoice ${summary.invoice_number}:`, error);
                    return null;
                }
            })
        );

        results.push(...batchResults.filter((inv): inv is ZohoInvoice => inv !== null));
    }

    return results;
}

export default SyncSales(async (ctx, inputs) => {
    const startDate = formatDate(inputs.start);
    const endDate = formatDate(inputs.end);

    // Get OAuth access token
    const accessToken = await getZohoAccessToken(ctx);

    let totalInvoicesProcessed = 0;
    let salesCreated = 0;
    let salesUpdated = 0;
    let salesSkipped = 0;
    const skippedProducts: Array<{
        invoiceNumber: string;
        sku: string;
        productName: string;
        reason: string;
    }> = [];

    // Cache for channel lookups by name
    const channelCache = new Map<string, { id: string }>();

    // Helper to get or create a channel
    async function getOrCreateChannel(channelName: string): Promise<{ id: string }> {
        const cached = channelCache.get(channelName);
        if (cached) return cached;

        const existing = await models.channel.findOne({ name: channelName });
        if (existing) {
            channelCache.set(channelName, { id: existing.id });
            return { id: existing.id };
        }

        const created = await models.channel.create({ name: channelName });
        channelCache.set(channelName, { id: created.id });
        return { id: created.id };
    }

    // Fetch all invoices from Zoho within the date range
    let page = 1;
    let hasMorePages = true;

    while (hasMorePages) {
        const invoicesUrl = `${ctx.env.ZOHO_BOOKS_BASE_URL}/invoices?organization_id=${ctx.env.ZOHO_BOOKS_ORG_ID}&date_start=${startDate}&date_end=${endDate}&page=${page}&per_page=200`;

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

        // Fetch all invoice details in parallel batches
        const invoices = await fetchInvoiceDetailsBatch(
            invoicesData.invoices,
            ctx.env.ZOHO_BOOKS_BASE_URL,
            ctx.env.ZOHO_BOOKS_ORG_ID,
            accessToken
        );

        // Log the first invoice to see custom_fields structure
        if (invoices.length > 0 && totalInvoicesProcessed === 0) {
            console.log('Sample invoice custom_fields:', JSON.stringify({
                invoice_number: invoices[0].invoice_number,
                custom_fields: invoices[0].custom_fields,
            }, null, 2));
        }

        totalInvoicesProcessed += invoices.length;

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

        // Collect all sale identifiers for batch existence check
        const allSaleIdentifiers: string[] = [];
        for (const invoice of invoices) {
            for (const lineItem of invoice.line_items) {
                allSaleIdentifiers.push(`${invoice.invoice_number}-${lineItem.line_item_id}`);
            }
        }

        // Batch fetch all existing sales
        const existingSalesMap = new Map<string, { id: string; quantity: number; price: any; productId: string }>();
        if (allSaleIdentifiers.length > 0) {
            const existingSales = await models.sale.findMany({
                where: { invoiceNumber: { oneOf: allSaleIdentifiers } },
            });
            for (const sale of existingSales) {
                existingSalesMap.set(sale.invoiceNumber, {
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

                if (!sku) {
                    salesSkipped++;
                    skippedProducts.push({
                        invoiceNumber: invoice.invoice_number,
                        sku: '',
                        productName: lineItem.name,
                        reason: 'No SKU provided',
                    });
                    continue;
                }

                const product = productMap.get(sku);

                if (!product) {
                    salesSkipped++;
                    skippedProducts.push({
                        invoiceNumber: invoice.invoice_number,
                        sku: sku,
                        productName: lineItem.name,
                        reason: 'Product not found in system',
                    });
                    continue;
                }

                const saleIdentifier = `${invoice.invoice_number}-${lineItem.line_item_id}`;
                const existingSale = existingSalesMap.get(saleIdentifier);

                const saleDate = new Date(invoice.date);
                const quantity = Math.round(lineItem.quantity);
                const price = lineItem.rate;
                const now = new Date();

                if (existingSale) {
                    // Update existing sale if values differ
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
                        salesUpdated++;
                    } else {
                        // Update synchronisedAt even if no other changes
                        await models.sale.update(
                            { id: existingSale.id },
                            { synchronisedAt: now }
                        );
                    }
                } else {
                    // Create new sale
                    console.log(`Creating sale: invoiceNumber=${saleIdentifier}, channelId=${channel.id}, productId=${product.id}`);
                    await models.sale.create({
                        invoiceNumber: saleIdentifier,
                        channel: { id: channel.id },
                        date: saleDate,
                        product: { id: product.id },
                        quantity: quantity,
                        price: price,
                        synchronisedAt: now,
                    });
                    salesCreated++;
                }
            }
        }

        hasMorePages = invoicesData.page_context.has_more_page;
        page++;
    }

    return {
        totalInvoicesProcessed,
        salesCreated,
        salesUpdated,
        salesSkipped,
        skippedProducts,
    };
});

function formatDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
