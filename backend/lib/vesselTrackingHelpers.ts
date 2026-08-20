// Sea freight via VesselAPI (AIS).
//
//   Resolve: GET {base}/v1/search/vessels?filter.name=NAME
//   ETA:     GET {base}/v1/vessel/{id}/eta?filter.idType=imo|mmsi
//   Auth:    Authorization: Bearer <key>
//
// For sea freight we track the vessel: its crew-reported destination and ETA are
// what we want to know, so status is derived from them (see
// deriveSeaFreightStatus) rather than from any per-consignment feed.
//
// Status is re-derived from scratch on every poll, never latched. That matters
// because a ship's reported destination changes mid-voyage: one bound for Cape
// Town may report SINGAPORE on the way. When that intermediate ETA passes the
// delivery reads Arrived, and as soon as the vessel reports its next destination
// and a future ETA it goes back to InTransit on its own. This is also why Arrived
// does not stop the polling — latching it would drop tracking at the first
// intermediate port.
//
// Vessel names are not unique, so the name is resolved to an IMO once and cached
// on the delivery; every later poll uses that id and skips the search entirely.

import { FetchLike, TrackingResult, TrackingSnapshot, parseTimestamp } from './deliveryTrackingHelpers';
import { DeliveryStatus } from '@teamkeel/sdk';

export interface VesselCtx {
    env: { VESSEL_API_BASE_URL: string };
    secrets: { VESSEL_API_KEY: string };
}

// ─── VesselAPI response types ───────────────────────────────────────────────

interface VesselSearchResult {
    name?: string;
    imo?: number | string | null;
    mmsi?: number | string | null;
    // "Active", "decommissioned_lost", … — used to drop retired hulls that would
    // otherwise make a live vessel's name look ambiguous.
    operating_status?: string | null;
}

export interface VesselSearchResponse {
    vessels?: VesselSearchResult[];
}

export interface VesselEtaResponse {
    vesselEta?: {
        destination?: string | null;
        destination_port?: string | null;
        eta?: string | null;
        draught?: number | null;
        imo?: number | string | null;
        mmsi?: number | string | null;
        timestamp?: string | null;
        vessel_name?: string | null;
    };
}

// A vessel resolved from a name to its stable identifiers.
export interface ResolvedVessel {
    imo: string | null;
    mmsi: string | null;
    name: string | null;
}

// ─── Pure helpers ───────────────────────────────────────────────────────────

function asIdString(value: number | string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    return text === '' || text === '0' ? null : text;
}

// A retired hull keeps its name and its IMO in the registry forever, so a search
// for a live ship can come back with its scrapped namesakes alongside it — the
// real "EVER GIVEN" (IMO 9811000) shares its name with a 1986 vessel marked
// decommissioned_lost. Those are dropped before matching, or one of the most
// recognisable ships afloat would be unresolvable as "ambiguous". An unknown or
// absent status is kept: only an explicitly retired vessel is excluded.
function isRetired(vessel: VesselSearchResult): boolean {
    const status = (vessel.operating_status ?? '').toLowerCase();
    if (status === '') return false;
    return ['decommission', 'scrap', 'lost', 'broken', 'demolish'].some((marker) => status.includes(marker));
}

// Pick the vessel to track from a name search. A name search can legitimately
// return several ships, and guessing between them would silently track the wrong
// vessel — so we only accept an unambiguous answer. An exact (case-insensitive)
// name match wins even when other partial matches came back; otherwise a single
// result is accepted and anything else is refused.
export function resolveVesselFromSearch(
    response: VesselSearchResponse,
    searchedName: string,
): { vessel: ResolvedVessel } | { error: string } {
    const identifiable = (response.vessels ?? []).filter((v) => asIdString(v.imo) || asIdString(v.mmsi));
    const candidates = identifiable.filter((v) => !isRetired(v));

    if (candidates.length === 0) {
        // Distinguish "nothing by that name" from "only retired ships by that
        // name" — the second usually means a typo or an out-of-date name.
        if (identifiable.length > 0) {
            return { error: `Only decommissioned vessels match "${searchedName}" — check the name with the forwarder` };
        }
        return { error: `No vessel found matching "${searchedName}"` };
    }

    const wanted = searchedName.trim().toLowerCase();
    const exact = candidates.filter((v) => (v.name ?? '').trim().toLowerCase() === wanted);

    if (exact.length === 1) {
        return { vessel: toResolved(exact[0]) };
    }
    if (exact.length > 1) {
        return {
            error: `Vessel name "${searchedName}" matches ${exact.length} vessels — set the IMO manually to disambiguate`,
        };
    }
    if (candidates.length === 1) {
        return { vessel: toResolved(candidates[0]) };
    }

    return {
        error: `Vessel name "${searchedName}" is ambiguous (${candidates.length} matches) — set the IMO manually`,
    };
}

function toResolved(vessel: VesselSearchResult): ResolvedVessel {
    return {
        imo: asIdString(vessel.imo),
        mmsi: asIdString(vessel.mmsi),
        name: vessel.name ?? null,
    };
}

// Status of a sea leg, from the vessel's currently reported ETA:
//   - no ETA reported        → Unknown
//   - ETA in the future      → InTransit
//   - ETA in the past        → Arrived (the vessel should be at its reported
//                              destination port)
// Pure and stateless, so each poll re-derives it — a vessel that reports a new
// destination after an intermediate arrival returns to InTransit.
export function deriveSeaFreightStatus(eta: Date | null, now: Date): DeliveryStatus {
    if (!eta) return DeliveryStatus.Unknown;
    return eta.getTime() > now.getTime() ? DeliveryStatus.InTransit : DeliveryStatus.Arrived;
}

