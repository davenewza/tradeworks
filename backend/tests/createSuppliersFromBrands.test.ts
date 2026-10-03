// Wiring for the CreateSuppliersFromBrands flow: the brands waiting for a
// supplier are offered, and only the ticked ones are acted on. The rules
// themselves are covered in lib/supplierHelpers.test.ts.

import { flows, models, resetDatabase } from '@teamkeel/testing';
import { Team } from '@teamkeel/sdk';
import { beforeEach, describe, expect, test } from 'vitest';

const FLOW_TIMEOUT = 30000;

async function operator() {
    const email = 'ops@tradeworks.test';
    const user = await models.user.create({ email, teams: [Team.Warehouse] });
    return await models.identity.create({ email, userId: user.id });
}

describe('CreateSuppliersFromBrands', () => {
    beforeEach(resetDatabase);

    test('offers the brands with unassigned products and creates suppliers for the ticked ones', async () => {
        const acme = await models.brand.create({ name: 'Acme', leadTimeInDays: 45 });
        const bolt = await models.brand.create({ name: 'Bolt' });
        const widget = await models.product.create({ name: 'Widget', sku: 'W', brandId: acme.id });
        const drill = await models.product.create({ name: 'Drill', sku: 'D', brandId: bolt.id });
        const authed = flows.createSuppliersFromBrands.withIdentity(await operator());

        let run = await authed.start({});
        run = await authed.untilAwaitingInput(run.id, FLOW_TIMEOUT);
        const step = run.steps.find((s) => s.type === 'UI' && s.status === 'PENDING')!;
        expect(step.name).toBe('pick');
        const table = ((step.ui as any).content as any[]).find((el) => el.__type === 'ui.select.table');
        expect(table.data.map((r: any) => r.brand)).toEqual(['Acme', 'Bolt']);

        run = await authed.putStepValues(run.id, step.id, { brands: [table.data[0]] }, 'apply');
        run = await authed.untilFinished(run.id, FLOW_TIMEOUT);
        expect(run.status).toBe('COMPLETED');
        const done = run.steps.find((s) => s.type === 'COMPLETE')!;
        expect((done.ui as any).description).toMatch(/^1 supplier\(s\) created, 1 product\(s\) assigned\./);

        const supplier = await models.supplier.findOne({ name: 'Acme' });
        expect(supplier!.leadTimeInDays).toBe(45);
        expect((await models.product.findOne({ id: widget.id }))!.supplierId).toBe(supplier!.id);
        expect((await models.product.findOne({ id: drill.id }))!.supplierId).toBeNull();
    });

    test('completes straight away when every product has a supplier', async () => {
        const authed = flows.createSuppliersFromBrands.withIdentity(await operator());
        const run = await authed.untilFinished((await authed.start({})).id, FLOW_TIMEOUT);
        expect((run.steps.find((s) => s.type === 'COMPLETE')!.ui as any).title).toBe('Every product has a supplier');
    });
});
