import { models } from '@teamkeel/sdk';
import { ProgressReporter } from './progress';

// ─── Zoho types ─────────────────────────────────────────────────────────────

interface ZohoCustomField {
    customfield_id?: string;
    label?: string;
    value?: string;
}

export interface ZohoItem {
    item_id: string;
    name: string;
    sku: string;
    status?: string;
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

// A single add/update/deactivate candidate produced by the read-only diff pass.
// All fields are JSON-serializable so the whole array can flow through
// ctx.step() and ctx.ui.select.table() unchanged. `sku`/`name`/`brand`/`change`/
// `reason` are the human-facing columns; `zohoItemId`/`action` are carried
// through hidden.
export interface SyncCandidate {
    sku: string;
    name: string;
    brand: string;
    change: 'New' | 'Update' | 'Deactivate' | 'Reactivate';
    // Why this row is here, in the operator's terms.
    reason: string;
    // The status the row lands on. Only a create reads it — an inactive item is
    // still imported, as an inactive product, so its sales and costs have
    // something to attach to.
    isActive: boolean;
    zohoItemId: string;
    action: 'create' | 'update' | 'deactivate' | 'reactivate';
}

// What we already hold for a SKU, as far as the diff cares.
export interface ExistingProduct {
    name: string;
    brandName: string;
    isActive: boolean;
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

// ─── Obsolescence ───────────────────────────────────────────────────────────

// Zoho's item status is the single signal: an inactive item can no longer be
// used in transactions over there, so the product it maps to is out of use here.
export function isItemInactive(item: ZohoItem): boolean {
    return (item.status ?? '').trim().toLowerCase() === 'inactive';
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

// Work out what each Zoho item means for our catalogue. Pure — no fetches, no
// writes — so the rules below can be tested directly.
//
// An item Zoho has made inactive deactivates the product we hold for it; one we
// do not hold is imported as an inactive product rather than skipped. It will
// never appear in the catalogue, but it gives the sales, cost and fee syncs a
// SKU to match on — without it every invoice line for a retired item is dropped
// with "no product found", and the transaction history has a hole in it.
// Everything else is the ordinary add/update diff. Products that already match
// Zoho produce no candidate; neither does an inactive item we already hold as
// inactive, whose name is frozen at import — it is a history record, not a
// catalogue entry, and re-proposing it every run would bury the real changes.
//
// Status runs in both directions, because nothing here can write isActive: an
// item made active again in Zoho brings its product back. There is no local
// change for the sync to second-guess, so a product's status can always be
// corrected at the source. A reactivation carries the item's current name and
// brand too — a product returning to the catalogue should return correct.
export function buildSyncCandidates(
    items: ZohoItem[],
    existingBySku: Map<string, ExistingProduct>
): SyncCandidate[] {
    const candidates: SyncCandidate[] = [];

    for (const item of items) {
        const sku = item.sku?.trim();
        if (!sku) continue;

        const existing = existingBySku.get(sku);
        const brandName = getBrandFromItem(item);

        if (isItemInactive(item)) {
            if (!existing) {
                candidates.push({
                    sku,
                    name: item.name,
                    brand: brandName,
                    change: 'New',
                    reason: 'Inactive in Zoho — imported for its history',
                    isActive: false,
                    zohoItemId: item.item_id,
                    action: 'create',
                });
                continue;
            }
            // Already off — nothing to do.
            if (!existing.isActive) continue;
            candidates.push({
                sku,
                name: item.name,
                // The brand we hold, not the one on the Zoho item — this row
                // only ever switches the product off, and our own record stays
                // right even when an obsolete item's brand field has gone
                // stale or empty.
                brand: existing.brandName,
                change: 'Deactivate',
                reason: 'Inactive in Zoho',
                isActive: false,
                zohoItemId: item.item_id,
                action: 'deactivate',
            });
            continue;
        }

        if (!existing) {
            candidates.push({
                sku,
                name: item.name,
                brand: brandName,
                change: 'New',
                reason: 'Not in our catalogue yet',
                isActive: true,
                zohoItemId: item.item_id,
                action: 'create',
            });
            continue;
        }

        if (!existing.isActive) {
            candidates.push({
                sku,
                name: item.name,
                brand: brandName,
                change: 'Reactivate',
                reason: 'Active again in Zoho',
                isActive: true,
                zohoItemId: item.item_id,
                action: 'reactivate',
            });
            continue;
        }

        const nameChanged = existing.name !== item.name;
        const brandChanged = existing.brandName !== brandName;
        if (nameChanged || brandChanged) {
            candidates.push({
                sku,
                name: item.name,
                brand: brandName,
                change: 'Update',
                reason:
                    nameChanged && brandChanged
                        ? 'Name and brand changed in Zoho'
                        : nameChanged
                          ? 'Name changed in Zoho'
                          : 'Brand changed in Zoho',
                isActive: true,
                zohoItemId: item.item_id,
                action: 'update',
            });
        }
        // else: already matches Zoho → nothing to do, not shown.
    }

    return candidates;
}

// Pull every item from Zoho and work out what each one means here. Performs NO
// writes — products are only touched later in applyProductSync(), and only for
// the items the user chooses to sync.
export async function computeSyncCandidates(
    ctx: ZohoProductCtx,
    accessToken: string,
    progress?: ProgressReporter
): Promise<SyncCandidate[]> {
    // 1. Collect every item from Zoho (with custom_fields for brand).
    const items: ZohoItem[] = [];
    let page = 1;
    let hasMorePages = true;

    progress?.set({ message: 'Fetching items from Zoho…' });
    while (hasMorePages) {
        // Status.All, not Status.Active: an item made inactive in Zoho drops
        // out of the Active filter entirely, and that disappearance is precisely
        // the change we need to see.
        const itemsUrl = `${ctx.env.ZOHO_BOOKS_BASE_URL}/items?organization_id=${ctx.env.ZOHO_BOOKS_ORG_ID}&filter_by=Status.All&page=${page}&per_page=200`;

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
            if (!listItem.sku?.trim()) continue; // no SKU → skipped
            // Details carry the custom fields (brand); the list response is the
            // one guaranteed to carry status. Merge so a details response
            // missing status cannot mask an inactive item.
            const details = detailsMap.get(listItem.item_id);
            items.push({ ...listItem, ...details, status: details?.status ?? listItem.status });
        }

        hasMorePages = itemsData.page_context?.has_more_page ?? false;
        progress?.set({ message: `Fetched ${items.length} item${items.length === 1 ? '' : 's'} from Zoho…` });
        page++;
    }

    progress?.set({ message: 'Comparing against existing products…' });

    // 2. Batch-load the existing products (and their current brand names) so we
    // can diff without a query per item.
    const skus = [...new Set(items.map((item) => item.sku.trim()))];
    const existingProducts =
        skus.length > 0 ? await models.product.findMany({ where: { sku: { oneOf: skus } } }) : [];

    const brandIds = [...new Set(existingProducts.map((p) => p.brandId))];
    const existingBrands =
        brandIds.length > 0 ? await models.brand.findMany({ where: { id: { oneOf: brandIds } } }) : [];
    const brandNameById = new Map(existingBrands.map((b) => [b.id, b.name]));

    const existingBySku = new Map<string, ExistingProduct>(
        existingProducts.map((p) => [
            p.sku,
            { name: p.name, brandName: brandNameById.get(p.brandId) ?? '', isActive: p.isActive },
        ])
    );

    // 3. Turn the two sides into candidates.
    return buildSyncCandidates(items, existingBySku);
}

// ─── Apply pass ─────────────────────────────────────────────────────────────

export interface SyncedProduct {
    sku: string;
    name: string;
    brand: string;
    change: 'New' | 'Update' | 'Deactivate' | 'Reactivate';
    reason: string;
}

export interface ApplyResult {
    synced: SyncedProduct[];
    created: number;
    // Of those created, how many landed inactive — items already retired in
    // Zoho, brought in only so their transactions have a product to hang off.
    // Counted apart so a first run reporting hundreds of adds is not mistaken
    // for hundreds of new catalogue entries.
    createdInactive: number;
    updated: number;
    deactivated: number;
    reactivated: number;
}

// Apply only the selected candidates, creating any missing brands along the
// way. Idempotent: keyed on the unique SKU, so a step retry re-derives the same
// result rather than duplicating records.
export async function applyProductSync(
    selected: SyncCandidate[],
    progress?: ProgressReporter
): Promise<ApplyResult> {
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
    let createdInactive = 0;
    let updated = 0;
    let deactivated = 0;
    let reactivated = 0;

    progress?.set({ current: 0, total: selected.length, unit: 'products', counter: 'count' });

    for (const candidate of selected) {
        const now = new Date();
        const existing = await models.product.findOne({ sku: candidate.sku });

        if (candidate.action === 'deactivate') {
            progress?.increment();
            // Nothing to switch off — the product was removed between the diff
            // and the apply. Not an error; just say so and move on.
            if (!existing) {
                progress?.log(`Skipped ${candidate.sku} — no longer in our catalogue`);
                continue;
            }
            await models.product.update({ id: existing.id }, { isActive: false, synchronisedAt: now });
            deactivated++;
            synced.push({
                sku: candidate.sku,
                name: candidate.name,
                brand: candidate.brand,
                change: 'Deactivate',
                reason: candidate.reason,
            });
            progress?.log(`Deactivated ${candidate.sku} — ${candidate.name}`);
            continue;
        }

        // Only rows that carry a brand from Zoho get one created.
        const brandId = await getOrCreateBrand(candidate.brand);
        const reactivating = candidate.action === 'reactivate';

        if (existing) {
            await models.product.update(
                { id: existing.id },
                {
                    name: candidate.name,
                    brandId,
                    synchronisedAt: now,
                    // A product coming back should come back switched on. Left
                    // out of an ordinary update so a plain rename never touches
                    // status.
                    ...(reactivating ? { isActive: true } : {}),
                }
            );
            if (reactivating) reactivated++;
            else updated++;
        } else {
            await models.product.create({
                name: candidate.name,
                sku: candidate.sku,
                brandId,
                synchronisedAt: now,
                isActive: candidate.isActive,
            });
            created++;
            if (!candidate.isActive) createdInactive++;
        }

        const change = existing ? (reactivating ? 'Reactivate' : 'Update') : 'New';
        synced.push({
            sku: candidate.sku,
            name: candidate.name,
            brand: candidate.brand,
            change,
            reason: candidate.reason,
        });

        progress?.increment();
        const verb = existing
            ? reactivating
                ? 'Reactivated'
                : 'Updated'
            : candidate.isActive
              ? 'Added'
              : 'Added (inactive)';
        progress?.log(`${verb} ${candidate.sku} — ${candidate.name}`);
    }

    return { synced, created, createdInactive, updated, deactivated, reactivated };
}
