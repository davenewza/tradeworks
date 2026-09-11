import { test, expect, describe } from 'vitest';
import { BarcodeSymbology, LabelElementKind, LabelStockSize } from '@teamkeel/sdk';
import {
    computeEan13CheckDigit,
    checkCode,
    describeElements,
    sanitiseZplText,
    totalModulesFor,
    pickModuleWidthDots,
    computeLayout,
    buildLabelZpl,
    buildQuantityRows,
    buildBatchZpl,
    fitTitle,
    mmToDots,
    validateElements,
    DEFAULT_ELEMENTS,
    LABEL_STOCKS,
    LabelCandidate,
    LabelElement,
    LabelFormat,
    EAN13_TOTAL_MODULES,
    EAN13_QUIET_LEFT_MODULES,
    CODE128_QUIET_MODULES,
    MIN_BAR_HEIGHT_MM,
    MIN_X_DIMENSION_MM,
} from './barcodeLabelHelpers';

// Decoded off the reference label Takealot's Seller Portal produced
// (product_labels_18_05_2021_CPT_1.pdf) — EAN-13 shown as "9 901043 896425".
const TAKEALOT_CODE = '9901043896425';
// Amazon FNSKUs are 10 alphanumeric characters, conventionally X + 9.
const FNSKU = 'X001ABCDEF';

// The two shapes in production use, both on the 50 × 30 mm roll the warehouse
// runs. Takealot: the product name over an EAN-13, "MP" stacked beside the bars.
const takealotElements: LabelElement[] = [
    { kind: LabelElementKind.Title, maxLines: 2 },
    { kind: LabelElementKind.Barcode },
    { kind: LabelElementKind.StackedText, text: 'MP' },
];
// Amazon FBA: the symbol at the top, the FNSKU under its own bars, the product
// name below that, and the item condition at the very bottom.
const amazonElements: LabelElement[] = [
    { kind: LabelElementKind.Barcode },
    { kind: LabelElementKind.Title, maxLines: 2 },
    { kind: LabelElementKind.Text, text: 'New' },
];

const takealotFormat: LabelFormat = {
    symbology: BarcodeSymbology.Ean13,
    elements: takealotElements,
    stock: LABEL_STOCKS[LabelStockSize.Size50x30],
};
const amazonFormat: LabelFormat = {
    symbology: BarcodeSymbology.Code128,
    elements: amazonElements,
    stock: LABEL_STOCKS[LabelStockSize.Size50x30],
};

const text = (value: string): LabelElement => ({ kind: LabelElementKind.Text, text: value });

describe('fitTitle — the title block is a hard boundary', () => {
    // The budget that produced the overprint this function exists to prevent:
    // 384 dots of width at a 26-dot font over two lines, i.e. 29 characters a
    // line. Fixed here rather than read off a stock, so the regression stays
    // pinned to the case that was actually printed.
    const WIDTH = 384;
    const FONT = 26;
    const LINES = 2;
    const PER_LINE = 29;

    // Greedy re-wrap at the same budget, to assert what ^FB will do with it.
    const wrap = (text: string): string[] => {
        const out: string[] = [];
        let current = '';
        for (const word of text.split(' ')) {
            const candidate = current ? `${current} ${word}` : word;
            if (candidate.length <= PER_LINE) current = candidate;
            else {
                if (current) out.push(current);
                current = word;
            }
        }
        if (current) out.push(current);
        return out;
    };

    const fit = (t: string) => fitTitle(t, WIDTH, FONT, LINES);

    test('leaves a name that already fits completely alone', () => {
        const name = 'Makerzoid Robot Master Premium';
        expect(fit(name)).toBe(name);
    });

    test('truncates the name that overprinted on a real label', () => {
        // 76 characters — ^FB with maxLines=2 stacked the third line on top of
        // the second on the ZD220 rather than dropping it.
        const name = 'Arduino-Compatible UNO R3 ATmega328P, Acrylic Case, and USB Cable - 2 Pieces';
        const fitted = fit(name);

        expect(fitted).toBe('Arduino-Compatible UNO R3 ATmega328P, Acrylic Case,...');
        expect(fitted.endsWith('...')).toBe(true);
        expect(wrap(fitted)).toHaveLength(LINES);
    });

    test('hard-breaks a single word too long for one line instead of dropping it', () => {
        const name = 'SuperlongUnbrokenPartNumberWithNoSpacesAtAllXYZ123456789';
        const fitted = fit(name);

        // Every character survives — only a space is inserted at the break.
        expect(fitted.replace(/ /g, '')).toBe(name);
        expect(wrap(fitted)).toHaveLength(LINES);
    });

    test('never lets any line exceed the width, suffix included', () => {
        const names = [
            'Makerzoid Robot Master Premium',
            'Arduino-Compatible UNO R3 ATmega328P, Acrylic Case, and USB Cable - 2 Pieces',
            'A'.repeat(200),
            'Word '.repeat(60).trim(),
            // A name whose natural break lands exactly on the budget, so the
            // suffix has to displace real characters rather than be appended.
            `${'x'.repeat(PER_LINE)} ${'y'.repeat(PER_LINE)} tail`,
        ];
        for (const name of names) {
            const lines = wrap(fit(name));
            expect(lines.length).toBeLessThanOrEqual(LINES);
            for (const line of lines) expect(line.length).toBeLessThanOrEqual(PER_LINE);
        }
    });

    test('handles an empty or single-character name without throwing', () => {
        expect(fit('')).toBe('');
        expect(fit('W')).toBe('W');
    });
});

