# Channel barcode labels

Prints the unit barcode labels that go on stock heading into a channel's
fulfilment centre, straight to the warehouse Zebra as ZPL. It replaces
downloading each channel's barcode PDF and printing it n-up on A4.

Nothing about the label is channel-specific in code. A channel becomes printable
once it has a **label spec**, and what its label carries — the barcode, the
product name, any fixed text — is a list of **label element** rows hanging off
that spec. Both are data, so a new channel, or a new line of text on an existing
one, is a row rather than a deploy.

## Where to find it

- **Products → Barcode labels → Print barcodes** — pick a channel, then products,
  set label counts, print.
- **A product page → Print barcode label** — same flow for one product; it skips
  the picker and goes straight to that product's label count.
- **A channel shipment → Print barcode labels** — same flow for a whole
  consignment; the shipment fixes the channel and seeds a label count per line
  from the units being sent. See [channel-shipments.md](channel-shipments.md).
- **Products → Barcode labels → Sync Amazon FNSKUs** — pull each FBA listing's
  FNSKU from the Selling Partner API. See [amazon-fnskus.md](amazon-fnskus.md).
- **Products → Barcode labels → Sync Takealot barcodes** — pull each offer's
  label barcode from the Marketplace API. See
  [takealot-barcodes.md](takealot-barcodes.md).
- **Products → Barcode labels → Label specs** — how each channel's label is
  built; open one to edit the elements it carries.
- **A product page → Channel codes** — the per-channel codes for that product.

## What a label is made of

A label is a stack of **elements**, printed top to bottom in `position` order.
There are four kinds:

| Kind | What it prints |
| --- | --- |
| **Barcode** | The symbol, plus the human-readable interpretation line the printer draws directly beneath the bars. Exactly one per spec. It takes whatever height the other elements leave. |
| **Title** | The product name, wrapped to its `maxLines` and truncated to fit. |
| **Text** | A fixed line — Amazon's item condition. |
| **Stacked text** | Fixed text set one character per line down the left of the symbol — Takealot's `MP`. Out of the vertical flow, so `position` does not apply to it. |

That the *barcode and the title are themselves elements* is the point. The two
shapes in use disagree about where the product name goes, not just about the
fixed text, so no arrangement of named slots — "above the barcode", "below the
barcode" — covers both:

|  | Takealot | Amazon FBA |
| --- | --- | --- |
| **Symbology** | EAN-13 | Code 128 |
| **Code** | the product's GTIN, as held against the offer | the **FNSKU** Amazon assigns |
| **Elements** | Title → Barcode, with `MP` stacked beside the bars | Barcode → Title → Text `New` |
| **Label stock** | 50 × 30 mm — the warehouse roll | 50 × 30 mm |

Amazon requires the **item condition** on every unit label and wants it at the
bottom, under the product name — hence the order. The FNSKU itself needs no
element: it is the barcode's own interpretation line, which `^BC`'s fourth
parameter puts directly beneath the bars.

A spec with **no elements still prints** — the product name over the barcode,
the shape every channel shares — and the print page says so in a banner. The
same fallback catches a spec whose elements do not make a label (no barcode, two
titles, a text element with no text); the banner names the problem. A plain
label beats a blank one when the run is a consignment that is already packed,
but it should never pass for a configured one.

The **title always runs the full width of the label from the left margin**,
wherever it sits in the stack. Stacked text sits beside the *bars*, not beside
the title, so it never reaches it — indenting the title to clear that column
would only drop characters off a long product name. On a Takealot label the
title, the stacked `MP` and the EAN's lead digit therefore share one left edge.

The Takealot geometry was measured off a Seller Portal
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

**Takealot codes fill themselves in** — they are synced from each offer's
`product_label` (the EAN on Takealot's own label sheets; *not* the merchant
`barcode` field, which is often an `MPTAL…` placeholder), on product create /
SKU change and via the *Sync Takealot Barcodes* flow (see
[takealot-barcodes.md](takealot-barcodes.md)).

**Amazon FNSKUs are synced too** — from each FBA listing via the Selling
Partner API's FBA Inventory summaries, through the *Sync Amazon FNSKUs* flow
(see [amazon-fnskus.md](amazon-fnskus.md)). Both syncs run on the same
plan → review → apply core (`lib/channelCodeSync.ts`) and share its rules:
matched by SKU, only that channel's rows touched, nothing ever deleted. Manual
capture on the product page remains for any other channel.

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
tolerance. **50 mm is the narrowest common roll that prints EAN-13 in spec at
203 dpi.** Only the *width* decides this, so the 50 × 30 mm roll the warehouse
runs on gets the same 3-dot module as 50 × 25 mm — the extra 5 mm of height goes
to taller bars.

**Code 128** is variable width — 11 modules per character, plus 35 fixed and 10
quiet modules either side, so `11n + 55`. A 10-character FNSKU is 165 modules.
Crucially its minimum X-dimension is **0.250 mm**, not 0.264 mm, so a 2-dot module
is exactly in spec:

