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

interface ZohoTokenResponse {
    access_token: string;
    token_type: string;
    expires_in: number;
}

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

    // Cache for product lookups by SKU
    const productCache = new Map<string, { id: string } | null>();

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

        for (const invoiceSummary of invoicesData.invoices) {
            // Fetch full invoice details to get line items
            const invoiceDetailUrl = `${ctx.env.ZOHO_BOOKS_BASE_URL}/invoices/${invoiceSummary.invoice_id}?organization_id=${ctx.env.ZOHO_BOOKS_ORG_ID}`;

            const invoiceDetailResponse = await fetch(invoiceDetailUrl, {
                method: 'GET',
                headers: {
                    'Authorization': `Zoho-oauthtoken ${accessToken}`,
                    'Content-Type': 'application/json',
                },
            });

            if (!invoiceDetailResponse.ok) {
                console.warn(`Failed to fetch invoice ${invoiceSummary.invoice_number}, skipping`);
                continue;
            }

            const invoiceDetail: ZohoInvoiceDetailResponse = await invoiceDetailResponse.json();
            const invoice = invoiceDetail.invoice;

            totalInvoicesProcessed++;

            // Log the first invoice to see custom_fields structure
            if (totalInvoicesProcessed === 1) {
                console.log('Sample invoice custom_fields:', JSON.stringify({
                    invoice_number: invoice.invoice_number,
                    custom_fields: invoice.custom_fields,
                }, null, 2));
            }

            // Get the channel from the invoice custom field
            const channelName = getChannelFromInvoice(invoice);
            const channel = await getOrCreateChannel(channelName);

            // Debug: log channel info
            if (!channel || !channel.id) {
                console.error(`Channel is invalid for invoice ${invoice.invoice_number}:`, { channelName, channel });
                throw new Error(`Failed to get/create channel '${channelName}' for invoice ${invoice.invoice_number}`);
            }

            // Process each line item as a separate sale
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

                // Look up product by SKU (with caching)
                let product = productCache.get(sku);
                if (product === undefined) {
                    const foundProduct = await models.product.findOne({
                        sku: sku,
                    });
                    product = foundProduct ? { id: foundProduct.id } : null;
                    productCache.set(sku, product);
                }

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

                // Check if sale already exists by invoice number and line item
                const saleIdentifier = `${invoice.invoice_number}-${lineItem.line_item_id}`;
                const existingSales = await models.sale.findMany({
                    where: { invoiceNumber: { equals: saleIdentifier } },
                    limit: 1,
                });
                const existingSale = existingSales.length > 0 ? existingSales[0] : null;

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
