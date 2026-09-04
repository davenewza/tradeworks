# Channel shipments

Consignments of our stock going **into a sales channel's fulfilment centre** —
what Takealot calls a shipment against a purchase order — pulled from the
channel's own API so the warehouse can see what is due and print the unit
barcode labels for it in one run.

Read-only: nothing is ever pushed back to the channel.

## Why it is channel-generic

Nothing in the models names Takealot. A `ChannelShipment` belongs to a
`Channel`, carries that channel's identifiers verbatim, and maps that channel's
status vocabulary onto one shared enum. The platform-specific part is a single
**adapter** — a function that turns one API's payload into `ExternalShipment[]`.

Adding Amazon FBA inbound shipments is a new adapter file plus one line in
`SHIPMENT_ADAPTERS`; the models, the sync flow and the label printing do not
change. This mirrors how [channel-barcode-labels.md](channel-barcode-labels.md)
keeps the label itself channel-generic.

```
Takealot API ──► takealotShipmentHelpers ──┐
                                            ├──► ExternalShipment[] ──► channelShipmentHelpers ──► ChannelShipment
(future) Amazon API ──► amazonShipment… ───┘        (transport shape)        (plan / apply)        ChannelShipmentItem
```

## How lines are matched to products

Takealot's shipment lines name a listing by **`offer_id` only** — there is no
SKU on the line. The adapter therefore fetches an `offer_id → sku` index
(`GET /v1/offers?fields=offer_id&fields=sku`, trimmed hard because it is an
index, not the offers themselves) and resolves each line through it. Products
are then matched **by SKU**, the same rule the barcode sync uses.

A line that cannot be matched is **kept, not dropped** — with its `listingRef`
and whatever SKU was found — so units never silently disappear from a
consignment. `matchedLines` versus `totalLines` shows the gap at a glance, and
the sync's review page lists the unmatched SKUs.

## Status

Each platform's vocabulary maps onto one enum. The order matters: Takealot
leaves `shipped` true after the fulfilment centre unloads, so the most advanced
state has to win.

| `ChannelShipmentStatus` | Takealot |
| --- | --- |
| `Cancelled` | `cancelled` is true (checked first) |
| `Received` | `date_unloaded` is set — the only positive signal the stock arrived |
| `Shipped` | `shipped` is true |
| `Open` | anything else |

The platform's own wording (`purchase_order_state`) is kept verbatim in
`statusDescription` alongside it.

## Syncing

The **Sync channel shipments** flow (Logistics → Channel shipments) shows a
review of what will change and applies on confirmation — the same confirm →
review → apply shape as the other syncs.

### What gets pulled

**Only consignments that have not shipped yet** — Takealot's draft and confirmed
states, filtered server-side with `shipped=false`. Those are the ones that still
need labelling, and a channel keeps every consignment it has ever had, so pulling
the lot and discarding most of it is wasted calls.

That filter alone would strand what we already track: a consignment that shipped
since the last sync simply stops coming back, and its stored row would sit at
`Open` forever — still offering to print labels for stock that has already gone.
So the sync *also* fetches the ids it already tracks in a non-terminal state
(`openShipmentExternalIds` → `shipment_id__in`), in batches of 100. `Received`
and `Cancelled` are terminal and drop out, so a finished consignment stops
costing a lookup.

The flow's **Pull the full history** box lifts both filters for a backfill.

Comparison is a **full diff of the header and every line**, not a
last-modified timestamp: channels do not reliably restamp a consignment when
only a line quantity moves, and a missed quantity change would mean printing the
wrong number of labels.

What it does and does not do:

- **Shipments are never deleted.** One the channel stops returning (archived,
  say) keeps its row and its history.
- **Lines within a synced shipment *are* deleted** when the channel no longer
  lists them. The channel owns what is on its own consignment, and a stale line
  would keep printing labels for units that are not going in.
- **Shipped and archived consignments are skipped** unless *Pull the full
  history* is ticked — except for ones already tracked here, which are always
  refreshed so their status can finish moving.
- **Nothing is written back** to the channel.

Both shipments and the offer index page at 1000 per request, so a full sync is a
handful of calls. This is Takealot's own API and does **not** draw on the shared
Zoho daily quota.

## Printing a shipment's labels

**Print barcode labels** on a shipment page runs the existing
`PrintChannelBarcodes` flow with the shipment's id. The shipment fixes the
channel — a Takealot consignment is labelled with Takealot's codes and nothing
else — so the channel picker is skipped, and the label count for each line is
seeded from the units being sent rather than starting at 1. The label stock comes
off the channel's spec, so the operator only reviews the counts and prints.

Lines are left out of the run, with the reason shown, when they are:

- **cancelled** — counted rather than listed; not a problem to fix;
- **not matched to a product** — fixed by *Sync Products* then re-syncing;
- **carrying no units** — nothing to print;
- **missing a code for the channel**, or carrying one that is not valid under
  the channel's symbology — fixed under *Channel codes* on the product page.

Seeding falls back to `quantityRequired` when a consignment the channel has
asked for has not been packed yet (everything still sending zero).

Lines are ordered by **product name** — in the Console's shipment view, in the
print flow's counts grid, and in the order the labels come off the printer — so
the printed stack can be checked against the screen. Lines with no matched
product have no name and sort last.

## Dates

`dueDate` is a **calendar date**, held as `YYYY-MM-DD` in the transport shape and
written at local midnight. A Postgres `date` column round-trips as local
midnight, so parsing `2026-09-01` as UTC and comparing instants would report a
change on every sync in any timezone east of UTC — which SAST is. `placedAt` and
`receivedAt` are genuine instants and stay ISO timestamps.

## Configuration

Nothing beyond what the barcode sync already needs — see
[takealot-barcodes.md](takealot-barcodes.md) for `TAKEALOT_API_BASE_URL` and
`TAKEALOT_API_KEY`. A channel whose credentials are unset simply does not appear
as an option, and with none set the flow says so rather than failing mid-fetch.

## Code

| File | Role |
| --- | --- |
| `schemas/channelShipments.keel` | `ChannelShipment`, `ChannelShipmentItem`, the status enum, and the `SyncChannelShipments` flow declaration. |
| `lib/channelShipmentHelpers.ts` | The transport shape, and the channel-generic plan/apply pair. No platform knowledge. |
| `lib/channelShipmentAdapters.ts` | The registry of platforms we can pull from. |
| `lib/takealotShipmentHelpers.ts` | Takealot fetchers (shipments, offer index) and the normalisation into the transport shape. No database access. |
| `flows/syncChannelShipments.ts` | UI orchestration only: confirm → review → apply. |
| `lib/barcodeLabelSelection.ts` | `loadShipmentLabelCandidates` — a consignment's labelling picture. |
| `flows/printChannelBarcodes.ts` | The shipment entry path, alongside the product ones. |
