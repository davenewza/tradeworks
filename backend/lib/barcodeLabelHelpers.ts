// Channel unit barcode labels, rendered as ZPL for the warehouse Zebra.
//
// Nothing here is channel-specific: a ChannelLabelSpec supplies the symbology,
// the fixed annotation and its placement, and the label stock. The two shapes in
// use today are Takealot (EAN-13 of the product's GTIN, "MP" stacked at the left)
// and Amazon FBA (Code 128 of the FNSKU, plus the item condition Amazon requires
// on every unit label). The Takealot geometry was measured off a Seller Portal
// barcode sheet — see docs/channel-barcode-labels.md.
//
// Everything is pure — no DB, no printer — so the ZPL can be asserted in tests.

import { BarcodeSymbology, LabelStockSize, LabelAnnotationPlacement } from '@teamkeel/sdk';

const MM_PER_INCH = 25.4;

// ─── Symbologies ────────────────────────────────────────────────────────────

// An EAN-13 symbol is 95 modules wide, and GS1 requires a quiet zone of 11
// modules on the left and 7 on the right. Those 113 modules are what has to fit
// on the label — not just the 95 the bars occupy. Takealot's own PDF lays the
// symbol out over exactly 113 modules, which is where these came from.
export const EAN13_SYMBOL_MODULES = 95;
export const EAN13_QUIET_LEFT_MODULES = 11;
export const EAN13_QUIET_RIGHT_MODULES = 7;
export const EAN13_TOTAL_MODULES =
    EAN13_SYMBOL_MODULES + EAN13_QUIET_LEFT_MODULES + EAN13_QUIET_RIGHT_MODULES;

// Code 128 is variable width: 11 modules each for the start character, every
// data character and the check character, then a 13-module stop. GS1 asks for a
// 10-module quiet zone either side.
export const CODE128_MODULES_PER_CHAR = 11;
export const CODE128_FIXED_MODULES = 11 /* start */ + 11 /* check */ + 13 /* stop */;
export const CODE128_QUIET_MODULES = 10;

// Minimum X-dimension (single module width) each symbology tolerates. EAN-13 is
// GS1's 80%-of-nominal floor for retail POS; Code 128 is the general-distribution
// minimum. The gap matters on a 203 dpi printer: a 2-dot module is 0.250mm, which
// is under EAN-13's floor but exactly at Code 128's — so a Code 128 label fits
// comfortably on stock where an EAN-13 would be out of tolerance.
export const MIN_X_DIMENSION_MM: Record<BarcodeSymbology, number> = {
    [BarcodeSymbology.Ean13]: 0.264,
    [BarcodeSymbology.Code128]: 0.25,
};
export const MAX_X_DIMENSION_MM: Record<BarcodeSymbology, number> = {
    [BarcodeSymbology.Ean13]: 0.66,
    [BarcodeSymbology.Code128]: 1.016,
};

/** Total modules the symbol plus its quiet zones occupies, for this data. */
export function totalModulesFor(symbology: BarcodeSymbology, code: string): number {
    if (symbology === BarcodeSymbology.Ean13) {
        return EAN13_TOTAL_MODULES;
    }
    return (
        CODE128_MODULES_PER_CHAR * code.length +
        CODE128_FIXED_MODULES +
        CODE128_QUIET_MODULES * 2
    );
}

// ─── Code validation ────────────────────────────────────────────────────────

/**
 * The check digit for the first 12 digits of an EAN-13, using the standard
 * alternating 1/3 weighting.
 *
 * @example
 * computeEan13CheckDigit('990104389642') // '5'  → 9901043896425
 */
export function computeEan13CheckDigit(twelveDigits: string): string {
    if (!/^\d{12}$/.test(twelveDigits)) {
        throw new Error(`Expected 12 digits, got "${twelveDigits}"`);
    }
    let sum = 0;
    for (let i = 0; i < 12; i++) {
        sum += Number(twelveDigits[i]) * (i % 2 === 0 ? 1 : 3);
    }
    return String((10 - (sum % 10)) % 10);
}

export type CodeCheck = { valid: true; code: string } | { valid: false; reason: string };

// Code 128 subset B covers printable ASCII. Longer than this and no sensible
// label stock will hold the symbol.
const CODE128_MAX_LENGTH = 48;

/**
 * Validate a code as captured against a product for one channel.
 *
 * EAN-13 tolerates the grouping channels display ("9 901043 896425") and
 * verifies the check digit. A wrong check digit is rejected rather than
 * corrected: it is a transcription error, and silently "fixing" the last digit
 * would mint labels for a different product.
 *
 * Code 128 is deliberately not narrowed to Amazon's FNSKU pattern — the same
 * symbology carries seller SKUs and ASINs, and rejecting those would be wrong.
 *
 * @example
 * checkCode(BarcodeSymbology.Ean13, '9 901043 896425') // { valid: true, code: '9901043896425' }
 * checkCode(BarcodeSymbology.Code128, 'X001ABCDEF')    // { valid: true, code: 'X001ABCDEF' }
 */
