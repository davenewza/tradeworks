import { Currency, StockCoverStatus } from '@teamkeel/sdk';
import { PlanLine, PurchasePlan, PurchasePlanParams, daysBetween } from './purchasePlanHelpers';

// How a purchase plan is shown — the grid the buyer edits, the "why" behind
// each quantity, and the labels shared by the review page and the completion
// report. Kept out of the flow so the wording can be unit-tested and the flow
// stays orchestration.

// '14 Nov 2026' — the Console's date style, in UTC so a plan never shifts a
// day depending on where the server happens to be.
export function formatDate(date: Date): string {
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const CURRENCY_PREFIX: Record<Currency, string> = {
    [Currency.ZAR]: 'R ',
    [Currency.USD]: '$',
    [Currency.GBP]: '£',
    [Currency.EUR]: '€',
    [Currency.CNY]: 'CN¥',
};

// 'R 1,234.50', '£1,234.50'. en-GB grouping rather than en-ZA: the ZA locale
// uses a comma for the decimal point, which reads as thousands next to
// whole-unit columns.
export function formatMoney(value: number, currency: Currency): string {
    const amount = value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${CURRENCY_PREFIX[currency]}${amount}`;
}

// A line's value, blank when its cost is unknown. A last-bill stand-in is
// marked, so nobody mistakes it for the supplier's price.
export function formatLineValue(line: PlanLine): string {
    if (line.lineValue === null || line.currency === null) return '';
    const value = formatMoney(line.lineValue, line.currency);
    return line.costSource === 'LastBill' ? `${value} (last bill)` : value;
}

export function formatUnitCost(line: PlanLine): string {
    if (line.unitCost === null || line.currency === null) return '';
    const cost = formatMoney(line.unitCost, line.currency);
    return line.costSource === 'LastBill' ? `${cost} (last bill)` : cost;
}

// The status bands' Console labels (see docs/stock-cover.md).
export function statusLabel(status: StockCoverStatus | null): string {
    switch (status) {
        case StockCoverStatus.InsufficientSupply:
            return 'Shortfall';
        case StockCoverStatus.LowSupply:
            return 'Low';
        case StockCoverStatus.GoodSupply:
            return 'Good';
        case StockCoverStatus.Oversupply:
            return 'Oversupply';
        default:
            return '';
    }
}

// One sentence on why a product got its quantity, for the grid's Why column.
export function describeReason(line: PlanLine, arrival: Date): string {
    switch (line.reason) {
        case 'StockoutBeforeArrival': {
            const gap = Math.max(1, Math.round(daysBetween(line.runsOutOn!, arrival)));
            return line.stockPosition <= 0
                ? `Already out of stock — ${gap} day(s) of lost sales before this order lands`
                : `Sells out ~${formatDate(line.runsOutOn!)}, ${gap} day(s) before this order lands`;
        }
        case 'Reorder':
            return `Sells out ~${formatDate(line.runsOutOn!)} without this order`;
        case 'Covered':
            return `Already covered to ~${formatDate(line.runsOutOn!)}`;
        case 'StockUnknown':
            return 'No stock reading yet — planned as if none on hand';
        case 'NoForecast':
            return 'No sales in the last 12 months — type a quantity to include it';
    }
}

// A row of the editable grid. Display-only figures that can be blank are
// strings, so an unknown cost or cover shows as nothing rather than a zero
// that means something else; the quantities the buyer works with are numbers.
export interface PlanGridRow {
    productId: string;
    abc: string;
    sku: string;
    name: string;
    // On hand + on the way. 0 when there is no reading — the Why column says so.
    stock: number;
    // Monthly run-rate to 1 dp; 0 without a forecast.
    monthly: number;
    suggested: number;
    // Editable.
    order: number;
    cover: string;
    coveredUntil: string;
    value: string;
    why: string;
}

export function toGridRow(line: PlanLine, arrival: Date): PlanGridRow {
    return {
        productId: line.productId,
        abc: line.abcClass ?? '',
        sku: line.sku,
        name: line.name,
        stock: line.stockPosition,
        monthly: Math.round((line.monthlyDemand ?? 0) * 10) / 10,
        suggested: line.suggestedQuantity,
        order: line.orderQuantity,
        cover: line.coverAtArrivalMonths === null ? '' : `${line.coverAtArrivalMonths.toFixed(1)} mo · ${statusLabel(line.statusAtArrival)}`,
        coveredUntil: line.coveredUntil ? formatDate(line.coveredUntil) : '',
        value: formatLineValue(line),
        why: describeReason(line, arrival),
    };
}

// The parameters and totals, as key/value rows for the review and completion
// pages.
export function summaryRows(plan: PurchasePlan, params: PurchasePlanParams): { key: string; value: string | number }[] {
    const s = plan.summary;
    const parts = s.valueByCurrency.map((t) => formatMoney(t.value, t.currency));
    if (parts.length === 0) parts.push(formatMoney(0, Currency.ZAR));
    if (s.linesWithoutCost > 0) parts.push(`${s.linesWithoutCost} line(s) with no cost on record`);
    const value = parts.join(' + ');
    return [
        { key: 'Purchase date', value: formatDate(params.purchaseDate) },
        { key: 'Lead time', value: `${params.leadTimeInDays} days` },
        { key: 'Lands', value: `~${formatDate(s.arrival)}` },
        { key: 'Cover on arrival', value: `${params.targetCoverMonths} month(s)` },
        { key: 'In stock until', value: `~${formatDate(s.horizon)}` },
        { key: 'Products to order', value: `${s.linesToOrder} of ${s.products}` },
        { key: 'Units', value: s.totalUnits },
        { key: 'Goods value (excl VAT & freight)', value },
        ...(s.linesCostedFromBills > 0
            ? [{ key: 'Costed from last bill', value: `${s.linesCostedFromBills} line(s) with no supplier price, in rand` }]
            : []),
    ];
}

// The first few products of a list as "SKU (date)", for banner copy.
export function listProducts(lines: PlanLine[], date: (l: PlanLine) => Date | null, max = 8): string {
    const shown = lines.slice(0, max).map((l) => {
        const d = date(l);
        return d ? `${l.sku} (~${formatDate(d)})` : l.sku;
    });
    const more = lines.length - shown.length;
    return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
}
