# Channel shipments

Consignments of our stock going **into a sales channel's fulfilment centre** —
what Takealot calls a shipment against a purchase order, and what Amazon calls a
shipment inside an FBA inbound plan — pulled from the channel's own API so the
warehouse can see what is due and print the unit barcode labels for it in one
run.

Read-only: nothing is ever pushed back to the channel.

## Why it is channel-generic

Nothing in the models names Takealot or Amazon. A `ChannelShipment` belongs to a
`Channel`, carries that channel's identifiers verbatim, and maps that channel's
status vocabulary onto one shared enum. The platform-specific part is a single
**adapter** — a function that turns one API's payload into `ExternalShipment[]`.

Amazon was added as exactly that: one adapter file plus one line in
`SHIPMENT_ADAPTERS`. The models grew two fields for shapes Takealot does not
have (below), but the sync flow and the label printing did not change. This
mirrors how [channel-barcode-labels.md](channel-barcode-labels.md) keeps the
label itself channel-generic.

```
Takealot API ──► takealotShipmentHelpers ──┐
                                            ├──► ExternalShipment[] ──► channelShipmentHelpers ──► ChannelShipment
Amazon SP-API ──► amazonShipmentHelpers ───┘        (transport shape)        (plan / apply)        ChannelShipmentItem
```

### What Amazon needed that Takealot did not

Two model fields, both channel-generic and both blank on Takealot:

- **`ChannelShipment.externalGroupId`** — Amazon nests shipments inside an
  **inbound plan**, and a shipment is only addressable as
  `/inboundPlans/{planId}/shipments/{shipmentId}`. Without the plan id a
  consignment we track could never be asked for again. Takealot's consignments
  stand alone, so it stays null there.
