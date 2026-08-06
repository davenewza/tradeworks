# Tradeworks Delivery Rates API — Integration Specification

**Version 1.0 — August 2026**

This document specifies the Delivery Rates API, which calculates real-time delivery quotes for Tradeworks products shipped within South Africa. Given a list of products (by SKU) and a destination address, the API determines the packaging required, obtains live courier rates, and returns the available delivery options with pricing.

---

## 1. Endpoint

```
POST https://production-tradeworks-n0Lpcg.keelapps.xyz/api/json/getDeliveryRates
```

- **Method:** POST only
- **Request body:** JSON (`Content-Type: application/json` required)
- **Response body:** JSON
- **Encoding:** UTF-8

A machine-readable OpenAPI 3.1 description of this endpoint (and its exact schemas) is available at:

```
https://production-tradeworks-n0Lpcg.keelapps.xyz/api/json/openapi.json
```

## 2. Authentication

Every request must include an API key in the `X-API-KEY` header:

```
X-API-KEY: <your key>
```

The key is issued by Tradeworks and shared with you through a secure channel — it is not included in this document.

- Requests without the header, or with an incorrect key, receive **HTTP 403** (see §6).
- Treat the key as a secret: server-side use only, never in browser code, mobile apps, or logs.
- If the key is compromised, contact Tradeworks immediately so it can be rotated. Rotation invalidates the old key at once, so coordinate deployment of the replacement.

## 3. Request

### 3.1 Body schema

```json
{
  "lines": [
    { "sku": "MS-TALEBOTPROCLASS", "quantity": 2 }
  ],
  "deliveryAddress": {
    "addressLine1": "1 Main Rd",
    "addressLine2": "Unit 4",
    "suburb": "Claremont",
    "city": "Cape Town",
    "province": "Western Cape",
    "postalCode": "7708",
    "country": "ZA",
    "organisation": "Acme (Pty) Ltd"
  },
  "includeEquipmentBox": false
}
```

### 3.2 Field reference

**Top level**

| Field | Type | Required | Description |
|---|---|---|---|
| `lines` | array of Line | Yes, at least 1 item | The products to be shipped. |
| `deliveryAddress` | Address | Yes | The destination. |
| `includeEquipmentBox` | boolean | No (default `false`) | `false`/omitted: products are packed in cardboard shipping boxes. `true`: products are packed in durable plastic equipment boxes, which are charged for (see `boxes` in the response). |

**Line**

| Field | Type | Required | Description |
|---|---|---|---|
| `sku` | string | Yes | A Tradeworks product SKU. Must exist in the Tradeworks catalogue. |
| `quantity` | integer | Yes | Whole number, minimum 1. |

The same SKU may appear on multiple lines; quantities are additive.

**Address**

| Field | Type | Required | Description |
|---|---|---|---|
| `addressLine1` | string | Yes | Street address. |
| `addressLine2` | string | No | Unit, floor, building, etc. |
| `suburb` | string | Yes | Suburb / local area. Required for accurate courier rating. |
| `city` | string | Yes | City or town. |
| `province` | string | Yes | Full province name, e.g. `"Western Cape"`, `"Gauteng"`. |
| `postalCode` | string | Yes | South African postal code. |
| `country` | string | No | ISO 3166-1 alpha-2 code. Defaults to `"ZA"`. Only South African delivery is supported. |
| `organisation` | string | No | Company name at the destination, if applicable. |

Missing required fields are rejected by schema validation (HTTP 400) before the calculation runs.

## 4. How the calculation works

Understanding the pipeline helps interpret the response:

1. Each SKU is looked up in the Tradeworks catalogue for its physical dimensions and weight. **All SKUs must be known, enabled, and have complete physical data**, or the request is rejected with a detailed error (§6.2).
2. The total product volume is packed into shipping boxes (cardboard or plastic equipment boxes, per `includeEquipmentBox`) using Tradeworks' bin-packing rules. The chosen boxes are returned in the response so you can see — and price — what the quote is based on.
3. Each box becomes a courier parcel; the total product weight is distributed evenly across the boxes and added to each box's own weight.
4. Live rates for those parcels are obtained from Tradeworks' courier partner for the given destination, and returned sorted cheapest first.

The endpoint is **read-only and idempotent**: it does not create quotes, orders, or shipments, and it is safe to retry.

## 5. Response (HTTP 200)

### 5.1 Body schema (abridged example, real values)

