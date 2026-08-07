import { models, ChannelFeeType } from '@teamkeel/sdk';
import { getOrCreateChannel } from './zohoSalesHelpers';

// ─── Constants ──────────────────────────────────────────────────────────────

// The fee custom modules in Zoho are Takealot-specific ("TAL ..."), so synced
// categories are attached to this channel (created on first sync if missing).
// The name matches the invoice "Sales Channel" dropdown value in Zoho.
export const TAKEALOT_CHANNEL_NAME = 'Takealot Marketplace';

// Zoho Books custom module API names.
const SUCCESS_FEE_MODULE = 'cm_tal_success_fee_category';
const FULFILLMENT_FEE_MODULE = 'cm_tal_fulfill_fee_category';

// Item lookup custom fields pointing at the fee modules. Zoho truncates
// placeholder names at 30 characters, hence the clipped "categor".
const ITEM_SUCCESS_FEE_PLACEHOLDER = 'cf_tal_success_fee_category';
const ITEM_FULFILLMENT_FEE_PLACEHOLDER = 'cf_tal_fulfillment_fee_categor';

// ─── Zoho types ─────────────────────────────────────────────────────────────

interface ZohoModuleRecord {
    module_record_id: string;
    record_name: string;
    status?: string;
    cf_fee_category?: string;
    cf_percentage?: number;
    cf_amount?: number;
    cf_size_category?: string;
    cf_weight_category?: string;
}

interface ZohoModuleRecordsResponse {
    module_records: ZohoModuleRecord[];
    page_context: {
        page: number;
        per_page: number;
        has_more_page: boolean;
    };
}

interface ZohoItemCustomField {
    label?: string;
    placeholder?: string;
    api_name?: string;
    value?: unknown;
}

export interface ZohoFeeItem {
    item_id: string;
    name: string;
    sku?: string;
    status?: string;
    custom_fields?: ZohoItemCustomField[];
}

interface ZohoItemsResponse {
    items: ZohoFeeItem[];
    page_context: {
        page: number;
        per_page: number;
        has_more_page: boolean;
    };
}

// The subset of the flow ctx we need for Zoho calls.
export interface ZohoFeeCtx {
    env: {
        ZOHO_ACCOUNTS_BASE_URL: string;
        ZOHO_CLIENT_ID: string;
        ZOHO_BOOKS_BASE_URL: string;
        ZOHO_BOOKS_ORG_ID: string;
    };
    secrets: { ZOHO_CLIENT_SECRET: string };
}

// ─── Authentication ─────────────────────────────────────────────────────────

export async function getZohoAccessToken(ctx: ZohoFeeCtx): Promise<string> {
    const accountsBase = ctx.env.ZOHO_ACCOUNTS_BASE_URL.replace(/\/$/, '');
    const clientId = ctx.env.ZOHO_CLIENT_ID;
    const clientSecret = ctx.secrets.ZOHO_CLIENT_SECRET;

    // settings.READ covers /items; custommodules.ALL covers the fee modules
    // (Zoho offers no READ-only scope for custom modules).
    const url = `${accountsBase}/oauth/v2/token?client_id=${encodeURIComponent(
        clientId
    )}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials&scope=${encodeURIComponent(
        'ZohoBooks.settings.READ,ZohoBooks.custommodules.ALL'
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

// ─── Fetch: fee category records ────────────────────────────────────────────

// A fee category as it exists in Zoho, normalised across the two modules.
export interface ZohoFeeCategory {
    zohoRecordId: string;
    feeType: ChannelFeeType;
    name: string;
    percentage: number | null;
    amount: number | null;
    sizeCategory: string | null;
    weightCategory: string | null;
}

async function fetchModuleRecords(
    ctx: ZohoFeeCtx,
    accessToken: string,
    moduleName: string
): Promise<ZohoModuleRecord[]> {
    const records: ZohoModuleRecord[] = [];
    let page = 1;
    let hasMorePages = true;

    while (hasMorePages) {
        const url = `${ctx.env.ZOHO_BOOKS_BASE_URL}/${moduleName}?organization_id=${ctx.env.ZOHO_BOOKS_ORG_ID}&page=${page}&per_page=200`;

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Authorization': `Zoho-oauthtoken ${accessToken}`,
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to fetch ${moduleName} records from Zoho: ${response.status} - ${errorText}`);
        }

        const data: ZohoModuleRecordsResponse = await response.json();
        records.push(...(data.module_records ?? []));
        hasMorePages = data.page_context?.has_more_page ?? false;
        page++;
    }

    return records;
}