describe('buildBatchZpl — the whole run is one job', () => {
    const specs = [
        { code: TAKEALOT_CODE, title: 'Alpha', quantity: 2 },
        { code: '6001234567899', title: 'Bravo', quantity: 1 },
    ];

    test('concatenates one complete format per product', () => {
        const zpl = buildBatchZpl(specs, takealotFormat);

        // Two formats, each a complete ^XA…^XZ — the printer treats them as one
        // stream, so there is a single job boundary for the run rather than one
        // per product (each boundary costs seconds of feed and backfeed).
        expect(zpl.match(/\^XA/g)).toHaveLength(2);
        expect(zpl.match(/\^XZ/g)).toHaveLength(2);
        expect(zpl).toContain('^PQ2');
        expect(zpl).toContain('^PQ1');
    });

    test('prints in the order given, so the stack matches the screen', () => {
        const forward = buildBatchZpl(specs, takealotFormat);
        const reversed = buildBatchZpl([...specs].reverse(), takealotFormat);

        expect(forward.indexOf('Alpha')).toBeLessThan(forward.indexOf('Bravo'));
        expect(reversed.indexOf('Bravo')).toBeLessThan(reversed.indexOf('Alpha'));
    });

    test('is identical to the single-label output for one product', () => {
        expect(buildBatchZpl([specs[0]], takealotFormat)).toBe(
            buildLabelZpl(specs[0], takealotFormat)
        );
    });

    test('refuses an empty run rather than sending a job that prints nothing', () => {
        expect(() => buildBatchZpl([], takealotFormat)).toThrow(/no labels/);
    });

    test('still rejects an unprintable code anywhere in the run', () => {
        const withBad = [...specs, { code: '9901043896424', title: 'Charlie', quantity: 1 }];
        expect(() => buildBatchZpl(withBad, takealotFormat)).toThrow(/check digit/);
    });
});

describe('computeEan13CheckDigit', () => {
    test('reproduces the check digit on the reference label', () => {
        expect(computeEan13CheckDigit('990104389642')).toBe('5');
    });

    test('handles a check digit of zero without wrapping to 10', () => {
        expect(computeEan13CheckDigit('000000000000')).toBe('0');
    });

    test('agrees with a known GS1 example', () => {
        expect(computeEan13CheckDigit('400638133393')).toBe('1');
    });

    test('rejects anything that is not exactly 12 digits', () => {
        expect(() => computeEan13CheckDigit('12345')).toThrow(/12 digits/);
        expect(() => computeEan13CheckDigit('99010438964A')).toThrow(/12 digits/);
        expect(() => computeEan13CheckDigit('9901043896425')).toThrow(/12 digits/);
    });
});

describe('checkCode — EAN-13', () => {
    const ean = BarcodeSymbology.Ean13;

    test('accepts the reference code', () => {
        expect(checkCode(ean, TAKEALOT_CODE)).toEqual({ valid: true, code: TAKEALOT_CODE });
    });

    test('strips the grouping the Seller Portal displays', () => {
        expect(checkCode(ean, '9 901043 896425')).toEqual({ valid: true, code: TAKEALOT_CODE });
        expect(checkCode(ean, '9-901043-896425')).toEqual({ valid: true, code: TAKEALOT_CODE });
    });

    test('rejects a transcription error rather than correcting it', () => {
        const result = checkCode(ean, '9901043896424');
        expect(result.valid).toBe(false);
        expect(result.valid === false && result.reason).toMatch(/check digit should be 5/);
    });

    test('reports the specific problem for each kind of bad input', () => {
        expect(checkCode(ean, null)).toEqual({ valid: false, reason: 'no code captured' });
        expect(checkCode(ean, '   ')).toEqual({ valid: false, reason: 'no code captured' });
        expect(checkCode(ean, 'ABC123')).toEqual({ valid: false, reason: 'must be digits only' });
        const short = checkCode(ean, '12345');
        expect(short.valid === false && short.reason).toMatch(/must be 13 digits, got 5/);
    });

    test('rejects an FNSKU — it is not expressible as an EAN', () => {
        expect(checkCode(ean, FNSKU).valid).toBe(false);
    });
});

