// Wiring for the PlanPurchase flow: the pages appear in order, the details feed
// the plan, the grid carries the suggestions, edits reach the report. The
// arithmetic itself is covered in lib/purchasePlanHelpers.test.ts.

import { flows, models, resetDatabase } from '@teamkeel/testing';
import { Team } from '@teamkeel/sdk';
import { beforeEach, describe, expect, test } from 'vitest';
import { formatDay } from '../lib/cumulativeSalesHelpers';

const FLOW_TIMEOUT = 30000;

// Roles come from team membership on User, so an operator is a User in the
// Warehouse team plus an Identity pointing at it.
let seq = 0;
async function operator() {
    const email = `buyer-${++seq}@tradeworks.test`;
    const user = await models.user.create({ email, teams: [Team.Warehouse] });
    return await models.identity.create({ email, userId: user.id });
}

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

// A brand with one steady seller (30/month, 100 on hand, costed) and one
// product that has never sold.
async function seedBrand() {
    const brand = await models.brand.create({ name: 'Acme', leadTimeInDays: 60 });
    const channel = await models.channel.create({ name: 'Shop' });
    const widget = await models.product.create({ name: 'Widget', sku: 'ACME-W', brandId: brand.id, stockAvailable: 100 });
    const gadget = await models.product.create({ name: 'Gadget', sku: 'ACME-G', brandId: brand.id, stockAvailable: 5 });
    // First sold years ago (12 months active), 360 in the trailing year → 30/month.
    await models.sale.create({ invoiceNumber: 'I1', lineItemId: 'L1', lineKey: 'L1', channelId: channel.id, date: daysAgo(3 * 365), productId: widget.id, quantity: 1, price: 10 });
    await models.sale.create({ invoiceNumber: 'I2', lineItemId: 'L2', lineKey: 'L2', channelId: channel.id, date: daysAgo(200), productId: widget.id, quantity: 360, price: 10 });
    const bill = await models.supplierBill.create({ billNumber: 'B-1', date: daysAgo(100) });
    await models.productCostLine.create({ productId: widget.id, supplierBillId: bill.id, unitCost: 50, quantity: 200, zohoRecordId: 'z1' });
    return { brand, widget, gadget };
}

type Executor = ReturnType<typeof flows.planPurchase.withIdentity>;

async function pendingPage(authed: Executor, runId: string) {
    const run = await authed.untilAwaitingInput(runId, FLOW_TIMEOUT);
    const step = run.steps.find((s) => s.type === 'UI' && s.status === 'PENDING')!;
    return { run, step, ui: step.ui as any };
}

function gridRows(ui: any): any[] {
    const grid = (ui.content as any[]).find((el) => el.__type === 'ui.input.dataGrid' && el.name === 'rows');
    return grid.data;
}