export function checkCode(
    symbology: BarcodeSymbology,
    raw: string | null | undefined
): CodeCheck {
    if (symbology === BarcodeSymbology.Ean13) {
        const code = (raw ?? '').replace(/[\s-]/g, '');
        if (code.length === 0) return { valid: false, reason: 'no code captured' };
        if (!/^\d+$/.test(code)) return { valid: false, reason: 'must be digits only' };
        if (code.length !== 13) {
            return { valid: false, reason: `must be 13 digits, got ${code.length}` };
        }
        const expected = computeEan13CheckDigit(code.slice(0, 12));
        if (code[12] !== expected) {
            return {
                valid: false,
                reason: `check digit should be ${expected}, not ${code[12]}`,
            };
        }
        return { valid: true, code };
    }

    const code = (raw ?? '').trim();
    if (code.length === 0) return { valid: false, reason: 'no code captured' };
    if (code.length > CODE128_MAX_LENGTH) {
        return { valid: false, reason: `too long for a label (${code.length} characters)` };
    }
    // Subset B spans ASCII 32–126. Anything outside it cannot be encoded.
    if (!/^[\x20-\x7E]+$/.test(code)) {
        return { valid: false, reason: 'contains characters Code 128 cannot encode' };
    }
    return { valid: true, code };
}

// ─── Label stock ────────────────────────────────────────────────────────────

export interface LabelStock {
    // Shown in the flow's stock picker.
    label: string;
    widthMm: number;
    heightMm: number;
    // The ZD220/ZD230 ("ZD200 series") is 203 dpi. Carried per stock so a
    // 300 dpi printer can be added without touching the layout maths.
    dpi: number;
}

export const LABEL_STOCKS: Record<LabelStockSize, LabelStock> = {
    [LabelStockSize.Size40x25]: { label: '40 × 25 mm', widthMm: 40, heightMm: 25, dpi: 203 },
    [LabelStockSize.Size50x25]: { label: '50 × 25 mm', widthMm: 50, heightMm: 25, dpi: 203 },
    [LabelStockSize.Size67x25]: {
        label: '66.7 × 25.4 mm (2⅝" × 1")',
        widthMm: 66.7,
        heightMm: 25.4,
        dpi: 203,
    },
    [LabelStockSize.Size100x50]: {
        label: '100 × 50 mm',
        widthMm: 100,
        heightMm: 50,
        dpi: 203,
    },
};

export const mmToDots = (mm: number, dpi: number): number => Math.round((mm / MM_PER_INCH) * dpi);
export const dotsToMm = (dots: number, dpi: number): number => (dots / dpi) * MM_PER_INCH;

// Beyond this a wider module buys nothing but label space.
const MAX_MODULE_DOTS = 6;

/**
 * The widest whole-dot module that still fits the symbol into the space
 * available, since ZPL's ^BY only takes whole dots.
 *
 * This is where label stock decides whether the symbol is in spec. At 203 dpi a
 * dot is 0.125mm, so the choices are coarse: for EAN-13's fixed 113 modules,
 * 2 dots (0.250mm) is under GS1's 0.264mm floor while 3 dots (0.375mm) needs
 * 42.4mm of width — which a 40mm label cannot give. `withinTolerance` reports
 * that rather than hiding it.
 */
export function pickModuleWidthDots(
    symbology: BarcodeSymbology,
    modules: number,
    availableDots: number,
    dpi: number
): { moduleDots: number; xDimensionMm: number; withinTolerance: boolean } {
    let moduleDots = 1;
    for (let candidate = MAX_MODULE_DOTS; candidate >= 1; candidate--) {
        if (modules * candidate <= availableDots) {
            moduleDots = candidate;
            break;
        }
    }
    const xDimensionMm = dotsToMm(moduleDots, dpi);
    return {
        moduleDots,
        xDimensionMm,
        withinTolerance:
            xDimensionMm >= MIN_X_DIMENSION_MM[symbology] &&
            xDimensionMm <= MAX_X_DIMENSION_MM[symbology],
    };
}

// ─── ZPL ────────────────────────────────────────────────────────────────────

