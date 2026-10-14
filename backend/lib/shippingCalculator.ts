import { BoxType, Currency, models, useDatabase } from '@teamkeel/sdk';
import { sql } from 'kysely';
import { MappedRate } from './deliveryHelpers';
import { DeliveryQuote, DeliveryQuoteAddress, DeliveryQuoteOutcome, ShipLogicCredentials, quoteDelivery } from './deliveryQuote';
import { formatMoney } from './purchasePlanFormat';

// The Console's shipping calculator (flows/calculateShipping.ts): reading the
// operator's shipment off the form, quoting it through lib/deliveryQuote, and
// shaping the quote into the rows and totals the results page shows. Kept out
// of the flow so the wording and arithmetic can be unit-tested.

export const PROVINCES = [
    'Eastern Cape',
    'Free State',
    'Gauteng',
    'KwaZulu-Natal',
    'Limpopo',
    'Mpumalanga',
    'North West',
    'Northern Cape',
    'Western Cape'
] as const;

export const BOX_TYPE_LABELS: Record<BoxType, string> = {
    [BoxType.Cardboard]: 'Cardboard boxes',
    [BoxType.PlasticEquipment]: 'Plastic equipment boxes'
};

export interface ShipmentLine {
    sku: string;
    quantity: number;
}

export interface Shipment {
    lines: ShipmentLine[];
    boxType: BoxType;
    address: DeliveryQuoteAddress;
}

// The shipment page's values, as the Console sends them back. A grid row the
// operator added but never filled has a null product.
export interface ShipmentPageData {
    lines?: Array<{ sku?: string | null; quantity?: number | string | null }>;
    boxType?: string;
    organisation?: string;
    addressLine1?: string;
    addressLine2?: string;
    suburb?: string;
    city?: string;
    province?: string;
    postalCode?: string;
}

const REQUIRED_ADDRESS_FIELDS: Array<[keyof ShipmentPageData, string]> = [
    ['addressLine1', 'street address'],
    ['suburb', 'suburb'],
    ['city', 'city'],
    ['province', 'province'],
    ['postalCode', 'postal code']
];

function filledLines(data: ShipmentPageData) {
    return (data.lines ?? []).filter((line) => typeof line.sku === 'string' && line.sku.trim() !== '');
}

// The shipment page's validate: one message for the first thing missing.
export function validateShipmentPage(data: ShipmentPageData): string | true {
    const lines = filledLines(data);
    if (lines.length === 0) {
        return 'Add at least one product.';
    }
    const badQuantity = lines.find((line) => {
        const quantity = Number(line.quantity);
        return !Number.isInteger(quantity) || quantity < 1;
    });
    if (badQuantity) {
        return `Set a whole quantity of 1 or more for ${badQuantity.sku}.`;
    }
    const missing = REQUIRED_ADDRESS_FIELDS.filter(([field]) => !String(data[field] ?? '').trim()).map(([, label]) => label);
    if (missing.length > 0) {
        return `Enter the ${missing.join(', ')}.`;
    }
    return true;
}

// The validated page as a shipment: blank grid rows dropped, text trimmed, and
// blank optional fields left out rather than sent to the courier as "".
export function readShipmentPage(data: ShipmentPageData): Shipment {
    const optional = (value?: string) => (value && value.trim() !== '' ? value.trim() : null);
    return {
        lines: filledLines(data).map((line) => ({ sku: line.sku!.trim(), quantity: Number(line.quantity) })),
        boxType: data.boxType === BoxType.PlasticEquipment ? BoxType.PlasticEquipment : BoxType.Cardboard,
        address: {
            organisation: optional(data.organisation),
            addressLine1: (data.addressLine1 ?? '').trim(),
            addressLine2: optional(data.addressLine2),
            suburb: (data.suburb ?? '').trim(),
            city: (data.city ?? '').trim(),
            province: (data.province ?? '').trim(),
            postalCode: (data.postalCode ?? '').trim(),
            country: 'ZA'
        }
    };
}

