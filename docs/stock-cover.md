# Stock availability & cover

Tracks, per product, how much stock is on hand and how many months of **cover**
that represents at the current sales rate — so the team can see at a glance what
needs reordering. It reproduces the old Zoho Analytics "Stock Availability and
Cover" report inside the Console. Each product also carries a revenue-based
**ABC class** (see below), so the reorder view shows how much each product
matters, not just how close it is to running out.

## Where to find it

- **Inventory → View stock and cover** — the reorder view: every enabled
  product's figures in one grid. Filter by brand, supplier, SKU, name, ABC
  class, status, and current or total cover (any comparison — less than, at
  least, between); click any column heading to sort by it. Brand and supplier
  are the columns that can't be sorted, because they are relations.
- **Stock cover dashboard** — charts of cover by ABC class; see
  [the dashboard](#stock-cover-dashboard). Its four headline figures are also
  pinned to the top of the Inventory space.
- **Per brand or supplier** — open a brand or a supplier and click **View stock
  & cover** to open that same grid filtered to it.
- **Per product** — the **Stock & cover** section on any product page.

## The figures

| Column | What it is |
| --- | --- |
| **ABC class** | Revenue-importance grade from the trailing revenue run-rate — see [ABC class](#abc-class). |
| **Total sales** | Lifetime units sold, from synced invoices. |
| **Stock available** | On-hand units — Zoho's `stock_on_hand`, refreshed daily. Can be negative when sales are billed ahead of stock. |
| **Stock on way** | Units on future-dated supplier bills. _Phase 2 — currently always 0, so Total cover equals Current cover._ |
| **Est. monthly sales** | Units sold in the last 12 months ÷ the number of months the product has been selling (capped at 12), rounded to a whole number. |
| **Current cover** | Stock available ÷ est. monthly sales, in months (1 dp). Blank when there is no sales estimate. |
| **Total cover** | (Stock available + stock on way) ÷ est. monthly sales. |

## Status

Each product is graded by comparing its **current cover** to its supplier's
**lead time** — how long new stock takes to arrive from them. With
`L = leadTimeInDays ÷ 30` (lead time in months):

| Status | Colour | Cover | Meaning |
| --- | --- | --- | --- |
| **Shortfall** | 🔴 red | `< L` | You'll run out before a reorder can arrive. |
| **Low** | 🟡 yellow | `L` to `1.5 × L` | At the reorder point — order soon. |
| **Good** | 🟢 green | `1.5 × L` to `2.5 × L` | Comfortable. |
| **Oversupply** | 🟣 purple | `≥ 2.5 × L` | More stock than needed. |

The status is **blank** when cover is unknown (no sales estimate) or the
product has no supplier (so no lead time). It is a computed field, so it
re-grades automatically the moment the cover, the product's supplier or that
supplier's lead time changes.

## ABC class

A Pareto cut over the **whole catalogue's monthly revenue run-rate**:
trailing-12-month realized revenue (net of discount, excl VAT — the same
`netAmount` basis as the sales figures) **÷ months active** — the same
launch-aware divisor the monthly sales estimate uses. Products are ranked by
run-rate and graded by cumulative share:

| Class | Colour | Meaning |
| --- | --- | --- |
| **A** | 🟢 green | The products making up the top **80%** of the revenue run-rate — protect these from stockouts first. |
| **B** | 🔵 blue | The next **15%**. |
| **C** | ⚪ grey | The tail **5%**. |

These are the same 80/15/5 defaults Zoho's ABC Classification report uses —
but computed here from local `Sale` rows, with **zero Zoho API calls**. Zoho
Books/Inventory never stores a class we could pull, so this is our own.

Details worth knowing:

- The grading is **launch-aware**: revenue is divided by months since the
  product's earliest sale (floored at 1, capped at 12), so a product launched
  3 months ago is graded on its run-rate, not penalised for missing most of
  the window.
- The classification is **catalogue-wide, not per brand** — an "A" means top
  revenue for the business, so small brands can legitimately have no A products.
- The class is **blank** when the product sold nothing in the last 12 months
  (mirroring blank cover for dormant products).
- A product that alone crosses a boundary keeps the higher class — one product
  carrying 85% of all revenue is still an A.
- Recomputed by the nightly `ScheduledSyncStock` run alongside the cover
  figures; the stock grid can be sorted and filtered by class.

## Stock cover dashboard

The **Stock cover** dashboard shows the catalogue's cover split by ABC class, so
you can check that the A products — the ones carrying 80% of revenue — are the
best stocked. Filter it by **Brand**, **ABC class** or **Status**. Every chart
counts enabled products only.

| Chart | What it shows |
| --- | --- |
| **Products in shortfall** / **Products running low** | How many products are in each at-risk status. |
| **Months of stock cover** | Overall cover: all stock ÷ all monthly sales. |
| **Stock value on hand** | Stock on hand × weighted landed cost. |
| **Products by cover status and class** | Product counts per class, split by status. |
| **Months of cover by class** | Overall cover for each class. |
| **Stock value by class and status** | Where the money in stock sits. Oversupplied B and C stock is money you could free up. |
| **Months of cover by brand and class** | A brand × class grid of overall cover. |
| **Products to reorder** | Every Shortfall and Low product, A class first, lowest cover first. |
| **Oversupplied stock** | Every Oversupply product, highest stock value first. |

How the group figures are worked out:

- **Cover for a group** (a class, a brand, the whole catalogue) is the group's
  total stock ÷ its total monthly sales. It is **not** the average of each
  product's cover, because one slow seller with years of stock would drag an
  average up. Negative stock reduces the group's cover.
- **Stock value** uses each product's weighted landed cost (cost of goods plus
  freight-in, averaged over its supplier bills). Negative stock is left out,
  and a product with no supplier bills counts as 0.
- Both are declared as `measures` on `Product`. The `stockCoverByClass`
  aggregate action returns the same figures through the API.

## Lead time

Each **supplier** carries a **lead time** (`leadTimeInDays`, default **60**).
Set it from the supplier page via **Edit supplier**; it drives the status bands
for every product bought from that supplier, and is the default lead time when
[planning a purchase](purchase-planning.md). (Brands used to carry the lead
time; `Brand.leadTimeInDays` is kept only for **Create suppliers from brands**
to copy across, and is no longer read anywhere else.)

## Reordering

Cover tells you *when* to reorder; **Plan a purchase** (on the supplier page,
or under Inventory) works out *how many* of each product to order so the whole
order lands with the same months of cover. See
[purchase-planning.md](purchase-planning.md).

## Refresh

The `ScheduledSyncStock` flow runs **daily at ~02:00**: it pulls `stock_on_hand`
from Zoho and recomputes the monthly estimate, cover, and ABC class. Stored
values only change when it runs, so after a deploy — or any time you want
figures to reflect a change immediately — trigger `ScheduledSyncStock` once from
the Console.

## Where it lives in the code

| Concern | Files |
| --- | --- |
| Schema | `backend/schemas/products.keel` — `Product` stock/cover fields, `stockCoverStatus`, `abcClass`, the `listStockAndCover` action; `backend/schemas/suppliers.keel` — `Supplier.leadTimeInDays` |
| Daily sync | `backend/flows/scheduledSyncStock.ts`, `backend/lib/stockCoverHelpers.ts`, `backend/lib/zohoStockHelpers.ts` |
| Console | `backend/tools/list-stock-and-cover.json` (the Inventory space's grid, in `_spaces.json`), `get-brand.json`, `get-supplier.json`, `get-product.json`, `_fields.json` |
| Dashboard | `backend/tools/_dashboards.json` ("Stock cover") and `_charts.json`, over the `stockCover` / `stockValue` measures in `products.keel` |

> **Roadmap — Stock on way (Phase 2):** populate `stockOnWay` from future-dated
> supplier bills (those dated after today), so Total cover reflects incoming
> stock. See `scheduledSyncStock.ts` for where this slots in.