- **`ChannelShipmentItem.labelledByChannel`** — Amazon says per line who applies
  the unit label. Anything other than `SELLER` means it is not ours to print
  (see [Printing](#printing-a-shipments-labels)). On Takealot the labels are
  always ours.

## How lines are matched to products

Both channels match **by SKU**, the same rule the barcode sync uses — but they
get there differently.

**Amazon** puts our own seller SKU on the line (`msku`), so no lookup is needed.
It also puts the **FNSKU** there, which is the code the unit label has to carry;
see [Label codes](#label-codes-stated-on-a-line) below.

**Takealot's** shipment lines name a listing by **`offer_id` only** — there is no
SKU on the line. The adapter therefore fetches an `offer_id → sku` index
(`GET /v1/offers?fields=offer_id&fields=sku`, trimmed hard because it is an
index, not the offers themselves) and resolves each line through it.

A line that cannot be matched is **kept, not dropped** — with its `listingRef`
and whatever SKU was found — so units never silently disappear from a
consignment. `matchedLines` versus `totalLines` shows the gap at a glance, and
the sync's review page lists the unmatched SKUs.

## Status

Each platform's vocabulary maps onto one enum. The order matters: Takealot
leaves `shipped` true after the fulfilment centre unloads, so the most advanced
state has to win.

| `ChannelShipmentStatus` | Takealot | Amazon |
| --- | --- | --- |
| `Cancelled` | `cancelled` is true (checked first) | `CANCELLED`, `ABANDONED`, `DELETED`, or the whole inbound plan is `VOIDED` |
| `Received` | `date_unloaded` is set — the only positive signal the stock arrived | `CHECKED_IN`, `RECEIVING`, `CLOSED` — the centre has the stock |
| `Shipped` | `shipped` is true | `SHIPPED`, `IN_TRANSIT`, `DELIVERED`, `MIXED` |
| `Open` | anything else | `UNCONFIRMED`, `WORKING`, `READY_TO_SHIP`, and anything unrecognised |

The platform's own wording is kept verbatim in `statusDescription` alongside it —
Takealot's `purchase_order_state`, Amazon's `READY_TO_SHIP` and friends as sent.

Two deliberate choices on the Amazon side:

- **`DELIVERED` is not `Received`.** `Received` is terminal here, so it stops the
  consignment being refreshed. Treating "the carrier dropped it off" as received
  would freeze it before the centre had checked it in, and it would never reach
  `CLOSED`.
- **An unrecognised state falls back to `Open`**, which keeps the consignment
  visible and refreshing rather than quietly retiring it if Amazon adds a state.

Two fields Takealot fills and Amazon cannot:

- **`receivedAt`** stays null on Amazon — the API exposes no unload timestamp, so
  arrival is carried by the status alone.
- **`isArchived`** is always false — Amazon has no archive flag; a plan it is
  finished with is voided, which comes through as cancelled.

## Label codes stated on a line

Amazon's shipment lines carry the **FNSKU** — the code that has to be on the
units in *that* consignment. Where a channel states a code like this
(`ExternalShipmentItem.code`; Takealot's lines do not), the sync brings the
matched products' `ProductChannelCode` rows into step with it, so a freshly
synced consignment is printable without running
[Sync Amazon FNSKUs](amazon-fnskus.md) first.

That runs on the same shared core as the barcode syncs
(`lib/channelCodeSync.ts`) and keeps its rules: only this channel's codes are
read or written, and none is ever deleted or blanked. Two details specific to
this path:

- Codes are diffed across **every consignment fetched**, not just the ones that
  changed, so a code that has drifted is still fixed in a sync where no
  consignment itself moved. That is why the flow can offer changes to apply with
  zero shipment changes.
- An **FNSKU equal to the ASIN** is refused, exactly as the FNSKU sync refuses
  it: Amazon reports it that way for a listing set to use the manufacturer
  barcode, and storing it would print a label nobody wants.

One SKU appearing across several consignments is ordinary and passes quietly;
consignments that *disagree* about a code warn on the review page, and the
**most recently placed** one wins — adapters return consignments newest first,
so reading them in that order would let one from months ago overwrite the code
for the one going out this week.

## Syncing

The **Sync channel shipments** flow (Logistics → Channel shipments) shows a
review of what will change and applies on confirmation — the same confirm →
review → apply shape as the other syncs.

### What gets pulled

**Only consignments that have not shipped yet.** Those are the ones that still
need labelling, and a channel keeps every consignment it has ever had, so pulling
the lot and discarding most of it is wasted calls.

- **Takealot** filters server-side with `shipped=false`, which covers its draft
  and confirmed states.
- **Amazon** has no such filter. The nearest thing is listing inbound plans with
  `status=ACTIVE`, so that is what is walked — plus, because an abandoned plan
  stays `ACTIVE` on Amazon forever and the listing takes no date filter either, a
  **90-day last-updated window**. The listing is sorted newest-updated first, so
  the first plan past the window means every later one is too and the walk stops
  there. The API has no marketplace filter, so plans belonging to another
  marketplace on the same seller account are dropped client-side.

That filtering alone would strand what we already track: a consignment that
shipped since the last sync simply stops coming back, and its stored row would
sit at `Open` forever — still offering to print labels for stock that has already
gone. So the sync *also* fetches what it already tracks in a non-terminal state
(`openShipmentRefs`) — for Takealot by `shipment_id__in` in batches of 100, for
Amazon by re-reading the consignment's inbound plan, which is what
`externalGroupId` is stored for. `Received` and `Cancelled` are terminal and drop
out, so a finished consignment stops costing a lookup.

The flow's **Pull the full history** box lifts all of these filters for a
backfill — for Amazon that means the `SHIPPED` and `VOIDED` plan statuses too,
and no window.

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

### What it costs

**Takealot** pages both shipments and the offer index at 1000 per request, so a
full sync is a handful of calls.

**Amazon** is chattier, because its shipments are nested: one Login with Amazon
token exchange, then a page of inbound plans per 30, then one call per plan plus
two per shipment (the shipment, and its lines paged at 1000). Every one of those
operations allows **2 requests a second**, so calls are spaced half a second
apart and a throttled one is retried after 1, 2 and 4 seconds — the same pacing
the FNSKU sync uses, shared from `lib/amazonApi.ts`. The 90-day window above is
what keeps this bounded.

Neither channel's API draws on the shared **Zoho** daily quota.

## Printing a shipment's labels

**Print barcode labels** on a shipment page runs the existing
`PrintChannelBarcodes` flow with the shipment's id. The shipment fixes the
channel — a Takealot consignment is labelled with Takealot's codes and nothing
else — so the channel picker is skipped, and the label count for each line is
seeded from the units being sent rather than starting at 1. The label stock comes
off the channel's spec, so the operator only reviews the counts and prints — two
pages, with the consignment's summary and any excluded lines shown above the
counts rather than on a page of their own.

Lines are left out of the run, with the reason shown, when they are:

- **cancelled** — counted rather than listed; not a problem to fix;
- **labelled by the channel** — Amazon's `labelOwner` says `AMAZON` (Amazon
  applies the label, for a fee) or `NONE` (the units carry the manufacturer's own
  barcode). Counted, not listed, for the same reason: there is nothing to fix,
  and printing FNSKU labels for those units would be wasted or wrong;
- **not matched to a product** — fixed by *Sync Products* then re-syncing;
- **carrying no units** — nothing to print;
- **missing a code for the channel**, or carrying one that is not valid under
  the channel's symbology — fixed under *Channel codes* on the product page, or
  by re-syncing the consignment on a channel that states its codes.

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

Where each channel's dates come from:

| Field | Takealot | Amazon |
| --- | --- | --- |
| `placedAt` | the shipment's `created_at` | the **inbound plan's** `createdAt` — a shipment carries no date of its own |
| `dueDate` | `due_date` | `selectedDeliveryWindow.startDate`, falling back to `dates.readyToShipWindow.start` before a delivery window is chosen |
| `receivedAt` | `date_unloaded` | not exposed; always null |

## Configuration

Nothing beyond what the barcode syncs already need — see
[takealot-barcodes.md](takealot-barcodes.md) for `TAKEALOT_API_BASE_URL` and
`TAKEALOT_API_KEY`, and [amazon-fnskus.md](amazon-fnskus.md) for the SP-API
environment variables and the two Login with Amazon secrets. The SP-API app's
roles must include **Amazon Fulfillment**, which covers both the FBA Inventory
and Fulfillment Inbound APIs. A channel whose credentials are unset simply does not appear
as an option, and with none set the flow says so rather than failing mid-fetch.

## Code

| File | Role |
| --- | --- |
| `schemas/channelShipments.keel` | `ChannelShipment`, `ChannelShipmentItem`, the status enum, and the `SyncChannelShipments` flow declaration. |
| `lib/channelShipmentHelpers.ts` | The transport shape, and the channel-generic plan/apply pair. No platform knowledge. |
| `lib/channelShipmentAdapters.ts` | The registry of platforms we can pull from. |
| `lib/takealotShipmentHelpers.ts` | Takealot fetchers (shipments, offer index) and the normalisation into the transport shape. No database access. |
| `lib/amazonShipmentHelpers.ts` | Amazon fetchers (inbound plans, shipments, lines) and the normalisation into the transport shape. No database access. |
| `lib/amazonApi.ts` | The LWA token exchange and the paced, throttle-aware GET, shared with the FNSKU sync. |
| `lib/channelCodeSync.ts` | The code plan/apply pair, shared with the barcode syncs — see *Label codes* above. |
| `flows/syncChannelShipments.ts` | UI orchestration only: confirm → review → apply. |
| `lib/barcodeLabelSelection.ts` | `loadShipmentLabelCandidates` — a consignment's labelling picture. |
| `flows/printChannelBarcodes.ts` | The shipment entry path, alongside the product ones. |
