# Purchase planning

Suggests a purchase order for one **supplier** — which products to reorder and
how many units — so that every product lands with the **same months of cover**.
The whole order then runs down together, and the next order can wait for all of
it, instead of a top-up order for the one product that ran out early.

It builds on [stock & cover](stock-cover.md): the same stock levels, the same
sales run-rate, the same lead time and status bands. It reads nothing from Zoho
directly, so a plan costs no API calls and can be re-run freely.

## Where to find it

- **Inventory → Plan a purchase** — pick the supplier first.
- **A supplier's page → Plan a purchase** — the supplier is preset.

Plans are per **supplier**, not per brand: an order goes to whoever invoices
us, which may carry several brands, and the lead time is the supplier's. A
supplier's products are the active products on its
[price lists](supplier-price-lists.md), so a product takes part once a list it
is on is linked to a supplier — see [Suppliers](#suppliers).

## The flow

1. **Supplier** (skipped when launched from a supplier). Only suppliers with
   active products on their price lists are offered.
2. **Order details**
   - **Purchase date** — when the order goes to the supplier. Defaults to today.
   - **Lead time (days)** — purchase to on-the-shelf. Defaults to the supplier's
     `leadTimeInDays`; a change here applies to this plan only.
   - **Cover on arrival (months)** — how many months of sales every product
     should have in stock the day the order lands. Defaults to **2 × the lead
     time** (in months), the middle of the *Good* status band.
3. **Review** — an editable grid of every active product from the supplier with its
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
| **Stock position** | `on hand + on the way` — on the way is the units on placed purchase orders not yet received ([purchase-orders.md](purchase-orders.md)), counted as if already here |
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
- **Goods value** is the order quantity × the product's price on **this
  supplier's** price list (excl freight), in that list's currency (see
  [supplier-price-lists.md](supplier-price-lists.md)). Another supplier's price
  for the same product is never used. A supplier with several lists (one per
  currency, say) prices from a list in its own currency first, then from the
  list Zoho changed most recently. Inactive lists, and lists in a currency the
  plan can't show, are passed over. A product its lists give no rate for falls
  back to the unit cost on its most recent supplier bill, in rand, marked
  *(last bill)*. There is no
  currency conversion: a plan with prices in more than one currency shows one
  total per currency (`£800.00 + R 1,200.00`). Lines with no cost at all are
  counted separately.

### Worked example

Lead time 60 days, cover on arrival 4 months, ordered today. A product selling
30 a month with 100 on hand:

- Demand to arrival: `30 ÷ 30.4375 × 60 ≈ 59` units → about 41 left when the
  order lands.
- Target: `30 × 4 = 120` units.
- Suggested: `⌈120 − 41⌉ = 80` units → lands with `(41 + 80) ÷ 30 ≈ 4.0` months
  of cover (**Good**), in stock until about 4 months after arrival.

A product from the same supplier selling 2.5 a month with 8 on hand needs 7. Both
run out on the same date.

## Why 2 × lead time

The status bands grade cover against the lead time `L` (in months): *Shortfall*
`< L`, *Low* `L–1.5L`, *Good* `1.5L–2.5L`, *Oversupply* `≥ 2.5L`. Landing at
`2L` puts every product in the middle of *Good* on arrival; stock then decays
through *Good* into *Low* — the reorder point — before the next order is due.
Raise the target to order less often; lower it to tie up less cash.

## Suppliers

A **supplier** is who invoices us for stock; a **brand** is what's on the box.
They are often the same company, but not always, so they are separate records.
Every supplier is a **vendor in Zoho Books**, linked by the vendor's Zoho
`contact_id` (`Supplier.zohoVendorId`).

- **Inventory → Import suppliers from Zoho** lists the active Zoho vendors that
  aren't suppliers yet; tick the ones you buy stock from. Each becomes a
  supplier with the vendor's name and currency (rand when Zoho's is one we
  don't support) and a 60-day lead time — set the real one on the supplier. It
  is one paged read of the vendor list, so a call or two against the shared
  Zoho quota. Suppliers can't be created by hand.
- A supplier made before suppliers came from Zoho has no vendor link. Importing
  the vendor of the **same name** links it (shown as **Link**), keeping its
  price lists, lead time and currency.
- **Inventory → Suppliers** lists them. On a supplier, **Edit supplier** sets
  the lead time, currency and notes; the name and Zoho link come from Zoho.
- A product's suppliers come from its price lists: link each price list to
  its supplier with **Link to supplier** (Inventory → Suppliers → Supplier
  price lists). The products on it become that supplier's. There is nothing to
  set on the product itself (see
  [supplier-price-lists.md](supplier-price-lists.md)).
- **Inventory → Products without a supplier** lists the active products on no
  linked price list. They go ungraded in stock cover and are left out of
  plans.

## Where it lives in the code

| Concern | Files |
| --- | --- |
| Schema | `backend/schemas/products.keel` — `flow PlanPurchase`; `backend/schemas/suppliers.keel` — `Supplier`, `Currency`, `flow ImportSuppliers`; `backend/schemas/supplierPriceLists.keel` — each supplier's price lists: which products its plans cover, and what they cost |
| Arithmetic & loading | `backend/lib/purchasePlanHelpers.ts` (+ `.test.ts`) |
| Grid rows, wording | `backend/lib/purchasePlanFormat.ts` |
| Flow | `backend/flows/planPurchase.ts`, wiring test in `backend/tests/planPurchase.test.ts` |
| Suppliers | `backend/lib/zohoVendorHelpers.ts` (+ `.test.ts`), `backend/flows/importSuppliers.ts`, `backend/tests/supplierActions.test.ts` |
| Console | `backend/tools/_spaces.json` (Inventory space, Suppliers group), `get-supplier.json` (entry action), `list-suppliers.json`, `list-products-without-supplier.json` |