export async function fetchFeeCategories(ctx: ZohoFeeCtx, accessToken: string): Promise<ZohoFeeCategory[]> {
    const successRecords = await fetchModuleRecords(ctx, accessToken, SUCCESS_FEE_MODULE);
    const fulfillmentRecords = await fetchModuleRecords(ctx, accessToken, FULFILLMENT_FEE_MODULE);

    return [
        ...successRecords.map((r) => ({
            zohoRecordId: r.module_record_id,
            feeType: ChannelFeeType.SuccessFee,
            name: (r.record_name || r.cf_fee_category || '').trim(),
            percentage: r.cf_percentage ?? null,
            amount: null,
            sizeCategory: null,
            weightCategory: null,
        })),
        ...fulfillmentRecords.map((r) => ({
            zohoRecordId: r.module_record_id,
            feeType: ChannelFeeType.FulfillmentFee,
            name: (r.record_name || r.cf_fee_category || '').trim(),
            percentage: null,
            amount: r.cf_amount ?? null,
            sizeCategory: r.cf_size_category?.trim() || null,
            weightCategory: r.cf_weight_category?.trim() || null,
        })),
    ];
}

// ─── Fetch: item fee assignments ────────────────────────────────────────────

// The fee lookups set on a Zoho item, keyed by the item's SKU. Both ids are
// null when the item has no fees assigned (e.g. not sold on Takealot).
export interface ZohoItemFees {
    sku: string;
    itemName: string;
    successFeeZohoId: string | null;
    fulfillmentFeeZohoId: string | null;
}

// Extract the fee module record ids from an item's custom fields. Matches on
// the field placeholder (api name) first, falling back to the label.
export function getItemFeeAssignment(item: ZohoFeeItem): {
    successFeeZohoId: string | null;
    fulfillmentFeeZohoId: string | null;
} {
    const findValue = (placeholder: string, labelFragment: string): string | null => {
        const field = (item.custom_fields ?? []).find(
            (cf) =>
                cf.placeholder === placeholder ||
                cf.api_name === placeholder ||
                cf.label?.toLowerCase().includes(labelFragment)
        );
        const value = field?.value == null ? '' : String(field.value).trim();
        return value ? value : null;
    };

    return {
        successFeeZohoId: findValue(ITEM_SUCCESS_FEE_PLACEHOLDER, 'success fee'),
        fulfillmentFeeZohoId: findValue(ITEM_FULFILLMENT_FEE_PLACEHOLDER, 'fulfillment fee'),
    };
}

// Fetch full item details in bulk to obtain custom_fields (the list endpoint
// omits them).
async function fetchItemDetails(
    ctx: ZohoFeeCtx,
    accessToken: string,
    itemIds: string[]
): Promise<Map<string, ZohoFeeItem>> {
    const itemMap = new Map<string, ZohoFeeItem>();
    if (itemIds.length === 0) return itemMap;

    const detailsUrl = `${ctx.env.ZOHO_BOOKS_BASE_URL}/itemdetails?organization_id=${ctx.env.ZOHO_BOOKS_ORG_ID}&item_ids=${itemIds.join(',')}`;

    const detailsResponse = await fetch(detailsUrl, {
        method: 'GET',
        headers: {
            'Authorization': `Zoho-oauthtoken ${accessToken}`,
            'Content-Type': 'application/json',
        },
    });

    if (!detailsResponse.ok) {
        console.warn(`Failed to fetch item details: ${detailsResponse.status}`);
        return itemMap;
    }

    const detailsData: { items: ZohoFeeItem[] } = await detailsResponse.json();
    for (const item of detailsData.items) {
        itemMap.set(item.item_id, item);
    }
    return itemMap;
}

