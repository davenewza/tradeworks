# Supplier delivery tracking

Tracks inbound deliveries from our suppliers and keeps their status and ETA
current by polling the carriers' own APIs — couriers every three hours, sea
freight daily — so the team can see what is on the way without chasing tracking
pages or the forwarder.

## Where to find it

The **Logistics** space in the Console:

- **Supplier deliveries** — the list of everything inbound, with status, ETA and
  when it was last checked.
- **Track a delivery** — create a new entry. The carrier is checked
  **immediately**, so a new delivery lands with a real status and ETA rather than
  sitting on *Pending* until the next scheduled run.
- Opening a delivery shows its full detail plus the **tracking history**: every
  carrier scan or AIS report we have seen.
- **Check now** — on a delivery's page (and from the grid) to re-check that one
  delivery against its carrier straight away, without waiting for the schedule.

## The two kinds of delivery

| Mode | Identified by | Tracked via |
| --- | --- | --- |
| **Air courier** | Carrier (FedEx, DHL or UPS) + tracking number | EasyPost (fronts all three) |
| **Sea freight** | Vessel name | VesselAPI (AIS) |

The identifier has to match the mode, and this is enforced when the entry is
created: a courier delivery needs both a carrier and a tracking number, sea
freight needs a vessel name. Tracking numbers are normalised on the way in
(spaces and dashes stripped, upper-cased), so you can type them the way they are
printed on the label.

## Status

Each provider has its own status vocabulary; they are all mapped onto one set so
the list reads consistently. The carrier's own wording is kept alongside and
shown on the delivery page as **Carrier's wording**.

| Status | Colour | Meaning |
| --- | --- | --- |
| **Pending** | grey | Logged here, but the carrier has nothing on it yet. |
| **Info received** | blue | The carrier has the details but has not picked it up. |
| **In transit** | blue | Moving. |
| **Out for delivery** | 🟡 | On the vehicle for final delivery. |
| **Arrived at port** | 🟡 | Sea freight only — the vessel's ETA has passed. |
| **Delivered** | 🟢 | Arrived with us. |
| **Exception** | 🔴 | Customs hold, damage, a failed attempt, a return to sender. |
| **Cancelled** | grey | Cancelled at the carrier. |
| **Not found yet** | 🟣 | The carrier does not recognise the number. |
| **Unknown** | grey | The provider gave a status we don't map. |

**Not found yet** is normal for the first few hours after a booking — the carrier
has not registered the number. It is *not* treated as final: the delivery keeps
being retried on a backoff. An unmapped provider status becomes **Unknown**
rather than a guess, and the carrier's own wording still comes through.

**Delivered** and **Cancelled** are the only statuses that stop the polling.

### A customs hold hides under "in transit"

Worth knowing, because it drove a deliberate design choice. EasyPost reports a
coarse `status` and a finer `status_detail`, and the interesting news is often
only in the second one. On a real Hong Kong → Cape Town DHL consignment of ours:

```
2026-06-29T12:09:48Z   in_transit   held   "Shipment is on hold"
```

The parcel sat in Cape Town customs for a day while the coarse status stayed
`in_transit` throughout. Mapping from `status` alone would have displayed "In
transit" and nobody would have noticed.

So a handful of `status_detail` values **override** the coarse status and mark the
delivery an **Exception**: `held`, `delayed`, `lost`, `damaged`,
`address_correction`, `failure`. Benign details (`arrived_at_facility`,
`departed_facility`, …) leave the status alone.

## Sea freight: tracking the vessel

For a sea leg we track the **vessel**, and its reported destination port and ETA
are the answer. Status comes from the ETA:

| Reported ETA | Status |
| --- | --- |
| In the future | **In transit** |
| In the past | **Arrived at port** |
| None reported | **Unknown** |

### The reported destination changes mid-voyage

Worth knowing, because it shapes how the status behaves. A vessel's AIS
destination is whatever the crew currently reports, and it is updated as the ship
goes: one ultimately bound for Cape Town may report `SINGAPORE` for the first
leg.

Status is therefore **derived fresh on every poll, never latched**. When an
intermediate ETA passes the delivery reads **Arrived at port**; as soon as the
vessel reports its next destination and a future ETA, it returns to **In transit**
by itself. No one has to correct it.

