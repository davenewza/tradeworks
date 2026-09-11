import { models } from '@teamkeel/sdk';
import { getOrCreateChannel } from './zohoSalesHelpers';
import { ProgressReporter } from './progress';

// The plan/apply pair behind every bulk channel-code sync: Takealot's offer
// barcodes from the Marketplace API (takealotOfferHelpers), Amazon's FNSKUs
// from a Seller Central report (amazonFnskuHelpers). A source hands over "this
// SKU carries this code on the channel"; this module diffs that against the
// stored ProductChannelCode rows and applies the difference. The rules are the
// same whichever channel is feeding it:
//   - matched by SKU, and only the named channel's rows are read or written —
//     a code on another channel is a different identifier, not a stale one;
//   - nothing is ever deleted or blanked. A SKU the source lists without a code
//     keeps whatever is stored and is surfaced in the plan instead;
//   - the apply is an upsert on the unique [product, channel] pair, so a
//     retried step updates in place rather than minting a second row.

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * One SKU's code as the channel reports it. An empty code means the channel
 * lists the SKU but holds no code for it.
 */
export interface ChannelCodeEntry {
    sku: string;
    code: string;
}

export interface ChannelCodeChange {
    sku: string;
    product: string;
    code: string;
    // The stored code being replaced; empty for a new code.
    replaces: string;
    change: 'New' | 'Update';
    productId: string;
}

export interface ChannelCodeSyncPlan {
    channelName: string;
    changes: ChannelCodeChange[];
    unchanged: number;
    // SKUs the source lists that match no product here (run Sync Products first).
    skusWithoutProduct: string[];
    // SKUs that matched a product but carry no code at the source.
    skusWithoutCode: string[];
    // Enabled products the source does not list — informational only.
    productsWithoutSource: string[];
    warnings: string[];
}

export interface ChannelCodeApplyResult {
    created: number;
    updated: number;
}

// ─── Plan pass ──────────────────────────────────────────────────────────────

/**
 * Read-only diff of a source's codes against the stored codes for one channel.
 *
 * `sourceName` is how the source is named in warnings ("Takealot", "Amazon").
 * Duplicate SKUs in the source warn and the last occurrence wins, matching the
 * fee sync's convention for duplicate Zoho SKUs.
 *
 * @example
 * const plan = await planChannelCodeSync('Amazon Marketplace', 'Amazon', [
 *   { sku: 'CS-ARD-UNO', code: 'X001ABCDEF' },
 * ]);
 * plan.changes // [{ sku: 'CS-ARD-UNO', code: 'X001ABCDEF', change: 'New', … }]
 */
export async function planChannelCodeSync(
    channelName: string,
    sourceName: string,
    entries: ChannelCodeEntry[]
): Promise<ChannelCodeSyncPlan> {
    const warnings: string[] = [];

    const codeBySku = new Map<string, string>();
    for (const entry of entries) {
        const sku = entry.sku.trim();
        if (!sku) continue;
        if (codeBySku.has(sku)) {
            warnings.push(`Duplicate SKU on ${sourceName}: ${sku} — using the last occurrence`);
        }
        codeBySku.set(sku, entry.code.trim());
    }

    const products = await models.product.findMany();
    const productBySku = new Map(products.map((p) => [p.sku, p]));

    const channels = await models.channel.findMany({ where: { name: { equals: channelName } } });
    const channel = channels.length > 0 ? channels[0] : null;

    const existingRows = channel
        ? await models.productChannelCode.findMany({ where: { channelId: channel.id } })
        : [];
    const codeByProductId = new Map(existingRows.map((r) => [r.productId, r.code]));

    const changes: ChannelCodeChange[] = [];
    const skusWithoutProduct: string[] = [];
    const skusWithoutCode: string[] = [];
    let unchanged = 0;

    for (const [sku, code] of codeBySku) {
        const product = productBySku.get(sku);
        if (!product) {
            skusWithoutProduct.push(sku);
            continue;
        }
        if (!code) {
            skusWithoutCode.push(sku);
            continue;
        }

        const current = codeByProductId.get(product.id);
        if (current === code) {
            unchanged++;
            continue;
        }

        changes.push({
            sku,
            product: product.name,
            code,
            replaces: current ?? '',
            change: current !== undefined ? 'Update' : 'New',
            productId: product.id,
        });
    }

    const productsWithoutSource = products
        .filter((p) => p.isEnabled && !codeBySku.has(p.sku))
        .map((p) => p.sku)
        .sort();

    return {
        channelName,
        changes,
        unchanged,
        skusWithoutProduct,
        skusWithoutCode,
        productsWithoutSource,
        warnings,
    };
}

// ─── Apply pass ─────────────────────────────────────────────────────────────

/**
 * Apply a plan. Idempotent: rows are keyed on the unique [product, channel]
 * pair — each product carries exactly one code per channel — so a step retry
 * updates in place rather than duplicating. Creates the channel if this is the
 * first code ever stored for it.
 */
export async function applyChannelCodeSync(
    plan: ChannelCodeSyncPlan,
    progress?: ProgressReporter
): Promise<ChannelCodeApplyResult> {
    const channel = await getOrCreateChannel(plan.channelName, new Map());

    let created = 0;
    let updated = 0;

    progress?.set({ current: 0, total: plan.changes.length, unit: 'codes', counter: 'count' });

    for (const change of plan.changes) {
        const existing = await models.productChannelCode.findMany({
            where: { productId: change.productId, channelId: channel.id },
        });

        if (existing.length > 0) {
            await models.productChannelCode.update({ id: existing[0].id }, { code: change.code });
            updated++;
        } else {
            await models.productChannelCode.create({
                productId: change.productId,
                channelId: channel.id,
                code: change.code,
            });
            created++;
        }

        progress?.increment();
        progress?.log(`${existing.length > 0 ? 'Updated' : 'Added'} code for ${change.sku} — ${change.product}`);
    }

    return { created, updated };
}
