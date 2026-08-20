import { useDatabase } from '@teamkeel/sdk';
import { sql } from 'kysely';

// Rows written per INSERT. Postgres caps a statement at 65535 bind parameters
// and each row binds 9 columns, so this leaves an order of magnitude of headroom.
const INSERT_CHUNK = 500;

// Series labels are built from a fixed table rather than toLocaleString: the
// label is stored and the chart legend groups on it, so it must not drift with
// the runtime's ICU data.
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// One day's realized sales for a channel/brand pair, straight off the Sale table.
export interface DailySalesAggregate {
    channelId: string;
    brandId: string;
    // UTC midnight of the calendar day.
    date: Date;
    dailySales: number;
}

// A single point on the worm — one stored CumulativeSales row.
export interface CumulativeSalesPoint {
    channelId: string;
    brandId: string;
    date: Date;
    monthStart: Date;
    monthLabel: string;
    dayOfMonth: number;
    dailySales: number;
    cumulativeSales: number;
}

// ─── Calendar helpers ───────────────────────────────────────────────────────
// All of these work in UTC. Sale.date is a calendar date with no timezone, and
// reading it with local accessors would shift the day — and therefore the point's
// position on a day-of-month axis — for anyone running west of Greenwich.

export function monthStartOf(date: Date): Date {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function monthLabelOf(date: Date): string {
    return `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

// Day 0 of the following month is the last day of this one.
export function daysInMonth(date: Date): number {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

// Every month start touched by the range, inclusive of both ends. Order is
// chronological regardless of which way round the inputs come.
export function monthsInRange(start: Date, end: Date): Date[] {
    const [from, to] = start.getTime() <= end.getTime() ? [start, end] : [end, start];
    const last = monthStartOf(to).getTime();

    const months: Date[] = [];
    let cursor = monthStartOf(from);
    while (cursor.getTime() <= last) {
        months.push(cursor);
        cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    }
    return months;
}

// Money to cents. Daily figures are rounded before they're accumulated, so the
// stored running total is exactly the sum of the daily values shown beside it.
export function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

// 'YYYY-MM-DD' in UTC, for binding against a Postgres `date` column.
export function formatDay(date: Date): string {
    return date.toISOString().slice(0, 10);
}

// ─── Building the series ────────────────────────────────────────────────────

// Expand per-day sales into the dense, per-month running totals the chart reads.
//
// One series per (channel, brand, month), each starting at zero on day 1 and
// carrying its total forward across days with no sales. Days are emitted from
// day 1 even before the pair's first sale of the month: the leading zeros cost
// almost nothing and keep one simple invariant — every series present in a month
// has a value at every day of that month — which is exactly what lets the chart
// sum across channels and brands without under-reporting.
export function buildCumulativeSeries(
    aggregates: DailySalesAggregate[],
    today: Date,
): CumulativeSalesPoint[] {
    const currentMonth = monthStartOf(today).getTime();

    const groups = new Map<
        string,
        { channelId: string; brandId: string; monthStart: Date; salesByDay: Map<number, number> }
    >();

    for (const agg of aggregates) {
        const monthStart = monthStartOf(agg.date);
        // NUL can't occur in an id, so it separates the three parts with no
        // chance of two different triples colliding on one key.
        const key = `${agg.channelId}\u0000${agg.brandId}\u0000${monthStart.toISOString()}`;

        let group = groups.get(key);
        if (!group) {
            group = { channelId: agg.channelId, brandId: agg.brandId, monthStart, salesByDay: new Map() };
            groups.set(key, group);
        }

        const day = agg.date.getUTCDate();
        group.salesByDay.set(day, (group.salesByDay.get(day) ?? 0) + agg.dailySales);
    }

    const points: CumulativeSalesPoint[] = [];

    for (const group of groups.values()) {
        // How far into the month the line runs. A closed month goes to its last
        // day; the month in progress stops at today, so the worm doesn't flatline
        // across days that haven't happened yet — that flat tail is what makes
        // the current month readable against the completed ones. Future-dated
        // sales (Zoho permits them) push the end out to the furthest one.
        const lastSaleDay = Math.max(...group.salesByDay.keys());
        const lastDay =
            group.monthStart.getTime() === currentMonth
                ? Math.max(today.getUTCDate(), lastSaleDay)
                : daysInMonth(group.monthStart);

        const monthLabel = monthLabelOf(group.monthStart);
        const year = group.monthStart.getUTCFullYear();
        const month = group.monthStart.getUTCMonth();
        let running = 0;

        for (let day = 1; day <= lastDay; day++) {
            const dailySales = round2(group.salesByDay.get(day) ?? 0);
            running = round2(running + dailySales);

            points.push({
                channelId: group.channelId,
                brandId: group.brandId,
                date: new Date(Date.UTC(year, month, day)),
                monthStart: group.monthStart,
                monthLabel,
                dayOfMonth: day,
                dailySales,
                cumulativeSales: running,
            });
        }
    }

    return points;
}

// ─── Reading and writing ────────────────────────────────────────────────────

// Per-day sales for every channel/brand pair in [from, toExclusive).
//
// Revenue is netAmount — realized, after discount, excl VAT — falling back to
// totalExclVat for rows synced before netAmount existed. The brand comes via the
// product, since Sale carries no brand of its own. No filter on invoiceStatus,
// matching every other revenue chart in the Console.
//
// Grouping isn't expressible through the generated models API, so this drops to
// Kysely per the project's DB-query convention. The date is read back as text
// and parsed as UTC: node-postgres turns a `date` column into a Date at *local*
// midnight, which would shift every point by a day on a non-UTC host.
export async function loadDailySalesAggregates(from: Date, toExclusive: Date): Promise<DailySalesAggregate[]> {
    const db = useDatabase();

    // Query the DB's snake_case columns but read camelCase result keys: Keel's
    // Kysely instance runs the CamelCasePlugin, which rewrites result columns
    // (channel_id → channelId) even for raw SQL.
    const result = await sql<{
        channelId: string;
        brandId: string;
        day: string;
        dailySales: string | number | null;
    }>`
        select
            s.channel_id,
            p.brand_id,
            to_char(s.date, 'YYYY-MM-DD') as day,
            sum(coalesce(s.net_amount, s.total_excl_vat)) as daily_sales
        from sale s
        join product p on p.id = s.product_id
        where s.date >= ${formatDay(from)}::date and s.date < ${formatDay(toExclusive)}::date
        group by s.channel_id, p.brand_id, to_char(s.date, 'YYYY-MM-DD')
    `.execute(db);

    return result.rows.map((row) => ({
        channelId: row.channelId,
        brandId: row.brandId,
        date: new Date(`${row.day}T00:00:00.000Z`),
        dailySales: Number(row.dailySales ?? 0),
    }));
}

// Rebuild one month from scratch and return how many rows it now holds.
//
// Delete-then-insert inside a transaction, rather than an upsert: a wholesale
// replace is the only thing that also clears rows whose sales have since moved
// or been removed, and the transaction keeps the month from being briefly empty
// while a chart is reading it. A month with no sales legitimately ends up with
// zero rows.
export async function rebuildMonth(monthStart: Date, today: Date, now: Date): Promise<number> {
    const nextMonth = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
    const aggregates = await loadDailySalesAggregates(monthStart, nextMonth);
    const points = buildCumulativeSeries(aggregates, today);

    const db = useDatabase();
    await db.transaction().execute(async (trx) => {
        // Table names are snake_case in Kysely's schema but column names stay
        // camelCase — the CamelCasePlugin converts only the columns.
        //
        // Both date columns are bound as 'YYYY-MM-DD' text rather than as JS
        // Dates. node-postgres renders a Date parameter in the host's LOCAL
        // timezone, so a UTC-midnight Date lands on the previous day anywhere
        // west of Greenwich — which would file every row under the wrong day,
        // and each month's first day under the wrong month entirely. Text binds
        // the calendar day literally and can't shift. The columns are typed as
        // Date, hence the cast.
        const monthStartText = formatDay(monthStart) as unknown as Date;

        await trx.deleteFrom('cumulative_sales').where('monthStart', '=', monthStartText).execute();

        for (let i = 0; i < points.length; i += INSERT_CHUNK) {
            const chunk = points.slice(i, i + INSERT_CHUNK).map((point) => ({
                ...point,
                date: formatDay(point.date) as unknown as Date,
                monthStart: monthStartText,
                rebuiltAt: now,
            }));
            await trx.insertInto('cumulative_sales').values(chunk).execute();
        }
    });

    return points.length;
}