describe('checkCode — Code 128', () => {
    const c128 = BarcodeSymbology.Code128;

    test('accepts an FNSKU', () => {
        expect(checkCode(c128, FNSKU)).toEqual({ valid: true, code: FNSKU });
    });

    test('accepts an ASIN and a seller SKU — the same symbology carries both', () => {
        // Narrowing to Amazon's FNSKU pattern would wrongly reject these.
        expect(checkCode(c128, 'B08N5WRWNW').valid).toBe(true);
        expect(checkCode(c128, 'RL-AE002').valid).toBe(true);
    });

    test('trims surrounding whitespace but keeps interior characters', () => {
        expect(checkCode(c128, '  X001ABCDEF  ')).toEqual({ valid: true, code: FNSKU });
        expect(checkCode(c128, 'ACME WIDGET 1')).toEqual({ valid: true, code: 'ACME WIDGET 1' });
    });

    test('rejects an empty code', () => {
        expect(checkCode(c128, '')).toEqual({ valid: false, reason: 'no code captured' });
        expect(checkCode(c128, null)).toEqual({ valid: false, reason: 'no code captured' });
    });

    test('rejects characters outside the encodable ASCII range', () => {
        const result = checkCode(c128, 'WIDGET-Ω');
        expect(result.valid).toBe(false);
        expect(result.valid === false && result.reason).toMatch(/cannot encode/);
    });

    test('rejects a code too long for any label', () => {
        const result = checkCode(c128, 'A'.repeat(49));
        expect(result.valid).toBe(false);
        expect(result.valid === false && result.reason).toMatch(/too long/);
    });
});

describe('totalModulesFor', () => {
    test('EAN-13 is a fixed 113 modules regardless of the digits', () => {
        expect(totalModulesFor(BarcodeSymbology.Ean13, TAKEALOT_CODE)).toBe(113);
        expect(totalModulesFor(BarcodeSymbology.Ean13, '4006381333931')).toBe(EAN13_TOTAL_MODULES);
    });

    test('Code 128 grows 11 modules per character', () => {
        // 11n + 11 start + 11 check + 13 stop + 2 × 10 quiet = 11n + 55
        expect(totalModulesFor(BarcodeSymbology.Code128, FNSKU)).toBe(11 * 10 + 55);
        const oneMore = totalModulesFor(BarcodeSymbology.Code128, FNSKU + 'A');
        expect(oneMore - totalModulesFor(BarcodeSymbology.Code128, FNSKU)).toBe(11);
    });
});

describe('pickModuleWidthDots — tolerance differs by symbology', () => {
    test('a 2-dot module is out of tolerance for EAN-13 but fine for Code 128', () => {
        // This is the whole reason Amazon labels are easier on a 203 dpi ZD200:
        // 2 dots is 0.250mm, under EAN-13's 0.264mm floor but exactly Code 128's.
        const ean = pickModuleWidthDots(BarcodeSymbology.Ean13, 113, 300, 203);
        expect(ean.moduleDots).toBe(2);
        expect(ean.withinTolerance).toBe(false);

        const c128 = pickModuleWidthDots(BarcodeSymbology.Code128, 165, 400, 203);
        expect(c128.moduleDots).toBe(2);
        expect(c128.xDimensionMm).toBeGreaterThanOrEqual(
            MIN_X_DIMENSION_MM[BarcodeSymbology.Code128]
        );
        expect(c128.withinTolerance).toBe(true);
    });

    test('takes the widest whole-dot module that still fits', () => {
        expect(pickModuleWidthDots(BarcodeSymbology.Ean13, 113, 400, 203).moduleDots).toBe(3);
        expect(pickModuleWidthDots(BarcodeSymbology.Ean13, 113, 339, 203).moduleDots).toBe(3);
        expect(pickModuleWidthDots(BarcodeSymbology.Ean13, 113, 338, 203).moduleDots).toBe(2);
    });

    test('never drops below one dot, even on impossibly narrow stock', () => {
        expect(pickModuleWidthDots(BarcodeSymbology.Ean13, 113, 10, 203).moduleDots).toBe(1);
    });
});

