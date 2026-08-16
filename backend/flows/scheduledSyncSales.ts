import { ScheduledSyncSales, models } from '@teamkeel/sdk';
import {
    ZohoInvoicesResponse,
    getZohoAccessToken,
    getChannelFromInvoice,
    fetchInvoiceDetailsBatch,
    formatModifiedSince,
    processInvoiceLineItems,
    isZohoDailyRateLimit,
    partitionInvoicesByChange,
} from '../lib/zohoSalesHelpers';

const LOOKBACK_HOURS = 48;

export default ScheduledSyncSales({}, async (ctx) => {
    const now = new Date();
    // Sweep by last-modified rather than invoice date, so edits to older invoices
    // (refunds, late status/payment changes) are picked up — not just recent dates.
    const modifiedSince = formatModifiedSince(new Date(now.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000));

    console.log(`Scheduled sync: invoices modified since ${modifiedSince}`);

    const accessToken = await ctx.step("authenticate", async () => {
        return await getZohoAccessToken(ctx);
    });

    let totalInvoicesProcessed = 0;
    let salesCreated = 0;
    let salesUpdated = 0;
    let totalSkippedUnchanged = 0;

    const channelCache = new Map<string, { id: string }>();

    let page = 1;
    let hasMorePages = true;
    let invoiceDetailFailures = 0;
    let salePersistFailures = 0;
    let rateLimited = false;

    while (hasMorePages) {
        const currentPage = page;

        const pageResult = await ctx.step(`sync-page-${currentPage}`, async () => {
            const invoicesUrl = `${ctx.env.ZOHO_BOOKS_BASE_URL}/invoices?organization_id=${ctx.env.ZOHO_BOOKS_ORG_ID}&last_modified_time=${modifiedSince.replace('+', '%2B')}&page=${currentPage}&per_page=200`;

            const invoicesResponse = await fetch(invoicesUrl, {
                method: 'GET',
                headers: {
                    'Authorization': `Zoho-oauthtoken ${accessToken}`,
                    'Content-Type': 'application/json',
                },
            });

            if (!invoicesResponse.ok) {
                const errorText = await invoicesResponse.text();
                // Daily quota reached — pause cleanly and resume next run rather
                // than failing the whole sync.
                if (isZohoDailyRateLimit(invoicesResponse.status, errorText)) {
                    return { hasMorePages: false, rateLimited: true, invoicesProcessed: 0, created: 0, updated: 0, detailFailures: 0, persistFailures: 0, skippedUnchanged: 0 };
                }
                throw new Error(`Failed to fetch invoices from Zoho: ${invoicesResponse.status} - ${errorText}`);
            }

            const invoicesData: ZohoInvoicesResponse = await invoicesResponse.json();
            const summaries = invoicesData.invoices;

            // Existing sales for the invoices on this page — for dedup and for the
            // unchanged-skip decision. Built from the LIST summaries, before any
            // detail call.
            const listInvoiceNumbers = new Set<string>();
            for (const summary of summaries) {
                listInvoiceNumbers.add(summary.invoice_number);
            }

            const existingSalesMap = new Map<string, { id: string; quantity: number; price: any; productId: string | null }>();
            const storedModifiedByInvoice = new Map<string, string | null>();
            if (listInvoiceNumbers.size > 0) {
                const existingSales = await models.sale.findMany({
                    where: { invoiceNumber: { oneOf: Array.from(listInvoiceNumbers) } },
                });
                for (const sale of existingSales) {
                    // Key by the stable lineKey (matches processInvoiceLineItems).
                    existingSalesMap.set(`${sale.invoiceNumber}-${sale.lineKey}`, {
                        id: sale.id,
                        quantity: sale.quantity,
                        price: sale.price,
                        productId: sale.productId,
                    });
                    storedModifiedByInvoice.set(sale.invoiceNumber, sale.zohoModifiedTime);
                }
            }

            // Skip invoices we already hold at their current version — the main
            // saving on Zoho's daily API quota.
            const { toFetch, skipped } = partitionInvoicesByChange(summaries, storedModifiedByInvoice);

            const invoiceDetailResult = await fetchInvoiceDetailsBatch(
                toFetch,
                ctx.env.ZOHO_BOOKS_BASE_URL,
                ctx.env.ZOHO_BOOKS_ORG_ID,
                accessToken
            );
            const invoices = invoiceDetailResult.invoices;

            let pageCreated = 0;
            let pageUpdated = 0;
            const pageDetailFailures = invoiceDetailResult.failures;
            let pagePersistFailures = 0;

            // Products for the fetched invoices.
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
                rateLimited: invoiceDetailResult.rateLimited,
                invoicesProcessed: invoices.length,
                created: pageCreated,
                updated: pageUpdated,
                detailFailures: pageDetailFailures,
                persistFailures: pagePersistFailures,
                skippedUnchanged: skipped,
            };
        });

        totalInvoicesProcessed += pageResult!.invoicesProcessed as number;
        salesCreated += pageResult!.created as number;
        salesUpdated += pageResult!.updated as number;
        invoiceDetailFailures += pageResult!.detailFailures as number;
        salePersistFailures += pageResult!.persistFailures as number;
        totalSkippedUnchanged += pageResult!.skippedUnchanged as number;

        if (pageResult!.rateLimited as boolean) {
            rateLimited = true;
            break;
        }

        hasMorePages = pageResult!.hasMorePages as boolean;
        page++;
    }

    // A rate-limit pause is expected and recoverable (resumes next run), so it is
    // NOT an error. Only genuine failures fail the flow.
    if (!rateLimited && (invoiceDetailFailures > 0 || salePersistFailures > 0)) {
        console.error(
            `ScheduledSyncSales completed with errors. Invoice detail failures: ${invoiceDetailFailures}. Sale persist failures: ${salePersistFailures}.`
        );
        throw new Error(
            `ScheduledSyncSales completed with errors. Invoice detail failures: ${invoiceDetailFailures}. Sale persist failures: ${salePersistFailures}.`
        );
    }

    return ctx.complete({
        title: rateLimited ? "Scheduled sales sync paused — Zoho daily API limit reached" : "Scheduled sales sync complete",
        content: [
            ctx.ui.display.keyValue({
                data: [
                    ...(rateLimited ? [{ key: "Status", value: "Paused at Zoho's daily API limit — the next run resumes where this stopped." }] : []),
                    { key: "Modified since", value: modifiedSince },
                    { key: "Invoices processed", value: totalInvoicesProcessed },
                    { key: "Unchanged skipped", value: totalSkippedUnchanged },
                    { key: "Sales created", value: salesCreated },
                    { key: "Sales updated", value: salesUpdated },
                ],
            }),
        ],
    });
});
