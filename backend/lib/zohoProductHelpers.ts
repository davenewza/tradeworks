import { models } from '@teamkeel/sdk';

// ─── Zoho types ─────────────────────────────────────────────────────────────

interface ZohoCustomField {
    customfield_id: string;
    label: string;
    value: string;
}

export interface ZohoItem {
    item_id: string;
    name: string;
    sku: string;
    status: string;
    custom_fields?: ZohoCustomField[];
}

interface ZohoItemsResponse {
    items: ZohoItem[];
    page_context: {
        page: number;
        per_page: number;
        has_more_page: boolean;
    };
}

interface ZohoItemDetailsResponse {
    items: ZohoItem[];
}

interface ZohoTokenResponse {
    access_token: string;
    token_type: string;
    expires_in: number;
}

// The subset of the flow ctx we need for Zoho calls.
export interface ZohoProductCtx {
    env: {
        ZOHO_ACCOUNTS_BASE_URL: string;
        ZOHO_CLIENT_ID: string;
        ZOHO_BOOKS_BASE_URL: string;
        ZOHO_BOOKS_ORG_ID: string;
    };
    secrets: { ZOHO_CLIENT_SECRET: string };
}

// A single add/update candidate produced by the read-only diff pass. All fields
// are JSON-serializable so the whole array can flow through ctx.step() and
// ctx.ui.select.table() unchanged. `sku`/`name`/`brand`/`change` are the
// human-facing columns; `zohoItemId`/`action` are carried through hidden.
export interface SyncCandidate {
    sku: string;
    name: string;
    brand: string;
    change: 'New' | 'Update';
    zohoItemId: string;
    action: 'create' | 'update';
}

// ─── Authentication ───────────────────────────────────────────────────────

