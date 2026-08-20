import { models, resetDatabase } from '@teamkeel/testing';
import { useDatabase } from '@teamkeel/sdk';
import { sql } from 'kysely';
import { beforeEach, describe, expect, test } from 'vitest';
import {
    buildCumulativeSeries,
    daysInMonth,
    loadDailySalesAggregates,
    monthLabelOf,
    monthStartOf,
    monthsInRange,
    rebuildMonth,
    round2,
    type DailySalesAggregate,
} from './cumulativeSalesHelpers';

const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

// "today" for the tests: mid-August, so August is the month in progress and
// July is a closed month.
const TODAY = utc('2026-08-20');

// The stored calendar days, read as text so the assertion sees exactly what
// Postgres holds rather than what the driver parses it back into.
const storedDays = async () => {
    const result = await sql<{ day: string; month: string; dayOfMonth: number }>`
        select
            to_char(date, 'YYYY-MM-DD') as day,
            to_char(month_start, 'YYYY-MM-DD') as month,
            day_of_month
        from cumulative_sales
        order by date asc
    `.execute(useDatabase());
    return result.rows;
};

const agg = (channelId: string, brandId: string, date: string, dailySales: number): DailySalesAggregate => ({
    channelId,
    brandId,
    date: utc(date),
    dailySales,
});

describe('calendar helpers', () => {
    test('monthStartOf and monthLabelOf read the date in UTC', () => {
        // 23:00 UTC on the 31st is already the next day locally east of Greenwich
        // — the label must still come from the UTC date.
        const lateOnMonthEnd = new Date('2026-08-31T23:00:00.000Z');
        expect(monthStartOf(lateOnMonthEnd).toISOString()).toBe('2026-08-01T00:00:00.000Z');
        expect(monthLabelOf(lateOnMonthEnd)).toBe('Aug 2026');
    });

    test('daysInMonth handles short months and leap years', () => {
        expect(daysInMonth(utc('2026-08-01'))).toBe(31);
        expect(daysInMonth(utc('2026-04-01'))).toBe(30);
        expect(daysInMonth(utc('2026-02-01'))).toBe(28);
        expect(daysInMonth(utc('2028-02-01'))).toBe(29); // leap year
    });

    test('monthsInRange spans year boundaries inclusively', () => {
        expect(monthsInRange(utc('2025-11-15'), utc('2026-02-03')).map((d) => d.toISOString().slice(0, 7))).toEqual([
            '2025-11',
            '2025-12',
            '2026-01',
            '2026-02',
        ]);
    });

    test('monthsInRange copes with the range given backwards', () => {
        expect(monthsInRange(utc('2026-03-01'), utc('2026-01-01')).map((d) => d.toISOString().slice(0, 7))).toEqual([
            '2026-01',
            '2026-02',
            '2026-03',
        ]);
    });

    test('monthsInRange returns the single month when both ends share it', () => {
        expect(monthsInRange(utc('2026-08-03'), utc('2026-08-29'))).toHaveLength(1);
    });
});