// A ShipLogic failure (a bad address, the courier being down) is shown to the
// operator to correct and retry, rather than failing the run.
export type ShipmentOutcome = DeliveryQuoteOutcome | { status: 'failed'; message: string };

export async function calculateShipment(shipment: Shipment, shipLogic: ShipLogicCredentials): Promise<ShipmentOutcome> {
    try {
        return await quoteDelivery(
            { lines: shipment.lines, deliveryAddress: shipment.address, boxType: shipment.boxType },
            shipLogic
        );
    } catch (error) {
        return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
}

// ─── Product picker ─────────────────────────────────────────────────────────

export interface ProductOption {
    value: string;
    label: string;
    description?: string;
}

export function productLabel(sku: string, name: string): string {
    return `${sku} · ${name}`;
}

// What the picker says under a product: its shipping weight and volume, or
// that it cannot be quoted until its catalogue data is filled in.
export function describeShippingData(weightInGrams: number | null, volumeInLitres: number | null): string {
    const missing = [
        ...(volumeInLitres === null || !(volumeInLitres > 0) ? ['dimensions'] : []),
        ...(weightInGrams === null || !(weightInGrams > 0) ? ['weight'] : [])
    ];
    if (missing.length > 0) {
        return `No ${missing.join(' or ')} — cannot be quoted`;
    }
    return `${formatKg(weightInGrams! / 1000)} · ${formatNumber(volumeInLitres!)} L`;
}

// Active products whose SKU or name contains the query, case-insensitively,
// for the grid's product column. SKU-prefix matches come first, so a typed
// SKU lands at the top.
export async function searchShippableProducts(query: string, limit = 25): Promise<ProductOption[]> {
    const term = query.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
    const db = useDatabase();
    // useDatabase's Kysely runs the CamelCasePlugin, so raw-SQL result
    // columns come back camelCased.
    const result = await sql<{
        sku: string;
        name: string;
        weightInGrams: string | number | null;
        volumeInLitres: string | number | null;
    }>`
        select sku, name, weight_in_grams, volume_in_litres
        from product
        where is_active and (sku ilike ${`%${term}%`} or name ilike ${`%${term}%`})
        order by (sku ilike ${`${term}%`}) desc, name
        limit ${limit}
    `.execute(db);

    return result.rows.map((row) => ({
        value: row.sku,
        label: productLabel(row.sku, row.name),
        description: describeShippingData(
            row.weightInGrams === null ? null : Number(row.weightInGrams),
            row.volumeInLitres === null ? null : Number(row.volumeInLitres)
        )
    }));
}

// Product names by SKU, for the grid's labels when a shipment is edited and
// for the results page's product list. Unknown SKUs are left out.
export async function loadProductNames(skus: string[]): Promise<Record<string, string>> {
    const unique = [...new Set(skus)];
    if (unique.length === 0) {
        return {};
    }
    const products = await models.product.findMany({ where: { sku: { oneOf: unique } } });
    return Object.fromEntries(products.map((product) => [product.sku, product.name]));
}

// ─── Results ────────────────────────────────────────────────────────────────

export function formatRand(value: number): string {
    return formatMoney(value, Currency.ZAR);
}

function formatNumber(value: number): string {
    return value.toLocaleString('en-GB', { maximumFractionDigits: 2 });
}

export function formatKg(value: number): string {
    return `${formatNumber(value)} kg`;
}

const SAST = 'Africa/Johannesburg';

function formatDay(iso: string): string {
    return new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: SAST });
}

function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: SAST });
}

// The courier's estimated delivery window, in South African time: 'Thu 16 Oct
// 09:00–15:00' for a same-day window, 'Thu 16 Oct – Fri 17 Oct' across days.
export function formatDeliveryWindow(rate: MappedRate): string {
    const from = rate.serviceLevel.deliveryDateFrom;
    const to = rate.serviceLevel.deliveryDateTo;
    if (!from && !to) {
        return '';
    }
    if (!from || !to) {
        return formatDay((from ?? to)!);
    }
    if (formatDay(from) === formatDay(to)) {
        return `${formatDay(from)} ${formatTime(from)}–${formatTime(to)}`;
    }
    return `${formatDay(from)} – ${formatDay(to)}`;
}