describe('validateElements — a label has to be buildable', () => {
    test('accepts both shapes in production use', () => {
        expect(validateElements(takealotElements)).toEqual([]);
        expect(validateElements(amazonElements)).toEqual([]);
        expect(validateElements(DEFAULT_ELEMENTS)).toEqual([]);
    });

    test('rejects a label with nothing to scan', () => {
        expect(validateElements([{ kind: LabelElementKind.Title }])).toEqual([
            'no barcode element — there would be nothing to scan',
        ]);
        expect(validateElements([])).toHaveLength(1);
    });

    test('rejects duplicates that would print on top of each other', () => {
        const twoBarcodes = validateElements([
            { kind: LabelElementKind.Barcode },
            { kind: LabelElementKind.Barcode },
        ]);
        expect(twoBarcodes).toEqual(['2 barcode elements — a label can only carry one']);

        const twoTitles = validateElements([
            { kind: LabelElementKind.Barcode },
            { kind: LabelElementKind.Title },
            { kind: LabelElementKind.Title },
        ]);
        expect(twoTitles[0]).toMatch(/more than one title/);

        const twoStacked = validateElements([
            { kind: LabelElementKind.Barcode },
            { kind: LabelElementKind.StackedText, text: 'MP' },
            { kind: LabelElementKind.StackedText, text: 'XX' },
        ]);
        expect(twoStacked[0]).toMatch(/more than one stacked text/);
    });

    test('rejects a text element with nothing in it', () => {
        // Including text that is nothing but ZPL control characters, which
        // sanitising leaves empty.
        for (const value of ['', '   ', '^^^']) {
            expect(validateElements([{ kind: LabelElementKind.Barcode }, text(value)])).toEqual([
                'a text element has no text',
            ]);
        }
    });

    test('reports every problem at once rather than the first', () => {
        expect(validateElements([text(''), { kind: LabelElementKind.Title }, { kind: LabelElementKind.Title }]))
            .toHaveLength(3);
    });
});

describe('describeElements — the print page has to say what it will print', () => {
    test('reads the label out in print order', () => {
        expect(describeElements(amazonElements)).toBe('Barcode → Product name → “New”');
    });

    test('names stacked text separately, since it is beside the bars', () => {
        expect(describeElements(takealotElements)).toBe('Product name → Barcode, “MP” stacked left');
    });
});

describe('computeLayout — Takealot shape (product name over an EAN-13)', () => {
    test('50 × 30 mm — the warehouse roll — prints an in-spec EAN-13', () => {
        const layout = computeLayout(takealotFormat, TAKEALOT_CODE);
        expect(layout.widthDots).toBe(400);
        expect(layout.heightDots).toBe(240);
        expect(layout.moduleDots).toBe(3);
        expect(layout.withinTolerance).toBe(true);
        expect(layout.barHeightWithinTolerance).toBe(true);
    });

    test('puts the product name above the bars', () => {
        const layout = computeLayout(takealotFormat, TAKEALOT_CODE);
        const title = layout.placements.find((p) => p.kind === LabelElementKind.Title)!;
        expect(title.yDots).toBeLessThan(layout.barcodeYDots);
        expect(title.lines).toBe(2);
    });

    test('40 × 25 mm cannot fit a 3-dot module, so it falls out of tolerance', () => {
        // 113 × 3 = 339 dots (42.4mm) does not fit a 40mm label.
        const layout = computeLayout(
            { ...takealotFormat, stock: LABEL_STOCKS[LabelStockSize.Size40x25] },
            TAKEALOT_CODE
        );
        expect(layout.moduleDots).toBe(2);
        expect(layout.withinTolerance).toBe(false);
    });

    test('keeps the stacked marker clear of the left quiet zone', () => {
        const layout = computeLayout(takealotFormat, TAKEALOT_CODE);
        const quietZoneStart = layout.symbolXDots - EAN13_QUIET_LEFT_MODULES * layout.moduleDots;
        expect(quietZoneStart).toBeGreaterThanOrEqual(8 + layout.textFontDots);
    });

    test('the extra 5mm of a 30mm roll goes to the bars, not the title', () => {
        const tall = computeLayout(takealotFormat, TAKEALOT_CODE);
        const short = computeLayout(
            { ...takealotFormat, stock: LABEL_STOCKS[LabelStockSize.Size50x25] },
            TAKEALOT_CODE
        );
        expect(tall.moduleDots).toBe(short.moduleDots);
        expect(tall.barHeightDots).toBeGreaterThan(short.barHeightDots);
        expect(tall.titleLines).toBe(short.titleLines);
    });
});

