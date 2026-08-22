# Channel barcode labels

Prints the unit barcode labels that go on stock heading into a channel's
fulfilment centre, straight to the warehouse Zebra as ZPL. It replaces
downloading each channel's barcode PDF and printing it n-up on A4.

Nothing about the label is channel-specific in code. A channel becomes printable
once it has a **label spec**, so adding one is a row rather than a deploy.

## Where to find it

- **Products → Barcode labels → Print barcodes** — pick a channel, then products,
  set label counts, print.
- **A product page → Print barcode label** — same flow for one product; it skips
  the picker and goes straight to that product's label count.
- **Products → Barcode labels → Label specs** — how each channel's label is built.
- **A product page → Channel codes** — the per-channel codes for that product.

## The two shapes in use

|  | Takealot | Amazon FBA |
| --- | --- | --- |
| **Symbology** | EAN-13 | Code 128 |
| **Code** | the product's GTIN, as held against the offer | the **FNSKU** Amazon assigns |
| **Annotation** | `MP`, stacked beside the symbol | the **item condition** (`New`), below the title |
| **Typical stock** | 50 × 25 mm | 66.7 × 25.4 mm (2⅝" × 1") |

Amazon requires the item condition on every unit label, which is what the
annotation carries. The Takealot geometry was measured off a Seller Portal
barcode sheet (`product_labels_<date>_<DC>.pdf`); the bar pattern our EAN-13 path
produces for that sheet's barcode is bit-for-bit identical to the pattern in the
PDF.

## Capturing codes

Codes live in **`ProductChannelCode`** — one row per product per channel — not as
a single field on the product. They are not interchangeable: an FNSKU is Amazon's
own fulfilment identifier and means nothing anywhere else, so collapsing them onto
the product would only ever work for the EAN case. The cost is that a product sold
on two EAN-13 channels carries the same digits twice; that is explicit and
visible, which beats one field the flow has to guess the meaning of.

Validation depends on the channel's symbology:

- **EAN-13** — 13 digits with a correct check digit. The grouping channels display
  (`9 901043 896425`) is fine, since spaces and hyphens are stripped. A wrong
  check digit is **rejected, never corrected** — it is a transcription error, and
  quietly fixing the last digit would mint labels for a different product.
- **Code 128** — any printable ASCII, up to 48 characters. Deliberately *not*
  narrowed to Amazon's `X`+9 FNSKU pattern: the same symbology legitimately
  carries ASINs and seller SKUs, and rejecting those would be wrong.

Products whose code fails validation are left out of the picker, and the flow
shows a banner counting them, so a bad code is visible rather than the product
just being silently absent.

**Takealot codes fill themselves in** — they are synced from the barcode the
Marketplace API holds against each offer, on product create / SKU change and via
the *Sync Takealot Barcodes* flow (see [takealot-barcodes.md](takealot-barcodes.md)).
Manual capture remains for channels without an API sync, such as Amazon's FNSKUs.

## Label stock, and why the symbology changes the answer

This is the one real constraint. ZPL's `^BY` only takes **whole dots**, so on a
203 dpi printer (the ZD220/ZD230, i.e. the "ZD200 series") the module width can
only be a multiple of 0.125 mm. The two symbologies then behave differently:

**EAN-13** is a fixed 95 modules, and GS1 requires quiet zones of 11 left and 7
right — **113 modules** must fit, not just the 95 the bars occupy:

| Module | X-dimension | 113 modules | EAN-13 min 0.264 mm |
| --- | --- | --- | --- |
| 2 dots | 0.250 mm | 28.3 mm | ✗ under the minimum |
| 3 dots | 0.375 mm | 42.4 mm | ✓ |

A 40 mm label cannot fit 42.4 mm, so 40 mm stock forces 2 dots and falls out of
tolerance. **50 × 25 mm is the smallest common roll that prints EAN-13 in spec at
203 dpi.**

