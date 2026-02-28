import { ImportProductViews, models, ViewsImportType } from '@teamkeel/sdk';

interface ParsedRow {
    sku: string;
    views: number;
}

function parseCSVLine(line: string): string[] {
    const fields: string[] = [];
    let current = '';
    let inQuotes = false;
    let i = 0;

    while (i < line.length) {
        const char = line[i];

        if (inQuotes) {
            if (char === '"') {
                if (i + 1 < line.length && line[i + 1] === '"') {
                    current += '"';
                    i += 2;
                } else {
                    inQuotes = false;
                    i++;
                }
            } else {
                current += char;
                i++;
            }
        } else {
            if (char === '"') {
                inQuotes = true;
                i++;
            } else if (char === ',') {
                fields.push(current.trim());
                current = '';
                i++;
            } else {
                current += char;
                i++;
            }
        }
    }

    fields.push(current.trim());
    return fields;
}

function parseTakealotProductSalesExport(fileContent: string): ParsedRow[] {
    const lines = fileContent.split(/\r?\n/).filter((line) => line.trim().length > 0);

    if (lines.length < 3) {
        throw new Error('File must have at least a header row, description row, and one data row');
    }

    // Row 0: headers, Row 1: descriptions, Row 2+: data
    const rows: ParsedRow[] = [];

    for (let i = 2; i < lines.length; i++) {
        const fields = parseCSVLine(lines[i]);

        // SKU is column index 1, Page Views is column index 5
        const sku = fields[1]?.trim();
        const viewsStr = fields[5]?.trim();

        if (!sku) {
            continue;
        }

        const views = parseInt(viewsStr, 10);
        if (isNaN(views)) {
            continue;
        }

        rows.push({ sku, views });
    }

    return rows;
}

function parseAmazonDetailPageSalesTraffic(fileContent: string): ParsedRow[] {
    // Strip BOM if present
    const content = fileContent.replace(/^\uFEFF/, '');
    const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);

    if (lines.length < 2) {
        throw new Error('File must have at least a header row and one data row');
    }

    // Row 0: headers, Row 1+: data (no description row)
    const rows: ParsedRow[] = [];

    for (let i = 1; i < lines.length; i++) {
        const fields = parseCSVLine(lines[i]);

        // SKU is column index 3, Sessions – Total is column index 4
        const sku = fields[3]?.trim();
        const sessionsStr = fields[4]?.trim();

        if (!sku) {
            continue;
        }

        const views = parseInt(sessionsStr, 10);
        if (isNaN(views)) {
            continue;
        }

        rows.push({ sku, views });
    }

    return rows;
}

function parseCreatespaceShopifyExport(fileContent: string): ParsedRow[] {
    // Strip BOM if present
    const content = fileContent.replace(/^\uFEFF/, '');
    const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);

    if (lines.length < 2) {
        throw new Error('File must have at least a header row and one data row');
    }

    // Row 0: headers — find SKU and Views/Sessions columns by name
    const headers = parseCSVLine(lines[0]).map((h) => h.toLowerCase());
    const skuIndex = headers.findIndex((h) => h === 'sku');
    const viewsIndex = headers.findIndex((h) => h === 'views' || h === 'sessions');

    if (skuIndex === -1) {
        throw new Error('CSV must have a "SKU" column');
    }
    if (viewsIndex === -1) {
        throw new Error('CSV must have a "Views" or "Sessions" column');
    }

    const rows: ParsedRow[] = [];

    for (let i = 1; i < lines.length; i++) {
        const fields = parseCSVLine(lines[i]);

        const sku = fields[skuIndex]?.trim();
        const viewsStr = fields[viewsIndex]?.trim();

        if (!sku) {
            continue;
        }

        const views = parseInt(viewsStr, 10);
        if (isNaN(views)) {
            continue;
        }

        rows.push({ sku, views });
    }

    return rows;
}

function getChannelName(type: ViewsImportType): string {
    switch (type) {
        case ViewsImportType.TakealotProductSalesExport:
            return "Takealot Marketplace";
        case ViewsImportType.AmazonDetailPageSalesTraffic:
            return "Amazon Marketplace";
        case ViewsImportType.CreatespaceShopifyExport:
            return "Createspace Shopify";
        default:
            throw new Error(`Unknown import type: ${type}`);
    }
}