describe('buildCumulativeSeries', () => {
    test('accumulates across the month and carries the total over zero-sale days', () => {
        const points = buildCumulativeSeries(
            [agg('ch1', 'br1', '2026-07-01', 100), agg('ch1', 'br1', '2026-07-03', 50)],
            TODAY,
        );

        const byDay = new Map(points.map((p) => [p.dayOfMonth, p]));
        expect(byDay.get(1)!.cumulativeSales).toBe(100);
        // Nothing sold on the 2nd, but the running total holds at 100.
        expect(byDay.get(2)!.dailySales).toBe(0);
        expect(byDay.get(2)!.cumulativeSales).toBe(100);
        expect(byDay.get(3)!.cumulativeSales).toBe(150);
        // ...and stays there to the end of the closed month.
        expect(byDay.get(31)!.cumulativeSales).toBe(150);
    });

    test('resets at each month boundary rather than running on', () => {
        const points = buildCumulativeSeries(
            [agg('ch1', 'br1', '2026-06-10', 400), agg('ch1', 'br1', '2026-07-05', 30)],
            TODAY,
        );

        const july = points.filter((p) => p.monthLabel === 'Jul 2026');
        expect(july.find((p) => p.dayOfMonth === 4)!.cumulativeSales).toBe(0);
        // June's 400 must not leak into July.
        expect(july.find((p) => p.dayOfMonth === 5)!.cumulativeSales).toBe(30);
    });

    test('emits zero-filled days from day 1 before the first sale of the month', () => {
        const points = buildCumulativeSeries([agg('ch1', 'br1', '2026-07-20', 90)], TODAY);

        expect(points.filter((p) => p.dayOfMonth < 20).every((p) => p.cumulativeSales === 0)).toBe(true);
        expect(points).toHaveLength(31);
    });

    test('a closed month runs to its last day; the month in progress stops at today', () => {
        const points = buildCumulativeSeries(
            [agg('ch1', 'br1', '2026-07-02', 10), agg('ch1', 'br1', '2026-08-02', 20)],
            TODAY,
        );

        const lastDayOf = (label: string) =>
            Math.max(...points.filter((p) => p.monthLabel === label).map((p) => p.dayOfMonth));

        expect(lastDayOf('Jul 2026')).toBe(31);
        // No flatline across days that haven't happened yet.
        expect(lastDayOf('Aug 2026')).toBe(TODAY.getUTCDate());
    });

    test('a future-dated sale extends the current month past today', () => {
        const points = buildCumulativeSeries([agg('ch1', 'br1', '2026-08-28', 75)], TODAY);
        const lastDay = Math.max(...points.map((p) => p.dayOfMonth));

        expect(lastDay).toBe(28);
        expect(points.find((p) => p.dayOfMonth === 28)!.cumulativeSales).toBe(75);
    });

    test('keeps a separate running total per channel and per brand', () => {
        const points = buildCumulativeSeries(
            [
                agg('ch1', 'br1', '2026-07-01', 100),
                agg('ch2', 'br1', '2026-07-01', 200),
                agg('ch1', 'br2', '2026-07-01', 300),
            ],
            TODAY,
        );

        const day1 = points.filter((p) => p.dayOfMonth === 1);
        expect(day1).toHaveLength(3);
        expect(day1.find((p) => p.channelId === 'ch1' && p.brandId === 'br1')!.cumulativeSales).toBe(100);
        expect(day1.find((p) => p.channelId === 'ch2' && p.brandId === 'br1')!.cumulativeSales).toBe(200);
        expect(day1.find((p) => p.channelId === 'ch1' && p.brandId === 'br2')!.cumulativeSales).toBe(300);
    });

    // The invariant the whole design rests on. The chart sums cumulativeSales
    // across whichever channels and brands the filter leaves in, so that sum has
    // to equal the running total of the combined series at every single day —
    // including days where one pair sold nothing and only its carried-forward
    // total keeps it in the picture.
    test('summing series at any day equals the combined running total', () => {
        const aggregates = [
            agg('ch1', 'br1', '2026-07-02', 100),
            agg('ch1', 'br1', '2026-07-09', 40),
            agg('ch2', 'br1', '2026-07-05', 250),
            agg('ch2', 'br2', '2026-07-05', 15),
            agg('ch2', 'br2', '2026-07-28', 60),
        ];

        const points = buildCumulativeSeries(aggregates, TODAY);

        for (let day = 1; day <= 31; day++) {
            const summed = points
                .filter((p) => p.dayOfMonth === day)
                .reduce((total, p) => total + p.cumulativeSales, 0);

            const expected = aggregates
                .filter((a) => a.date.getUTCDate() <= day)
                .reduce((total, a) => total + a.dailySales, 0);

            expect(round2(summed)).toBe(expected);
        }
    });

    test('the same invariant holds for a single brand across channels', () => {
        const points = buildCumulativeSeries(
            [
                agg('ch1', 'br1', '2026-07-02', 100),
                agg('ch2', 'br1', '2026-07-20', 70),
                agg('ch1', 'br2', '2026-07-02', 999), // other brand, must not count
            ],
            TODAY,
        );

        // Day 10: ch2/br1 has sold nothing yet, ch1/br1 has sold 100.
        const brandOnDay10 = points
            .filter((p) => p.brandId === 'br1' && p.dayOfMonth === 10)
            .reduce((total, p) => total + p.cumulativeSales, 0);
        expect(brandOnDay10).toBe(100);

        // Day 25: both channels have contributed.
        const brandOnDay25 = points
            .filter((p) => p.brandId === 'br1' && p.dayOfMonth === 25)
            .reduce((total, p) => total + p.cumulativeSales, 0);
        expect(brandOnDay25).toBe(170);
    });

    test('rounds money to cents so the running total matches the daily column', () => {
        const points = buildCumulativeSeries(
            [agg('ch1', 'br1', '2026-07-01', 0.1), agg('ch1', 'br1', '2026-07-02', 0.2)],
            TODAY,
        );

        // 0.1 + 0.2 is 0.30000000000000004 in raw float arithmetic.
        expect(points.find((p) => p.dayOfMonth === 2)!.cumulativeSales).toBe(0.3);
    });

    test('returns nothing when there are no sales', () => {
        expect(buildCumulativeSeries([], TODAY)).toEqual([]);
    });
});

