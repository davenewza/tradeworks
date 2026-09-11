# Amazon FNSKUs

Keeps each product's **Amazon channel code** (`ProductChannelCode`, the code
printed on its unit labels — see
[channel-barcode-labels.md](channel-barcode-labels.md)) in step with the
**FNSKU** Amazon holds against the product's FBA listing, read from the
[Selling Partner API](https://developer-docs.amazon.com/sp-api/). The FNSKU is
Amazon's fulfilment-network SKU: the Code 128 barcode on every FBA unit label,
assigned by Amazon per seller per listing and meaningless anywhere else.

Listings are matched to products **by seller SKU**, and a product carries
exactly **one code per channel** (`@unique([product, channel])`), so a sync
always updates the product's single Amazon row in place. It is the same
plan → review → apply shape as the Takealot barcode sync and runs on the same
core (`lib/channelCodeSync.ts`): only the Amazon channel's rows are read or
written, and nothing is ever deleted.

## Where to find it

**Products → Barcode labels → Sync Amazon FNSKUs.** Confirm, review the adds
and updates, apply.

## What the API is asked

Two calls per sync, neither of which draws on the shared Zoho quota:

1. **Login with Amazon** — `POST https://api.amazon.com/auth/o2/token` with the
   `refresh_token` grant, exchanging the stored refresh token for a one-hour
   access token. SP-API no longer requires AWS request signing; the access
   token in `x-amz-access-token` is the whole of it.
2. **FBA Inventory** — `GET /fba/inventory/v1/summaries` with
   `granularityType=Marketplace` and the marketplace ID, paged with `nextToken`
   to the end. With no SKU or date filter the API returns **every FBA listing**
   in the marketplace, each with `sellerSku`, `fnSku`, `asin`, `condition` and
   `productName` — the same fields as the *Manage FBA Inventory* page.

The inventory API allows **2 requests a second (burst 2)** and a `nextToken`
expires **30 seconds** after it is issued, so pages are paced half a second
apart and a throttled page is retried after 1, 2 and 4 seconds before the sync
gives up. A few hundred listings is a handful of pages and well under a minute.

## What happens to each listing

| Listing | Outcome |
| --- | --- |
| FNSKU present, product matched | Planned as **New** (no Amazon code yet) or **Update** (differs), or counted as unchanged. |
| Seller SKU matches no product | Noted. Run *Sync Products* first, or check the seller SKU on Amazon matches the Zoho SKU. |
| No FNSKU | Product left untouched and noted — Amazon not holding one today does not make a stored code wrong. |
| FNSKU **equals the ASIN** | Left untouched and noted separately (below). |
| Condition is not New | FNSKU **still synced**, but warned (below). |
| No seller SKU | Skipped. |
| Same SKU twice | Warned; the last occurrence wins. |

Enabled products with no FBA listing are listed for information only.

### FNSKU equal to ASIN

Amazon reports a listing's FNSKU **as its ASIN** when the listing is set up to
use the **manufacturer barcode**: the fulfilment centre scans the product's own
EAN/UPC, and no FNSKU label goes on those units. Storing the ASIN as the
product's Amazon code would print a Code 128 label nobody wants, so those
listings are surfaced rather than stored, and any FNSKU already on the product
is kept. (Amazon ended commingled inventory in March 2026 and now requires FNSKU
labels from most sellers, so a listing still on the manufacturer barcode is
worth a look.)

### Condition

Amazon requires the item condition on every unit label, and the Amazon label
spec prints **one fixed annotation** for the channel — `New`. A listing Amazon
holds as used or refurbished (`UsedLikeNew`, `Refurbished`, …) would therefore
be labelled "New", so those are called out as a warning. The FNSKU is still
right, so it is still synced. Amazon's own New variants (`NewItem`,
`NewWithWarranty`, `NewOEM`, `NewOpenBox`) all count as New.

## What it never does

- **Delete or blank a code.** A product with no FBA listing, or whose listing
  carries no FNSKU, keeps whatever code it has; the flow surfaces both cases as
  notes instead.