export interface ShipmentTotals {
    deliveryExclVat: number;
    boxesExclVat: number;
    vat: number;
    totalInclVat: number;
}

// What the shipment costs the customer with the cheapest service: the
// delivery fee plus any charge for the boxes, which a customer quote adds as
// its equipment-box lines.
export function shipmentTotals(quote: DeliveryQuote): ShipmentTotals {
    const boxesExclVat = quote.boxes.reduce((sum, box) => sum + box.priceExclVat * box.quantity, 0);
    const boxesInclVat = quote.boxes.reduce((sum, box) => sum + box.priceInclVat * box.quantity, 0);
    const totalInclVat = quote.deliveryFeeInclVat + boxesInclVat;
    return {
        deliveryExclVat: quote.deliveryFee,
        boxesExclVat,
        vat: totalInclVat - quote.deliveryFee - boxesExclVat,
        totalInclVat
    };
}

export function totalsItems(quote: DeliveryQuote): Array<{ label: string; value: string; important?: boolean }> {
    const totals = shipmentTotals(quote);
    return [
        { label: `Delivery — ${quote.deliveryService}`, value: formatRand(totals.deliveryExclVat) },
        { label: BOX_TYPE_LABELS[quote.boxType], value: formatRand(totals.boxesExclVat) },
        { label: 'VAT', value: formatRand(totals.vat) },
        { label: 'Total incl. VAT', value: formatRand(totals.totalInclVat), important: true }
    ];
}

export function describeAddress(address: DeliveryQuoteAddress): string {
    return [
        address.organisation,
        address.addressLine1,
        address.addressLine2,
        address.suburb,
        address.city,
        `${address.province} ${address.postalCode}`
    ]
        .filter((part) => !!part)
        .join(', ');
}

export function shipmentFacts(quote: DeliveryQuote, shipment: Shipment): Array<{ key: string; value: string | number }> {
    const charged = quote.rates[0]?.weights.chargedWeight;
    return [
        { key: 'Deliver to', value: describeAddress(shipment.address) },
        { key: 'Packed in', value: BOX_TYPE_LABELS[quote.boxType] },
        { key: 'Parcels', value: quote.totalParcels },
        { key: 'Actual weight', value: formatKg(quote.totalWeightKg) },
        ...(charged !== undefined && charged !== null ? [{ key: 'Charged weight', value: formatKg(Number(charged)) }] : [])
    ];
}

export function rateRows(quote: DeliveryQuote) {
    return quote.rates.map((rate) => ({
        Service: rate.serviceLevel.name,
        'Estimated delivery': formatDeliveryWindow(rate),
        'Excl. VAT': formatRand(rate.pricing.rateExcludingVat),
        'Incl. VAT': formatRand(rate.pricing.rate),
        'Charged weight':
            rate.weights.chargedWeight === undefined || rate.weights.chargedWeight === null
                ? ''
                : formatKg(Number(rate.weights.chargedWeight))
    }));
}

export function boxRows(quote: DeliveryQuote) {
    return quote.boxes.map((box) => ({
        Box: box.name,
        Qty: box.quantity,
        'Size (cm)': `${formatNumber(box.lengthInCm)} × ${formatNumber(box.widthInCm)} × ${formatNumber(box.heightInCm)}`,
        'Empty weight': formatKg(box.weightInGrams / 1000),
        'Each excl. VAT': formatRand(box.priceExclVat),
        'Total incl. VAT': formatRand(box.priceInclVat * box.quantity)
    }));
}

export function productRows(shipment: Shipment, names: Record<string, string>) {
    return shipment.lines.map((line) => ({
        SKU: line.sku,
        Product: names[line.sku] ?? '',
        Qty: line.quantity
    }));
}

// 'SKU "X": product is inactive' → '- SKU "X": product is inactive', one per
// line, as markdown.
export function issuesMarkdown(issues: string[]): string {
    return issues.map((issue) => `- ${issue.charAt(0).toUpperCase()}${issue.slice(1)}`).join('\n');
}