describe('loadDailySalesAggregates', () => {
    beforeEach(resetDatabase);

    const seed = async () => {
        const brandA = await models.brand.create({ name: 'Brand A' });
        const brandB = await models.brand.create({ name: 'Brand B' });
        const channel1 = await models.channel.create({ name: 'Channel 1' });
        const channel2 = await models.channel.create({ name: 'Channel 2' });
        const productA = await models.product.create({ name: 'PA', sku: 'CUM-A', brandId: brandA.id });
        const productB = await models.product.create({ name: 'PB', sku: 'CUM-B', brandId: brandB.id });

        return { brandA, brandB, channel1, channel2, productA, productB };
    };

    const sale = async (
        overrides: { channelId: string; productId: string; date: Date; netAmount?: number | null; price?: number },
        ref: string,
    ) => {
        return await models.sale.create({
            invoiceNumber: `INV-${ref}`,
            lineItemId: ref,
            lineKey: ref,
            channelId: overrides.channelId,
            productId: overrides.productId,
            date: overrides.date,
            quantity: 1,
            price: overrides.price ?? 0,
            netAmount: overrides.netAmount === undefined ? 100 : overrides.netAmount,
        });
    };

    test('groups by channel, brand and day, and resolves the brand via the product', async () => {
        const { brandA, brandB, channel1, channel2, productA, productB } = await seed();

        await sale({ channelId: channel1.id, productId: productA.id, date: utc('2026-07-10'), netAmount: 100 }, 'a');
        await sale({ channelId: channel1.id, productId: productA.id, date: utc('2026-07-10'), netAmount: 25 }, 'b');
        await sale({ channelId: channel2.id, productId: productA.id, date: utc('2026-07-10'), netAmount: 40 }, 'c');
        await sale({ channelId: channel1.id, productId: productB.id, date: utc('2026-07-11'), netAmount: 60 }, 'd');

        const rows = await loadDailySalesAggregates(utc('2026-07-01'), utc('2026-08-01'));

        expect(rows).toHaveLength(3);

        const find = (channelId: string, brandId: string, day: string) =>
            rows.find(
                (r) => r.channelId === channelId && r.brandId === brandId && r.date.toISOString().startsWith(day),
            );

        // Two lines on the same channel/brand/day roll into one figure.
        expect(find(channel1.id, brandA.id, '2026-07-10')!.dailySales).toBe(125);
        expect(find(channel2.id, brandA.id, '2026-07-10')!.dailySales).toBe(40);
        expect(find(channel1.id, brandB.id, '2026-07-11')!.dailySales).toBe(60);
    });

    test('falls back to totalExclVat when netAmount is null', async () => {
        const { channel1, productA } = await seed();

        // price 115 x qty 1 → total 115. Note Sale.totalExclVat is total minus
        // 15% OF THE TOTAL (115 - 17.25 = 97.75), not the VAT-exclusive base of
        // a VAT-inclusive price (115 / 1.15 = 100). That's how the Sale model has
        // always computed it and what every other revenue chart already shows, so
        // the fallback matches it rather than quietly disagreeing.
        await sale(
            { channelId: channel1.id, productId: productA.id, date: utc('2026-07-04'), netAmount: null, price: 115 },
            'e',
        );

        const rows = await loadDailySalesAggregates(utc('2026-07-01'), utc('2026-08-01'));
        expect(rows).toHaveLength(1);
        expect(rows[0].dailySales).toBeCloseTo(97.75, 6);
    });

    test('prefers netAmount over the derived total when both are present', async () => {
        const { channel1, productA } = await seed();

        // Discounted line: list price 115, but only 80 was actually realized.
        await sale(
            { channelId: channel1.id, productId: productA.id, date: utc('2026-07-04'), netAmount: 80, price: 115 },
            'f',
        );

        const rows = await loadDailySalesAggregates(utc('2026-07-01'), utc('2026-08-01'));
        expect(rows[0].dailySales).toBe(80);
    });

    test('honours the window: start inclusive, end exclusive', async () => {
        const { channel1, productA } = await seed();

        await sale({ channelId: channel1.id, productId: productA.id, date: utc('2026-06-30') }, 'f');
        await sale({ channelId: channel1.id, productId: productA.id, date: utc('2026-07-01') }, 'g');
        await sale({ channelId: channel1.id, productId: productA.id, date: utc('2026-07-31') }, 'h');
        await sale({ channelId: channel1.id, productId: productA.id, date: utc('2026-08-01') }, 'i');

        const rows = await loadDailySalesAggregates(utc('2026-07-01'), utc('2026-08-01'));
        const days = rows.map((r) => r.date.toISOString().slice(0, 10)).sort();

        expect(days).toEqual(['2026-07-01', '2026-07-31']);
    });
});