// Pull every active item (with SKU) from Zoho along with its fee assignments.
// Items with no fees assigned are included so a cleared fee in Zoho clears
// here too on sync.
export async function fetchItemFeeAssignments(ctx: ZohoFeeCtx, accessToken: string): Promise<ZohoItemFees[]> {
    const assignments: ZohoItemFees[] = [];
    let page = 1;
    let hasMorePages = true;

    while (hasMorePages) {
        const itemsUrl = `${ctx.env.ZOHO_BOOKS_BASE_URL}/items?organization_id=${ctx.env.ZOHO_BOOKS_ORG_ID}&filter_by=Status.Active&page=${page}&per_page=200`;

        const itemsResponse = await fetch(itemsUrl, {
            method: 'GET',
            headers: {
                'Authorization': `Zoho-oauthtoken ${accessToken}`,
                'Content-Type': 'application/json',
            },
        });

        if (!itemsResponse.ok) {
            const errorText = await itemsResponse.text();
            throw new Error(`Failed to fetch items from Zoho: ${itemsResponse.status} - ${errorText}`);
        }

        const itemsData: ZohoItemsResponse = await itemsResponse.json();

        const itemIds = itemsData.items
            .filter((item) => item.sku?.trim())
            .map((item) => item.item_id);
        const detailsMap = await fetchItemDetails(ctx, accessToken, itemIds);

        for (const listItem of itemsData.items) {
            const sku = listItem.sku?.trim();
            if (!sku) continue;
            if (listItem.status?.toLowerCase() === 'inactive') continue;
            const item = detailsMap.get(listItem.item_id) || listItem;
            assignments.push({
                sku,
                itemName: item.name,
                ...getItemFeeAssignment(item),
            });
        }

        hasMorePages = itemsData.page_context?.has_more_page ?? false;
        page++;
    }

    return assignments;
}

// ─── Read-only diff pass ────────────────────────────────────────────────────

// A single fee category to add or update. `name`/`type`/`value`/`change` are
// the human-facing table columns; the rest is carried through hidden.
export interface FeeCategoryChange {
    name: string;
    type: string;
    value: string;
    change: 'New' | 'Update';
    zohoRecordId: string;
    feeType: ChannelFeeType;
    percentage: number | null;
    amount: number | null;
    sizeCategory: string | null;
    weightCategory: string | null;
}

// A single product fee assignment to add or update. `sku`/`product`/
// `successFee`/`fulfillmentFee`/`change` are the table columns.
export interface ProductFeeChange {
    sku: string;
    product: string;
    successFee: string;
    fulfillmentFee: string;
    change: 'New' | 'Update';
    productId: string;
    successFeeZohoId: string | null;
    fulfillmentFeeZohoId: string | null;
}

export interface FeeSyncPlan {
    channelName: string;
    categories: FeeCategoryChange[];
    productFees: ProductFeeChange[];
    unchangedCategories: number;
    unchangedProductFees: number;
    // Zoho items that have fees but no matching product in our system.
    unmatchedSkus: string[];
    warnings: string[];
}

const NO_FEE = '—';

function toNumberOrNull(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    return Number(value);
}

function displayValue(category: ZohoFeeCategory): string {
    if (category.feeType === ChannelFeeType.SuccessFee) {
        return category.percentage === null ? NO_FEE : `${category.percentage}%`;
    }
    return category.amount === null ? NO_FEE : `R${category.amount.toFixed(2)}`;
}

function displayType(feeType: ChannelFeeType): string {
    return feeType === ChannelFeeType.SuccessFee ? 'Success fee' : 'Fulfillment fee';
}