export async function getZohoAccessToken(ctx: ZohoProductCtx): Promise<string> {
    const accountsBase = ctx.env.ZOHO_ACCOUNTS_BASE_URL.replace(/\/$/, '');
    const clientId = ctx.env.ZOHO_CLIENT_ID;
    const clientSecret = ctx.secrets.ZOHO_CLIENT_SECRET;

    const url = `${accountsBase}/oauth/v2/token?client_id=${encodeURIComponent(
        clientId
    )}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials&scope=${encodeURIComponent(
        'ZohoBooks.settings.READ'
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

    const tokenData: ZohoTokenResponse = await response.json();
    if (!tokenData.access_token) {
        throw new Error(`Zoho OAuth token response missing access_token: ${JSON.stringify(tokenData)}`);
    }
    return tokenData.access_token;
}

// ─── Brand helpers ────────────────────────────────────────────────────────

// Extract the brand name from a Zoho item's custom fields, defaulting to 'Other'.
export function getBrandFromItem(item: ZohoItem): string {
    if (!item.custom_fields || item.custom_fields.length === 0) {
        return 'Other';
    }
    const brandField = item.custom_fields.find(
        (cf) =>
            cf.label?.toLowerCase() === 'brand' ||
            cf.label?.toLowerCase() === 'cf_brand' ||
            cf.label?.toLowerCase().includes('brand')
    );
    return brandField?.value?.trim() || 'Other';
}

// Fetch full item details in bulk to obtain custom_fields (the list endpoint
// omits them).
async function fetchItemDetails(
    ctx: ZohoProductCtx,
    accessToken: string,
    itemIds: string[]
): Promise<Map<string, ZohoItem>> {
    const itemMap = new Map<string, ZohoItem>();
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

    const detailsData: ZohoItemDetailsResponse = await detailsResponse.json();
    for (const item of detailsData.items) {
        itemMap.set(item.item_id, item);
    }
    return itemMap;
}

// ─── Read-only diff pass ────────────────────────────────────────────────────

// Pull all active items from Zoho and work out which need to be added or
// updated in our system. Performs NO writes — brands and products are only
// created/updated later in applyProductSync(), and only for the items the user
// chooses to sync. Items without a SKU or that are inactive are excluded, as
// are products that already match Zoho exactly (nothing to do).
export async function computeSyncCandidates(
    ctx: ZohoProductCtx,
    accessToken: string
): Promise<SyncCandidate[]> {
    // 1. Collect every active item from Zoho (with custom_fields for brand).
    const items: ZohoItem[] = [];
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

        // Only items with a SKU are candidates; fetch their details for brand.
        const itemIds = itemsData.items
            .filter((item) => item.sku?.trim())
            .map((item) => item.item_id);
        const detailsMap = await fetchItemDetails(ctx, accessToken, itemIds);

        for (const listItem of itemsData.items) {
            const sku = listItem.sku?.trim();
            if (!sku) continue; // no SKU → skipped
            if (listItem.status?.toLowerCase() === 'inactive') continue; // inactive → skipped
            items.push(detailsMap.get(listItem.item_id) || listItem);
        }

        hasMorePages = itemsData.page_context?.has_more_page ?? false;
        page++;
    }

    // 2. Batch-load the existing products (and their current brand names) so we
    // can diff without a query per item.
    const skus = [...new Set(items.map((item) => item.sku.trim()))];
    const existingProducts =
        skus.length > 0 ? await models.product.findMany({ where: { sku: { oneOf: skus } } }) : [];
    const productBySku = new Map(existingProducts.map((p) => [p.sku, p]));

    const brandIds = [...new Set(existingProducts.map((p) => p.brandId))];
    const existingBrands =
        brandIds.length > 0 ? await models.brand.findMany({ where: { id: { oneOf: brandIds } } }) : [];
    const brandNameById = new Map(existingBrands.map((b) => [b.id, b.name]));

    // 3. Build the candidate list (creates + genuine updates only).
    const candidates: SyncCandidate[] = [];
    for (const item of items) {
        const sku = item.sku.trim();
        const brandName = getBrandFromItem(item);
        const existing = productBySku.get(sku);

        if (!existing) {
            candidates.push({
                sku,
                name: item.name,
                brand: brandName,
                change: 'New',
                zohoItemId: item.item_id,
                action: 'create',
            });
            continue;
        }

        const currentBrandName = brandNameById.get(existing.brandId);
        const needsUpdate = existing.name !== item.name || currentBrandName !== brandName;
        if (needsUpdate) {
            candidates.push({
                sku,
                name: item.name,
                brand: brandName,
                change: 'Update',
                zohoItemId: item.item_id,
                action: 'update',
            });
        }
        // else: already matches Zoho → nothing to do, not shown.
    }

    return candidates;
}

// ─── Apply pass ─────────────────────────────────────────────────────────────

export interface SyncedProduct {
    sku: string;
    name: string;
    brand: string;
    change: 'New' | 'Update';
}

export interface ApplyResult {
    synced: SyncedProduct[];
    created: number;
    updated: number;
}

// Create/update only the selected candidates, creating any missing brands along
// the way. Idempotent: keyed on the unique SKU, so a step retry re-derives the
// same result rather than duplicating records.
export async function applyProductSync(selected: SyncCandidate[]): Promise<ApplyResult> {
    const brandCache = new Map<string, string>(); // brand name → brand id

    async function getOrCreateBrand(brandName: string): Promise<string> {
        const cached = brandCache.get(brandName);
        if (cached) return cached;

        const existing = await models.brand.findMany({
            where: { name: { equals: brandName } },
            limit: 1,
        });
        const id = existing.length > 0 ? existing[0].id : (await models.brand.create({ name: brandName })).id;
        brandCache.set(brandName, id);
        return id;
    }

    const synced: SyncedProduct[] = [];
    let created = 0;
    let updated = 0;

    for (const candidate of selected) {
        const brandId = await getOrCreateBrand(candidate.brand);
        const now = new Date();
        const existing = await models.product.findOne({ sku: candidate.sku });

        if (existing) {
            await models.product.update(
                { id: existing.id },
                { name: candidate.name, brandId, synchronisedAt: now }
            );
            updated++;
        } else {
            await models.product.create({
                name: candidate.name,
                sku: candidate.sku,
                brandId,
                synchronisedAt: now,
            });
            created++;
        }

        synced.push({
            sku: candidate.sku,
            name: candidate.name,
            brand: candidate.brand,
            change: existing ? 'Update' : 'New',
        });
    }

    return { synced, created, updated };
}