```json
{
  "deliveryService": "Local Same Day Economy Ecomms",
  "deliveryFee": 213.07,
  "deliveryFeeInclVat": 245.03,
  "boxType": "Cardboard",
  "boxes": [
    {
      "name": "Cardboard Box Large",
      "sku": "STOCK6",
      "quantity": 1,
      "priceExclVat": 0,
      "priceInclVat": 0,
      "lengthInCm": 60,
      "widthInCm": 45,
      "heightInCm": 30,
      "weightInGrams": 600
    },
    {
      "name": "Cardboard Box Small",
      "sku": "4X5L",
      "quantity": 1,
      "priceExclVat": 0,
      "priceInclVat": 0,
      "lengthInCm": 38.5,
      "widthInCm": 26.5,
      "heightInCm": 26,
      "weightInGrams": 150
    }
  ],
  "totalParcels": 2,
  "totalWeightKg": 4.85,
  "rates": [
    {
      "serviceLevel": {
        "code": "LSE",
        "name": "Local Same Day Economy Ecomms",
        "description": "Collection must be booked by 10:30, and ready by 11:00, to be delivered by 17:00 the same day.",
        "deliveryDateFrom": "2026-08-06T09:00:00+02:00",
        "deliveryDateTo": "2026-08-06T15:00:00+02:00",
        "collectionDate": "2026-08-06T08:00:00+02:00",
        "collectionCutOffTime": "2026-08-06T10:30:00+02:00"
      },
      "pricing": {
        "rate": 245.03,
        "rateExcludingVat": 213.07,
        "vat": 28.41,
        "vatPercentage": 15
      },
      "weights": {
        "chargedWeight": 15,
        "actualWeight": 4.85,
        "volumetricWeight": 15
      }
    }
  ]
}
```

### 5.2 Field reference

**Top level**

| Field | Type | Description |
|---|---|---|
| `deliveryService` | string | Name of the cheapest available service. The two fee fields below refer to this service. |
| `deliveryFee` | number | Delivery fee for the cheapest service, in ZAR, **excluding VAT**. |
| `deliveryFeeInclVat` | number | The same fee **including 15% VAT**. |
| `boxType` | string | `"Cardboard"` or `"PlasticEquipment"` — which packaging was used. |
| `boxes` | array of Box | The packaging the quote is based on (see below). |
| `totalParcels` | integer | Number of parcels that will ship. |
| `totalWeightKg` | number | Actual total shipment weight in kg (products + packaging). |
| `rates` | array of Rate | Every available delivery option, sorted cheapest first. `rates[0]` is always the option summarised by the top-level fee fields. |

**Box**

| Field | Type | Description |
|---|---|---|
| `name` | string | Box name. |
| `sku` | string or null | Box SKU, when it is a sellable item. |
| `quantity` | integer | How many of this box. |
| `priceExclVat` / `priceInclVat` | number | Per-box price in ZAR. Cardboard boxes are free (0); plastic equipment boxes are charged. **Box charges are separate from, and additional to, the delivery fee.** |
| `lengthInCm` / `widthInCm` / `heightInCm` | number | Box dimensions. |
| `weightInGrams` | number | Empty-box weight. |

**Rate**

| Field | Type | Description |
|---|---|---|
| `serviceLevel.code` | string | Courier service-level code, e.g. `ECO`, `OVN`, `LSE`. |
| `serviceLevel.name` | string | Human-readable service name. |
| `serviceLevel.description` | string or absent | Courier's description of the service. |
| `serviceLevel.deliveryDateFrom` / `deliveryDateTo` | string or absent | Estimated delivery window (ISO 8601). |
| `serviceLevel.collectionDate` | string or absent | Planned collection date. |
| `serviceLevel.collectionCutOffTime` | string or absent | Cut-off time for same-day collection. |
| `pricing.rate` | number | Fee in ZAR including VAT. |
| `pricing.rateExcludingVat` | number | Fee in ZAR excluding VAT. |
| `pricing.vat` | number | VAT amount the courier reports on its base charge only. Surcharges carry their own VAT, so this can be less than `rate - rateExcludingVat`; use that difference if you need the total VAT amount. |
| `pricing.vatPercentage` | number | VAT percentage (currently `15`). |
| `weights.chargedWeight` | number or absent | Billable weight in kg (the greater of actual and volumetric weight). |
| `weights.actualWeight` | number or absent | Actual weight in kg. |
| `weights.volumetricWeight` | number or absent | Volumetric weight in kg. |

Notes:

- All monetary values are ZAR, returned as JSON numbers with full floating-point precision. **Round to 2 decimal places for display**, and do not rely on exact equality when comparing.
- Optional fields may be absent or `null`; treat both the same.
- Service levels, their codes, and their availability come from the courier and **vary by destination** — do not hard-code an expected list. Local metro destinations may see same-day services; national destinations typically see Economy/Overnight/Express.
- Delivery estimates are the courier's own and are not guaranteed by Tradeworks.

## 6. Errors

Errors return a JSON body:

```json
{ "code": "<error code>", "message": "<human-readable message>" }
```

