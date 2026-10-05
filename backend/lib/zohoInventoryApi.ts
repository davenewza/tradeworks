import { ZohoFeeCtx, getZohoAccessToken } from './zohoChannelFeeHelpers';
import { isZohoDailyRateLimit } from './zohoSalesHelpers';

// A read-only client for the Zoho Inventory API, shared by the syncs that read
// it: supplier bills, purchase orders, supplier price lists and stock on hand.
//
// The token endpoint rate-limits hard on repeated fetches, so a run fetches one
// token and passes it to everything it reads.

// The self-client is already authorised for this scope (verified against the
// org); it covers bills, purchase orders, price books and items.
const INVENTORY_SCOPE = 'ZohoInventory.FullAccess.READ';
const INVENTORY_BASE = 'https://www.zohoapis.com/inventory/v1';

// Spacing between Zoho API calls, to stay under the per-minute cap.
const CALL_SPACING_MS = 350;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getZohoInventoryToken(ctx: ZohoFeeCtx): Promise<string> {
    return getZohoAccessToken(ctx, INVENTORY_SCOPE);
}

// A non-OK answer from Zoho, with its status and body kept so a caller can tell
// a daily rate limit (which won't lift today) from any other failure.
export class ZohoApiError extends Error {
    constructor(
        readonly path: string,
        readonly status: number,
        readonly body: string
    ) {
        super(`Zoho GET ${path} failed: ${status} - ${body.slice(0, 300)}`);
    }

    get isDailyRateLimit(): boolean {
        return isZohoDailyRateLimit(this.status, this.body);
    }
}

// A GET against the Zoho Inventory API: a path under /inventory/v1 and its
// query, resolving to the parsed body. Injected so the syncs can be tested
// against captured payloads without the network.
export type ZohoGet = (path: string, query?: Record<string, string>) => Promise<any>;

export function zohoInventoryGet(ctx: ZohoFeeCtx, accessToken: string): ZohoGet {
    return async (path, query = {}) => {
        await sleep(CALL_SPACING_MS);
        const params = new URLSearchParams({ organization_id: ctx.env.ZOHO_BOOKS_ORG_ID, ...query });
        const url = `${INVENTORY_BASE}${path}?${params}`;
        const res = await fetch(url, {
            method: 'GET',
            headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        });
        if (!res.ok) throw new ZohoApiError(path, res.status, await res.text());
        return res.json();
    };
}

// Zoho writes offsets without a colon ("2026-09-07T10:43:18+0200"), which ISO
// 8601 parsers needn't accept.
export function parseZohoTime(value: string): Date {
    const parsed = new Date(value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    if (Number.isNaN(parsed.getTime())) throw new Error(`Unreadable Zoho timestamp "${value}"`);
    return parsed;
}
