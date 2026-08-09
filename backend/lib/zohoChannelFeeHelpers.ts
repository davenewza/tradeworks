import { models, FeeMethod } from '@teamkeel/sdk';
import { getOrCreateChannel } from './zohoSalesHelpers';

// ─── Constants ──────────────────────────────────────────────────────────────

// The fee custom modules in Zoho are Takealot-specific ("TAL ..."), so synced
// fees are attached to this channel (created on first sync if missing). The
// name matches the invoice "Sales Channel" dropdown value in Zoho.
export const TAKEALOT_CHANNEL_NAME = 'Takealot Marketplace';

// Zoho Books custom modules holding Takealot's fees. Each maps to a display
// label, the method for applying it, and the Zoho field carrying its value.
// Other channels get their own modules via their own sync; the stored model
// (ChannelFee/ProductChannelFee) is channel-agnostic.
const TAKEALOT_FEE_MODULES = [
    {
        moduleName: 'cm_tal_success_fee_category',
        feeType: 'Success fee',
        method: FeeMethod.Commission,
        valueField: 'cf_percentage',
    },
    {
        moduleName: 'cm_tal_fulfill_fee_category',
        feeType: 'Fulfilment fee',
        method: FeeMethod.Flat,
        valueField: 'cf_amount',
    },
] as const;

// Item lookup custom fields pointing at the fee modules. Zoho truncates
// placeholder names at 30 characters, hence the clipped "categor".
const ITEM_FEE_PLACEHOLDERS = [
    { placeholder: 'cf_tal_success_fee_category', labelFragment: 'success fee' },
    { placeholder: 'cf_tal_fulfillment_fee_categor', labelFragment: 'fulfillment fee' },
] as const;

// ─── Zoho types ─────────────────────────────────────────────────────────────

interface ZohoModuleRecord {
    module_record_id: string;
    record_name: string;
    cf_fee_category?: string;
    cf_percentage?: number;
    cf_amount?: number;
    [key: string]: unknown;
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

// ─── Fetch: channel fees ────────────────────────────────────────────────────

// A fee as it exists in Zoho, normalised across the fee modules into a single
// value plus the method for applying it.
export interface ZohoChannelFee {
    zohoRecordId: string;
    feeType: string;
    name: string;
    method: FeeMethod;
    value: number;
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

// Pull every fee record from the Takealot fee modules, normalising each into a
// method + value labelled by fee type.
export async function fetchChannelFees(ctx: ZohoFeeCtx, accessToken: string): Promise<ZohoChannelFee[]> {
    const fees: ZohoChannelFee[] = [];

    for (const { moduleName, feeType, method, valueField } of TAKEALOT_FEE_MODULES) {
        const records = await fetchModuleRecords(ctx, accessToken, moduleName);
        for (const r of records) {
            const raw = r[valueField];
            fees.push({
                zohoRecordId: r.module_record_id,
                feeType,
                name: (r.record_name || r.cf_fee_category || '').trim(),
                method,
                value: typeof raw === 'number' ? raw : Number(raw ?? 0),
            });
        }
    }

    return fees;
}

// ─── Fetch: item fee assignments ────────────────────────────────────────────

// The fees assigned to a Zoho item (its fee-lookup custom fields), keyed by SKU.
// `feeZohoIds` is empty when the item has no fees (e.g. not sold on Takealot).
export interface ZohoItemFees {
    sku: string;
    itemName: string;
    feeZohoIds: string[];
}

// Extract the fee module record ids from an item's fee-lookup custom fields.
// Matches on the field placeholder (api name) first, falling back to the label.
export function getItemFeeAssignment(item: ZohoFeeItem): string[] {
    const feeZohoIds: string[] = [];

    for (const { placeholder, labelFragment } of ITEM_FEE_PLACEHOLDERS) {
        const field = (item.custom_fields ?? []).find(
            (cf) =>
                cf.placeholder === placeholder ||
                cf.api_name === placeholder ||
                cf.label?.toLowerCase().includes(labelFragment)
        );
        const value = field?.value == null ? '' : String(field.value).trim();
        if (value) feeZohoIds.push(value);
    }

    return feeZohoIds;
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
// Items with no fees assigned are included so a cleared fee in Zoho clears here
// too on sync.
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
                feeZohoIds: getItemFeeAssignment(item),
            });
        }

        hasMorePages = itemsData.page_context?.has_more_page ?? false;
        page++;
    }

    return assignments;
}

