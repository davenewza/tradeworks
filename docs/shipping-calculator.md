# Shipping calculator

**Logistics → Shipping calculator** in the Console (the `CalculateShipping`
flow) prices delivery for any set of products to any South African address.
Use it to answer a "what would delivery cost?" question without creating a
customer quote. Nothing is written: the quote is the run's completion page.

## One calculation, three ways in

All three entry points pack and price a shipment with the same code:

| Entry point | Who uses it | Code |
| --- | --- | --- |
| Customer portal quote | Customers, on a quote's shipping step | `calculateEquipmentBoxes` + `calculateDelivery` |
| Delivery rates API | Partners' systems ([delivery-rates-api.md](delivery-rates-api.md)) | `getDeliveryRates` → `lib/deliveryQuote` |
| Shipping calculator | Staff, in the Console | `CalculateShipping` → `lib/deliveryQuote` |

The API and the calculator both call `quoteDelivery` in `lib/deliveryQuote.ts`,
so for the same products, box type and address they return the same boxes,
parcels and rates. The portal's actions run the same steps through the same
`lib/deliveryHelpers` functions:

1. **Pack.** The products' total volume (`volumeInLitres` × quantity) goes into
   the enabled equipment boxes of the chosen type (`packEquipmentBoxes`).
   Larger boxes are filled whole first. The remainder goes into the smallest
   box that holds it.
2. **Parcel.** Each box becomes one courier parcel. The products' total weight
   is spread evenly across the parcels, on top of each box's own weight
   (`buildParcels`).
3. **Price.** The parcels are rated by The Courier Guy (ShipLogic), collected
   from the Somerset West warehouse (`COLLECTION_ADDRESS`).
4. **Mark up.** Every rate is increased by `DELIVERY_MARKUP` (10%) and sorted
   cheapest first (`mapRates`). The cheapest is the delivery fee a customer
   quote would carry.

## Using it

1. Add a row per product. The **Product** column searches active products by
   SKU or name as you type. Under each match it shows the product's weight and
   volume, or warns that its dimensions or weight are missing.
2. Choose cardboard boxes or plastic equipment boxes. Plastic boxes are
   charged per box on top of the delivery fee, as on a customer quote.
3. Enter the delivery address. Pick the province from the list so the courier
   gets its exact name.
4. **Calculate.** The results page shows:
   - the shipping total: the cheapest delivery fee, plus any box charge, plus VAT;
   - the parcels, actual weight and the courier's charged weight;
   - every courier option, with its estimated delivery window in SA time;
   - the boxes the shipment was packed in.
5. **Change the shipment** returns to the first page with everything still
   filled in. **Done** ends the run, with the quote as its completion page.

## When it cannot quote

- **A product is missing data.** A product without dimensions or a weight is
  listed by SKU, together with every other problem in the shipment. Set the
  missing values on the product page, then calculate again.
- **No boxes are configured.** Either no box of the chosen type exists or none
  is enabled.
- **The courier has no service.** ShipLogic returned no rates for the address.
- **The courier returned an error.** Usually a bad address. The courier's own
  message is shown.

In each case **Change the shipment** returns to the first page. A courier
error is shown on the page rather than failing the run, so the address can be
corrected without starting again.