export default ImportProductViews({}, async (ctx, inputs) => {
    const { periodType, periodStart, type } = inputs;

    const channelId = await ctx.step("resolve-channel", async () => {
        const channelName = getChannelName(type);
        const existing = await models.channel.findMany({
            where: { name: { equals: channelName } },
        });
        if (existing.length > 0) {
            return existing[0].id;
        }
        const created = await models.channel.create({ name: channelName });
        return created.id;
    }) as unknown as string;

    const parsedRows = await ctx.step("parse-file", async () => {
        const buffer = await inputs.fileContent.read();
        const content = buffer.toString("utf-8");

        let rows: ParsedRow[];
        switch (type) {
            case ViewsImportType.TakealotProductSalesExport:
                rows = parseTakealotProductSalesExport(content);
                break;
            case ViewsImportType.AmazonDetailPageSalesTraffic:
                rows = parseAmazonDetailPageSalesTraffic(content);
                break;
            case ViewsImportType.CreatespaceShopifyExport:
                rows = parseCreatespaceShopifyExport(content);
                break;
            default:
                throw new Error(`Unknown import type: ${type}`);
        }

        return rows.map(r => ({ sku: r.sku, views: r.views }));
    }) as unknown as ParsedRow[];

    if (parsedRows.length === 0) {
        throw new Error('No valid data rows found');
    }

    // Process in a single durable step
    const importResult = await ctx.step("import-views", async () => {
        // Batch lookup all products by SKU
        const allSkus = [...new Set(parsedRows.map((r) => r.sku))];
        const products = await models.product.findMany({
            where: { sku: { oneOf: allSkus } },
        });
        const productMap = new Map(products.map((p) => [p.sku, p.id]));

        // Check for existing records for this channel and period
        const existingViews = await models.productViews.findMany({
            where: {
                channel: { id: { equals: channelId } },
                periodStart: { equals: periodStart },
            },
        });
        const existingMap = new Map(
            existingViews.map((v) => [v.productId, v.id])
        );

        let created = 0;
        let updated = 0;
        let skipped = 0;
        const unmatchedSkus: string[] = [];

        for (const row of parsedRows) {
            const productId = productMap.get(row.sku);

            if (!productId) {
                unmatchedSkus.push(row.sku);
                skipped++;
                continue;
            }

            const existingId = existingMap.get(productId);

            if (existingId) {
                await models.productViews.update(
                    { id: existingId },
                    { views: row.views }
                );
                updated++;
            } else {
                const newRecord = await models.productViews.create({
                    product: { id: productId },
                    channel: { id: channelId },
                    periodType: periodType,
                    periodStart: periodStart,
                    views: row.views,
                });
                existingMap.set(productId, newRecord.id);
                created++;
            }
        }

        return { created, updated, skipped, unmatchedSkus, totalRows: parsedRows.length };
    });

    const { created, updated, skipped, unmatchedSkus, totalRows } = importResult as {
        created: number;
        updated: number;
        skipped: number;
        unmatchedSkus: string[];
        totalRows: number;
    };

    const parts: string[] = [];
    parts.push(`Processed ${totalRows} rows.`);
    if (created > 0) parts.push(`${created} new records created.`);
    if (updated > 0) parts.push(`${updated} existing records updated.`);
    if (skipped > 0) parts.push(`${skipped} rows skipped (no matching product).`);

    const content = [
        ctx.ui.display.keyValue({
            data: [
                { key: "Total rows processed", value: totalRows },
                { key: "Records created", value: created },
                { key: "Records updated", value: updated },
                { key: "Rows skipped (no product match)", value: skipped },
            ],
        }),
    ];

    if (unmatchedSkus.length > 0) {
        content.push(
            ctx.ui.display.keyValue({
                data: unmatchedSkus.slice(0, 20).map((sku) => ({
                    key: sku,
                    value: "Not found",
                })),
            })
        );
    }

    return ctx.complete({
        title: "Product views import complete",
        description: parts.join(" "),
        content,
    });
});