// ─── Read-only diff pass ────────────────────────────────────────────────────

// A single fee to add or update. `name`/`feeType`/`value`/`change` are the
// human-facing table columns; the rest is carried through hidden.
export interface FeeChange {
    name: string;
    feeType: string;
    value: string;
    change: 'New' | 'Update';
    zohoRecordId: string;
    method: FeeMethod;
    numericValue: number;
}

// A product whose set of assigned fees needs to change. `fees` is the resulting
// set (comma-joined names) for display; `feeZohoIds` is the desired set carried
// through for the apply pass.
export interface ProductFeeChange {
    sku: string;
    product: string;
    fees: string;
    change: 'New' | 'Update';
    productId: string;
    feeZohoIds: string[];
}

export interface FeeSyncPlan {
    channelName: string;
    fees: FeeChange[];
    productFees: ProductFeeChange[];
    unchangedFees: number;
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

function displayValue(fee: { method: FeeMethod; value: number }): string {
    return fee.method === FeeMethod.Commission ? `${fee.value}%` : `R${fee.value.toFixed(2)}`;
}

function sameStringSet(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false;
    for (const value of a) if (!b.has(value)) return false;
    return true;
}

// Work out what needs to change to bring our fee data in line with Zoho.
// Performs NO writes — everything is applied later in applyFeeSync(), after the
// user confirms. Fees are matched on their Zoho record id; product assignments
// are compared as sets (per product) so additions and removals both surface.
export async function computeFeeSyncPlan(
    zohoFees: ZohoChannelFee[],
    zohoItems: ZohoItemFees[]
): Promise<FeeSyncPlan> {
    const warnings: string[] = [];
    const feeByZohoId = new Map(zohoFees.map((f) => [f.zohoRecordId, f]));

    // 1. Diff fees against what we have (across all channels — zohoRecordId is
    // globally unique).
    const zohoRecordIds = zohoFees.map((f) => f.zohoRecordId);
    const existingFees =
        zohoRecordIds.length > 0
            ? await models.channelFee.findMany({ where: { zohoRecordId: { oneOf: zohoRecordIds } } })
            : [];
    const existingByZohoId = new Map(existingFees.map((f) => [f.zohoRecordId, f]));

    const fees: FeeChange[] = [];
    let unchangedFees = 0;

    for (const zohoFee of zohoFees) {
        if (!zohoFee.name) {
            warnings.push(`Skipping fee record ${zohoFee.zohoRecordId}: it has no name`);
            continue;
        }

        const existing = existingByZohoId.get(zohoFee.zohoRecordId);
        const change: FeeChange = {
            name: zohoFee.name,
            feeType: zohoFee.feeType,
            value: displayValue(zohoFee),
            change: existing ? 'Update' : 'New',
            zohoRecordId: zohoFee.zohoRecordId,
            method: zohoFee.method,
            numericValue: zohoFee.value,
        };

        if (!existing) {
            fees.push(change);
            continue;
        }

        const needsUpdate =
            existing.name !== zohoFee.name ||
            (existing.feeType ?? null) !== (zohoFee.feeType || null) ||
            existing.method !== zohoFee.method ||
            toNumberOrNull(existing.value) !== zohoFee.value;

        if (needsUpdate) {
            fees.push(change);
        } else {
            unchangedFees++;
        }
    }

    // 2. Diff product fee assignments as sets.
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

    // Existing assignments for these products, mapped back to Zoho record ids
    // and scoped to this channel's fees (so other channels are left alone).
    const productIds = existingProducts.map((p) => p.id);
    const existingRows =
        channel && productIds.length > 0
            ? await models.productChannelFee.findMany({ where: { productId: { oneOf: productIds } } })
            : [];
    const linkedFeeIds = [...new Set(existingRows.map((r) => r.channelFeeId))];
    const linkedFees =
        linkedFeeIds.length > 0
            ? await models.channelFee.findMany({ where: { id: { oneOf: linkedFeeIds } } })
            : [];
    const linkedFeeById = new Map(linkedFees.map((f) => [f.id, f]));

    const currentByProductId = new Map<string, Set<string>>();
    for (const row of existingRows) {
        const fee = linkedFeeById.get(row.channelFeeId);
        if (!fee || fee.channelId !== channel!.id) continue; // another channel → leave alone
        const set = currentByProductId.get(row.productId) ?? new Set<string>();
        set.add(fee.zohoRecordId);
        currentByProductId.set(row.productId, set);
    }

    const productFees: ProductFeeChange[] = [];
    const unmatchedSkus: string[] = [];
    let unchangedProductFees = 0;

    for (const [sku, item] of itemBySku) {
        // Resolve the desired set, dropping references to unknown fee records.
        const desired = new Set<string>();
        for (const id of item.feeZohoIds) {
            if (feeByZohoId.has(id)) desired.add(id);
            else warnings.push(`Item ${sku} references an unknown fee record (${id})`);
        }

        const product = productBySku.get(sku);
        if (!product) {
            if (desired.size > 0) unmatchedSkus.push(sku);
            continue;
        }

        const current = currentByProductId.get(product.id) ?? new Set<string>();

        if (sameStringSet(current, desired)) {
            if (desired.size > 0) unchangedProductFees++;
            continue; // both empty → nothing to record
        }

        const desiredIds = [...desired];
        productFees.push({
            sku,
            product: product.name,
            fees: desiredIds.length > 0 ? desiredIds.map((id) => feeByZohoId.get(id)!.name).join(', ') : NO_FEE,
            change: current.size > 0 ? 'Update' : 'New',
            productId: product.id,
            feeZohoIds: desiredIds,
        });
    }

    return {
        channelName: TAKEALOT_CHANNEL_NAME,
        fees,
        productFees,
        unchangedFees,
        unchangedProductFees,
        unmatchedSkus,
        warnings,
    };
}

// ─── Apply pass ─────────────────────────────────────────────────────────────

export interface FeeApplyResult {
    feesCreated: number;
    feesUpdated: number;
    assignmentsAdded: number;
    assignmentsRemoved: number;
    productsChanged: number;
}

// Apply a fee sync plan: upsert the channel and its fees, then reconcile each
// product's set of assigned fees (adding new links, removing stale ones).
// Idempotent: fees are keyed on the unique zohoRecordId and assignments on the
// unique [product, channelFee] pair, so a step retry re-derives the same result
// rather than duplicating records.
export async function applyFeeSync(plan: FeeSyncPlan): Promise<FeeApplyResult> {
    const channel = await getOrCreateChannel(plan.channelName, new Map());
    const now = new Date();

    let feesCreated = 0;
    let feesUpdated = 0;

    for (const fee of plan.fees) {
        const values = {
            channelId: channel.id,
            feeType: fee.feeType || null,
            name: fee.name,
            method: fee.method,
            value: fee.numericValue,
            synchronisedAt: now,
        };

        const existing = await models.channelFee.findOne({ zohoRecordId: fee.zohoRecordId });
        if (existing) {
            await models.channelFee.update({ id: existing.id }, values);
            feesUpdated++;
        } else {
            await models.channelFee.create({ ...values, zohoRecordId: fee.zohoRecordId });
            feesCreated++;
        }
    }

    // All fees for this channel: used to map Zoho ids → our ids and to scope
    // which of a product's existing assignments belong to this channel.
    const channelFees = await models.channelFee.findMany({ where: { channelId: channel.id } });
    const feeIdByZohoId = new Map(channelFees.map((f) => [f.zohoRecordId, f.id]));
    const channelFeeIds = new Set(channelFees.map((f) => f.id));

    let assignmentsAdded = 0;
    let assignmentsRemoved = 0;
    let productsChanged = 0;

    for (const productFee of plan.productFees) {
        const desiredIds = new Set(
            productFee.feeZohoIds.map((z) => feeIdByZohoId.get(z)).filter((id): id is string => !!id)
        );

        const existingRows = await models.productChannelFee.findMany({
            where: { productId: productFee.productId },
        });
        const inScope = existingRows.filter((r) => channelFeeIds.has(r.channelFeeId));
        const existingIds = new Set(inScope.map((r) => r.channelFeeId));

        for (const feeId of desiredIds) {
            if (!existingIds.has(feeId)) {
                await models.productChannelFee.create({
                    productId: productFee.productId,
                    channelFeeId: feeId,
                    synchronisedAt: now,
                });
                assignmentsAdded++;
            }
        }

        for (const row of inScope) {
            if (!desiredIds.has(row.channelFeeId)) {
                await models.productChannelFee.delete({ id: row.id });
                assignmentsRemoved++;
            }
        }

        productsChanged++;
    }

    return { feesCreated, feesUpdated, assignmentsAdded, assignmentsRemoved, productsChanged };
}
