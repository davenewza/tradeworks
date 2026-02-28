import { test, expect, beforeEach, describe } from "vitest";
import { models, flows, resetDatabase } from "@teamkeel/testing";
import { ViewsImportType, PeriodType } from "@teamkeel/sdk";

const FLOW_TIMEOUT = 15000;

// Minimal Takealot CSV header + description rows
const TAKEALOT_HEADER = "TSIN,SKU,Takealot Barcode,Product Title,Status,Page Views,Conversion Rate";
const TAKEALOT_DESCRIPTION = "Takealot Product Identifier,Seller Product Identifier,Universal barcode,Product Title,Status,Number of page views,Ratio";

function buildTakealotCSV(dataRows: string[]): string {
    return [TAKEALOT_HEADER, TAKEALOT_DESCRIPTION, ...dataRows].join("\n");
}

// Amazon Detail Page Sales and Traffic CSV header
const AMAZON_HEADER = "(Parent) ASIN,(Child) ASIN,Title,SKU,Sessions \u2013 Total,Session percentage \u2013 Total,Page views \u2013 Total,Page views percentage \u2013 Total,Featured Offer (Buy Box) percentage,Units ordered,Unit session percentage,Ordered Product Sales,Total order items";

function buildAmazonCSV(dataRows: string[], withBOM: boolean = false): string {
    const csv = [AMAZON_HEADER, ...dataRows].join("\n");
    return withBOM ? "\uFEFF" + csv : csv;
}

function toDataURL(csvContent: string, filename: string = "import.csv"): string {
    const base64 = Buffer.from(csvContent).toString("base64");
    return `data:text/csv;name=${filename};base64,${base64}`;
}

async function createTestIdentity() {
    return await models.identity.create({
        email: "test@example.com",
        issuer: "https://accounts.google.com",
    });
}

async function createTestBrand() {
    return await models.brand.create({
        name: "Test Brand",
    });
}

async function createTestProduct(brandId: string, sku: string, name: string) {
    return await models.product.create({
        name,
        sku,
        brandId,
        isEnabled: true,
    });
}

async function runImportFlow(
    identity: any,
    inputs: { periodType: PeriodType; periodStart: Date; type: ViewsImportType },
    csvContent: string,
    filename: string = "import.csv"
) {
    const executor = flows.importProductViews.withIdentity(identity);
    const run = await executor.start({
        ...inputs,
        fileContent: toDataURL(csvContent, filename),
    });
    return await executor.untilFinished(run.id, FLOW_TIMEOUT);
}

