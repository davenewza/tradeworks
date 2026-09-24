// Shared plumbing for the Amazon Selling Partner API: the Login with Amazon
// token exchange, and a GET that paces itself and rides out a throttle.
//
// Split out of amazonFnskuHelpers once a second caller appeared
// (amazonShipmentHelpers), the same way channelCodeSync was split out of the
// per-channel barcode helpers. Nothing here knows what is being fetched.

// The subset of ctx needed for Amazon calls, satisfied by flow, function and
// subscriber contexts alike (mirrors TakealotCtx).
export interface AmazonCtx {
    env: {
        AMAZON_SP_API_BASE_URL: string;
        AMAZON_LWA_TOKEN_URL: string;
        AMAZON_MARKETPLACE_ID: string;
        AMAZON_LWA_CLIENT_ID: string;
    };
    secrets: {
        AMAZON_LWA_CLIENT_SECRET: string;
        AMAZON_LWA_REFRESH_TOKEN: string;
    };
}

/** Whether the Amazon credentials and endpoints are all set. */
export function amazonIsConfigured(ctx: AmazonCtx): boolean {
    return Boolean(
        ctx.secrets.AMAZON_LWA_CLIENT_SECRET &&
            ctx.secrets.AMAZON_LWA_REFRESH_TOKEN &&
            ctx.env.AMAZON_LWA_CLIENT_ID &&
            ctx.env.AMAZON_SP_API_BASE_URL &&
            ctx.env.AMAZON_LWA_TOKEN_URL &&
            ctx.env.AMAZON_MARKETPLACE_ID
    );
}

/** The API base with any trailing slash removed, ready to have a path appended. */
export function amazonApiBase(ctx: AmazonCtx): string {
    return ctx.env.AMAZON_SP_API_BASE_URL.replace(/\/$/, '');
}

// ─── Authentication ─────────────────────────────────────────────────────────

/**
 * Exchange the long-lived LWA refresh token for an access token. SP-API no
 * longer needs AWS request signing; this token in `x-amz-access-token` is the
 * whole of it.
 */
export async function getAmazonAccessToken(ctx: AmazonCtx): Promise<string> {
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: ctx.secrets.AMAZON_LWA_REFRESH_TOKEN,
        client_id: ctx.env.AMAZON_LWA_CLIENT_ID,
        client_secret: ctx.secrets.AMAZON_LWA_CLIENT_SECRET,
    });

    const response = await fetch(ctx.env.AMAZON_LWA_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: body.toString(),
    });

    if (!response.ok) {
        // LWA's error body is `{ error, error_description }` — no credentials in it.
        const errorText = await response.text();
        throw new Error(`Failed to get Amazon access token: ${response.status} - ${errorText}`);
    }

    const tokenData = (await response.json()) as { access_token?: string };
    if (!tokenData.access_token) {
        throw new Error('Amazon token response missing access_token');
    }
    return tokenData.access_token;
}

// ─── Requests ───────────────────────────────────────────────────────────────

// Every operation we call allows 2 requests a second, and a pagination token
// dies 30 seconds after it is issued. Pacing requests keeps a walk under the
// limit; the retries cover a throttle that lands anyway and are short enough
// that the token is still alive when the retry goes out.
export const PAGE_PAUSE_MS = 500;
const THROTTLE_BACKOFF_MS = [1000, 2000, 4000];

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface FetchOptions {
    // Injected by tests so retries and pacing do not actually wait.
    sleep?: (ms: number) => Promise<void>;
}

/** The sleep to use — the injected one under test, a real timer otherwise. */
export function sleeper(options: FetchOptions = {}): (ms: number) => Promise<void> {
    return options.sleep ?? realSleep;
}

/**
 * A failed SP-API call, carrying the status so a caller can tell a resource
 * that has gone (404) from a credential or service problem — the difference
 * between skipping one record and abandoning the sync.
 */
export class AmazonApiError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message);
        this.name = 'AmazonApiError';
    }
}

/**
 * GET one SP-API URL as JSON, retrying a throttled response.
 *
 * `what` names the resource in the error message ("FBA inventory", "inbound
 * plans"), so a failure says which call gave up.
 */
export async function amazonGet<T>(
    url: string,
    accessToken: string,
    what: string,
    sleep: (ms: number) => Promise<void>
): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'x-amz-access-token': accessToken, Accept: 'application/json' },
        });

        if (response.status === 429 && attempt < THROTTLE_BACKOFF_MS.length) {
            await sleep(THROTTLE_BACKOFF_MS[attempt]);
            continue;
        }

        if (!response.ok) {
            const errorText = await response.text();
            throw new AmazonApiError(
                response.status,
                `Failed to fetch Amazon ${what}: ${response.status} - ${errorText}`
            );
        }

        return (await response.json()) as T;
    }
}
