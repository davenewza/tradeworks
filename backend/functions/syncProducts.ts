import { SyncProducts, models } from '@teamkeel/sdk';

interface ZohoCustomField {
    customfield_id: string;
    label: string;
    value: string;
}

interface ZohoItem {
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

async function getZohoAccessToken(ctx: {
    env: { ZOHO_ACCOUNTS_BASE_URL: string; ZOHO_CLIENT_ID: string };
    secrets: { ZOHO_CLIENT_SECRET: string };
}): Promise<string> {
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

export default SyncProducts(async (ctx, inputs) => {
    // Get OAuth access token
    const accessToken = await getZohoAccessToken(ctx);

    let totalItemsProcessed = 0;
    let productsCreated = 0;
    let productsUpdated = 0;
    let productsSkipped = 0;
    const skippedItems: Array<{
        sku: string;
        name: string;
        reason: string;
    }> = [];

    // Cache for brand lookups by name
    const brandCache = new Map<string, { id: string }>();

    // Helper to get or create a brand
    async function getOrCreateBrand(brandName: string): Promise<{ id: string }> {
        const cached = brandCache.get(brandName);
        if (cached) return cached;

        const existingBrands = await models.brand.findMany({
            where: { name: { equals: brandName } },
            limit: 1,
        });

        if (existingBrands.length > 0) {
            brandCache.set(brandName, { id: existingBrands[0].id });
            return { id: existingBrands[0].id };
        }

        const created = await models.brand.create({ name: brandName });
        brandCache.set(brandName, { id: created.id });
        return { id: created.id };
    }

    // Helper to extract brand from item custom fields
    function getBrandFromItem(item: ZohoItem): string {
        if (!item.custom_fields || item.custom_fields.length === 0) {
            return 'Other';
        }
        // Look for brand field - check label case-insensitively for "brand" or "cf_brand"
        const brandField = item.custom_fields.find(
            (cf) => cf.label?.toLowerCase() === 'brand' ||
                    cf.label?.toLowerCase() === 'cf_brand' ||
                    cf.label?.toLowerCase().includes('brand')
        );
        return brandField?.value?.trim() || 'Other';
    }

    // Helper to fetch item details in bulk (to get custom_fields)
    async function fetchItemDetails(itemIds: string[]): Promise<Map<string, ZohoItem>> {
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

    // Fetch all active items from Zoho
    let page = 1;
    let hasMorePages = true;
    let loggedFirstItem = false;

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

        // Collect item IDs to fetch details in bulk
        const itemIds = itemsData.items
            .filter(item => item.sku?.trim()) // Only fetch details for items with SKUs
            .map(item => item.item_id);

        // Fetch full item details including custom_fields
        const itemDetailsMap = await fetchItemDetails(itemIds);

        for (const listItem of itemsData.items) {
            totalItemsProcessed++;

            // Skip items without SKU
            const sku = listItem.sku?.trim();
            if (!sku) {
                productsSkipped++;
                skippedItems.push({
                    sku: '',
                    name: listItem.name,
                    reason: 'No SKU provided',
                });
                continue;
            }

            // Skip inactive items (double-check even though we filter)
            if (listItem.status?.toLowerCase() === 'inactive') {
                productsSkipped++;
                skippedItems.push({
                    sku: sku,
                    name: listItem.name,
                    reason: 'Item is inactive',
                });
                continue;
            }

            // Get the detailed item with custom_fields, fall back to list item
            const item = itemDetailsMap.get(listItem.item_id) || listItem;

            // Log the first item to see its structure (especially custom_fields)
            if (!loggedFirstItem) {
                console.log('Sample item with details:', JSON.stringify({
                    item_id: item.item_id,
                    name: item.name,
                    sku: item.sku,
                    status: item.status,
                    custom_fields: item.custom_fields,
                }, null, 2));
                loggedFirstItem = true;
            }

            // Get brand from custom field
            const brandName = getBrandFromItem(item);
            const brand = await getOrCreateBrand(brandName);

            // Check if product exists in our system
            const existingProduct = await models.product.findOne({ sku: sku });

            const now = new Date();

            if (existingProduct) {
                // Update existing product (only name and brand)
                const needsUpdate =
                    existingProduct.name !== item.name ||
                    existingProduct.brandId !== brand.id;

                if (needsUpdate) {
                    await models.product.update(
                        { id: existingProduct.id },
                        {
                            name: item.name,
                            brandId: brand.id,
                            synchronisedAt: now,
                        }
                    );
                    productsUpdated++;
                } else {
                    // Update synchronisedAt even if no other changes
                    await models.product.update(
                        { id: existingProduct.id },
                        { synchronisedAt: now }
                    );
                }
            } else {
                // Create new product
                await models.product.create({
                    name: item.name,
                    sku: sku,
                    brandId: brand.id,
                    synchronisedAt: now,
                });
                productsCreated++;
            }
        }

        hasMorePages = itemsData.page_context?.has_more_page ?? false;
        page++;
    }

    return {
        totalItemsProcessed,
        productsCreated,
        productsUpdated,
        productsSkipped,
        skippedItems,
    };
});
