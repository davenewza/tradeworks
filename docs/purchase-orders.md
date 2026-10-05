# Purchase orders and stock on the way

Every product's **stock on the way** comes from the purchase orders we raise
in Zoho. It's the units ordered from a supplier that haven't been received into
stock yet. It feeds:

- **Stock on way** and **Total cover** on the stock grid and the product page
  (see [stock-cover.md](stock-cover.md))
- the **stock position** in [purchase planning](purchase-planning.md), so a
  plan doesn't reorder what's already coming

## Where to find it

- **Inventory → Stock on the way**: every order line with units still to come,
  oldest order first. Filter by product, SKU or supplier.
- **Inventory → Suppliers → Purchase orders**: every order, with its status
  and the units still on the way.
- **On a product**: the **Purchase orders** table, which lists every order
  line for that product.
- **On a supplier**: their **Purchase orders**.

## What counts as on the way

A line's units are on the way from the day its order is **placed** until they
are **received** in Zoho:

```
on the way = ordered − received − cancelled        (never below 0)
```

- **Billing doesn't change it.** Imports are billed when the supplier
  invoices, often weeks before they land. A billed order that hasn't been
  received is still on the way.
- **Received** means a purchase receive saved as *Received*. A receive saved as
  *In transit* hasn't reached the shelf, so its units stay on the way.
- **Not placed**: drafts, orders awaiting approval (or approved but not
  issued), rejected and cancelled orders, and drop shipments straight to a
  customer. Their lines are kept but count for nothing.
- An order Zoho has as **received** in full, or marked as received, has
  nothing left on the way.
- Lines that aren't stock (a freight or service line) count for nothing.

## Why stock available is Zoho's physical stock

Zoho keeps two stock figures per item. `stock_on_hand` (accounting stock) goes
up when an order is **billed**. `actual_available_stock` (physical stock) goes
up when it is **received**. Before purchase orders the two were the same,
because every bill was booked directly. With an order billed ahead of its
delivery, `stock_on_hand` counts those units as on the shelf while they're
still at sea. Adding them as stock on the way as well would count them twice.

So **Stock available** is the physical figure. When the first purchase order
went in (2026-10-05), the two figures agreed on 423 of the 424 active items.
The odd one out was the item on that order (MEFV22G: 200 accounting, 100
physical, with 100 billed but not received).

The daily sync reads the orders just before it reads stock. That way a receive
can't land between the two reads and count a unit both as on hand and as on
the way.

## How the sync works

`ScheduledSyncStock` (daily at 2am, or **Inventory → Refresh stock & purchase
orders** to run it now) mirrors the orders into `PurchaseOrder` and
`PurchaseOrderLine` (`backend/schemas/purchaseOrders.keel`,
`backend/lib/zohoPurchaseOrderHelpers.ts`). Then it reads physical stock and
recomputes cover.

- All orders are listed in one go, whatever their status: a call per 200
  orders against the Zoho quota shared with the Takealot integration.
- An order is read in full (one call) when it's new, or when Zoho's
  `last_modified_time` or `quantity_yet_to_receive` for it has moved.
  Otherwise the run skips it. The second check catches a receive even if it
  didn't touch the order's modified time.
- A changed order's lines are replaced outright. An order deleted in Zoho is
  removed here.
- Lines are matched to products by **SKU**, and orders to suppliers by the
  Zoho vendor. Each run links lines and orders whose product or supplier has
  arrived since, and the run summary lists SKUs with units on the way that
  match no product.
- `Product.stockOnWay` is a computed sum of its lines' `quantityOnWay`, so it
  changes as soon as the orders do.
- If Zoho's daily API limit is hit, the run keeps the orders it had and skips
  the stock read. Estimates and cover still refresh from local sales, and
  everything catches up next run.

Orders are a copy of Zoho with no local edits, so the tables can be emptied
and re-imported at any time.

## Not yet used

- **Expected delivery date** is stored and shown, but nothing plans by it yet:
  the purchase planner counts stock on the way as if it were already here.
  The first order had no date set.