describe('computeLayout — Amazon shape (bars, FNSKU, name, condition)', () => {
    test('stacks the elements in the order the channel lists them', () => {
        const layout = computeLayout(amazonFormat, FNSKU);
        expect(layout.placements.map((p) => p.kind)).toEqual([
            LabelElementKind.Barcode,
            LabelElementKind.Title,
            LabelElementKind.Text,
        ]);
        expect(layout.placements.map((p) => p.yDots)).toEqual(
            [...layout.placements.map((p) => p.yDots)].sort((a, b) => a - b)
        );
    });

    test('puts the product name below the bars and the FNSKU under them', () => {
        const layout = computeLayout(amazonFormat, FNSKU);
        const title = layout.placements.find((p) => p.kind === LabelElementKind.Title)!;
        // The printer draws the interpretation line — the FNSKU itself —
        // immediately below the bars, so the name has to start below that.
        const interpretationBottom =
            layout.barcodeYDots + layout.barHeightDots + layout.textFontDots;
        expect(title.yDots).toBeGreaterThanOrEqual(interpretationBottom);
    });

    test('puts the item condition at the very bottom', () => {
        const layout = computeLayout(amazonFormat, FNSKU);
        const condition = layout.placements.find((p) => p.kind === LabelElementKind.Text)!;
        const others = layout.placements.filter((p) => p !== condition);
        for (const other of others) expect(condition.yDots).toBeGreaterThan(other.yDots);
        // And still on the label.
        expect(condition.yDots + condition.heightDots).toBeLessThanOrEqual(layout.heightDots);
    });

    test('50 × 30 mm fits a 10-character FNSKU at the Code 128 minimum', () => {
        const layout = computeLayout(amazonFormat, FNSKU);
        // 165 modules × 2 dots = 330, inside 384; a 3-dot module would need 495.
        expect(layout.moduleDots).toBe(2);
        expect(layout.xDimensionMm).toBeCloseTo(MIN_X_DIMENSION_MM[BarcodeSymbology.Code128], 3);
        expect(layout.withinTolerance).toBe(true);
    });

    test('12 characters is the ceiling before the module falls out of spec', () => {
        // 11n + 55 modules at 2 dots has to fit 384: n = 12 needs 374, n = 13
        // needs 396 and drops to a 1-dot module — 0.125mm, which will not scan.
        expect(computeLayout(amazonFormat, 'A'.repeat(12)).withinTolerance).toBe(true);
        const tooLong = computeLayout(amazonFormat, 'A'.repeat(13));
        expect(tooLong.moduleDots).toBe(1);
        expect(tooLong.withinTolerance).toBe(false);
    });

    test('clears Amazon’s minimum barcode height with all four elements on', () => {
        const layout = computeLayout(amazonFormat, FNSKU);
        expect(layout.barHeightDots).toBeGreaterThan(mmToDots(MIN_BAR_HEIGHT_MM, 203));
        expect(layout.barHeightWithinTolerance).toBe(true);
    });

    test('re-ordering the rows moves the name without touching anything else', () => {
        const nameOnTop = computeLayout(
            {
                ...amazonFormat,
                elements: [amazonElements[1], amazonElements[0], amazonElements[2]],
            },
            FNSKU
        );
        const asShipped = computeLayout(amazonFormat, FNSKU);
        // Same heights, different order — the label is a stack, so moving a
        // block cannot cost or gain space.
        expect(nameOnTop.barHeightDots).toBe(asShipped.barHeightDots);
        expect(nameOnTop.placements[0].kind).toBe(LabelElementKind.Title);
    });

    test('a longer code narrows the module rather than overflowing', () => {
        const short = computeLayout(amazonFormat, 'X001AB');
        const long = computeLayout(amazonFormat, 'A'.repeat(40));
        expect(long.moduleDots).toBeLessThan(short.moduleDots);
    });
});

