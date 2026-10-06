// The team task list: who may touch it, where a new task lands, what moving a
// task between statuses can and cannot change, and how the list filters and sorts.

import { actions, models, resetDatabase } from '@teamkeel/testing';
import { Team, TeamTaskStatus } from '@teamkeel/sdk';
import { beforeEach, describe, expect, test } from 'vitest';

// Roles come from team membership, which lives on User rather than Identity, so
// an operator is a User in the Warehouse team plus an Identity pointing at it.
// Anyone can be a person to assign work to, so this returns the user too.
let personSeq = 0;

async function person(opts: { operator: boolean }) {
    const email = `person-${++personSeq}@tradeworks.test`;
    const user = await models.user.create({
        email,
        firstName: `First${personSeq}`,
        teams: opts.operator ? [Team.Warehouse] : [],
    });
    const identity = await models.identity.create({ email, userId: user.id });
    return { user, identity };
}

describe('team tasks', () => {
    beforeEach(resetDatabase);

    describe('permissions', () => {
        test('an operator can create, read, update and delete a task', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);

            const created = await authed.createTeamTask({ title: 'Count the pallets' });
            expect((await authed.getTeamTask({ id: created.id }))!.title).toBe('Count the pallets');
            expect((await authed.listTeamTasks({})).results).toHaveLength(1);

            await authed.updateTeamTask({ where: { id: created.id }, values: { title: 'Count pallets' } });
            expect((await authed.getTeamTask({ id: created.id }))!.title).toBe('Count pallets');

            await authed.deleteTeamTask({ id: created.id });
            expect((await authed.listTeamTasks({})).results).toEqual([]);
        });

        test('a signed-in user who is not an operator cannot use the task list', async () => {
            const task = await models.teamTask.create({ title: 'Reorder tape' });
            const outsider = actions.withIdentity((await person({ operator: false })).identity);

            await expect(outsider.listTeamTasks({})).toHaveAuthorizationError();
            await expect(outsider.getTeamTask({ id: task.id })).toHaveAuthorizationError();
            await expect(outsider.createTeamTask({ title: 'Sneaky' })).toHaveAuthorizationError();
            await expect(
                outsider.moveTeamTask({ where: { id: task.id }, values: { status: TeamTaskStatus.Done } })
            ).toHaveAuthorizationError();
            await expect(
                outsider.updateTeamTask({ where: { id: task.id }, values: { title: 'Renamed' } })
            ).toHaveAuthorizationError();
            await expect(
                outsider.assignTeamTask({ where: { id: task.id }, values: { assignee: null } })
            ).toHaveAuthorizationError();
            await expect(
                outsider.editTeamTaskInline({ where: { id: task.id }, values: { status: TeamTaskStatus.Done } })
            ).toHaveAuthorizationError();
            await expect(outsider.deleteTeamTask({ id: task.id })).toHaveAuthorizationError();
        });

        test('someone who is not signed in cannot use the task list', async () => {
            await expect(actions.listTeamTasks({})).toHaveAuthorizationError();
            await expect(actions.createTeamTask({ title: 'Anonymous' })).toHaveAuthorizationError();
        });
    });

    describe('a new task', () => {
        test('lands in the backlog, unassigned', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);

            const task = await authed.createTeamTask({ title: 'Label the returns shelf' });

            expect(task.status).toBe(TeamTaskStatus.Backlog);
            expect(task.assigneeId).toBeNull();
        });

        test('can be created straight into another status with someone assigned', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);
            const { user: sam } = await person({ operator: true });

            const task = await authed.createTeamTask({
                title: 'Book the courier',
                status: TeamTaskStatus.InProgress,
                assignee: { id: sam.id },
            });

            expect(task.status).toBe(TeamTaskStatus.InProgress);
            expect(task.assigneeId).toBe(sam.id);
        });
    });

    describe('moving a task', () => {
        test('can put a task into every status, including blocked and done', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);
            const task = await authed.createTeamTask({ title: 'Walk through every status' });

            for (const status of [
                TeamTaskStatus.InProgress,
                TeamTaskStatus.Blocked,
                TeamTaskStatus.InProgress,
                TeamTaskStatus.Done,
                TeamTaskStatus.Backlog,
            ]) {
                const moved = await authed.moveTeamTask({ where: { id: task.id }, values: { status } });
                expect(moved.status).toBe(status);
            }
        });

        test('changes the status and nothing else', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);
            const { user: sam } = await person({ operator: true });
            const task = await authed.createTeamTask({
                title: 'Unpack the Takealot delivery',
                description: 'Check against the packing list',
                assignee: { id: sam.id },
            });

            await authed.moveTeamTask({ where: { id: task.id }, values: { status: TeamTaskStatus.Blocked } });

            const stored = await models.teamTask.findOne({ id: task.id });
            expect(stored!.status).toBe(TeamTaskStatus.Blocked);
            expect(stored!.title).toBe('Unpack the Takealot delivery');
            expect(stored!.description).toBe('Check against the packing list');
            expect(stored!.assigneeId).toBe(sam.id);
        });
    });

    describe('editing a task', () => {
        test('changes the title and description and nothing else', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);
            const { user: sam } = await person({ operator: true });
            const task = await authed.createTeamTask({
                title: 'Chase the courier',
                description: 'Ask for a delivery slot',
                status: TeamTaskStatus.Blocked,
                assignee: { id: sam.id },
            });

            await authed.updateTeamTask({
                where: { id: task.id },
                values: { title: 'Chase DHL', description: 'Ask for a Friday slot' },
            });

            const stored = await models.teamTask.findOne({ id: task.id });
            expect(stored!.title).toBe('Chase DHL');
            expect(stored!.description).toBe('Ask for a Friday slot');
            expect(stored!.status).toBe(TeamTaskStatus.Blocked);
            expect(stored!.assigneeId).toBe(sam.id);
        });
    });

    // The grid edits through this one action, a cell at a time, so each field must
    // be changeable on its own without disturbing the rest.
    describe('editing in the grid', () => {
        test('changes one cell at a time and leaves the rest of the row alone', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);
            const { user: sam } = await person({ operator: true });
            const { user: alex } = await person({ operator: true });
            const task = await authed.createTeamTask({
                title: 'Book the courier',
                description: 'Friday slot',
                status: TeamTaskStatus.InProgress,
                assignee: { id: sam.id },
            });

            await authed.editTeamTaskInline({ where: { id: task.id }, values: { status: TeamTaskStatus.Blocked } });
            let stored = await models.teamTask.findOne({ id: task.id });
            expect([stored!.status, stored!.assigneeId, stored!.title, stored!.description]).toEqual([
                TeamTaskStatus.Blocked,
                sam.id,
                'Book the courier',
                'Friday slot',
            ]);

            await authed.editTeamTaskInline({ where: { id: task.id }, values: { assignee: { id: alex.id } } });
            stored = await models.teamTask.findOne({ id: task.id });
            expect([stored!.status, stored!.assigneeId, stored!.title]).toEqual([
                TeamTaskStatus.Blocked,
                alex.id,
                'Book the courier',
            ]);

            await authed.editTeamTaskInline({ where: { id: task.id }, values: { title: 'Book DHL' } });
            stored = await models.teamTask.findOne({ id: task.id });
            expect([stored!.status, stored!.assigneeId, stored!.title]).toEqual([
                TeamTaskStatus.Blocked,
                alex.id,
                'Book DHL',
            ]);
        });

        test('can clear the assignee', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);
            const { user: sam } = await person({ operator: true });
            const task = await authed.createTeamTask({ title: 'Drop it', assignee: { id: sam.id } });

            await authed.editTeamTaskInline({ where: { id: task.id }, values: { assignee: null } });

            expect((await models.teamTask.findOne({ id: task.id }))!.assigneeId).toBeNull();
        });
    });

    describe('assignment', () => {
        test('assigning changes the assignee and nothing else', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);
            const { user: sam } = await person({ operator: true });
            const task = await authed.createTeamTask({
                title: 'Chase the courier',
                description: 'Ask for a delivery slot',
                status: TeamTaskStatus.InProgress,
            });

            await authed.assignTeamTask({ where: { id: task.id }, values: { assignee: { id: sam.id } } });

            const stored = await models.teamTask.findOne({ id: task.id });
            expect(stored!.assigneeId).toBe(sam.id);
            expect(stored!.title).toBe('Chase the courier');
            expect(stored!.description).toBe('Ask for a delivery slot');
            expect(stored!.status).toBe(TeamTaskStatus.InProgress);
        });

        test('a task can be reassigned and then unassigned', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);
            const { user: sam } = await person({ operator: true });
            const { user: alex } = await person({ operator: true });
            const task = await authed.createTeamTask({ title: 'Pass the baton', assignee: { id: sam.id } });

            await authed.assignTeamTask({ where: { id: task.id }, values: { assignee: { id: alex.id } } });
            expect((await models.teamTask.findOne({ id: task.id }))!.assigneeId).toBe(alex.id);

            await authed.assignTeamTask({ where: { id: task.id }, values: { assignee: null } });
            expect((await models.teamTask.findOne({ id: task.id }))!.assigneeId).toBeNull();
        });

        test('the list can be narrowed to one person', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);
            const { user: sam } = await person({ operator: true });
            const { user: alex } = await person({ operator: true });
            await models.teamTask.create({ title: 'Sams first', assigneeId: sam.id });
            await models.teamTask.create({ title: 'Alexs', assigneeId: alex.id });
            await models.teamTask.create({ title: 'Sams second', assigneeId: sam.id });
            await models.teamTask.create({ title: 'Nobodys' });

            const mine = await authed.listTeamTasks({ where: { assignee: { id: { equals: sam.id } } } });

            expect(mine.results.map((t) => t.title)).toEqual(['Sams first', 'Sams second']);
        });
    });

    describe('the task list', () => {
        test('a status filter narrows the list to one status, oldest task first', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);
            await models.teamTask.create({ title: 'Blocked one', status: TeamTaskStatus.Blocked });
            await models.teamTask.create({ title: 'In flight', status: TeamTaskStatus.InProgress });
            await models.teamTask.create({ title: 'Blocked two', status: TeamTaskStatus.Blocked });

            const blocked = await authed.listTeamTasks({
                where: { status: { equals: TeamTaskStatus.Blocked } },
            });

            expect(blocked.results.map((t) => t.title)).toEqual(['Blocked one', 'Blocked two']);
        });

        test('can be searched by title', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);
            await models.teamTask.create({ title: 'Reprint the barcode labels' });
            await models.teamTask.create({ title: 'Chase the courier invoice' });

            const found = await authed.listTeamTasks({ search: 'barcode' });

            expect(found.results.map((t) => t.title)).toEqual(['Reprint the barcode labels']);
        });

        test('can be sorted by status, in either direction', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);
            // Created out of any order, so the creation-date default can't pass by luck.
            await models.teamTask.create({ title: 'c', status: TeamTaskStatus.Blocked });
            await models.teamTask.create({ title: 'a', status: TeamTaskStatus.Done });
            await models.teamTask.create({ title: 'e', status: TeamTaskStatus.Backlog });
            await models.teamTask.create({ title: 'd', status: TeamTaskStatus.InProgress });

            const asc = await authed.listTeamTasks({ orderBy: [{ status: 'asc' }] });
            const desc = await authed.listTeamTasks({ orderBy: [{ status: 'desc' }] });

            // Enums are stored as text, so this is the status name's order (which
            // groups tasks by status) and not the workflow's: Done comes before
            // InProgress. A workflow order would need its own numeric column.
            expect(asc.results.map((t) => t.status)).toEqual([
                TeamTaskStatus.Backlog,
                TeamTaskStatus.Blocked,
                TeamTaskStatus.Done,
                TeamTaskStatus.InProgress,
            ]);
            expect(desc.results.map((t) => t.status)).toEqual(asc.results.map((t) => t.status).reverse());
        });
    });
});
