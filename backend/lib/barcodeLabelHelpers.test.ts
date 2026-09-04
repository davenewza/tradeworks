import { test, expect, describe } from 'vitest';
import { BarcodeSymbology, LabelStockSize, LabelAnnotationPlacement } from '@teamkeel/sdk';
import {
    computeEan13CheckDigit,
    checkCode,
    sanitiseZplText,
    totalModulesFor,
    pickModuleWidthDots,
    computeLayout,
    buildLabelZpl,
    buildQuantityRows,
    buildBatchZpl,
    fitTitle,
    mmToDots,
    LABEL_STOCKS,
    LabelCandidate,
    LabelFormat,
    EAN13_TOTAL_MODULES,
    EAN13_QUIET_LEFT_MODULES,
    CODE128_QUIET_MODULES,
    MIN_X_DIMENSION_MM,
} from './barcodeLabelHelpers';

// Decoded off the reference label Takealot's Seller Portal produced
// (product_labels_18_05_2021_CPT_1.pdf) — EAN-13 shown as "9 901043 896425".
const TAKEALOT_CODE = '9901043896425';
// Amazon FNSKUs are 10 alphanumeric characters, conventionally X + 9.
const FNSKU = 'X001ABCDEF';

// The two shapes in production use.
const takealotFormat: LabelFormat = {
    symbology: BarcodeSymbology.Ean13,
    annotation: 'MP',
    annotationPlacement: LabelAnnotationPlacement.StackedLeft,
    stock: LABEL_STOCKS[LabelStockSize.Size50x25],
};
const amazonFormat: LabelFormat = {
    symbology: BarcodeSymbology.Code128,
    annotation: 'New',
    annotationPlacement: LabelAnnotationPlacement.BelowTitle,
    stock: LABEL_STOCKS[LabelStockSize.Size67x25],
};

describe('fitTitle — the title block is a hard boundary', () => {
    // The 50 × 30 mm Takealot shape: 384 dots of width at a 26-dot font over two
    // lines, which works out at 29 characters per line.
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

describe('computeLayout — Takealot shape (EAN-13, stacked marker)', () => {
    test('50 × 25 mm prints an in-tolerance symbol', () => {
        const layout = computeLayout(takealotFormat, TAKEALOT_CODE);
        expect(layout.widthDots).toBe(400);
        expect(layout.heightDots).toBe(200);
        expect(layout.moduleDots).toBe(3);
        expect(layout.withinTolerance).toBe(true);
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
        expect(quietZoneStart).toBeGreaterThanOrEqual(8 + layout.annotationFontDots);
    });

    test('50 × 30 mm — the warehouse roll — prints an in-spec EAN-13', () => {
        const layout = computeLayout(
            { ...takealotFormat, stock: LABEL_STOCKS[LabelStockSize.Size50x30] },
            TAKEALOT_CODE
        );
        // Same 50mm width as the 25mm-tall roll, so the module width is
        // unchanged and comfortably inside GS1's 0.264mm floor.
        expect(layout.moduleDots).toBe(3);
        expect(layout.withinTolerance).toBe(true);
        // The extra 5mm of height goes to the bars, not the title.
        const shorter = computeLayout(
            { ...takealotFormat, stock: LABEL_STOCKS[LabelStockSize.Size50x25] },
            TAKEALOT_CODE
        );
        expect(layout.barHeightDots).toBeGreaterThan(shorter.barHeightDots);
        expect(layout.titleLines).toBe(2);
    });

    test('keeps two title lines when the annotation is beside the barcode', () => {
        expect(computeLayout(takealotFormat, TAKEALOT_CODE).titleLines).toBe(2);
    });
});

describe('computeLayout — Amazon shape (Code 128, condition below title)', () => {
    test("2⅝\" × 1\" stock prints an in-tolerance FNSKU symbol", () => {
        const layout = computeLayout(amazonFormat, FNSKU);
        expect(layout.withinTolerance).toBe(true);
        // 165 modules × 3 dots = 495, which fits the 533-dot width.
        expect(layout.moduleDots).toBe(3);
    });

    test('drops the title to one line to make room for the condition', () => {
        const layout = computeLayout(amazonFormat, FNSKU);
        expect(layout.titleLines).toBe(1);
        // The condition sits between the title and the barcode.
        expect(layout.annotationYDots).toBeGreaterThan(8);
        expect(layout.barcodeYDots).toBeGreaterThan(layout.annotationYDots);
    });

    test('clears Amazon’s 6.35mm minimum barcode height', () => {
        const layout = computeLayout(amazonFormat, FNSKU);
        expect(layout.barHeightDots).toBeGreaterThan(mmToDots(6.35, 203));
    });

    test('a longer code narrows the module rather than overflowing', () => {
        const short = computeLayout(amazonFormat, 'X001AB');
        const long = computeLayout(amazonFormat, 'A'.repeat(40));
        expect(long.moduleDots).toBeLessThan(short.moduleDots);
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

    test.each(cases)('%s fits vertically below the title', (_name, format, code) => {
        const layout = computeLayout(format, code);
        expect(layout.barcodeYDots).toBeGreaterThan(layout.titleFontDots);
        const bottom = layout.barcodeYDots + layout.barHeightDots + layout.annotationFontDots;
        expect(bottom).toBeLessThanOrEqual(layout.heightDots);
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
        expect(zpl).toContain(`^LL${mmToDots(25, 203)}`);
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

    test('runs the title full width from the left margin, past a stacked annotation', () => {
        const zpl = buildLabelZpl(
            { code: TAKEALOT_CODE, title: 'National Geographic Metal Detector Starter Kit', quantity: 1 },
            takealotFormat
        );
        const width = mmToDots(50, 203);
        // Title and the stacked "MP" share the same left edge: the annotation is
        // below the title, not beside it, so indenting the title would drop
        // characters off a long product name for no reason. (The y differs — the
        // top margin is larger than the sides; see the leading-edge test.)
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

    test('stacks the annotation one character per line when placed left', () => {
        const zpl = buildLabelZpl({ code: TAKEALOT_CODE, title: 'W', quantity: 1 }, takealotFormat);
        expect(zpl).toContain('^FDM^FS');
        expect(zpl).toContain('^FDP^FS');
        expect(zpl).not.toContain('^FDMP^FS');
    });

    test('prints the annotation as one line when placed below the title', () => {
        const zpl = buildLabelZpl({ code: FNSKU, title: 'W', quantity: 1 }, amazonFormat);
        // Amazon requires the item condition on every unit label.
        expect(zpl).toContain('^FDNew^FS');
        expect(zpl).not.toContain('^FDN^FS');
    });

    test('omits the annotation entirely when the channel has none', () => {
        const zpl = buildLabelZpl(
            { code: FNSKU, title: 'Widget', quantity: 1 },
            { ...amazonFormat, annotation: null }
        );
        expect(zpl).toContain('^FDWidget^FS');
        expect(zpl).not.toContain('^FDNew^FS');
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