describe('computeLayout — text shrinks to fit before the bars are sacrificed', () => {
    const crowd = (lines: number): LabelFormat => ({
        ...amazonFormat,
        stock: LABEL_STOCKS[LabelStockSize.Size50x25],
        elements: [
            { kind: LabelElementKind.Barcode },
            { kind: LabelElementKind.Title, maxLines: 2 },
            ...Array.from({ length: lines }, (_, i) => text(`Line ${i + 1}`)),
        ],
    });

    test('leaves the nominal size alone when the label is not crowded', () => {
        const roomy = computeLayout(amazonFormat, FNSKU);
        // 50 × 30 mm: 20-dot title, 18-dot fixed text.
        expect(roomy.titleFontDots).toBe(20);
        expect(roomy.textFontDots).toBe(18);
    });

    test('shrinks the text rather than letting the bars fall short', () => {
        const crowded = computeLayout(crowd(4), FNSKU);
        const roomy = computeLayout(crowd(0), FNSKU);
        expect(crowded.titleFontDots).toBeLessThan(roomy.titleFontDots);
        expect(crowded.textFontDots).toBeLessThan(roomy.textFontDots);
        // Which is the point: the barcode still clears its minimum.
        expect(crowded.barHeightWithinTolerance).toBe(true);
    });

    test('stops at a readable floor and reports rather than shrinking forever', () => {
        const impossible = computeLayout(crowd(9), FNSKU);
        expect(impossible.titleFontDots).toBe(14);
        expect(impossible.textFontDots).toBe(12);
        expect(impossible.barHeightWithinTolerance).toBe(false);
        // Still a drawable format — the operator is warned, not handed a
        // negative bar height.
        expect(impossible.barHeightDots).toBeGreaterThan(0);
    });

    test('one title line buys the bars about 2.7mm over two', () => {
        const oneLine = computeLayout(
            { ...amazonFormat, elements: [amazonElements[0], { kind: LabelElementKind.Title, maxLines: 1 }, amazonElements[2]] },
            FNSKU
        );
        const twoLines = computeLayout(amazonFormat, FNSKU);
        expect(oneLine.barHeightMm - twoLines.barHeightMm).toBeCloseTo(2.75, 1);
    });

    test('caps the title at three lines however the row is configured', () => {
        const layout = computeLayout(
            { ...amazonFormat, elements: [amazonElements[0], { kind: LabelElementKind.Title, maxLines: 9 }] },
            FNSKU
        );
        expect(layout.titleLines).toBe(3);
    });
});

describe('computeLayout — fits every stock and symbology', () => {
    const cases: Array<[string, LabelFormat, string]> = [];
    for (const size of Object.keys(LABEL_STOCKS) as LabelStockSize[]) {
        cases.push([`ean13/${size}`, { ...takealotFormat, stock: LABEL_STOCKS[size] }, TAKEALOT_CODE]);
        cases.push([`code128/${size}`, { ...amazonFormat, stock: LABEL_STOCKS[size] }, FNSKU]);
    }

    test.each(cases)('%s keeps the symbol and both quiet zones on the label', (_name, format, code) => {
        const layout = computeLayout(format, code);
        const leftQuiet =
            format.symbology === BarcodeSymbology.Ean13
                ? EAN13_QUIET_LEFT_MODULES
                : CODE128_QUIET_MODULES;
        const modules = totalModulesFor(format.symbology, code);
        // symbolXDots is already past the left quiet zone; the rest must land on
        // the label.
        const rightEdge = layout.symbolXDots + (modules - leftQuiet) * layout.moduleDots;
        expect(rightEdge).toBeLessThanOrEqual(layout.widthDots);
    });

    test.each(cases)('%s stacks its elements without overlap or overflow', (_name, format, code) => {
        const layout = computeLayout(format, code);
        let cursor = 0;
        for (const placement of layout.placements) {
            // Clears the leading edge, and starts where the last one ended.
            expect(placement.yDots).toBeGreaterThanOrEqual(24);
            expect(placement.yDots).toBeGreaterThanOrEqual(cursor);
            cursor = placement.yDots + placement.heightDots;
        }
        expect(cursor).toBeLessThanOrEqual(layout.heightDots);
    });
});

describe('sanitiseZplText', () => {
    test('strips the characters that would be read as ZPL markup', () => {
        expect(sanitiseZplText('Widget ^FS Blue')).toBe('Widget FS Blue');
        expect(sanitiseZplText('Widget ~JA Blue')).toBe('Widget JA Blue');
        expect(sanitiseZplText('Widget \\5C Blue')).toBe('Widget 5C Blue');
    });

    test('collapses newlines and runs of whitespace', () => {
        expect(sanitiseZplText('  Sensor\n\tModule   Kit  ')).toBe('Sensor Module Kit');
    });

    test('leaves ordinary product names untouched', () => {
        expect(sanitiseZplText('37 Sensor Module Kit for Arduino, Raspberry Pi, ESP32')).toBe(
            '37 Sensor Module Kit for Arduino, Raspberry Pi, ESP32'
        );
    });
});