| HTTP status | `code` | Meaning |
|---|---|---|
| 400 | `ERR_INVALID_INPUT` | Request body is malformed or missing required fields (schema-level rejection). A `data.errors` array lists each problem, e.g. `{"errors": [{"field": "deliveryAddress", "error": "city is required"}]}`. |
| 403 | `ERR_PERMISSION_DENIED` | `X-API-KEY` header missing or incorrect. Message: `"not authorized to access"`. |
| 500 | `ERR_UNKNOWN` | Business validation failed, or an upstream error occurred. **Read the `message`** — validation failures are precise and actionable (below). |

### 6.1 Product/line validation (500, message starts with `Cannot calculate delivery rates:`)

**All problems in the request are reported together** in one message, separated by `"; "` — fix everything listed, not just the first item. Individual message formats:

| Message | Cause |
|---|---|
| `at least one line item is required` | `lines` was empty. |
| `each line item must have a sku` | A line had a blank SKU. |
| `SKU "X": quantity must be a whole number of 1 or more (got N)` | Zero, negative, or fractional quantity. |
| `SKU "X": no product with this SKU exists` | Unknown SKU. |
| `SKU "X": product is disabled` | The product is no longer sold. |
| `SKU "X": product is missing dimensions (length, width and height must be set)` | Catalogue data incomplete — contact Tradeworks. |
| `SKU "X": product is missing a weight (weightInGrams must be greater than 0)` | Catalogue data incomplete — contact Tradeworks. |
| `no <BoxType> equipment boxes are configured` | No packaging configured for the requested box type — contact Tradeworks. |

Example (real response):

```json
{
  "code": "ERR_UNKNOWN",
  "message": "Cannot calculate delivery rates: SKU \"DOES-NOT-EXIST\": no product with this SKU exists; SKU \"RL-AE086\": product is missing dimensions (length, width and height must be set); SKU \"RL-AE086\": product is missing a weight (weightInGrams must be greater than 0)"
}
```

### 6.2 Other 500 messages

| Message contains | Cause | Suggested handling |
|---|---|---|
| `Shiplogic API error: <status>` | The courier's rating service failed or rejected the request (e.g. unrecognisable address). | Retry once; if persistent, check the address, then contact Tradeworks. |
| `No delivery rates available` | The courier returned no options for this address/parcel combination. | Verify the address; contact Tradeworks if it looks correct. |
| `The DELIVERY_API_KEY secret is not configured for this environment` | Server-side misconfiguration. | Contact Tradeworks. |

## 7. Worked examples

### 7.1 Cardboard shipment, Cape Town (local)

```bash
curl -X POST https://production-tradeworks-n0Lpcg.keelapps.xyz/api/json/getDeliveryRates \
  -H "Content-Type: application/json" \
  -H "X-API-KEY: $DELIVERY_API_KEY" \
  -d '{
    "lines": [
      { "sku": "MS-TALEBOTPROCLASS", "quantity": 2 },
      { "sku": "MKZ-OBK-EC", "quantity": 1 }
    ],
    "deliveryAddress": {
      "addressLine1": "1 Main Rd",
      "suburb": "Claremont",
      "city": "Cape Town",
      "province": "Western Cape",
      "postalCode": "7708"
    }
  }'
```

Result (observed in production): 2 parcels (1× large + 1× small cardboard box), 4.85 kg, cheapest option *Local Same Day Economy Ecomms* at **R213.07 excl VAT** (R245.03 incl), with overnight and express alternatives in `rates`.

### 7.2 Plastic equipment boxes

Same request with `"includeEquipmentBox": true` returns 3 parcels (65L + 45L + 25L Pride storage boxes), each box priced in `boxes` (e.g. R121.74 excl VAT for the 65L), and a higher delivery fee reflecting the larger volumetric weight.

### 7.3 National destination

Same cardboard request to Rosebank, Johannesburg (`province: "Gauteng"`, `postalCode: "2196"`) returns Economy at **R360.49 excl VAT** (delivery in ~4–6 days), Overnight, and Same Day Express options.

## 8. Operational notes

- **Latency:** typically 1–3 seconds (a live courier call is made per request). Use a client timeout of at least 15 seconds.
- **Retries:** safe (read-only). Use modest retry policies (e.g. 1–2 retries with backoff) — do not retry aggressively in a loop.
- **Rate limits:** none currently enforced. Call per checkout/quote event, not per keystroke; cache results client-side if you re-display them.
- **Quote validity:** rates are live courier prices and can change at any time; treat a quote as indicative until an order is confirmed.
- **Currency:** all amounts are ZAR.
- **Coverage:** South African destinations only.
- **Change management:** additive changes (new response fields, new service levels) may occur without notice — build tolerant parsing. Breaking changes will be communicated in advance.

## 9. Support

For API keys, catalogue data issues (missing dimensions/weights), unexpected errors, or integration questions, contact Tradeworks with the full request body, response body, and timestamp of the call.