**Code 128** is variable width — 11 modules per character, plus 35 fixed and 10
quiet modules either side, so `11n + 55`. A 10-character FNSKU is 165 modules.
Crucially its minimum X-dimension is **0.250 mm**, not 0.264 mm, so a 2-dot module
is exactly in spec:

| Module | X-dimension | 165 modules | Code 128 min 0.250 mm |
| --- | --- | --- | --- |
| 2 dots | 0.250 mm | 41.3 mm | ✓ (at the minimum) |
| 3 dots | 0.375 mm | 61.9 mm | ✓ |

So Amazon labels are *easier* on this printer than Takealot's, despite the longer
symbol. On 66.7 mm stock a 10-character FNSKU gets a comfortable 3-dot module.

Because Code 128 grows with the code, the print page checks **every** row and
warns on the tightest one — a long code in the batch is what decides whether the
run is in tolerance, not the first one.

The flow pre-selects the spec's default stock and lets the operator override it
per run. `computeLayout` derives every coordinate from the stock, symbology and
code, so adding a roll size is one entry in `LABEL_STOCKS` plus one enum value.

Takealot's own PDF uses a 0.330 mm X-dimension — GS1 nominal, and unreachable in
whole dots at 203 dpi (2.68 dots) — which is why our label is not a pixel-exact
copy of theirs.

## Quantities

Counts start at **1**, with each product's units **on hand** shown beside them for
reference. Defaulting to stock on hand was rejected deliberately: you label the
units going into the FC, which is normally a subset of what's on hand, and one
stray click on a 340-unit product would burn a roll of labels.

Each product becomes one print job using ZPL's `^PQ` copy count, so 200 labels is
one small format rather than 200 copies of it. Jobs are individually
reprintable — if a label jams or prints short, reprint just that product.

## Printing

The printer is declared in `keelconfig.yaml`:

```yaml
hardware:
  printers:
    - name: Barcode labels
```

Keel generates a `Hardware` type from that, narrowing the `printer` field to the
declared names — so a typo in the flow is a compile error rather than a job that
silently vanishes. The physical device the name resolves to is bound in the
Console.

## Code

| File | Role |
| --- | --- |
| `schemas/labels.keel` | `ChannelLabelSpec`, `ProductChannelCode`, the symbology / stock / placement enums, and the flow. |
| `lib/barcodeLabelHelpers.ts` | Code validation, label geometry, ZPL generation, row building. Pure apart from the generated enums — no DB, no printer. |
| `lib/barcodeLabelSelection.ts` | The DB queries (printable channels, candidates, stock on hand). |
| `flows/printChannelBarcodes.ts` | UI orchestration only: channel → products → counts → print. |

## Setting up a new channel

1. Create the `Channel` if it does not exist.
2. **Products → Barcode labels → Label specs → Add a label spec**: pick the
   channel, its symbology, the fixed annotation and placement, and the default
   stock.
3. Add a **channel code** per product you intend to label (product page → Add
   channel code).

## Known gaps

- **Bulk code capture for non-Takealot channels.** Takealot codes are now synced
  from the Marketplace API ([takealot-barcodes.md](takealot-barcodes.md)), which
  covers the catalogue for that channel. Other channels' codes — Amazon FNSKUs in
  particular — are still entered one product-channel pair at a time; a bulk path
  would want a CSV import off the channel's own offer export, the same shape as
  the existing `ImportProductViews` flow.
- **No print preview in the Console.** The label is generated as native ZPL and
  rendered by the printer, so there is no on-screen proof before it prints. A
  preview would mean rasterising server-side (the approach klira takes for its
  dispensing labels), costing a `sharp` dependency and a bitmap-quality barcode.
- **Amazon's stated 300 dpi guidance.** Amazon's docs ask for a 300 dpi printer.
  203 dpi is widely used for FNSKU labels in practice — Amazon's own FCs run
  203 dpi Zebras — and the Code 128 maths above lands in spec, but it is worth
  knowing the guidance exists if a shipment is ever queried.