// Human-readable destination: the crew-reported free-text destination, falling
// back to the UN/LOCODE when that is blank.
function formatDestination(destination: string | null | undefined, port: string | null | undefined): string | null {
    const reported = destination?.trim();
    if (reported) return reported;
    const code = port?.trim();
    return code ? code : null;
}

export function parseVesselEta(response: VesselEtaResponse, now: Date): TrackingResult {
    const eta = response.vesselEta;
    if (!eta) {
        return { error: 'VesselAPI returned no ETA data for this vessel' };
    }

    const estimatedArrival = parseTimestamp(eta.eta);
    const status = deriveSeaFreightStatus(estimatedArrival, now);
    const destination = formatDestination(eta.destination, eta.destination_port);
    const reportedAt = parseTimestamp(eta.timestamp);

    // AIS gives one current report rather than a history, so each poll
    // contributes at most one event — keyed on the report's own timestamp, so
    // repeated polls of an unchanged report collapse to a single stored event.
    const description = destination
        ? `AIS report — destination ${destination}${estimatedArrival ? `, ETA ${estimatedArrival.toISOString()}` : ''}`
        : 'AIS report';

    const snapshot: TrackingSnapshot = {
        status,
        statusDescription: destination ? `Reported destination ${destination}` : null,
        estimatedArrival,
        // Never inferred for sea freight: arrival of the ship is not delivery.
        deliveredAt: null,
        destination,
        events: reportedAt
            ? [{ occurredAt: reportedAt, description, location: destination, status }]
            : [],
        vesselImo: asIdString(eta.imo),
        vesselMmsi: asIdString(eta.mmsi),
    };
    return snapshot;
}

// ─── Fetch ──────────────────────────────────────────────────────────────────

export function hasVesselCredentials(ctx: VesselCtx): boolean {
    return Boolean(ctx.secrets.VESSEL_API_KEY);
}

function authHeaders(ctx: VesselCtx): Record<string, string> {
    return {
        Authorization: `Bearer ${ctx.secrets.VESSEL_API_KEY}`,
        Accept: 'application/json',
    };
}

// Resolve a vessel name to its identifiers. Only needed the first time a sea
// delivery is polled.
export async function searchVesselByName(
    ctx: VesselCtx,
    vesselName: string,
    fetchImpl: FetchLike = fetch,
): Promise<{ vessel: ResolvedVessel } | { error: string }> {
    const base = ctx.env.VESSEL_API_BASE_URL.replace(/\/$/, '');
    const url = `${base}/v1/search/vessels?filter.name=${encodeURIComponent(vesselName)}`;

    const response = await fetchImpl(url, { method: 'GET', headers: authHeaders(ctx) });

    if (!response.ok) {
        return { error: `VesselAPI search: ${response.status} - ${(await response.text()).slice(0, 200)}` };
    }

    const data: VesselSearchResponse = await response.json();
    return resolveVesselFromSearch(data, vesselName);
}

export async function fetchVesselEta(
    ctx: VesselCtx,
    id: string,
    idType: 'imo' | 'mmsi',
    now: Date,
    fetchImpl: FetchLike = fetch,
): Promise<TrackingResult> {
    const base = ctx.env.VESSEL_API_BASE_URL.replace(/\/$/, '');
    const url = `${base}/v1/vessel/${encodeURIComponent(id)}/eta?filter.idType=${idType}`;

    const response = await fetchImpl(url, { method: 'GET', headers: authHeaders(ctx) });

    if (!response.ok) {
        return { error: `VesselAPI ETA: ${response.status} - ${(await response.text()).slice(0, 200)}` };
    }

    const data: VesselEtaResponse = await response.json();
    return parseVesselEta(data, now);
}

// Full sea-freight refresh for one delivery: resolve the name if we don't yet
// have an id, then read the ETA. Returns the ids alongside the snapshot so the
// caller can cache them and skip the search next time.
export async function trackVessel(
    ctx: VesselCtx,
    delivery: { vesselName: string | null; vesselImo: string | null; vesselMmsi: string | null },
    now: Date,
    fetchImpl: FetchLike = fetch,
): Promise<TrackingResult> {
    let id = delivery.vesselImo;
    let idType: 'imo' | 'mmsi' = 'imo';

    if (!id && delivery.vesselMmsi) {
        id = delivery.vesselMmsi;
        idType = 'mmsi';
    }

    if (!id) {
        if (!delivery.vesselName) {
            return { error: 'Sea freight delivery has no vessel name or IMO to track' };
        }
        const resolved = await searchVesselByName(ctx, delivery.vesselName, fetchImpl);
        if ('error' in resolved) return resolved;

        if (resolved.vessel.imo) {
            id = resolved.vessel.imo;
            idType = 'imo';
        } else if (resolved.vessel.mmsi) {
            id = resolved.vessel.mmsi;
            idType = 'mmsi';
        } else {
            return { error: `Vessel "${delivery.vesselName}" resolved without an IMO or MMSI` };
        }
    }

    const result = await fetchVesselEta(ctx, id, idType, now, fetchImpl);

    // Make sure the resolved id is persisted even when the ETA payload omits it,
    // so the next poll doesn't repeat the name search.
    if (!('error' in result)) {
        if (idType === 'imo') result.vesselImo = result.vesselImo ?? id;
        else result.vesselMmsi = result.vesselMmsi ?? id;
    }

    return result;
}
