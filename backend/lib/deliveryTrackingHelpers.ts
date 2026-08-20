// Provider-neutral pieces of supplier delivery tracking: what a refresh returns,
// which deliveries are due for one, and how repeated polls are de-duplicated.
// Everything here is pure, so the scheduling and dedup rules are unit-tested
// directly. Provider-specific parsing lives in fedex/dhl/vesselTrackingHelpers.

import { DeliveryMode, DeliveryStatus } from '@teamkeel/sdk';

// ─── Types ──────────────────────────────────────────────────────────────────

// One event in a provider's history, already normalised.
export interface TrackingEvent {
    occurredAt: Date;
    description: string;
    location: string | null;
    status: DeliveryStatus | null;
}

// The outcome of asking a provider about one delivery. `status` is always set;
// everything else is filled in where the provider gives it.
export interface TrackingSnapshot {
    status: DeliveryStatus;
    statusDescription: string | null;
    estimatedArrival: Date | null;
    deliveredAt: Date | null;
    destination: string | null;
    events: TrackingEvent[];
    // Sea freight only: the ids the vessel name resolved to, cached on the row so
    // later polls skip the name lookup.
    vesselImo?: string | null;
    vesselMmsi?: string | null;
}

// A provider failure for one delivery. Distinguished from a snapshot so the flow
// can record the reason and back off rather than overwriting good state.
export interface TrackingFailure {
    error: string;
}

export type TrackingResult = TrackingSnapshot | TrackingFailure;

export function isFailure(result: TrackingResult): result is TrackingFailure {
    return (result as TrackingFailure).error !== undefined;
}

// Injectable fetch, so every provider adapter's request/response handling can be
// exercised in tests without touching the network.
export type FetchLike = typeof fetch;

// ─── Terminal states ────────────────────────────────────────────────────────

// Statuses we stop polling on. NotFound is deliberately absent: a number the
// carrier has not registered yet is normal for the first few hours, so those keep
// being retried (with backoff) rather than being written off.
const TERMINAL_STATUSES: DeliveryStatus[] = [DeliveryStatus.Delivered, DeliveryStatus.Cancelled];

export function isTerminal(status: DeliveryStatus): boolean {
    return TERMINAL_STATUSES.includes(status);
}

// ─── Refresh scheduling ─────────────────────────────────────────────────────

// How often each mode is re-polled. These differ because the providers' quotas
// and the underlying reality differ by an order of magnitude:
//
//   - Couriers change status through the day (picked up, in transit, out for
//     delivery), so they are polled on every run — every 3 hours.
//   - A vessel's reported ETA moves slowly, and VesselAPI's free tier allows only
//     150 calls a month (~5/day). Polling a sea delivery every 3 hours would cost
//     240 calls a month for a *single* delivery — over the allowance on its own.
//     Once a day costs 30/month each, so ~5 concurrent sea deliveries fit the
//     free tier. Raise this if the plan changes.
export const BASE_REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000;
export const SEA_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Failures back off by doubling, up to 16× the mode's base interval, so one bad
// tracking number or vessel name cannot keep burning a provider's quota.
const MAX_BACKOFF_DOUBLINGS = 4;

export function baseRefreshIntervalMs(mode: DeliveryMode): number {
    return mode === DeliveryMode.SeaFreight ? SEA_REFRESH_INTERVAL_MS : BASE_REFRESH_INTERVAL_MS;
}

// How long to wait before re-polling a delivery of this mode that has failed
// `failures` times in a row.
export function refreshIntervalMs(failures: number, mode: DeliveryMode): number {
    const doublings = Math.min(Math.max(failures, 0), MAX_BACKOFF_DOUBLINGS);
    return baseRefreshIntervalMs(mode) * 2 ** doublings;
}

// The subset of a delivery's fields the scheduling decision reads. Kept minimal
// so tests don't have to build whole model rows.
export interface RefreshCandidate {
    mode: DeliveryMode;
    status: DeliveryStatus;
    isArchived: boolean;
    lastCheckedAt: Date | null;
    consecutiveFailures: number;
}

// True when a delivery should be polled on this run: still open, not archived,
// and either never checked or past its mode's (possibly backed-off) interval.
export function dueForRefresh(delivery: RefreshCandidate, now: Date): boolean {
    if (delivery.isArchived) return false;
    if (isTerminal(delivery.status)) return false;
    if (!delivery.lastCheckedAt) return true;

    const waited = now.getTime() - delivery.lastCheckedAt.getTime();
    return waited >= refreshIntervalMs(delivery.consecutiveFailures, delivery.mode);
}

// Order deliveries so the ones waiting longest are polled first: never-checked
// before checked, then oldest check first. This matters because the per-run
// provider caps (DHL's especially) truncate the list — without a deliberate
// order, the same deliveries would be served every run and the tail would never
// be polled at all. Sorts a copy; the input is left alone.
export function stalestFirst<T extends { lastCheckedAt: Date | null }>(deliveries: T[]): T[] {
    return [...deliveries].sort((a, b) => {
        if (!a.lastCheckedAt && !b.lastCheckedAt) return 0;
        if (!a.lastCheckedAt) return -1;
        if (!b.lastCheckedAt) return 1;
        return a.lastCheckedAt.getTime() - b.lastCheckedAt.getTime();
    });
}

// ─── Event de-duplication ───────────────────────────────────────────────────

// Providers replay their entire scan history on every poll, so events need a
// stable identity to avoid re-inserting them. Timestamp plus a normalised
// description is enough: a carrier does not issue two different scans with the
// same wording at the same instant. Whitespace and case are flattened so cosmetic
// changes on the carrier's side don't resurrect an event, and the key is capped
// to keep the index narrow.
const EVENT_KEY_MAX_LENGTH = 200;

export function eventKey(event: TrackingEvent): string {
    const stamp = event.occurredAt.toISOString();
    const detail = event.description.trim().toLowerCase().replace(/\s+/g, ' ');
    return `${stamp}|${detail}`.slice(0, EVENT_KEY_MAX_LENGTH);
}

// Drop events already stored against this delivery, and collapse duplicates
// within the provider's own payload (FedEx in particular repeats scans across
// its per-piece results). Returns them oldest-first so insertion order matches
// the shipment's history.
export function newEvents(events: TrackingEvent[], knownKeys: Set<string>): { event: TrackingEvent; key: string }[] {
    const seen = new Set(knownKeys);
    const out: { event: TrackingEvent; key: string }[] = [];

    for (const event of events) {
        const key = eventKey(event);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ event, key });
    }

    return out.sort((a, b) => a.event.occurredAt.getTime() - b.event.occurredAt.getTime());
}

// ─── Shared parsing ─────────────────────────────────────────────────────────

// Parse a provider timestamp, returning null for missing or unparseable values
// rather than an Invalid Date — every provider here has optional date fields and
// DHL omits the zone on some services.
export function parseTimestamp(value: unknown): Date | null {
    if (typeof value !== 'string' || value.trim() === '') return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

// The most recent event in a list, used to fill lastEventAt/lastEventLocation.
export function latestEvent(events: TrackingEvent[]): TrackingEvent | null {
    if (events.length === 0) return null;
    return events.reduce((latest, e) => (e.occurredAt.getTime() > latest.occurredAt.getTime() ? e : latest));
}