describe("ImportProductViews Flow - Takealot Product Sales Export", () => {
    beforeEach(resetDatabase);

    test("imports views for matching products", async () => {
        const identity = await createTestIdentity();
        const brand = await createTestBrand();
        const product1 = await createTestProduct(brand.id, "SKU-001", "Product One");
        const product2 = await createTestProduct(brand.id, "SKU-002", "Product Two");

        const csv = buildTakealotCSV([
            '111,SKU-001,BARCODE1,"Product One",Buyable,150,5.0',
            '222,SKU-002,BARCODE2,"Product Two",Buyable,300,10.0',
        ]);

        const finished = await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.TakealotProductSalesExport,
        }, csv);

        expect(finished.status).toBe("COMPLETED");

        const views = await models.productViews.findMany({});
        expect(views).toHaveLength(2);

        const view1 = views.find((v) => v.productId === product1.id);
        expect(view1).toBeDefined();
        expect(view1!.views).toBe(150);

        // Verify channel was auto-created
        const channels = await models.channel.findMany({});
        expect(channels).toHaveLength(1);
        expect(channels[0].name).toBe("Takealot Marketplace");
        expect(view1!.channelId).toBe(channels[0].id);

        const view2 = views.find((v) => v.productId === product2.id);
        expect(view2).toBeDefined();
        expect(view2!.views).toBe(300);
    });

    test("updates existing records on re-import for same period and channel", async () => {
        const identity = await createTestIdentity();
        const brand = await createTestBrand();
        await createTestProduct(brand.id, "SKU-001", "Product One");

        const csv1 = buildTakealotCSV([
            '111,SKU-001,BARCODE1,"Product One",Buyable,150,5.0',
        ]);

        await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.TakealotProductSalesExport,
        }, csv1);

        let views = await models.productViews.findMany({});
        expect(views).toHaveLength(1);
        expect(views[0].views).toBe(150);

        // Second import with updated views
        const csv2 = buildTakealotCSV([
            '111,SKU-001,BARCODE1,"Product One",Buyable,500,8.0',
        ]);

        await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.TakealotProductSalesExport,
        }, csv2);

        views = await models.productViews.findMany({});
        expect(views).toHaveLength(1);
        expect(views[0].views).toBe(500);
    });

    test("skips rows with unmatched SKUs", async () => {
        const identity = await createTestIdentity();
        const brand = await createTestBrand();
        await createTestProduct(brand.id, "SKU-001", "Product One");

        const csv = buildTakealotCSV([
            '111,SKU-001,BARCODE1,"Product One",Buyable,150,5.0',
            '222,SKU-MISSING,BARCODE2,"Missing Product",Buyable,300,10.0',
            '333,SKU-ALSO-MISSING,BARCODE3,"Also Missing",Buyable,50,2.0',
        ]);

        const finished = await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.TakealotProductSalesExport,
        }, csv);

        expect(finished.status).toBe("COMPLETED");

        const views = await models.productViews.findMany({});
        expect(views).toHaveLength(1);
        expect(views[0].views).toBe(150);
    });

    test("creates separate records for different months", async () => {
        const identity = await createTestIdentity();
        const brand = await createTestBrand();
        await createTestProduct(brand.id, "SKU-001", "Product One");

        const csv = buildTakealotCSV([
            '111,SKU-001,BARCODE1,"Product One",Buyable,150,5.0',
        ]);

        // Import January
        await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.TakealotProductSalesExport,
        }, csv);

        // Import February with different views
        const csv2 = buildTakealotCSV([
            '111,SKU-001,BARCODE1,"Product One",Buyable,250,7.0',
        ]);

        await runImportFlow(identity, {
            periodStart: new Date("2025-02-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.TakealotProductSalesExport,
        }, csv2);

        const views = await models.productViews.findMany({
            orderBy: { periodStart: "asc" },
        });
        expect(views).toHaveLength(2);
        expect(views[0].views).toBe(150);
        expect(views[1].views).toBe(250);
    });

    test("creates separate records for different channels", async () => {
        const identity = await createTestIdentity();
        const brand = await createTestBrand();
        await createTestProduct(brand.id, "SKU-001", "Product One");

        // Import as Takealot
        const takealotCsv = buildTakealotCSV([
            '111,SKU-001,BARCODE1,"Product One",Buyable,150,5.0',
        ]);

        await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.TakealotProductSalesExport,
        }, takealotCsv);

        // Import as Amazon
        const amazonCsv = buildAmazonCSV([
            'B0PARENT,B0CHILD,Product One,SKU-001,80,5.00%,100,6.00%,99.00%,5,5.00%,"R 500,00",5',
        ]);

        await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.AmazonDetailPageSalesTraffic,
        }, amazonCsv);

        const views = await models.productViews.findMany({});
        expect(views).toHaveLength(2);

        const channels = await models.channel.findMany({});
        const takealotChannel = channels.find((c) => c.name === "Takealot Marketplace");
        const amazonChannel = channels.find((c) => c.name === "Amazon Marketplace");

        const takealotView = views.find((v) => v.channelId === takealotChannel!.id);
        expect(takealotView!.views).toBe(150);

        const amazonView = views.find((v) => v.channelId === amazonChannel!.id);
        expect(amazonView!.views).toBe(80);
    });

    test("handles CSV with quoted fields containing commas", async () => {
        const identity = await createTestIdentity();
        const brand = await createTestBrand();
        await createTestProduct(brand.id, "RL-RA423", "Raspberry Pi");

        const csv = buildTakealotCSV([
            '58141545,RL-RA423,0652508442181,"""Raspberry Pi 3 Model A+,  RPI3-MODAP - Single Board Computer""",Disabled by Seller,42,0',
        ]);

        const finished = await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.TakealotProductSalesExport,
        }, csv);

        expect(finished.status).toBe("COMPLETED");

        const views = await models.productViews.findMany({});
        expect(views).toHaveLength(1);
        expect(views[0].views).toBe(42);
    });

    test("records zero page views", async () => {
        const identity = await createTestIdentity();
        const brand = await createTestBrand();
        await createTestProduct(brand.id, "SKU-001", "Product One");

        const csv = buildTakealotCSV([
            '111,SKU-001,BARCODE1,"Product One",Disabled by Seller,0,0',
        ]);

        const finished = await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.TakealotProductSalesExport,
        }, csv);

        expect(finished.status).toBe("COMPLETED");

        const views = await models.productViews.findMany({});
        expect(views).toHaveLength(1);
        expect(views[0].views).toBe(0);
    });

    test("handles rows with empty SKU by skipping them", async () => {
        const identity = await createTestIdentity();
        const brand = await createTestBrand();
        await createTestProduct(brand.id, "SKU-001", "Product One");

        const csv = buildTakealotCSV([
            '111,SKU-001,BARCODE1,"Product One",Buyable,150,5.0',
            '222,,BARCODE2,"No SKU Product",Buyable,300,10.0',
        ]);

        const finished = await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.TakealotProductSalesExport,
        }, csv);

        expect(finished.status).toBe("COMPLETED");

        const views = await models.productViews.findMany({});
        expect(views).toHaveLength(1);
    });

    test("handles rows with non-numeric page views by skipping them", async () => {
        const identity = await createTestIdentity();
        const brand = await createTestBrand();
        await createTestProduct(brand.id, "SKU-001", "Product One");
        await createTestProduct(brand.id, "SKU-002", "Product Two");

        const csv = buildTakealotCSV([
            '111,SKU-001,BARCODE1,"Product One",Buyable,150,5.0',
            '222,SKU-002,BARCODE2,"Product Two",Buyable,N/A,0',
        ]);

        const finished = await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.TakealotProductSalesExport,
        }, csv);

        expect(finished.status).toBe("COMPLETED");

        const views = await models.productViews.findMany({});
        expect(views).toHaveLength(1);
        expect(views[0].views).toBe(150);
    });

    test("handles many products in a single import", async () => {
        const identity = await createTestIdentity();
        const brand = await createTestBrand();

        for (let i = 1; i <= 20; i++) {
            await createTestProduct(brand.id, `SKU-${String(i).padStart(3, "0")}`, `Product ${i}`);
        }

        const dataRows: string[] = [];
        for (let i = 1; i <= 20; i++) {
            const sku = `SKU-${String(i).padStart(3, "0")}`;
            dataRows.push(`${i},${sku},BARCODE${i},"Product ${i}",Buyable,${i * 100},5.0`);
        }
        const csv = buildTakealotCSV(dataRows);

        const finished = await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.TakealotProductSalesExport,
        }, csv);

        expect(finished.status).toBe("COMPLETED");

        const views = await models.productViews.findMany({});
        expect(views).toHaveLength(20);
    });

    test("handles Windows-style line endings (CRLF)", async () => {
        const identity = await createTestIdentity();
        const brand = await createTestBrand();
        await createTestProduct(brand.id, "SKU-001", "Product One");

        const csv = [
            TAKEALOT_HEADER,
            TAKEALOT_DESCRIPTION,
            '111,SKU-001,BARCODE1,"Product One",Buyable,150,5.0',
        ].join("\r\n");

        const finished = await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.TakealotProductSalesExport,
        }, csv);

        expect(finished.status).toBe("COMPLETED");

        const views = await models.productViews.findMany({});
        expect(views).toHaveLength(1);
        expect(views[0].views).toBe(150);
    });

    test("stores correct period type and start date", async () => {
        const identity = await createTestIdentity();
        const brand = await createTestBrand();
        await createTestProduct(brand.id, "SKU-001", "Product One");

        const csv = buildTakealotCSV([
            '111,SKU-001,BARCODE1,"Product One",Buyable,150,5.0',
        ]);

        await runImportFlow(identity, {
            periodStart: new Date("2025-03-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.TakealotProductSalesExport,
        }, csv);

        const views = await models.productViews.findMany({});
        expect(views).toHaveLength(1);

        const view = views[0];
        expect(view.periodType).toBe(PeriodType.Monthly);

        // Keel Date fields return Date objects at local midnight; use local time methods
        const start = new Date(view.periodStart);
        expect(start.getFullYear()).toBe(2025);
        expect(start.getMonth()).toBe(2); // March is 2 (0-indexed)
        expect(start.getDate()).toBe(1);
    });

    test("fails when file has no data rows", async () => {
        const identity = await createTestIdentity();

        const csv = [TAKEALOT_HEADER, TAKEALOT_DESCRIPTION].join("\n");

        const finished = await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.TakealotProductSalesExport,
        }, csv);

        expect(finished.status).toBe("FAILED");
    });

    test("fails when file content is empty", async () => {
        const identity = await createTestIdentity();

        const finished = await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.TakealotProductSalesExport,
        }, "");

        expect(finished.status).toBe("FAILED");
    });

    test("handles duplicate SKUs in the same file (last value wins)", async () => {
        const identity = await createTestIdentity();
        const brand = await createTestBrand();
        await createTestProduct(brand.id, "SKU-001", "Product One");

        const csv = buildTakealotCSV([
            '111,SKU-001,BARCODE1,"Product One",Buyable,150,5.0',
            '222,SKU-001,BARCODE1,"Product One Duplicate",Buyable,300,10.0',
        ]);

        const finished = await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.TakealotProductSalesExport,
        }, csv);

        expect(finished.status).toBe("COMPLETED");

        const views = await models.productViews.findMany({});
        expect(views).toHaveLength(1);
        expect(views[0].views).toBe(300);
    });
});