// Work out what needs to change to bring our fee data in line with Zoho.
// Performs NO writes — everything is applied later in applyFeeSync(), after
// the user confirms. Categories are matched on their Zoho record id and
// product assignments on SKU; rows that already match Zoho are only counted.
export async function computeFeeSyncPlan(
    zohoCategories: ZohoFeeCategory[],
    zohoItems: ZohoItemFees[]
): Promise<FeeSyncPlan> {
    const warnings: string[] = [];
    const categoryByZohoId = new Map(zohoCategories.map((c) => [c.zohoRecordId, c]));

    // 1. Diff fee categories against what we have (across all channels —
    // zohoRecordId is globally unique).
    const zohoRecordIds = zohoCategories.map((c) => c.zohoRecordId);
    const existingCategories =
        zohoRecordIds.length > 0
            ? await models.channelFeeCategory.findMany({ where: { zohoRecordId: { oneOf: zohoRecordIds } } })
            : [];
    const existingByZohoId = new Map(existingCategories.map((c) => [c.zohoRecordId, c]));

    const categories: FeeCategoryChange[] = [];
    let unchangedCategories = 0;

    for (const zohoCategory of zohoCategories) {
        if (!zohoCategory.name) {
            warnings.push(`Skipping fee record ${zohoCategory.zohoRecordId}: it has no name`);
            continue;
        }

        const existing = existingByZohoId.get(zohoCategory.zohoRecordId);
        const change: FeeCategoryChange = {
            name: zohoCategory.name,
            type: displayType(zohoCategory.feeType),
            value: displayValue(zohoCategory),
            change: existing ? 'Update' : 'New',
            zohoRecordId: zohoCategory.zohoRecordId,
            feeType: zohoCategory.feeType,
            percentage: zohoCategory.percentage,
            amount: zohoCategory.amount,
            sizeCategory: zohoCategory.sizeCategory,
            weightCategory: zohoCategory.weightCategory,
        };

        if (!existing) {
            categories.push(change);
            continue;
        }

        const needsUpdate =
            existing.name !== zohoCategory.name ||
            existing.feeType !== zohoCategory.feeType ||
            toNumberOrNull(existing.percentage) !== zohoCategory.percentage ||
            toNumberOrNull(existing.amount) !== zohoCategory.amount ||
            (existing.sizeCategory ?? null) !== zohoCategory.sizeCategory ||
            (existing.weightCategory ?? null) !== zohoCategory.weightCategory;

        if (needsUpdate) {
            categories.push(change);
        } else {
            unchangedCategories++;
        }
    }

    // 2. Diff product fee assignments. Existing rows reference our category
    // ids, so map them back to Zoho record ids for comparison.
    const itemBySku = new Map<string, ZohoItemFees>();
    for (const item of zohoItems) {
        if (itemBySku.has(item.sku)) {
            warnings.push(`Duplicate SKU in Zoho: ${item.sku} — using the last occurrence`);
        }
        itemBySku.set(item.sku, item);
    }

    const skus = [...itemBySku.keys()];
    const existingProducts =
        skus.length > 0 ? await models.product.findMany({ where: { sku: { oneOf: skus } } }) : [];
    const productBySku = new Map(existingProducts.map((p) => [p.sku, p]));

    const channels = await models.channel.findMany({ where: { name: { equals: TAKEALOT_CHANNEL_NAME } } });
    const channel = channels.length > 0 ? channels[0] : null;

    const existingRows = channel
        ? await models.productChannelFee.findMany({ where: { channelId: channel.id } })
        : [];
    const rowByProductId = new Map(existingRows.map((r) => [r.productId, r]));

    // Categories referenced by existing rows may predate this sync, so map ids
    // to Zoho record ids across the whole table.
    const referencedCategoryIds = [
        ...new Set(
            existingRows
                .flatMap((r) => [r.successFeeCategoryId, r.fulfillmentFeeCategoryId])
                .filter((id): id is string => id !== null)
        ),
    ];
    const referencedCategories =
        referencedCategoryIds.length > 0
            ? await models.channelFeeCategory.findMany({ where: { id: { oneOf: referencedCategoryIds } } })
            : [];
    const zohoIdByCategoryId = new Map(referencedCategories.map((c) => [c.id, c.zohoRecordId]));

    const productFees: ProductFeeChange[] = [];
    const unmatchedSkus: string[] = [];
    let unchangedProductFees = 0;

    for (const [sku, item] of itemBySku) {
        // Resolve dangling references (an item pointing at a deleted fee
        // record) to "no fee" rather than failing the whole sync.
        let successFeeZohoId = item.successFeeZohoId;
        if (successFeeZohoId && !categoryByZohoId.has(successFeeZohoId)) {
            warnings.push(`Item ${sku} references an unknown success fee record (${successFeeZohoId})`);
            successFeeZohoId = null;
        }
        let fulfillmentFeeZohoId = item.fulfillmentFeeZohoId;
        if (fulfillmentFeeZohoId && !categoryByZohoId.has(fulfillmentFeeZohoId)) {
            warnings.push(`Item ${sku} references an unknown fulfillment fee record (${fulfillmentFeeZohoId})`);
            fulfillmentFeeZohoId = null;
        }

        const hasAnyFee = successFeeZohoId !== null || fulfillmentFeeZohoId !== null;

        const product = productBySku.get(sku);
        if (!product) {
            if (hasAnyFee) unmatchedSkus.push(sku);
            continue;
        }

        const existingRow = rowByProductId.get(product.id);
        if (!existingRow) {
            // No row and no fees → nothing worth recording.
            if (!hasAnyFee) continue;
        } else {
            const currentSuccessZohoId = existingRow.successFeeCategoryId
                ? zohoIdByCategoryId.get(existingRow.successFeeCategoryId) ?? null
                : null;
            const currentFulfillmentZohoId = existingRow.fulfillmentFeeCategoryId
                ? zohoIdByCategoryId.get(existingRow.fulfillmentFeeCategoryId) ?? null
                : null;
            if (currentSuccessZohoId === successFeeZohoId && currentFulfillmentZohoId === fulfillmentFeeZohoId) {
                unchangedProductFees++;
                continue;
            }
        }

        productFees.push({
            sku,
            product: product.name,
            successFee: successFeeZohoId ? categoryByZohoId.get(successFeeZohoId)!.name : NO_FEE,
            fulfillmentFee: fulfillmentFeeZohoId ? categoryByZohoId.get(fulfillmentFeeZohoId)!.name : NO_FEE,
            change: rowByProductId.has(product.id) ? 'Update' : 'New',
            productId: product.id,
            successFeeZohoId,
            fulfillmentFeeZohoId,
        });
    }

    return {
        channelName: TAKEALOT_CHANNEL_NAME,
        categories,
        productFees,
        unchangedCategories,
        unchangedProductFees,
        unmatchedSkus,
        warnings,
    };
}

