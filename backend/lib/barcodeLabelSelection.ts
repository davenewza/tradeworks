// Data loading for the PrintChannelBarcodes flow. Split from
// barcodeLabelHelpers so the ZPL/geometry logic there stays free of the SDK and
// testable as plain functions.

import { models, BarcodeSymbology, LabelStockSize, LabelAnnotationPlacement } from '@teamkeel/sdk';
import { CandidateLoad, LabelCandidate, UnprintableProduct, checkCode } from './barcodeLabelHelpers';

// A channel we can print labels for, flattened for the flow's picker.
export interface PrintableChannel {
    specId: string;
    channelId: string;
    channelName: string;
    symbology: BarcodeSymbology;
    annotation: string | null;
    annotationPlacement: LabelAnnotationPlacement;
    defaultStock: LabelStockSize;
    // How many products already carry a code for this channel — the difference
    // between "ready to print" and "configured but empty" at a glance.
    productsWithCodes: number;
}

/**
 * Channels with an enabled label spec, newest config last.
 *
 * @example
 * const channels = await loadPrintableChannels();
 */
export async function loadPrintableChannels(): Promise<PrintableChannel[]> {
    const specs = await models.channelLabelSpec.findMany({
        where: { isEnabled: { equals: true } },
    });
    if (specs.length === 0) return [];

    const channels = await models.channel.findMany({});
    const channelName = new Map(channels.map((c) => [c.id, c.name]));

    const result: PrintableChannel[] = [];
    for (const spec of specs) {
        const codes = await models.productChannelCode.findMany({
            where: { channel: { id: { equals: spec.channelId } } },
        });
        result.push({
            specId: spec.id,
            channelId: spec.channelId,
            channelName: channelName.get(spec.channelId) ?? '—',
            symbology: spec.symbology,
            annotation: spec.annotation,
            annotationPlacement: spec.annotationPlacement,
            defaultStock: spec.defaultStock,
            productsWithCodes: codes.length,
        });
    }
    result.sort((a, b) => a.channelName.localeCompare(b.channelName));
    return result;
}

/**
 * Every enabled product carrying a code for this channel, split by whether that
 * code is printable under the channel's symbology.
 *
 * `productId` narrows to a single product — the entry-action path from a product
 * page. A product with no code for the channel comes back as unprintable rather
 * than as an empty list, so the flow can say why.
 */
export async function loadLabelCandidates(
    channelId: string,
    symbology: BarcodeSymbology,
    productId?: string
): Promise<CandidateLoad> {
    const codes = await models.productChannelCode.findMany({
        where: {
            channel: { id: { equals: channelId } },
            ...(productId ? { product: { id: { equals: productId } } } : {}),
        },
    });

    const candidates: LabelCandidate[] = [];
    const unprintable: UnprintableProduct[] = [];

    if (codes.length === 0 && productId) {
        // Asked for one specific product and it has no code for this channel.
        const product = await models.product.findOne({ id: productId });
        if (product) {
            unprintable.push({
                sku: product.sku,
                name: product.name,
                problem: 'no code captured for this channel',
            });
        }
        return { candidates, unprintable };
    }

    const products = await models.product.findMany({
        where: { id: { oneOf: codes.map((c) => c.productId) }, isEnabled: { equals: true } },
    });
    const productById = new Map(products.map((p) => [p.id, p]));

    const brands = await models.brand.findMany({});
    const brandName = new Map(brands.map((b) => [b.id, b.name]));

    for (const row of codes) {
        const product = productById.get(row.productId);
        // Disabled products are filtered out above; skip rather than report them,
        // since they are intentionally out of the catalogue.
        if (!product) continue;

        const check = checkCode(symbology, row.code);
        if (check.valid) {
            candidates.push({
                productId: product.id,
                sku: product.sku,
                name: product.name,
                brand: brandName.get(product.brandId) ?? '—',
                code: check.code,
            });
        } else {
            unprintable.push({
                sku: product.sku,
                name: product.name,
                problem: check.reason,
            });
        }
    }

    candidates.sort((a, b) => a.name.localeCompare(b.name));
    unprintable.sort((a, b) => a.sku.localeCompare(b.sku));

    return { candidates, unprintable };
}

/** Units on hand for the given SKUs, for the quantity grid's reference column. */
export async function loadStockBySku(skus: string[]): Promise<Record<string, number | null>> {
    if (skus.length === 0) return {};
    const products = await models.product.findMany({ where: { sku: { oneOf: skus } } });
    return Object.fromEntries(products.map((p) => [p.sku, p.stockAvailable]));
}