describe("ImportProductViews Flow - Amazon Detail Page Sales Traffic", () => {
    beforeEach(resetDatabase);

    test("imports sessions as views for matching products", async () => {
        const identity = await createTestIdentity();
        const brand = await createTestBrand();
        const product1 = await createTestProduct(brand.id, "MEFV22G", "Micro Bit Go");
        const product2 = await createTestProduct(brand.id, "RL-AE071", "Electronics Kit");

        const csv = buildAmazonCSV([
            'B0DGTF91LY,B0BMPDJ6XD,Vis Viva BBC Micro:bit v2 Go,MEFV22G,92,5.41%,115,5.45%,99.07%,6,6.52%,"R 3 998,00",6',
            'B0D4DTR3TL,B0D4DTR3TL,Robotico Electronics Workshop Kit,RL-AE071,232,13.66%,291,13.79%,99.27%,4,1.72%,"R 1 596,00",4',
        ]);

        const finished = await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.AmazonDetailPageSalesTraffic,
        }, csv);

        expect(finished.status).toBe("COMPLETED");

        const views = await models.productViews.findMany({});
        expect(views).toHaveLength(2);

        const view1 = views.find((v) => v.productId === product1.id);
        expect(view1).toBeDefined();
        expect(view1!.views).toBe(92);

        const view2 = views.find((v) => v.productId === product2.id);
        expect(view2).toBeDefined();
        expect(view2!.views).toBe(232);
    });

    test("handles BOM character at start of file", async () => {
        const identity = await createTestIdentity();
        const brand = await createTestBrand();
        await createTestProduct(brand.id, "SKU-001", "Product One");

        const csv = buildAmazonCSV([
            'B0PARENT,B0CHILD,Product One,SKU-001,150,5.00%,200,6.00%,99.00%,10,6.67%,"R 1 000,00",10',
        ], true); // withBOM = true

        const finished = await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.AmazonDetailPageSalesTraffic,
        }, csv);

        expect(finished.status).toBe("COMPLETED");

        const views = await models.productViews.findMany({});
        expect(views).toHaveLength(1);
        expect(views[0].views).toBe(150);
    });

    test("handles CSV with quoted title containing commas", async () => {
        const identity = await createTestIdentity();
        const brand = await createTestBrand();
        await createTestProduct(brand.id, "RL-AE086", "UNO Starter Kit");

        const csv = buildAmazonCSV([
            'B0D4DWP215,B0D4DWP215,"Robotico Arduino Ultimate UNO R3 Starter Kit | Arduino-Compatible STEM Kit | DIY Robotics and Electronics Projects | Coding Kit for Beginners | Educational Gift | Kids & Adults",RL-AE086,327,19.25%,391,18.53%,97.64%,4,1.22%,"R 5 196,00",4',
        ]);

        const finished = await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.AmazonDetailPageSalesTraffic,
        }, csv);

        expect(finished.status).toBe("COMPLETED");

        const views = await models.productViews.findMany({});
        expect(views).toHaveLength(1);
        expect(views[0].views).toBe(327);
    });

    test("skips unmatched SKUs", async () => {
        const identity = await createTestIdentity();
        const brand = await createTestBrand();
        await createTestProduct(brand.id, "SKU-MATCH", "Matching Product");

        const csv = buildAmazonCSV([
            'B0PARENT,B0CHILD,Matching Product,SKU-MATCH,100,5.00%,120,6.00%,99.00%,5,5.00%,"R 500,00",5',
            'B0PARENT,B0CHILD,Missing Product,SKU-NOPE,200,10.00%,240,12.00%,98.00%,3,1.50%,"R 300,00",3',
        ]);

        const finished = await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.AmazonDetailPageSalesTraffic,
        }, csv);

        expect(finished.status).toBe("COMPLETED");

        const views = await models.productViews.findMany({});
        expect(views).toHaveLength(1);
        expect(views[0].views).toBe(100);
    });

    test("updates existing records on re-import", async () => {
        const identity = await createTestIdentity();
        const brand = await createTestBrand();
        await createTestProduct(brand.id, "SKU-001", "Product One");

        const csv1 = buildAmazonCSV([
            'B0PARENT,B0CHILD,Product One,SKU-001,100,5.00%,120,6.00%,99.00%,5,5.00%,"R 500,00",5',
        ]);

        await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.AmazonDetailPageSalesTraffic,
        }, csv1);

        let views = await models.productViews.findMany({});
        expect(views).toHaveLength(1);
        expect(views[0].views).toBe(100);

        // Re-import with higher sessions
        const csv2 = buildAmazonCSV([
            'B0PARENT,B0CHILD,Product One,SKU-001,450,15.00%,500,16.00%,99.00%,20,4.44%,"R 2 000,00",20',
        ]);

        await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.AmazonDetailPageSalesTraffic,
        }, csv2);

        views = await models.productViews.findMany({});
        expect(views).toHaveLength(1);
        expect(views[0].views).toBe(450);
    });

    test("fails when file has only header row and no data", async () => {
        const identity = await createTestIdentity();

        const finished = await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.AmazonDetailPageSalesTraffic,
        }, AMAZON_HEADER);

        expect(finished.status).toBe("FAILED");
    });
});