// `^` and `~` open ZPL commands and `\` opens a hex escape, so a product name
// containing any of them would be read as markup and corrupt the rest of the
// format. Product names are free text synced from Zoho, so strip them.
export function sanitiseZplText(text: string): string {
    return text
        .replace(/[\^~\\]/g, ' ')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export interface LabelFormat {
    symbology: BarcodeSymbology;
    annotation?: string | null;
    annotationPlacement: LabelAnnotationPlacement;
    stock: LabelStock;
}

export interface LabelLayout {
    widthDots: number;
    heightDots: number;
    moduleDots: number;
    xDimensionMm: number;
    withinTolerance: boolean;
    barHeightDots: number;
    symbolXDots: number;
    titleFontDots: number;
    titleWidthDots: number;
    titleLines: number;
    annotationFontDots: number;
    barcodeYDots: number;
    annotationYDots: number;
}

const MARGIN_DOTS = 8;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * Resolve the whole dot geometry in one place. Every coordinate the renderer
 * emits comes from here — the vertical positions depend on the font sizes, so
 * recomputing them alongside the drawing code would let the two drift and
 * silently overlap the title with the bars.
 *
 * The layout depends on the code, not just the stock: Code 128 widens with every
 * character, so a long FNSKU can force a narrower module than a short one.
 */
export function computeLayout(format: LabelFormat, code: string): LabelLayout {
    const { stock, symbology, annotationPlacement } = format;
    const widthDots = mmToDots(stock.widthMm, stock.dpi);
    const heightDots = mmToDots(stock.heightMm, stock.dpi);

    const titleFontDots = clamp(Math.round(heightDots * 0.11), 16, 30);
    const annotationFontDots = clamp(Math.round(heightDots * 0.1), 14, 26);
    const hasAnnotation = Boolean(format.annotation && format.annotation.trim().length > 0);

    // A stacked annotation needs a column at the left, outside the barcode's
    // quiet zone, so it comes off the width available to the symbol. An
    // annotation below the title costs a line of height instead.
    const stackedLeft =
        hasAnnotation && annotationPlacement === LabelAnnotationPlacement.StackedLeft;
    const markerColDots = stackedLeft ? annotationFontDots + 6 : 0;
    const availableDots = widthDots - MARGIN_DOTS * 2 - markerColDots;

    const modules = totalModulesFor(symbology, code);
    const { moduleDots, xDimensionMm, withinTolerance } = pickModuleWidthDots(
        symbology,
        modules,
        availableDots,
        stock.dpi
    );

    // Centre the whole quiet-zone-inclusive block in what's left, then step in
    // past the left quiet zone to where the bars themselves start.
    const totalBarDots = modules * moduleDots;
    const leftQuietModules =
        symbology === BarcodeSymbology.Ean13 ? EAN13_QUIET_LEFT_MODULES : CODE128_QUIET_MODULES;
    const blockXDots =
        MARGIN_DOTS + markerColDots + Math.max(0, Math.floor((availableDots - totalBarDots) / 2));
    const symbolXDots = blockXDots + leftQuietModules * moduleDots;

    // A below-title annotation eats into the title's share, so the title drops
    // to one line on short stock rather than colliding with the annotation.
    const belowTitle =
        hasAnnotation && annotationPlacement === LabelAnnotationPlacement.BelowTitle;
    const titleLines = belowTitle && heightDots < 300 ? 1 : 2;
    const titleBlockDots = titleLines * (titleFontDots + 2);
    const annotationYDots = MARGIN_DOTS + titleBlockDots;
    const barcodeYDots =
        MARGIN_DOTS + titleBlockDots + (belowTitle ? annotationFontDots + 2 : 0) + 4;

    // The symbology prints its interpretation line below the bars, so it needs
    // reserving out of the remaining height.
    const barHeightDots = Math.max(
        24,
        heightDots - MARGIN_DOTS - barcodeYDots - annotationFontDots - 2
    );

    return {
        widthDots,
        heightDots,
        moduleDots,
        xDimensionMm,
        withinTolerance,
        barHeightDots,
        symbolXDots,
        titleFontDots,
        titleWidthDots: widthDots - MARGIN_DOTS * 2 - markerColDots,
        titleLines,
        annotationFontDots,
        barcodeYDots,
        annotationYDots,
    };
}

export interface LabelSpec {
    code: string;
    title: string;
    quantity: number;
}

/**
 * Build the ZPL for one product's labels on one channel. `quantity` becomes ^PQ
 * rather than repeating the format, so 200 labels is one small format, not 200
 * copies of it.
 *
 * @example
 * buildLabelZpl({ code: 'X001ABCDEF', title: 'Sensor Kit', quantity: 12 }, {
 *   symbology: BarcodeSymbology.Code128,
 *   annotation: 'New',
 *   annotationPlacement: LabelAnnotationPlacement.BelowTitle,
 *   stock: LABEL_STOCKS[LabelStockSize.Size67x25],
 * })
 */
export function buildLabelZpl(spec: LabelSpec, format: LabelFormat): string {
    const check = checkCode(format.symbology, spec.code);
    if (!check.valid) {
        throw new Error(`Cannot print label: ${check.reason}`);
    }
    if (!Number.isInteger(spec.quantity) || spec.quantity < 1) {
        throw new Error(`Label quantity must be a positive whole number, got ${spec.quantity}`);
    }

    const layout = computeLayout(format, check.code);
    const { titleFontDots, annotationFontDots, barcodeYDots } = layout;
    const annotation = sanitiseZplText(format.annotation ?? '');
    const title = sanitiseZplText(spec.title);
    const stackedLeft = format.annotationPlacement === LabelAnnotationPlacement.StackedLeft;
    // A stacked annotation sits beside the barcode, so the title starts at the
    // margin either way; only the title's usable width differs.
    const titleXDots = MARGIN_DOTS;

    const lines: string[] = [
        '^XA',
        // UTF-8, so accented product names survive the trip.
        '^CI28',
        `^PW${layout.widthDots}`,
        `^LL${layout.heightDots}`,
        '^LH0,0',
        // The barcode's interpretation line takes the default font, so pin it.
        `^CF0,${annotationFontDots}`,
    ];

    // Title, word-wrapped by ^FB and truncated past titleLines.
    lines.push(
        `^FO${titleXDots + (stackedLeft ? annotationFontDots + 6 : 0)},${MARGIN_DOTS}`,
        `^A0N,${titleFontDots},${titleFontDots}`,
        `^FB${layout.titleWidthDots},${layout.titleLines},2,L,0`,
        `^FD${title}^FS`
    );

    if (annotation.length > 0) {
        if (stackedLeft) {
            // One character per line down the left edge, as on Takealot's label.
            annotation.split('').forEach((char, index) => {
                lines.push(
                    `^FO${MARGIN_DOTS},${barcodeYDots + index * annotationFontDots}`,
                    `^A0N,${annotationFontDots},${annotationFontDots}`,
                    `^FD${char}^FS`
                );
            });
        } else {
            // A normal line under the title — Amazon's item condition.
            lines.push(
                `^FO${MARGIN_DOTS},${layout.annotationYDots}`,
                `^A0N,${annotationFontDots},${annotationFontDots}`,
                `^FD${annotation}^FS`
            );
        }
    }

    // The symbol. ^BY sets the module width. ^BE draws EAN-13 and is given the
    // first 12 digits so the printer recomputes the check digit — passing 13
    // would encode the check digit as data. ^BC draws Code 128, which
    // auto-selects its subset and appends its own check character.
    lines.push(`^FO${layout.symbolXDots},${barcodeYDots}`, `^BY${layout.moduleDots}`);
    if (format.symbology === BarcodeSymbology.Ean13) {
        lines.push(`^BEN,${layout.barHeightDots},Y,N`, `^FD${check.code.slice(0, 12)}^FS`);
    } else {
        lines.push(`^BCN,${layout.barHeightDots},Y,N,N`, `^FD${check.code}^FS`);
    }

    lines.push(`^PQ${spec.quantity}`, '^XZ');
    return lines.join('\n');
}

// ─── Selection rows ─────────────────────────────────────────────────────────
// Shapes and row-building for the print flow's pages. Pure, so they live here
// rather than beside the queries in barcodeLabelSelection — importing the SDK
// there would drag the Keel runtime into these unit tests.

// One selectable product. Flat and JSON-serializable so it can pass through
// ctx.step() and ctx.ui.select.table() unchanged.
export interface LabelCandidate {
    productId: string;
    sku: string;
    name: string;
    brand: string;
    code: string;
}

// A product that cannot be labelled for this channel, and why — surfaced rather
// than dropped, so a missing or mistyped code is visible instead of the product
// just being absent from the picker.
export interface UnprintableProduct {
    sku: string;
    name: string;
    problem: string;
}

export interface CandidateLoad {
    candidates: LabelCandidate[];
    unprintable: UnprintableProduct[];
}

// A row of the quantity grid. `productId` and `code` ride along hidden so the
// print step needs no second lookup.
export interface LabelQuantityRow {
    productId: string;
    code: string;
    sku: string;
    name: string;
    // Units on hand, shown read-only so the operator can size the run against
    // stock without it dictating the count.
    onHand: number;
    labels: number;
}

/**
 * Seed the quantity grid from the picked products.
 *
 * Counts start at 1, deliberately: you label the units going into the FC, which
 * is normally a subset of stock on hand. Defaulting to stock would mean one
 * stray click could commit a 300-label run and burn a roll, so on-hand is shown
 * as a reference column instead. Stock can be null (never synced) or negative
 * (sales billed ahead of stock), so it is floored at 0 for display.
 */
export function buildQuantityRows(
    selected: LabelCandidate[],
    stockBySku: Record<string, number | null> = {}
): LabelQuantityRow[] {
    return selected.map((candidate) => ({
        productId: candidate.productId,
        code: candidate.code,
        sku: candidate.sku,
        name: candidate.name,
        onHand: Math.max(0, stockBySku[candidate.sku] ?? 0),
        labels: 1,
    }));
}
