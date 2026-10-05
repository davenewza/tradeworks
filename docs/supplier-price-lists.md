# Supplier price lists

What our stock costs to buy comes from the **purchase price lists** in Zoho
(Zoho's API calls them price books). They're mirrored here as
`SupplierPriceList` and `SupplierPriceListItem`
(`backend/schemas/supplierPriceLists.keel`).

These aren't the same as **price lists** (`PriceList`), which are what we
*sell* at, per channel. Zoho's sales price lists aren't synced.

## Where to find them

- **On a product:** the **Supplier prices** table shows the product's price on
  every purchase price list it's on. Lists aren't tied to a supplier in Zoho
  or here, so a product can appear on several.
- **Inventory → Suppliers → Supplier price lists:** every list, and the price of
  every item on it.
- **Purchase planning** prices from them. See
  [purchase-planning.md](purchase-planning.md) for which list wins when a
  product is on several.

They are read-only here. Nothing in the app can create, change or delete a
list or a price. Change it in Zoho, then sync.

Margins on our selling price lists don't come from these. They use the actual
landed cost from supplier bills (see [supplier-bills.md](supplier-bills.md)),
in rand.

## The sync

**Sync supplier price lists from Zoho** (Inventory → Suppliers) and its nightly
twin **ScheduledSyncSupplierPriceLists** (5am) mirror every purchase price list
(`backend/lib/zohoSupplierPriceListHelpers.ts`).

- Each list is stored with its currency, whether it's active, and every item
  on it with its rate. A changed list's items are replaced outright. A list
  deleted in Zoho is removed here.
- Zoho lists a price list's items by Zoho item id alone. So a run that reads a
  list first pages through the item catalogue (a call per 200 items) to find
  each item's SKU, and matches items to products by SKU. An item whose product
  isn't here yet is stored unlinked. Each run links such items once *Sync
  Products* brings the product in, and lists the SKUs still unmatched.
- The **nightly** run reads only lists whose `last_modified_time` in Zoho has
  moved, so an unchanged night costs one call against the quota shared with the
  Takealot integration. The **on-demand** run reads every list. We haven't yet
  checked whether editing a single price moves the list's modified time.
- **Inactive** lists are kept and shown, but planning doesn't price from them.
- **Mark-up/mark-down lists** have no per-item rates in Zoho, so they sync with
  no items. **Volume-priced** lists have rates by quantity bracket, so their
  items sync with no rate. The run summary names such lists.
- If Zoho answers without a list of price lists, the run fails rather than
  reading it as "no lists" and deleting them all.

Lists are a copy of Zoho with no local edits, so the tables can be emptied and
re-imported at any time.

## Replaces

Before price lists, each product had a hand-entered **supplier price** and
currency (`Product.supplierUnitCost` / `supplierCurrency`, set with *Set
supplier & price*). Those fields are gone. **Set supplier** now only assigns
the supplier.
