# Takealot barcodes

Keeps each product's **Takealot channel code** (`ProductChannelCode`, the code
printed on its unit labels — see [channel-barcode-labels.md](channel-barcode-labels.md))
in step with the label barcode Takealot holds against the product's offer, read
from the [Takealot Marketplace API](https://marketplace-api.takealot.com/v1/docs).

Offers are matched to products **by SKU**, and a product carries exactly **one
code per channel** (`@unique([product, channel])`), so a sync always updates the
product's single Takealot row in place — it can never mint a second one.

## Which field is the barcode?

An offer carries two barcode-like fields, and only one of them is on the labels:

| Field | What it holds | Example |
| --- | --- | --- |
| `product_label` | The EAN-13 Takealot prints on its own Seller Portal unit-label sheets — the code the FC scans. **This is what the sync stores.** | `9901043896425` |
| `barcode` | The merchant-provided barcode. Takealot backfills offers listed without one with a placeholder. **Never stored.** | `MPTAL75747951` |

This was verified against real Seller Portal label sheets from 2021 and 2026:
every printed EAN matched `product_label` exactly, while `barcode` held an
`MPTAL<tsin>` / `MPTALX<id>-0` placeholder that appears on no label. The first
version of this sync read `barcode` and filled the catalogue with placeholders;
re-running the flow replaces them.

## The three paths in

- **Automatically, per product.** `@on([create, update], syncTakealotBarcode)`
  on `Product` fires an event on every create and update. The subscriber acts
  only when the SKU is **new or changed** — the SKU is what identifies the offer,
  so no other edit can alter which barcode applies. It looks the offer up with
  `GET /v1/offers/by_sku/{sku}` and upserts the product's Takealot code.
- **Automatically, nightly.** **ScheduledSyncChannelCodes** runs the
  whole-catalogue sync below at 3am and applies it without review, alongside the
  Amazon one. The subscriber cannot see a `product_label` Takealot reissues
  against an unchanged SKU — no product write happens, so no event fires. The
  sweep is what catches that, and an offer created after the product arrived
  here. See [amazon-fnskus.md](amazon-fnskus.md#why-the-subscriber-is-not-enough-on-its-own)
  for why applying unreviewed is safe.
- **Manually, whole catalogue.** The **Sync Takealot Barcodes** flow pulls every
  offer via the paginated `GET /v1/offers` listing (1000 per page, full objects —
  no `fields=` trimming, so `product_label` is always present), shows a review of
  adds/updates, and applies on confirmation. Use it for the initial backfill, and
  whenever you want to see what would change before it does.

## What it never does

- **Delete or blank a code.** A product whose offer is missing (404) or whose
  offer carries no `product_label` keeps whatever code it has; the flow surfaces
  both cases as notes instead. Takealot not listing a product today does not
  make its stored GTIN wrong.
- **Touch other channels.** Only the *Takealot Marketplace* channel's rows are
  read or written. An Amazon FNSKU on the same product is a different identifier,
  not a stale Takealot code.
- **Push anything to Takealot.** The offer's barcode is read-only here; the sync
  brings Takealot's value in, never writes back.
- **Validate the code.** The barcode is stored verbatim (trimmed). Print-time
  validation still applies: a code that is not a valid EAN-13 drops out of the
  print picker with a banner, exactly as a mistyped manual code would.

## Configuration

| Name | What |
| --- | --- |
| `TAKEALOT_API_BASE_URL` | Environment variable, `https://marketplace-api.takealot.com`. |
| `TAKEALOT_API_KEY` | Secret, sent as the `X-API-Key` header. Generated in the Seller Portal under **API Access**. |

Only **one API key can be active per seller account** — regenerating the key
invalidates the old one everywhere it is used, so coordinate before rotating.
Without the key set (e.g. local dev), the subscriber logs and skips rather than
failing every product write; the flow fails loudly on its first fetch.

This API is Takealot's own and does **not** draw on the shared Zoho daily quota.

## Code

| File | Role |
| --- | --- |
| `schemas/products.keel` | The `@on([create, update], syncTakealotBarcode)` event hook on `Product`. |
| `schemas/labels.keel` | The `SyncTakealotBarcodes` and `ScheduledSyncChannelCodes` flow declarations (next to `ProductChannelCode`). |
| `lib/takealotOfferHelpers.ts` | API fetchers, the offer → code mapping that feeds the flow's plan, and the single-product sync for the subscriber. |
| `lib/channelCodeSync.ts` | The plan/apply pair itself — shared with the Amazon FNSKU import ([amazon-fnskus.md](amazon-fnskus.md)), so the never-delete and one-channel-only rules live once. |
| `subscribers/syncTakealotBarcode.ts` | Event handler: skip unless created or SKU changed, then sync that product. |
| `flows/syncTakealotBarcodes.ts` | UI orchestration only: confirm → review changes → apply. |
| `lib/channelCodeSweep.ts` | The unattended both-channel sweep behind `flows/scheduledSyncChannelCodes.ts`. |