| Module | X-dimension | 165 modules | Code 128 min 0.250 mm |
| --- | --- | --- | --- |
| 2 dots | 0.250 mm | 41.3 mm | ✓ (at the minimum) |
| 3 dots | 0.375 mm | 61.9 mm | ✓ |

So Amazon labels are *easier* on this printer than Takealot's, despite the longer
symbol. On the 50 mm roll a 10-character FNSKU gets a 2-dot module — in spec, but
exactly at the floor, which puts a **hard ceiling of 12 characters** on an FBA
code before the symbol drops to a 1-dot module and stops scanning:

| Code length | modules | at 2 dots | |
| --- | --- | --- | --- |
| 10 chars (a standard FNSKU) | 165 | 41.3 mm | fits |
| 12 chars | 187 | 46.8 mm | fits, at the limit |
| 13 chars | 198 | 49.5 mm | falls to a 1-dot module, out of spec |

Because Code 128 grows with the code, the print page checks **every** row and
warns on the tightest one — a long code in the batch is what decides whether the
run is in tolerance, not the first one.

**The flow never asks which stock is loaded** — it reads it straight off the
channel's label spec. The roll is a property of how a channel is set up, not a
per-run decision, and asking every time invited a mis-click that would waste a
run on the wrong geometry. Change it under *Products → Barcode labels → Label
specs* when the warehouse changes stock; the print page shows which roll the run
assumed. `computeLayout` derives every coordinate from the stock, symbology and
code, so adding a roll size is one entry in `LABEL_STOCKS` plus one enum value.

## Text size, and how the height is shared

Every element takes the height its text needs; **the barcode gets what is
left**. On the 50 × 30 mm roll (400 × 240 dots at 203 dpi) that works out at:

| | Takealot | Amazon FBA |
| --- | --- | --- |
| Elements | Title (2 lines) → Barcode | Barcode → Title (2 lines) → Text |
| Title / text font | 20 / 18 dots | 20 / 18 dots |
| Characters per title line | 38 | 38 |
| Bar height | 17.5 mm | 15.0 mm |

The fonts are **20 and 18 dots** — 2.5 mm and 2.2 mm of cap height, about 7 pt
and 6.5 pt — derived as a fraction of the label height so a different roll
scales with it. That is smaller than the label carried before elements existed:
a 26-dot title fitted 29 characters a line on this roll and a 20-dot one fits
38, which is what pays for a second title line once the barcode, the name and a
condition all share the height. The Amazon label went from one 29-character line
to two 38-character ones at no cost to the bars.