describe('PlanPurchase', () => {
    beforeEach(resetDatabase);

    test('from a brand page: details → suggested grid → edited quantities reach the report', async () => {
        const { brand, widget, gadget } = await seedBrand();
        const authed = flows.planPurchase.withIdentity(await operator());

        let run = await authed.start({ brandId: brand.id });

        // The brand is preset, so the first page is the order details.
        let page = await pendingPage(authed, run.id);
        expect(page.step.name).toBe('details');
        const numberDefaults = Object.fromEntries(
            (page.ui.content as any[]).filter((el) => el.__type === 'ui.input.number').map((el) => [el.name, el.defaultValue]),
        );
        expect(numberDefaults).toEqual({ leadTimeInDays: 60, targetCoverMonths: 4 });

        run = await authed.putStepValues(
            run.id,
            page.step.id,
            { purchaseDate: formatDay(new Date()), leadTimeInDays: 60, targetCoverMonths: 4 },
            'next',
        );

        // The grid: the widget needs 80 (see the helper tests), the gadget has
        // no forecast and sits at 0 below it.
        page = await pendingPage(authed, run.id);
        expect(page.step.name).toBe('review-0');
        const rows = gridRows(page.ui);
        expect(rows.map((r) => r.sku)).toEqual(['ACME-W', 'ACME-G']);
        expect(rows[0]).toMatchObject({ productId: widget.id, stock: 100, monthly: 30, suggested: 80, order: 80, value: 'R 4,000.00' });
        expect(rows[0].cover).toBe('4.0 mo · Good');
        expect(rows[1]).toMatchObject({ productId: gadget.id, suggested: 0, order: 0, cover: '' });

        // Trim the widget and add a few gadgets by hand, then recalculate.
        run = await authed.putStepValues(
            run.id,
            page.step.id,
            { rows: rows.map((r) => (r.sku === 'ACME-W' ? { ...r, order: 40 } : { ...r, order: 6 })) },
            'recalculate',
        );

        page = await pendingPage(authed, run.id);
        expect(page.step.name).toBe('review-1');
        const recalculated = gridRows(page.ui);
        expect(recalculated[0]).toMatchObject({ suggested: 80, order: 40, value: 'R 2,000.00' });
        expect(recalculated[0].cover).toBe('2.7 mo · Low');
        expect(recalculated[1]).toMatchObject({ suggested: 0, order: 6 });
        // Trimming below the target is called out as a top-up risk.
        const banners = (page.ui.content as any[]).filter((el) => el.__type === 'ui.display.banner');
        expect(banners.some((b) => /run out before/.test(b.title))).toBe(true);

        run = await authed.putStepValues(run.id, page.step.id, { rows: recalculated }, 'finish');
        run = await authed.untilFinished(run.id, FLOW_TIMEOUT);
        expect(run.status).toBe('COMPLETED');

        const done = run.steps.find((s) => s.type === 'COMPLETE')!;
        const ui = done.ui as any;
        expect(ui.title).toBe('Purchase plan — Acme');
        expect(ui.description).toMatch(/^46 unit\(s\) across 2 product\(s\)\./);
        const table = (ui.content as any[]).find((el) => el.__type === 'ui.display.table');
        expect(table.data.map((r: any) => [r.SKU, r.Order])).toEqual([
            ['ACME-W', 40],
            ['ACME-G', 6],
        ]);
    });

    test('from the space: the brand is picked first, and only brands with enabled products are offered', async () => {
        const { brand } = await seedBrand();
        await models.brand.create({ name: 'Nothing here' });
        const authed = flows.planPurchase.withIdentity(await operator());

        let run = await authed.start({});
        let page = await pendingPage(authed, run.id);
        expect(page.step.name).toBe('brand');
        const select = (page.ui.content as any[]).find((el) => el.__type === 'ui.select.one');
        expect(select.options.map((o: any) => o.value)).toEqual([brand.id]);

        run = await authed.putStepValues(run.id, page.step.id, { brandId: brand.id }, 'next');
        page = await pendingPage(authed, run.id);
        expect(page.step.name).toBe('details');
        expect(page.ui.title).toBe('Order details — Acme');
    });

    test('rejects a lead time that is not a whole number of days', async () => {
        const { brand } = await seedBrand();
        const authed = flows.planPurchase.withIdentity(await operator());

        let run = await authed.start({ brandId: brand.id });
        const page = await pendingPage(authed, run.id);
        run = await authed.putStepValues(
            run.id,
            page.step.id,
            { purchaseDate: formatDay(new Date()), leadTimeInDays: 0, targetCoverMonths: 4 },
            'next',
        );

        // The rejection rides on the response to the submission itself — a
        // re-fetched run renders the page afresh, without it.
        const rejected = run.steps.find((s) => s.type === 'UI' && s.status === 'PENDING')!;
        expect(rejected.name).toBe('details');
        expect((rejected.ui as any).validationError).toBe('Lead time must be a whole number of days, 1 or more.');

        // And the run is still waiting on the same page.
        const again = await pendingPage(authed, run.id);
        expect(again.step.name).toBe('details');
    });

    test('a brand with no enabled products completes straight away with nothing to plan', async () => {
        const brand = await models.brand.create({ name: 'Bare' });
        await models.product.create({ name: 'Off', sku: 'OFF', brandId: brand.id, isEnabled: false });
        const authed = flows.planPurchase.withIdentity(await operator());

        const run = await authed.start({ brandId: brand.id });
        const finished = await authed.untilFinished(run.id, FLOW_TIMEOUT);
        expect(finished.status).toBe('COMPLETED');
        const done = finished.steps.find((s) => s.type === 'COMPLETE')!;
        expect((done.ui as any).title).toBe('Nothing to plan for this brand');
    });
});
