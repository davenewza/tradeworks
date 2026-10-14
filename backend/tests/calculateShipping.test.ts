// Wiring for the CalculateShipping flow: the shipment page, what a shipment
// that cannot be quoted shows, and going back to change it with everything
// still filled in. Runs stop short of ShipLogic, which keel test cannot
// reach; the quote itself is covered in lib/deliveryQuote.test.ts with the
// courier stubbed, and the page wording in lib/shippingCalculator.test.ts.

import { flows, models, resetDatabase } from '@teamkeel/testing';
import { BoxType, Team } from '@teamkeel/sdk';
import { beforeEach, describe, expect, test } from 'vitest';

const FLOW_TIMEOUT = 30000;

// Roles come from team membership on User, so an operator is a User in the
// Warehouse team plus an Identity pointing at it.
let seq = 0;
async function operator() {
    const email = `shipper-${++seq}@tradeworks.test`;
    const user = await models.user.create({ email, teams: [Team.Warehouse] });
    return await models.identity.create({ email, userId: user.id });
}

type Executor = ReturnType<typeof flows.calculateShipping.withIdentity>;

async function pendingPage(authed: Executor, runId: string) {
    const run = await authed.untilAwaitingInput(runId, FLOW_TIMEOUT);
    const step = run.steps.find((s) => s.type === 'UI' && s.status === 'PENDING')!;
    return { run, step, ui: step.ui as any };
}

function element(ui: any, type: string, name?: string): any {
    return (ui.content as any[]).find((el) => el.__type === type && (name === undefined || el.name === name));
}

const ADDRESS = {
    organisation: 'Acme (Pty) Ltd',
    addressLine1: '1 Main Rd',
    addressLine2: '',
    suburb: 'Claremont',
    city: 'Cape Town',
    province: 'Western Cape',
    postalCode: '7708',
};

describe('CalculateShipping', () => {
    beforeEach(resetDatabase);

    test('a product without a weight is listed, and the shipment comes back filled in to change', async () => {
        const brand = await models.brand.create({ name: 'Acme' });
        await models.product.create({
            name: 'Unweighed widget', sku: 'UW-1', brandId: brand.id,
            lengthInCm: 10, widthInCm: 10, heightInCm: 10,
        });
        const authed = flows.calculateShipping.withIdentity(await operator());

        let run = await authed.start({});

        // The shipment page opens with one blank row, packing in cardboard.
        let page = await pendingPage(authed, run.id);
        expect(page.step.name).toBe('shipment-0');
        expect(element(page.ui, 'ui.input.dataGrid', 'lines').data).toEqual([{ sku: null, quantity: 1 }]);
        expect(element(page.ui, 'ui.select.one', 'boxType').defaultValue).toBe(BoxType.Cardboard);
        expect(element(page.ui, 'ui.input.text', 'addressLine1').optional).toBe(true);

        run = await authed.putStepValues(
            run.id,
            page.step.id,
            { lines: [{ sku: 'UW-1', quantity: 2 }], boxType: BoxType.PlasticEquipment, ...ADDRESS },
            'calculate',
        );

        page = await pendingPage(authed, run.id);
        expect(page.step.name).toBe('rates-0');
        expect(page.ui.title).toBe('This shipment cannot be quoted yet');
        expect(element(page.ui, 'ui.display.markdown').content).toBe(
            '- SKU "UW-1": product is missing a weight (weightInGrams must be greater than 0)',
        );
        expect(element(page.ui, 'ui.display.table').data).toEqual([{ SKU: 'UW-1', Product: 'Unweighed widget', Qty: 2 }]);
        // Nothing to finish with — only the way back.
        expect(page.ui.actions.map((a: any) => a.value)).toEqual(['change']);

        run = await authed.putStepValues(run.id, page.step.id, {}, 'change');

        // Back on the shipment page, everything as it was entered.
        page = await pendingPage(authed, run.id);
        expect(page.step.name).toBe('shipment-1');
        const grid = element(page.ui, 'ui.input.dataGrid', 'lines');
        expect(grid.data).toEqual([{ sku: 'UW-1', quantity: 2 }]);
        expect(grid.columns.find((c: any) => c.key === 'sku').lookup.labels).toEqual({ 'UW-1': 'UW-1 · Unweighed widget' });
        expect(element(page.ui, 'ui.select.one', 'boxType').defaultValue).toBe(BoxType.PlasticEquipment);
        expect(element(page.ui, 'ui.select.one', 'province').defaultValue).toBe('Western Cape');
        expect(element(page.ui, 'ui.input.text', 'addressLine1').defaultValue).toBe('1 Main Rd');
        expect(element(page.ui, 'ui.input.text', 'organisation').defaultValue).toBe('Acme (Pty) Ltd');
    });

    test('the product column searches active products as the operator types', async () => {
        const brand = await models.brand.create({ name: 'Acme' });
        await models.product.create({
            name: 'Widget', sku: 'W-1', brandId: brand.id,
            lengthInCm: 20, widthInCm: 10, heightInCm: 10, weightInGrams: 500,
        });
        await models.product.create({ name: 'Old widget', sku: 'W-0', brandId: brand.id, isActive: false });
        const authed = flows.calculateShipping.withIdentity(await operator());

        const run = await authed.start({});
        const page = await pendingPage(authed, run.id);

        const result = await authed.callback(run.id, page.step.id, 'lines', 'onLookup', { column: 'sku', query: 'widg' });

        expect(result.options).toEqual([{ value: 'W-1', label: 'W-1 · Widget', description: '0.5 kg · 2 L' }]);
    });

    test('no packaging for the chosen box type is reported as such, with no street address given', async () => {
        const brand = await models.brand.create({ name: 'Acme' });
        await models.product.create({
            name: 'Widget', sku: 'W-1', brandId: brand.id,
            lengthInCm: 10, widthInCm: 10, heightInCm: 10, weightInGrams: 500,
        });
        const authed = flows.calculateShipping.withIdentity(await operator());

        let run = await authed.start({});
        let page = await pendingPage(authed, run.id);
        run = await authed.putStepValues(
            run.id,
            page.step.id,
            { lines: [{ sku: 'W-1', quantity: 1 }], boxType: BoxType.Cardboard, ...ADDRESS, addressLine1: '' },
            'calculate',
        );

        // Past the shipment page: a street address is not required to quote.
        page = await pendingPage(authed, run.id);
        expect(page.step.name).toBe('rates-0');
        expect(element(page.ui, 'ui.display.markdown').content).toBe('- No Cardboard equipment boxes are configured');
    });

    test('a shipment without products or a full address is turned back on the page', async () => {
        const authed = flows.calculateShipping.withIdentity(await operator());

        let run = await authed.start({});
        const page = await pendingPage(authed, run.id);

        run = await authed.putStepValues(
            run.id,
            page.step.id,
            { lines: [{ sku: null, quantity: 1 }], boxType: BoxType.Cardboard, ...ADDRESS },
            'calculate',
        );
        let rejected = run.steps.find((s) => s.type === 'UI' && s.status === 'PENDING')!;
        expect(rejected.name).toBe('shipment-0');
        expect((rejected.ui as any).validationError).toBe('Add at least one product.');

        run = await authed.putStepValues(
            run.id,
            page.step.id,
            { lines: [{ sku: 'W-1', quantity: 1 }], boxType: BoxType.Cardboard, ...ADDRESS, suburb: '', postalCode: ' ' },
            'calculate',
        );
        rejected = run.steps.find((s) => s.type === 'UI' && s.status === 'PENDING')!;
        expect((rejected.ui as any).validationError).toBe('Enter the suburb, postal code.');
    });
});