This is also why **Arrived at port** does not stop the polling — latching it would
drop tracking at the first intermediate port. Only **Delivered** and **Cancelled**
stop the polling, so a sea delivery is finished off with **Mark delivered** (or
**Stop tracking**) when the team is done with it.

### Vessel names are not unique

Several ships can share a name. The first refresh resolves the name against AIS
and stores the vessel's **IMO**, which every later poll uses instead — so the
lookup happens once, which also matters for the call budget.

**Retired hulls are filtered out first.** A scrapped ship keeps its name and IMO
in the registry forever, so a search for a live vessel comes back with its dead
namesakes: the real `EVER GIVEN` (IMO 9811000) shares its name with a 1986 vessel
marked `decommissioned_lost`. Without that filter, one of the most recognisable
ships afloat would be unresolvable as "ambiguous".

If a name still matches more than one *active* vessel, the delivery is left with a
tracking problem rather than being matched to the wrong ship; set the IMO directly
to resolve it.

## Refresh

A delivery is refreshed from three places, all running the same code
(`lib/deliveryRefresh.ts`) so they cannot drift apart:

| Trigger | When | Scope |
| --- | --- | --- |
| **On create** | The moment a delivery is logged | Just that delivery |
| **Check now** | Someone clicks it on the delivery page | Just that delivery |
| **Scheduled** | Every 3 hours (sea freight: daily) | Everything due |

The two manual paths deliberately **ignore the interval and the failure backoff**
— those exist to ration automatic polling, and a person asking is an explicit
instruction to go and look. **Check now** also works on archived and
already-delivered deliveries, since re-reading a stored tracker costs nothing.

Neither can break anything it is attached to. A first check that fails does not
fail the create: the delivery is already saved and is perfectly valid without a
reading, so the failure is recorded on the row and the scheduled run retries. A
failed **Check now** returns `refreshed: false` with the reason rather than an
error page.

A skipped check — no provider credentials, or no usable identifier — is treated as
distinct from a failure: it does **not** move `lastCheckedAt` and does **not**
advance the backoff, so the delivery stays due for the next scheduled run rather
than appearing freshly checked.

### The scheduled run

The `ScheduledRefreshDeliveries` flow runs **every 3 hours** (`0 */3 * * *`). On
each run it re-polls the open deliveries that are due — not archived, not already
delivered or cancelled — and writes back status, ETA, destination and any new
tracking events.

How often "due" comes around depends on the mode, because the providers' quotas
and the underlying reality differ by an order of magnitude:

| Mode | Re-polled | Why |
| --- | --- | --- |
| **Air courier** | Every run (3 hours) | Courier status changes through the day, and EasyPost reads are free. |
| **Sea freight** | Once a day | A vessel's ETA moves slowly, and VesselAPI's free tier is only **150 calls/month** (~5/day). |

That sea-freight interval is not cosmetic. At the courier cadence a *single* sea
delivery would cost 8 calls a day — 240 a month, over the entire free-tier
allowance on its own. At once a day it costs 30 a month, so roughly **5
concurrent sea deliveries** fit the free tier. Raise `SEA_REFRESH_INTERVAL_MS` in
`deliveryTrackingHelpers.ts` if the plan changes.

Repeated polls do not duplicate history: events are keyed on their timestamp plus
description, so a provider replaying its whole scan list only ever adds what is
genuinely new.

### When a provider fails

A failed lookup **does not overwrite** the delivery's status or ETA — the
last-known-good figures stay, and the reason is recorded in **Tracking problem**
on the delivery. Repeated failures back off, so one bad tracking number cannot
consume a provider's quota — each failure doubles the mode's own interval, up to
16×:

| Consecutive failures | Courier | Sea freight |
| --- | --- | --- |
| 0 | 3 hours | 1 day |
| 1 | 6 hours | 2 days |
| 2 | 12 hours | 4 days |
| 3 | 24 hours | 8 days |
| 4 or more | 48 hours | 16 days |

A successful poll clears both the error and the counter.

Use **Stop tracking** to take a delivery out of the rotation without deleting it
— a wrong number, or a shipment nobody is chasing any more.

## Provider quotas

Each provider is polled within its own limits, which is why there are per-run
caps:

| Provider | Limit | How we stay inside it |
| --- | --- | --- |
| **FedEx** | 30 tracking numbers per call | Batched 30 at a time; 300 deliveries per run. |
| **DHL** | 250 calls/day, **1 call every 5 seconds**, no batch endpoint | One call per delivery, paced 5s apart, **25 per run** (8 runs/day = 200/day). |
| **VesselAPI** | Free tier: 150 calls/month | Sea deliveries are polled once a day (see above), capped at 10 per run; the vessel-name lookup happens once, then the IMO is cached. |

VesselAPI's monthly allowance is the hardest overall ceiling, and DHL's is the
tightest per-run one. If more than 25 DHL deliveries are open at once, the surplus
is simply picked up on the next run and the flow reports how many it deferred. A DHL rate-limit response stops that
run's DHL leg immediately rather than retrying — retrying is what exhausts an
allowance that is already thin.

This is deliberately separate from the Zoho quota problem described in
`CLAUDE.md`: these are different vendors, so delivery tracking cannot starve the
Zoho sync flows.

## Credentials

Each provider is independently gated on its secret. **A provider with no
credentials configured is skipped**, and the flow reports which ones are
inactive — so this feature is safe to deploy before the accounts exist, and each
one starts working as soon as its key is set.

| Secret | Provider |
| --- | --- |
| `EASYPOST_API_KEY` | EasyPost — covers FedEx, DHL and UPS |
| `VESSEL_API_KEY` | VesselAPI |

**No per-carrier credentials are needed.** EasyPost's docs warn that some carriers
restrict tracking data from third-party platforms, but a real DHL Express
consignment resolved on a bare production key with no DHL account of our own —
verified end to end. The key is sent as the HTTP Basic *username* with an empty
password.

EasyPost keys are environment-specific: a `EZTK…` test key only accepts EasyPost's
own synthetic codes (`EZ1000000001`–`EZ7000000007`) and rejects real tracking
numbers outright, so only an `EZAK…` production key will track live shipments.

Base URLs are environment variables (`EASYPOST_API_BASE_URL`,
`VESSEL_API_BASE_URL`).

### Why EasyPost for couriers

Three options were weighed. **TrackingMore** and **AfterShip** both put the
tracking API behind a higher-priced plan. **Direct carrier APIs** (FedEx, DHL and
UPS all publish free tracking APIs) cost nothing but mean three integrations, and
DHL's free tier caps at 250 calls/day with a one-call-every-5-seconds floor.
**EasyPost** charges ~$0.02 per consignment with no monthly minimum and covers all
three carriers through one API.

EasyPost won on the machinery it removes, not on price: the direct route needed
per-carrier request pacing, daily-quota accounting and per-run caps, all of which
existed purely to ration polling. One provider with free reads deletes that.

### Endpoints used

- **EasyPost** — `POST /v2/trackers` (`tracker[tracking_code]`,
  `tracker[carrier]`) on first contact, then `GET /v2/trackers/{id}` on every
  later poll. HTTP Basic with the API key as the username. Carrier codes are
  `FedEx`, `DHLExpress` and `UPS`.
- **VesselAPI** — `GET /v1/search/vessels?filter.name=…` to resolve a name once,
  then `GET /v1/vessel/{id}/eta?filter.idType=imo` on every poll. Bearer auth.

## Code map

| Path | What it holds |
| --- | --- |
| `backend/schemas/deliveries.keel` | `SupplierDelivery`, `DeliveryEvent`, the enums, actions and the flow declaration |
| `backend/flows/scheduledRefreshDeliveries.ts` | The 3-hourly run: which deliveries are due, in what order, and per-run caps |
| `backend/lib/deliveryRefresh.ts` | What one refresh *does* — provider dispatch and persistence, shared by all three triggers |
| `backend/functions/refreshSupplierDelivery.ts` | The **Check now** action for a single delivery |
| `backend/lib/deliveryTrackingHelpers.ts` | Provider-neutral logic — backoff, due-for-refresh, event dedup |
| `backend/lib/easypostTrackingHelpers.ts` | EasyPost tracker create/read, carrier codes, status + status_detail mapping |
| `backend/lib/vesselTrackingHelpers.ts` | Vessel name resolution, ETA, sea-freight status derivation |
| `backend/lib/deliveryInputHelpers.ts` | Mode/identifier validation and tracking-number normalisation |
| `backend/functions/createSupplierDelivery.ts` | Applies that validation on create |
