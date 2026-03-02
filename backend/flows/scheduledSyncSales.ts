import { ScheduledSyncSales, models } from '@teamkeel/sdk';
import {
    ZohoInvoicesResponse,
    getZohoAccessToken,
    getChannelFromInvoice,
    fetchInvoiceDetailsBatch,
    formatDate,
    processInvoiceLineItems,
} from '../lib/zohoSalesHelpers';

const LOOKBACK_HOURS = 48;

export default ScheduledSyncSales({}, async (ctx) => {
    const now = new Date();
    const start = new Date(now.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000);
    const startDate = formatDate(start);
    const endDate = formatDate(now);

    console.log(`Scheduled sync: ${startDate} to ${endDate}`);

    const accessToken = await ctx.step("authenticate", async () => {
        return await getZohoAccessToken(ctx);
    });

    let totalInvoicesProcessed = 0;
    let salesCreated = 0;
    let salesUpdated = 0;

    const channelCache = new Map<string, { id: string }>();

    let page = 1;
    let hasMorePages = true;
    let invoiceDetailFailures = 0;
    let salePersistFailures = 0;

    while (hasMorePages) {
        const currentPage = page;

        const pageResult = await ctx.step(`sync-page-${currentPage}`, async () => {
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

            // Batch fetch products and existing sales for efficiency
            const allSkus = new Set<string>();
            for (const invoice of invoices) {
                for (const lineItem of invoice.line_items) {
                    const sku = lineItem.sku?.trim();
                    if (sku) {
                        allSkus.add(sku);
                    }
                }
            }

            const productMap = new Map<string, { id: string }>();
            if (allSkus.size > 0) {
                const products = await models.product.findMany({
                    where: { sku: { oneOf: Array.from(allSkus) } },
                });
                for (const product of products) {
                    productMap.set(product.sku, { id: product.id });
                }
            }

            const allInvoiceNumbers = new Set<string>();
            for (const invoice of invoices) {
                allInvoiceNumbers.add(invoice.invoice_number);
            }

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

            // Pre-fetch/create channels
            const channelNames = new Set<string>();
            for (const invoice of invoices) {
                channelNames.add(getChannelFromInvoice(invoice));
            }
            for (const channelName of channelNames) {
                const existing = await models.channel.findMany({ where: { name: channelName } });
                if (existing.length > 0) {
                    channelCache.set(channelName, { id: existing[0].id });
                } else {
                    const created = await models.channel.create({ name: channelName });
                    channelCache.set(channelName, { id: created.id });
                }
            }

            for (const invoice of invoices) {
                const invoiceResult = await processInvoiceLineItems(invoice, channelCache, {
                    productMap,
                    existingSalesMap,
                });
                pageCreated += invoiceResult.created;
                pageUpdated += invoiceResult.updated;
                pagePersistFailures += invoiceResult.skipped;
                for (const error of invoiceResult.errors) {
                    console.error(error);
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
            `ScheduledSyncSales completed with errors. Invoice detail failures: ${invoiceDetailFailures}. Sale persist failures: ${salePersistFailures}.`
        );
        throw new Error(
            `ScheduledSyncSales completed with errors. Invoice detail failures: ${invoiceDetailFailures}. Sale persist failures: ${salePersistFailures}.`
        );
    }

    return ctx.complete({
        title: "Scheduled sales sync complete",
        content: [
            ctx.ui.display.keyValue({
                data: [
                    { key: "Date range", value: `${startDate} to ${endDate}` },
                    { key: "Invoices processed", value: totalInvoicesProcessed },
                    { key: "Sales created", value: salesCreated },
                    { key: "Sales updated", value: salesUpdated },
                ],
            }),
        ],
    });
});
