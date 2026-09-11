// Data loading for the PrintChannelBarcodes flow. Split from
// barcodeLabelHelpers so the ZPL/geometry logic there stays free of the SDK and
// testable as plain functions.

import { models, BarcodeSymbology, LabelStockSize } from '@teamkeel/sdk';
import {
    CandidateLoad,
    DEFAULT_ELEMENTS,
    LabelCandidate,
    LabelElement,
    ShipmentLabelCandidate,
    UnprintableProduct,
    checkCode,
    validateElements,
} from './barcodeLabelHelpers';

// A channel we can print labels for, flattened for the flow's picker.
export interface PrintableChannel {
    specId: string;
    channelId: string;
    channelName: string;
    symbology: BarcodeSymbology;
    // What the label carries, in print order.
    elements: LabelElement[];
    // True when the spec has no element rows of its own and is falling back to
    // DEFAULT_ELEMENTS. Surfaced rather than swallowed: a plain label prints
    // fine, so nothing else would tell the operator the channel is only
    // half set up.
    usingDefaultElements: boolean;
    // Why the channel's own elements cannot be used as they stand.
    elementProblems: string[];
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

    // Every spec's elements in one query, then grouped — one query per spec
    // would be a handful more round trips for no benefit.
    const elementRows = await models.channelLabelElement.findMany({
        where: { specId: { oneOf: specs.map((s) => s.id) } },
    });
    const elementsBySpec = new Map<string, LabelElement[]>();
    for (const row of elementRows
        .slice()
        // Position first, creation order as the tie-break — position is not
        // unique, so two rows can legitimately share one.
        .sort((a, b) => a.position - b.position || a.createdAt.getTime() - b.createdAt.getTime())) {
        const list = elementsBySpec.get(row.specId) ?? [];
        list.push({
            kind: row.kind,
            text: row.text,
            maxLines: row.maxLines,
            maxHeightMm: row.maxHeightMm,
            fontSizeMm: row.fontSizeMm,
            paddingMm: row.paddingMm,
            align: row.align,
        });
        elementsBySpec.set(row.specId, list);
    }

    const result: PrintableChannel[] = [];
    for (const spec of specs) {
        const codes = await models.productChannelCode.findMany({
            where: { channel: { id: { equals: spec.channelId } } },
        });
        const own = elementsBySpec.get(spec.id) ?? [];
        const elementProblems = own.length > 0 ? validateElements(own) : [];
        // A spec whose own elements do not make a label falls back too, rather
        // than printing something misshapen; the problems ride along so the
        // flow can name them.
        const usable = own.length > 0 && elementProblems.length === 0;

        result.push({
            specId: spec.id,
            channelId: spec.channelId,
            channelName: channelName.get(spec.channelId) ?? '—',
            symbology: spec.symbology,
            elements: usable ? own : DEFAULT_ELEMENTS,
            usingDefaultElements: !usable,
            elementProblems,
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

// ─── Shipment path ──────────────────────────────────────────────────────────

// A consignment's labelling picture: what the shipment is, which channel it
// belongs to, and its lines split by whether they can be printed.
export interface ShipmentLabelLoad {
    reference: string;
    externalId: string;
    // Null when the shipment's channel has no enabled label spec — the flow
    // needs to say that rather than showing an empty picker.
    channel: PrintableChannel | null;
    candidates: ShipmentLabelCandidate[];
    unprintable: UnprintableProduct[];
    // Lines the channel has cancelled, excluded from the run. Counted rather
    // than listed: they are not a problem to fix, just not being sent.
    cancelledLines: number;
    // Lines whose unit label the channel applies itself, or whose units carry
    // the manufacturer's own barcode. Counted for the same reason — nothing to
    // fix, just nothing for us to print.
    channelLabelledLines: number;
}

/**
 * Everything needed to print a whole consignment's unit labels.
 *
 * The channel is taken from the shipment, not chosen — a Takealot consignment
 * is labelled with Takealot's codes and nothing else.
 *
 * Label counts come from `quantitySending`, falling back to `quantityRequired`
 * for a consignment the channel has asked for but that has not been packed yet
 * (everything still sending zero). A line with neither has nothing to print.
 *
 * Cancelled lines and lines the channel labels itself are counted and left out
 * rather than reported as problems — neither is something to go and fix.
 */
export async function loadShipmentLabelCandidates(
    shipmentId: string
): Promise<ShipmentLabelLoad | null> {
    const shipment = await models.channelShipment.findOne({ id: shipmentId });
    if (!shipment) return null;

    const channels = await loadPrintableChannels();
    const channel = channels.find((c) => c.channelId === shipment.channelId) ?? null;

    const load: ShipmentLabelLoad = {
        reference: shipment.reference ?? shipment.externalId,
        externalId: shipment.externalId,
        channel,
        candidates: [],
        unprintable: [],
        cancelledLines: 0,
        channelLabelledLines: 0,
    };
    if (!channel) return load;

    const items = await models.channelShipmentItem.findMany({ where: { shipmentId } });

    const productIds = items.map((i) => i.productId).filter((id): id is string => id !== null);
    const products =
        productIds.length > 0
            ? await models.product.findMany({ where: { id: { oneOf: productIds } } })
            : [];
    const productById = new Map(products.map((p) => [p.id, p]));

    const brands = await models.brand.findMany({});
    const brandName = new Map(brands.map((b) => [b.id, b.name]));

    const codes =
        productIds.length > 0
            ? await models.productChannelCode.findMany({
                  where: { channelId: channel.channelId, productId: { oneOf: productIds } },
              })
            : [];
    const codeByProductId = new Map(codes.map((c) => [c.productId, c.code]));

    for (const item of items) {
        if (item.cancelled) {
            load.cancelledLines++;
            continue;
        }

        // Checked before the product and code checks below: a line the channel
        // labels itself has no business being reported as missing a code, and
        // on a manufacturer-barcode listing there deliberately is none.
        if (item.labelledByChannel) {
            load.channelLabelledLines++;
            continue;
        }

        // What the line is called when there is no product behind it: the SKU if
        // the channel gave one, otherwise its listing id.
        const label = item.sku ?? (item.listingRef ? `listing ${item.listingRef}` : '—');

        const product = item.productId ? productById.get(item.productId) : undefined;
        if (!product) {
            load.unprintable.push({
                sku: label,
                name: item.productName ?? '—',
                problem: 'line is not matched to a product here',
            });
            continue;
        }

        const quantity = item.quantitySending || item.quantityRequired;
        if (quantity < 1) {
            load.unprintable.push({
                sku: product.sku,
                name: product.name,
                problem: 'no units on this line',
            });
            continue;
        }

        // No code row at all reads differently from a code that is present but
        // unusable, and the fix differs too — capture one, versus correct one.
        const code = codeByProductId.get(product.id);
        if (code === undefined) {
            load.unprintable.push({
                sku: product.sku,
                name: product.name,
                problem: 'no code captured for this channel',
            });
            continue;
        }

        const check = checkCode(channel.symbology, code);
        if (!check.valid) {
            load.unprintable.push({ sku: product.sku, name: product.name, problem: check.reason });
            continue;
        }

        load.candidates.push({
            productId: product.id,
            sku: product.sku,
            name: product.name,
            brand: brandName.get(product.brandId) ?? '—',
            code: check.code,
            quantity,
        });
    }

    load.candidates.sort((a, b) => a.name.localeCompare(b.name));
    load.unprintable.sort((a, b) => a.sku.localeCompare(b.sku));

    return load;
}