describe('rebuildMonth', () => {
    beforeEach(resetDatabase);

    const seed = async () => {
        const brand = await models.brand.create({ name: 'Brand A' });
        const channel = await models.channel.create({ name: 'Channel 1' });
        const product = await models.product.create({ name: 'PA', sku: 'CUM-A', brandId: brand.id });
        return { brand, channel, product };
    };

    const sale = async (channelId: string, productId: string, date: Date, netAmount: number, ref: string) => {
        return await models.sale.create({
            invoiceNumber: `INV-${ref}`,
            lineItemId: ref,
            lineKey: ref,
            channelId,
            productId,
            date,
            quantity: 1,
            price: 0,
            netAmount,
        });
    };

    test('writes a dense month of rows with running totals and labels', async () => {
        const { brand, channel, product } = await seed();
        await sale(channel.id, product.id, utc('2026-07-05'), 100, 'a');
        await sale(channel.id, product.id, utc('2026-07-06'), 50, 'b');

        const written = await rebuildMonth(utc('2026-07-01'), TODAY, TODAY);
        expect(written).toBe(31);

        const rows = await models.cumulativeSales.findMany({});
        expect(rows).toHaveLength(31);

        const byDay = new Map(rows.map((r) => [r.dayOfMonth, r]));
        expect(Number(byDay.get(4)!.cumulativeSales)).toBe(0);
        expect(Number(byDay.get(5)!.cumulativeSales)).toBe(100);
        expect(Number(byDay.get(6)!.cumulativeSales)).toBe(150);
        expect(Number(byDay.get(31)!.cumulativeSales)).toBe(150);

        expect(byDay.get(5)!.monthLabel).toBe('Jul 2026');
        expect(byDay.get(5)!.channelId).toBe(channel.id);
        expect(byDay.get(5)!.brandId).toBe(brand.id);
        expect(byDay.get(5)!.rebuiltAt).toBeInstanceOf(Date);
    });

    // The chart reads these columns straight out of Postgres, so what matters is
    // the calendar day actually stored — not what node-postgres hands back, which
    // it parses at LOCAL midnight and so reports shifted on any non-UTC host.
    test('stores the exact calendar day, unshifted by the host timezone', async () => {
        const { channel, product } = await seed();
        await sale(channel.id, product.id, utc('2026-07-05'), 100, 'a');

        await rebuildMonth(utc('2026-07-01'), TODAY, TODAY);

        const stored = await storedDays();

        // Every row sits in July, first row on the 1st and last on the 31st.
        expect(stored).toHaveLength(31);
        expect(stored[0]).toEqual({ day: '2026-07-01', month: '2026-07-01', dayOfMonth: 1 });
        expect(stored[30]).toEqual({ day: '2026-07-31', month: '2026-07-01', dayOfMonth: 31 });
        expect(stored.every((r) => r.month === '2026-07-01')).toBe(true);
        // dayOfMonth and the stored date never disagree.
        expect(stored.every((r) => Number(r.day.slice(8, 10)) === r.dayOfMonth)).toBe(true);
    });

    test('is idempotent — re-running replaces rather than duplicating', async () => {
        const { channel, product } = await seed();
        await sale(channel.id, product.id, utc('2026-07-05'), 100, 'a');

        await rebuildMonth(utc('2026-07-01'), TODAY, TODAY);
        await rebuildMonth(utc('2026-07-01'), TODAY, TODAY);

        const rows = await models.cumulativeSales.findMany({});
        expect(rows).toHaveLength(31);
    });

    test('picks up revised sales and drops rows for a month emptied out', async () => {
        const { channel, product } = await seed();
        const first = await sale(channel.id, product.id, utc('2026-07-05'), 100, 'a');

        await rebuildMonth(utc('2026-07-01'), TODAY, TODAY);

        // The invoice is corrected downwards in Zoho and re-synced.
        await models.sale.update({ id: first.id }, { netAmount: 20 });
        await rebuildMonth(utc('2026-07-01'), TODAY, TODAY);

        const revised = await models.cumulativeSales.findMany({});
        expect(Number(revised.find((r) => r.dayOfMonth === 31)!.cumulativeSales)).toBe(20);

        // The sale is voided and removed; the month must be cleared, not stale.
        await models.sale.delete({ id: first.id });
        const written = await rebuildMonth(utc('2026-07-01'), TODAY, TODAY);

        expect(written).toBe(0);
        expect(await models.cumulativeSales.findMany({})).toHaveLength(0);
    });

    test('rebuilding one month leaves other months untouched', async () => {
        const { channel, product } = await seed();
        await sale(channel.id, product.id, utc('2026-06-10'), 400, 'a');
        await sale(channel.id, product.id, utc('2026-07-05'), 100, 'b');

        await rebuildMonth(utc('2026-06-01'), TODAY, TODAY);
        await rebuildMonth(utc('2026-07-01'), TODAY, TODAY);

        const rows = await models.cumulativeSales.findMany({});
        expect(rows.filter((r) => r.monthLabel === 'Jun 2026')).toHaveLength(30);
        expect(rows.filter((r) => r.monthLabel === 'Jul 2026')).toHaveLength(31);
    });

    test('the month in progress stops at today', async () => {
        const { channel, product } = await seed();
        await sale(channel.id, product.id, utc('2026-08-03'), 100, 'a');

        const written = await rebuildMonth(utc('2026-08-01'), TODAY, TODAY);
        expect(written).toBe(TODAY.getUTCDate());
    });
});