describe('buildLabelZpl', () => {
    test('emits one well-formed format regardless of copy count', () => {
        const zpl = buildLabelZpl(
            { code: TAKEALOT_CODE, title: 'Sensor Kit', quantity: 200 },
            takealotFormat
        );
        expect(zpl.startsWith('^XA')).toBe(true);
        expect(zpl.trimEnd().endsWith('^XZ')).toBe(true);
        expect(zpl.match(/\^XA/g)).toHaveLength(1);
        expect(zpl).toContain('^PQ200');
        // ^PQ, not 200 repeats of the format.
        expect(zpl.match(/\^BEN/g)).toHaveLength(1);
    });

    test('sets the page geometry from the stock', () => {
        const zpl = buildLabelZpl({ code: TAKEALOT_CODE, title: 'W', quantity: 1 }, takealotFormat);
        expect(zpl).toContain(`^PW${mmToDots(50, 203)}`);
        expect(zpl).toContain(`^LL${mmToDots(30, 203)}`);
        expect(zpl).toContain('^CI28'); // UTF-8
    });

    test('EAN-13 uses ^BE and is handed 12 digits so the printer adds the check digit', () => {
        const zpl = buildLabelZpl({ code: TAKEALOT_CODE, title: 'W', quantity: 1 }, takealotFormat);
        expect(zpl).toMatch(/\^BEN,\d+,Y,N/);
        expect(zpl).toContain('^FD990104389642^FS');
        // Sending all 13 would encode the check digit as data.
        expect(zpl).not.toContain('^FD9901043896425^FS');
        expect(zpl).not.toContain('^BCN');
    });

    test('Code 128 uses ^BC and is handed the code verbatim', () => {
        const zpl = buildLabelZpl({ code: FNSKU, title: 'W', quantity: 1 }, amazonFormat);
        expect(zpl).toMatch(/\^BCN,\d+,Y,N,N/);
        expect(zpl).toContain(`^FD${FNSKU}^FS`);
        expect(zpl).not.toContain('^BEN');
    });

    test('runs the title full width from the left margin, past stacked text', () => {
        const zpl = buildLabelZpl(
            { code: TAKEALOT_CODE, title: 'National Geographic Metal Detector Starter Kit', quantity: 1 },
            takealotFormat
        );
        const width = mmToDots(50, 203);
        // Title and the stacked "MP" share the same left edge: the stacked text
        // is beside the bars, not beside the title, so indenting the title
        // would drop characters off a long product name for no reason. (The y
        // differs — the top margin is larger than the sides; see the
        // leading-edge test.)
        expect(zpl).toMatch(/\^FO8,\d+\n\^A0N,\d+/);
        expect(zpl).toContain(`^FB${width - 16},2,2,L,0`);
    });

    test('keeps the title clear of the leading edge on every stock', () => {
        // A 1mm top margin sliced the tops off the title on real 50 × 30 stock:
        // a thermal printer cannot place ink that close to the label gap, and the
        // die-cut corner radius is right there too. 3mm clears both.
        for (const size of Object.keys(LABEL_STOCKS) as LabelStockSize[]) {
            const zpl = buildLabelZpl(
                { code: TAKEALOT_CODE, title: 'A long product name that wraps to two lines', quantity: 1 },
                { ...takealotFormat, stock: LABEL_STOCKS[size] }
            );
            expect(zpl).toContain('^FO8,24');
        }
    });

    test('sets stacked text one character per line beside the bars', () => {
        const zpl = buildLabelZpl({ code: TAKEALOT_CODE, title: 'W', quantity: 1 }, takealotFormat);
        expect(zpl).toContain('^FDM^FS');
        expect(zpl).toContain('^FDP^FS');
        expect(zpl).not.toContain('^FDMP^FS');
    });

    test('prints a text element as one line', () => {
        const zpl = buildLabelZpl({ code: FNSKU, title: 'W', quantity: 1 }, amazonFormat);
        // Amazon requires the item condition on every unit label.
        expect(zpl).toContain('^FDNew^FS');
        expect(zpl).not.toContain('^FDN^FS');
    });

    test('emits the fields in the order the channel lists them', () => {
        const zpl = buildLabelZpl({ code: FNSKU, title: 'Widget', quantity: 1 }, amazonFormat);
        // Barcode, then the product name, then the condition — the order is the
        // only thing that decides this, so it is worth asserting on the stream
        // itself and not just on the coordinates.
        expect(zpl.indexOf('^BCN')).toBeLessThan(zpl.indexOf('^FDWidget^FS'));
        expect(zpl.indexOf('^FDWidget^FS')).toBeLessThan(zpl.indexOf('^FDNew^FS'));

        const takealot = buildLabelZpl({ code: TAKEALOT_CODE, title: 'Widget', quantity: 1 }, takealotFormat);
        expect(takealot.indexOf('^FDWidget^FS')).toBeLessThan(takealot.indexOf('^BEN'));
    });

    test('asks for the interpretation line below the bars, not above', () => {
        // The fourth ^BC parameter is "interpretation line above code" — N is
        // what puts the FNSKU directly beneath its own symbol.
        const zpl = buildLabelZpl({ code: FNSKU, title: 'W', quantity: 1 }, amazonFormat);
        expect(zpl).toMatch(/\^BCN,\d+,Y,N,N/);
    });

    test('prints a plain label for a channel with no elements of its own', () => {
        const zpl = buildLabelZpl(
            { code: FNSKU, title: 'Widget', quantity: 1 },
            { ...amazonFormat, elements: DEFAULT_ELEMENTS }
        );
        expect(zpl).toContain('^FDWidget^FS');
        expect(zpl).not.toContain('^FDNew^FS');
        expect(zpl).toContain('^BCN');
    });

    test('refuses a format that could not make a label', () => {
        expect(() =>
            buildLabelZpl(
                { code: FNSKU, title: 'W', quantity: 1 },
                { ...amazonFormat, elements: [{ kind: LabelElementKind.Title }] }
            )
        ).toThrow(/nothing to scan/);
    });

    test('neutralises ZPL control characters in the product name', () => {
        const zpl = buildLabelZpl(
            { code: TAKEALOT_CODE, title: 'Widget ^XZ ~JA', quantity: 1 },
            takealotFormat
        );
        // Still exactly one format — the injected ^XZ did not terminate it early.
        expect(zpl.match(/\^XZ/g)).toHaveLength(1);
        expect(zpl).toContain('^FDWidget XZ JA^FS');
    });

    test('refuses to print a code the symbology cannot carry', () => {
        expect(() =>
            buildLabelZpl({ code: '9901043896424', title: 'W', quantity: 1 }, takealotFormat)
        ).toThrow(/check digit should be 5/);
        // An FNSKU on an EAN-13 channel is a misconfiguration, not a label.
        expect(() =>
            buildLabelZpl({ code: FNSKU, title: 'W', quantity: 1 }, takealotFormat)
        ).toThrow(/Cannot print label/);
        expect(() =>
            buildLabelZpl({ code: '', title: 'W', quantity: 1 }, amazonFormat)
        ).toThrow(/no code captured/);
    });

    test('refuses a non-positive or fractional quantity', () => {
        for (const quantity of [0, -1, 1.5]) {
            expect(() =>
                buildLabelZpl({ code: FNSKU, title: 'W', quantity }, amazonFormat)
            ).toThrow(/positive whole number/);
        }
    });
});