When a spec is crowded enough that the bars would fall under **6.35 mm** (0.25",
Amazon's floor for a unit label), both fonts **shrink a dot at a time** until
they clear it, stopping at 14 / 12 dots — below that the warehouse cannot read
the label and a shorter barcode is the better trade. If even the floor does not
fit, the print page says so in a banner, the same way it warns on a too-narrow
module. Both searches exist for the same reason: ZPL only takes whole dots, so
the answer has to be found rather than calculated.

A **barcode's interpretation line** is reserved as part of the barcode's own
block — the font height plus 6 dots. The gap is larger than the 2 dots between
ordinary lines on purpose: the firmware adds a little space of its own, which
the bottom margin used to absorb, and with a product name now sitting directly
under an FNSKU there is nothing left to absorb it.

## The title block

Up to `maxLines` per the Title element — two on both shapes today; one buys the
bars about 2.7 mm, and three is the cap whatever the row says. **Long product
names are truncated in software**, with a trailing `...`, before the ZPL is
built.

That is not belt-and-braces. `^FB`'s max-lines parameter is documented as
truncating, but the ZD220 prints the overflow **on top of the last line** — a
76-character name came out as two lines of text superimposed and unreadable. So
the wrap is done in `fitTitle`, and `^FB` only ever receives text that already
fits; its own limit stays in as a backstop.

Font 0 is proportional, so there is no exact character width. The budget uses
0.5 × the font height per character, measured off printed labels (30 characters
span ~349 dots at a 26-dot font, ≈0.45) and rounded **up** so it errs toward
truncating early — overshooting is unreadable, undershooting merely shortens the
name. A single word too long for a line is hard-broken rather than dropped, so a
long unspaced part number still prints in full.

Labels print in **product-name order**, and the counts grid, the print page's
table and the printed stack all use that same order so the operator can check one
against the other. On the multi-select path the picked rows are re-sorted by name,
since a table selection comes back in whatever order it was ticked.

The barcode, not the title, is what identifies the unit — the name is a human
hint, so shortening it is the right trade against a smaller font or a shorter
symbol.

## Margins

The **top margin is 3 mm; the sides and bottom are 1 mm.** That asymmetry is
deliberate and was learned from a real print: at 1 mm the title's glyph tops were
sliced flat by the leading edge, because a direct-thermal printer cannot reliably
place ink immediately after the label gap and die-cut stock has its corner radius
in exactly that spot. The sides stay tight because on EAN-13 the *width* is the
scarce dimension — widening them by 8 dots would cost a whole module and drop the
symbol out of tolerance on 50 mm stock.

Takealot's own PDF uses a 0.330 mm X-dimension — GS1 nominal, and unreachable in
whole dots at 203 dpi (2.68 dots) — which is why our label is not a pixel-exact
copy of theirs.

## Quantities

Counts start at **1**, with each product's units **on hand** shown beside them for
reference. Defaulting to stock on hand was rejected deliberately: you label the
units going into the FC, which is normally a subset of what's on hand, and one
stray click on a 340-unit product would burn a roll of labels.

The exception is the shipment path, where the consignment already states how
many units of each product are going in — so counts are seeded from that rather
than from 1. They stay editable either way.

Counts of **0** are allowed and simply skipped, which is what makes a re-run
cheap (below).

**The whole run is a single print job.** Each product contributes one `^XA…^XZ`
format using ZPL's `^PQ` copy count — so 200 labels is one small format, not 200
copies of it — and the formats are concatenated into one job.

That is a deliberate reversal of the original one-job-per-product design.
Copies *inside* a job stream back-to-back, but every job boundary costs a CUPS
spool cycle plus the printer's own feed-to-tear-bar and backfeed — measured at
about **six seconds per product** on the ZD220. A 25-label run across 10 products
spent roughly a minute standing still. One job removes all but one of those
boundaries.

### Re-running after a jam

The trade for a single job is that you can no longer reprint one product's job in
isolation, so the print page has an **Adjust counts and print again** action
instead. It returns to the counts grid with what you last entered: set the
products that came out fine to 0, leave the one that jammed, and print again.
Each pass is a fresh pair of page keys (`quantities-N` / `print-N`), capped at 20
passes, since step and page keys have to be unique within a run.

The flow closes itself when you press **Done** — there is no summary screen; the
print page already lists exactly what was sent.

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
| `schemas/labels.keel` | `ChannelLabelSpec`, `ChannelLabelElement`, `ProductChannelCode`, the symbology / stock / element-kind enums, and the print and sync flows. |
| `lib/barcodeLabelHelpers.ts` | Code validation, label geometry, ZPL generation, row building. Pure apart from the generated enums — no DB, no printer. |
| `lib/barcodeLabelSelection.ts` | The DB queries (printable channels, candidates, a shipment's lines, stock on hand). |
| `flows/printChannelBarcodes.ts` | UI orchestration only: channel → products (or a shipment) → counts → print. |
| `lib/channelCodeSync.ts` | The plan/apply pair both channel syncs run on. |
| `lib/takealotOfferHelpers.ts`, `flows/syncTakealotBarcodes.ts` | Takealot codes from the Marketplace API ([takealot-barcodes.md](takealot-barcodes.md)). |
| `lib/amazonFnskuHelpers.ts`, `flows/syncAmazonFnskus.ts` | Amazon FNSKUs from the Selling Partner API ([amazon-fnskus.md](amazon-fnskus.md)). |

## Setting up a new channel

1. Create the `Channel` if it does not exist.
2. **Products → Barcode labels → Label specs → Add a label spec**: pick the
   channel, its symbology and the label stock.
3. Open the spec and **add its elements** — the barcode, the product name, and
   any fixed text, in the order they should print. Until you do, the channel
   prints the product name over the barcode and the print page says so.
4. Add a **channel code** per product you intend to label — synced for
   Takealot and Amazon, or per product on its page → Add channel code for any
   other channel.

The two shapes in use, as rows:

| Channel | Position | Kind | Text | Max lines |
| --- | --- | --- | --- | --- |
| Takealot | 1 | Title | | 2 |
| | 2 | Barcode | | |
| | 3 | Stacked text | `MP` | |
| Amazon | 1 | Barcode | | |
| | 2 | Title | | 2 |
| | 3 | Text | `New` | |

## Known gaps

- **Amazon codes are only synced on demand.** Takealot codes are also picked
  up per product on create / SKU change; Amazon's deliberately are not, since
  the FNSKU only exists once the listing is created on Amazon, normally after
  the product exists here ([amazon-fnskus.md](amazon-fnskus.md)). Run the sync
  after listing new products, or add a nightly scheduled sync if that becomes a
  chore. Any further channel's codes are still entered one product-channel pair
  at a time; a bulk path for it is a fetcher feeding the shared
  `channelCodeSync` core, as both syncs do.
- **Element order is a number you type.** Re-ordering a label means editing
  `position` on two rows; there is no drag handle, because the Console's list
  tools do not offer one. With three or four rows per channel that is a
  30-second job, but it would not scale to a label with a dozen lines.
- **No print preview in the Console.** The label is generated as native ZPL and
  rendered by the printer, so there is no on-screen proof before it prints. A
  preview would mean rasterising server-side (the approach klira takes for its
  dispensing labels), costing a `sharp` dependency and a bitmap-quality barcode.
- **Amazon's stated 300 dpi guidance.** Amazon's docs ask for a 300 dpi printer.
  203 dpi is widely used for FNSKU labels in practice — Amazon's own FCs run
  203 dpi Zebras — and the Code 128 maths above lands in spec, but it is worth
  knowing the guidance exists if a shipment is ever queried.