describe("ImportProductViews Flow - Createspace Shopify Export", () => {
    beforeEach(resetDatabase);

    test("imports views for matching products", async () => {
        const identity = await createTestIdentity();
        const brand = await createTestBrand();
        const product1 = await createTestProduct(brand.id, "SKU-001", "Product One");
        const product2 = await createTestProduct(brand.id, "SKU-002", "Product Two");

        const csv = [
            "SKU,Views",
            "SKU-001,120",
            "SKU-002,350",
        ].join("\n");

        const finished = await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.CreatespaceShopifyExport,
        }, csv);

        expect(finished.status).toBe("COMPLETED");

        const views = await models.productViews.findMany({});
        expect(views).toHaveLength(2);

        const view1 = views.find((v) => v.productId === product1.id);
        expect(view1).toBeDefined();
        expect(view1!.views).toBe(120);

        const view2 = views.find((v) => v.productId === product2.id);
        expect(view2).toBeDefined();
        expect(view2!.views).toBe(350);
    });

    test("supports 'Sessions' column name", async () => {
        const identity = await createTestIdentity();
        const brand = await createTestBrand();
        await createTestProduct(brand.id, "SKU-001", "Product One");

        const csv = [
            "Product,SKU,Sessions",
            "Product One,SKU-001,200",
        ].join("\n");

        const finished = await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.CreatespaceShopifyExport,
        }, csv);

        expect(finished.status).toBe("COMPLETED");

        const views = await models.productViews.findMany({});
        expect(views).toHaveLength(1);
        expect(views[0].views).toBe(200);
    });

    test("handles extra columns and column ordering", async () => {
        const identity = await createTestIdentity();
        const brand = await createTestBrand();
        await createTestProduct(brand.id, "ABC-123", "Widget");

        const csv = [
            "Product Title,Views,SKU,Category",
            "Widget,450,ABC-123,Electronics",
        ].join("\n");

        const finished = await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.CreatespaceShopifyExport,
        }, csv);

        expect(finished.status).toBe("COMPLETED");

        const views = await models.productViews.findMany({});
        expect(views).toHaveLength(1);
        expect(views[0].views).toBe(450);
    });

    test("skips unmatched SKUs", async () => {
        const identity = await createTestIdentity();
        const brand = await createTestBrand();
        await createTestProduct(brand.id, "SKU-001", "Product One");

        const csv = [
            "SKU,Views",
            "SKU-001,100",
            "SKU-MISSING,200",
        ].join("\n");

        const finished = await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.CreatespaceShopifyExport,
        }, csv);

        expect(finished.status).toBe("COMPLETED");

        const views = await models.productViews.findMany({});
        expect(views).toHaveLength(1);
        expect(views[0].views).toBe(100);
    });

    test("updates existing records on re-import", async () => {
        const identity = await createTestIdentity();
        const brand = await createTestBrand();
        await createTestProduct(brand.id, "SKU-001", "Product One");

        const csv1 = ["SKU,Views", "SKU-001,100"].join("\n");

        await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.CreatespaceShopifyExport,
        }, csv1);

        let views = await models.productViews.findMany({});
        expect(views).toHaveLength(1);
        expect(views[0].views).toBe(100);

        const csv2 = ["SKU,Views", "SKU-001,500"].join("\n");

        await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.CreatespaceShopifyExport,
        }, csv2);

        views = await models.productViews.findMany({});
        expect(views).toHaveLength(1);
        expect(views[0].views).toBe(500);
    });

    test("fails when CSV is missing SKU column", async () => {
        const identity = await createTestIdentity();

        const csv = ["Product,Views", "Product One,100"].join("\n");

        const finished = await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.CreatespaceShopifyExport,
        }, csv);

        expect(finished.status).toBe("FAILED");
    });

    test("fails when CSV is missing Views/Sessions column", async () => {
        const identity = await createTestIdentity();

        const csv = ["SKU,Product", "SKU-001,Product One"].join("\n");

        const finished = await runImportFlow(identity, {
            periodStart: new Date("2025-01-01"),
            periodType: PeriodType.Monthly,
            type: ViewsImportType.CreatespaceShopifyExport,
        }, csv);

        expect(finished.status).toBe("FAILED");
    });
});