// ─── Quantity rows ──────────────────────────────────────────────────────────

const candidate = (sku: string, overrides: Partial<LabelCandidate> = {}): LabelCandidate => ({
    productId: `id-${sku}`,
    sku,
    name: `Product ${sku}`,
    brand: 'Robotico',
    code: TAKEALOT_CODE,
    ...overrides,
});

describe('buildQuantityRows', () => {
    test('starts every count at 1 rather than at stock on hand', () => {
        // Defaulting to stock would let one stray click commit a 340-label run.
        const rows = buildQuantityRows([candidate('RL-AE002')], { 'RL-AE002': 340 });
        expect(rows[0].labels).toBe(1);
        expect(rows[0].onHand).toBe(340);
    });

    test('carries the ids the print step needs, so it needs no second lookup', () => {
        const rows = buildQuantityRows([candidate('RL-AE002')]);
        expect(rows[0]).toMatchObject({
            productId: 'id-RL-AE002',
            code: TAKEALOT_CODE,
            sku: 'RL-AE002',
        });
    });

    test('floors unknown, null and negative stock at zero', () => {
        // stockAvailable goes negative when sales are billed ahead of stock.
        expect(buildQuantityRows([candidate('A')], {})[0].onHand).toBe(0);
        expect(buildQuantityRows([candidate('A')], { A: null })[0].onHand).toBe(0);
        expect(buildQuantityRows([candidate('A')], { A: -12 })[0].onHand).toBe(0);
    });

    test('preserves the order of the selection', () => {
        const rows = buildQuantityRows([candidate('AAA'), candidate('BBB'), candidate('CCC')]);
        expect(rows.map((r) => r.sku)).toEqual(['AAA', 'BBB', 'CCC']);
    });

    test('returns nothing for an empty selection', () => {
        expect(buildQuantityRows([])).toEqual([]);
    });
});
