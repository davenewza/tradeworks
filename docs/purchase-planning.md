# Purchase planning

Suggests a purchase order for one **brand** — which products to reorder and
how many units — so that every product lands with the **same months of cover**.
The whole order then runs down together, and the next order can wait for all of
it, instead of a top-up order for the one product that ran out early.

It builds on [stock & cover](stock-cover.md): the same stock levels, the same
sales run-rate, the same lead time and status bands. It reads nothing from Zoho
directly, so a plan costs no API calls and can be re-run freely.

## Where to find it

- **Products → Purchasing → Plan a purchase** — pick the brand first.
- **A brand's page → Plan a purchase** — the brand is preset.

## The flow

1. **Brand** (skipped when launched from a brand). Only brands with enabled
   products are offered.
2. **Order details**
   - **Purchase date** — when the order goes to the supplier. Defaults to today.
   - **Lead time (days)** — purchase to on-the-shelf. Defaults to the brand's
     `leadTimeInDays`; a change here applies to this plan only.
   - **Cover on arrival (months)** — how many months of sales every product
     should have in stock the day the order lands. Defaults to **2 × the lead
     time** (in months), the middle of the *Good* status band.
3. **Review** — an editable grid of every enabled product in the brand with its
   suggested quantity, sorted so the products in trouble come first. Change any
   **Order** quantity and press **Recalculate cover** to see what it does to that
   product's cover on arrival; **Finish** produces the plan.
4. **The plan** — the run's completion page: the parameters, totals, one table
   of what to order (with cost, value, cover and status on arrival) and one of
   what is not being ordered and why.

Nothing is written to the database. The plan lives in the flow run.

## The arithmetic

For each product, with `m` = monthly run-rate (units), `d = m ÷ 30.4375`
(daily), and the order landing `A = purchase date + lead time`:

| Figure | Formula |
| --- | --- |
| **Stock position** | `on hand + on the way` (on the way is 0 until the Phase 2 sync lands) |
| **Demand to arrival** | `d × days from today to A` |
| **Projected at arrival** | `position − demand to arrival` |
| **Backorders** | `max(0, −position)` — negative on-hand is sales already billed |
| **Target units** | `m × cover on arrival` |
| **Suggested quantity** | `⌈ target − max(0, projected) + backorders ⌉`, floored at 0 |
| **Cover on arrival** | `(max(0, projected) + order − backorders) ÷ m`, in months |
| **In stock until** | `A + cover on arrival` |
| **Status on arrival** | The cover, graded against the lead time exactly as `stockCoverStatus` is |

Points worth knowing:

- **The run-rate is unrounded.** The product page shows *Est. monthly sales* as
  a whole number; the planner uses the underlying figure (trailing-365-day units
  ÷ months active). A product selling 5 a year shows as 0 a month on the grid
  but still gets the 2–3 units a six-month horizon needs.
- **Sells out before arrival.** If the current stock runs dry before the order
  lands, the product is ordered to the **full target** — nothing will be left
  to count — and flagged. The sales in the gap are lost, not deferred, so the
  plan does not buy stock for them. Only a faster shipment closes that gap.
- **Already covered.** A product whose stock lasts past the horizon gets 0. It
  still appears in the grid so nothing is missed, and shows when it runs out.
- **No sales forecast.** Nothing sold in the last 12 months → no rate to
  project. Listed at 0; type a quantity to include it.
- **No stock reading.** A product the stock sync has never seen is planned as
  if the shelf were empty and flagged; run the sync and plan again.
- **Trimming a suggestion** is fine, but if the product then runs out before
  the common horizon the plan says so — that product would need exactly the
  top-up order the plan exists to avoid.
- **Goods value** is the order quantity × the unit cost on the product's most
  recent supplier bill (excl VAT, excl freight) — the best guess at what the
  supplier will charge. Lines with no bill on record are counted separately.

### Worked example

Lead time 60 days, cover on arrival 4 months, ordered today. A product selling
30 a month with 100 on hand:

- Demand to arrival: `30 ÷ 30.4375 × 60 ≈ 59` units → about 41 left when the
  order lands.
- Target: `30 × 4 = 120` units.
- Suggested: `⌈120 − 41⌉ = 80` units → lands with `(41 + 80) ÷ 30 ≈ 4.0` months
  of cover (**Good**), in stock until about 4 months after arrival.

A product in the same brand selling 2.5 a month with 8 on hand needs 7. Both
run out on the same date.

## Why 2 × lead time

The status bands grade cover against the lead time `L` (in months): *Shortfall*
`< L`, *Low* `L–1.5L`, *Good* `1.5L–2.5L`, *Oversupply* `≥ 2.5L`. Landing at
`2L` puts every product in the middle of *Good* on arrival; stock then decays
through *Good* into *Low* — the reorder point — before the next order is due.
Raise the target to order less often; lower it to tie up less cash.

## Where it lives in the code

| Concern | Files |
| --- | --- |
| Schema | `backend/schemas/products.keel` — `flow PlanPurchase` |
| Arithmetic & loading | `backend/lib/purchasePlanHelpers.ts` (+ `.test.ts`) |
| Grid rows, wording | `backend/lib/purchasePlanFormat.ts` |
| Flow | `backend/flows/planPurchase.ts`, wiring test in `backend/tests/planPurchase.test.ts` |
| Console | `backend/tools/_spaces.json` (Purchasing group), `get-brand.json` (entry action) |
