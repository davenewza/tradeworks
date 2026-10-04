# Supplier bills and product cost

Every product's **cost of goods** and **freight-in** come from what our
suppliers bill us. Those two figures feed everything that knows what a product
costs:

- `ProductPrice.unitCost` / `unitFreightIn` / `landedUnitCost`, and so total
  costs, gross profit and margin on every price list
- the **stock value** measure on the Stock cover dashboard
- **purchase planning**, whose goods value falls back to the most recent bill's
  unit cost when a product has no supplier price

## Where the bills come from

**SyncSupplierBills** (Inventory → Suppliers → *Sync supplier bills from Zoho*)
and its nightly twin **ScheduledSyncSupplierBills** (4am) mirror every bill of
every supplier linked to a Zoho vendor from Zoho Inventory, into
`SupplierBill` and `SupplierBillLine` (`backend/schemas/costs.keel`,
`backend/lib/zohoBillHelpers.ts`).

- Bills are listed **per supplier** by Zoho vendor id. Expense bills from
  everyone else (shops, utilities, the courier) are never read.
- **Every line** is kept: stock items, landed-cost charges (freight, customs),
  prepayments (the `ADVANCE…` bills booked to *Advance to Suppliers*),
  packaging. Only stock lines are matched to a product, **by SKU**.
- A bill is read in full (one call, plus one per landed cost on it) when it's
  new, or when Zoho's `last_modified_time` for it has moved. Otherwise the run
  skips it, so after the first import a run costs about one call per supplier
  against the Zoho quota shared with the Takealot integration. Allocating a
  landed cost to a bill moves that bill's `last_modified_time`.
- A bill deleted or voided in Zoho is removed here, along with its lines.
- A stock line whose SKU matches no product yet is stored unlinked. Each run
  links such lines once *Sync Products* brings the product in, and lists the
  SKUs still unmatched.
- Suppliers with no Zoho vendor (made before suppliers came from Zoho) are
  skipped and named in the run summary. Deleting a supplier here keeps its
  bills, so its products keep their cost history.

## How a line is costed

All amounts are **excl VAT and in rand**.

| Field | From Zoho |
| --- | --- |
| `unitCost` | `item_total` × the bill's `exchange_rate` ÷ `quantity`. `item_total` is after any line discount and excl VAT. `rate` would include VAT on a tax-inclusive bill. |
| `freightIn` | The sum of the landed-cost allocations Zoho made to the line (`cost_allocations[].allocated_amount`, keyed by the line's id). This is a total, not per unit. |
| `freightAllocated` | Whether the bill has any landed costs allocated to it yet. |

## How a product is costed

```
weightedUnitCost  = Σ(unitCost × quantity) ÷ Σ quantity          over all its lines
weightedFreightIn = Σ freightIn ÷ Σ quantity                     over lines on bills with freight allocated
weightedLandedCost = weightedUnitCost + weightedFreightIn
```

The freight average skips bills awaiting their landed costs on purpose. An
import is billed before the forwarder's and customs bills arrive, often weeks
before, and counting its units as freight-free meanwhile would pull the
product's landed cost down. Its goods cost counts straight away. A product
that never has freight allocated (a local supplier) gets a freight-in of 0.

## First import

Bills are a copy of Zoho with no local edits, so the tables can be emptied
and re-imported at any time. The first sync reads every bill, which costs
one call per bill plus one per landed cost (several hundred to a couple of
thousand calls). It runs in steps of 100 bills, and a run stopped partway
picks up from where it got to.