// ─── Apply pass ─────────────────────────────────────────────────────────────

export interface FeeApplyResult {
    categoriesCreated: number;
    categoriesUpdated: number;
    productFeesCreated: number;
    productFeesUpdated: number;
}

// Apply a fee sync plan: upsert the channel, its fee categories, and the
// per-product assignments. Idempotent: categories are keyed on the unique
// zohoRecordId and assignments on the unique [product, channel] pair, so a
// step retry re-derives the same result rather than duplicating records.
export async function applyFeeSync(plan: FeeSyncPlan): Promise<FeeApplyResult> {
    const channel = await getOrCreateChannel(plan.channelName, new Map());
    const now = new Date();

    let categoriesCreated = 0;
    let categoriesUpdated = 0;

    for (const category of plan.categories) {
        const values = {
            channelId: channel.id,
            feeType: category.feeType,
            name: category.name,
            percentage: category.percentage,
            amount: category.amount,
            sizeCategory: category.sizeCategory,
            weightCategory: category.weightCategory,
            synchronisedAt: now,
        };

        const existing = await models.channelFeeCategory.findOne({ zohoRecordId: category.zohoRecordId });
        if (existing) {
            await models.channelFeeCategory.update({ id: existing.id }, values);
            categoriesUpdated++;
        } else {
            await models.channelFeeCategory.create({ ...values, zohoRecordId: category.zohoRecordId });
            categoriesCreated++;
        }
    }

    // Resolve the category ids referenced by the assignments (some were just
    // created above, others already existed).
    const referencedZohoIds = [
        ...new Set(
            plan.productFees
                .flatMap((pf) => [pf.successFeeZohoId, pf.fulfillmentFeeZohoId])
                .filter((id): id is string => id !== null)
        ),
    ];
    const referencedCategories =
        referencedZohoIds.length > 0
            ? await models.channelFeeCategory.findMany({ where: { zohoRecordId: { oneOf: referencedZohoIds } } })
            : [];
    const categoryIdByZohoId = new Map(referencedCategories.map((c) => [c.zohoRecordId, c.id]));

    let productFeesCreated = 0;
    let productFeesUpdated = 0;

    for (const productFee of plan.productFees) {
        const successFeeCategoryId = productFee.successFeeZohoId
            ? categoryIdByZohoId.get(productFee.successFeeZohoId) ?? null
            : null;
        const fulfillmentFeeCategoryId = productFee.fulfillmentFeeZohoId
            ? categoryIdByZohoId.get(productFee.fulfillmentFeeZohoId) ?? null
            : null;

        const existing = await models.productChannelFee.findMany({
            where: { productId: productFee.productId, channelId: channel.id },
            limit: 1,
        });

        if (existing.length > 0) {
            await models.productChannelFee.update(
                { id: existing[0].id },
                { successFeeCategoryId, fulfillmentFeeCategoryId, synchronisedAt: now }
            );
            productFeesUpdated++;
        } else {
            await models.productChannelFee.create({
                productId: productFee.productId,
                channelId: channel.id,
                successFeeCategoryId,
                fulfillmentFeeCategoryId,
                synchronisedAt: now,
            });
            productFeesCreated++;
        }
    }

    return { categoriesCreated, categoriesUpdated, productFeesCreated, productFeesUpdated };
}
