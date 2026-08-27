# Stock availability & cover

Tracks, per product, how much stock is on hand and how many months of **cover**
that represents at the current sales rate — so the team can see at a glance what
needs reordering. It reproduces the old Zoho Analytics "Stock Availability and
Cover" report inside the Console. Each product also carries a revenue-based
**ABC class** (see below), so the reorder view shows how much each product
matters, not just how close it is to running out.

## Where to find it

- **Per brand** — open a brand and click **View stock & cover** for a read-only
  grid of that brand's products (the primary reorder view).
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

Each product is graded by comparing its **current cover** to the brand's **lead
time** — how long new stock takes to arrive from the supplier. With
`L = leadTimeInDays ÷ 30` (lead time in months):

| Status | Colour | Cover | Meaning |
| --- | --- | --- | --- |
| **Shortfall** | 🔴 red | `< L` | You'll run out before a reorder can arrive. |
| **Low** | 🟡 yellow | `L` to `1.5 × L` | At the reorder point — order soon. |
| **Good** | 🟢 green | `1.5 × L` to `2.5 × L` | Comfortable. |
| **Oversupply** | 🟣 purple | `≥ 2.5 × L` | More stock than needed. |

The status is **blank** when cover is unknown (no sales estimate). It is a
computed field, so it re-grades automatically the moment either the cover or the
brand's lead time changes.

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

## Lead time

Each **brand** carries a **lead time** (`leadTimeInDays`, default **60**). Set it
from the brand page via **Edit lead time**; it drives the status bands for all of
that brand's products.

## Refresh

The `ScheduledSyncStock` flow runs **daily at ~02:00**: it pulls `stock_on_hand`
from Zoho and recomputes the monthly estimate, cover, and ABC class. Stored
values only change when it runs, so after a deploy — or any time you want
figures to reflect a change immediately — trigger `ScheduledSyncStock` once from
the Console.

## Where it lives in the code

| Concern | Files |
| --- | --- |
| Schema | `backend/schemas/products.keel` — `Product` stock/cover fields, `stockCoverStatus`, `abcClass`, `Brand.leadTimeInDays` |
| Daily sync | `backend/flows/scheduledSyncStock.ts`, `backend/lib/stockCoverHelpers.ts`, `backend/lib/zohoStockHelpers.ts` |
| Console | `backend/tools/list-product-stock.json`, `get-brand.json`, `get-product.json`, `_fields.json` |

> **Roadmap — Stock on way (Phase 2):** populate `stockOnWay` from future-dated
> supplier bills (those dated after today), so Total cover reflects incoming
> stock. See `scheduledSyncStock.ts` for where this slots in.