- **Touch other channels.** Only the *Amazon Marketplace* channel's rows are
  read or written. A Takealot EAN on the same product is a different identifier,
  not a stale Amazon code.
- **Push anything to Amazon.** The listing is read-only here.
- **Validate the code.** The FNSKU is stored verbatim (trimmed). Print-time
  validation still applies: a code Code 128 cannot encode drops out of the print
  picker with a banner.

## The shipment sync also sets codes

Amazon's **inbound shipment** lines carry the FNSKU of the units actually going
into the fulfilment centre, so
[Sync channel shipments](channel-shipments.md#label-codes-stated-on-a-line) sets
the matched products' Amazon codes from them as it goes — a consignment can be
labelled without running this sync first. It applies the same rules (matched by
SKU, only this channel's rows, an ASIN-as-FNSKU refused, nothing ever deleted),
on the same shared core, but it only ever sees the SKUs on those consignments.
This sync remains the way to cover the **whole catalogue**.

## Why there is no per-product subscriber

Takealot codes are also synced one product at a time, on product create or SKU
change. Amazon deliberately is not: an FNSKU exists once the **listing** is
created on Amazon, which normally happens *after* the product exists in Zoho, so
a hook on product create would mostly find no listing yet — and nothing would
fire again when the listing appeared. Run the sync after listing new products;
it is one confirmation and a few seconds. (A nightly scheduled sync would be the
next step if that becomes a chore; it applies without review, which is why it is
not the default.)

## After syncing

Codes and the label spec are set up separately, so the first sync can leave
every product coded and still nothing printable. The completion page says so if
the Amazon channel has no enabled **label spec**, with the shape to create under
*Products → Barcode labels → Add a label spec*: channel *Amazon Marketplace*,
symbology **Code 128**, annotation **New** placed **below the title**, stock
**66.7 × 25.4 mm** (2⅝" × 1"). Once that exists, *Print barcodes* offers Amazon
alongside Takealot.

## Configuration

| Name | What |
| --- | --- |
| `AMAZON_SP_API_BASE_URL` | Environment variable, `https://sellingpartnerapi-eu.amazon.com`. Amazon.co.za is served by the **EU** regional endpoint. |
| `AMAZON_LWA_TOKEN_URL` | Environment variable, `https://api.amazon.com/auth/o2/token`. |
| `AMAZON_MARKETPLACE_ID` | Environment variable, `AE08WJ6YKNBMC` — Amazon South Africa. |
| `AMAZON_LWA_CLIENT_ID` | Environment variable. The Login with Amazon client ID of the seller's own SP-API app — an identifier, not a secret, like the Zoho client ID. |
| `AMAZON_LWA_CLIENT_SECRET` | Secret. The app's client secret. |
| `AMAZON_LWA_REFRESH_TOKEN` | Secret. The refresh token from self-authorising the app. |

The app is created in Seller Central under **Apps & Services → Develop Apps**;
its roles must include the FBA Inventory API (the *Amazon Fulfillment* role,
which also covers the Fulfillment Inbound API the shipment sync reads).
Self-authorising it there produces the refresh token. Set the two secrets per
environment with `keel secrets set`; without them the flow fails loudly on its
first fetch. Rotating the client secret in Developer Central invalidates the old
one, so coordinate before regenerating.

## Code

| File | Role |
| --- | --- |
| `schemas/labels.keel` | The `SyncAmazonFnskus` flow declaration (next to `ProductChannelCode`). |
| `lib/amazonFnskuHelpers.ts` | The paged FBA Inventory fetch, the Amazon-specific plan (manufacturer-barcode and condition notes), the label-spec check. |
| `lib/amazonApi.ts` | The LWA token exchange and the paced, throttle-aware GET, shared with the inbound shipment sync. |
| `lib/channelCodeSync.ts` | The plan/apply pair shared with the Takealot barcode sync. |
| `flows/syncAmazonFnskus.ts` | UI orchestration only: confirm → review changes → apply. |
