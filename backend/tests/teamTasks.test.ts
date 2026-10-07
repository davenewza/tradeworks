// The team task list: who may touch it, where a new task lands, what moving a
// task between statuses can and cannot change, and how the list filters and sorts.

import { actions, flows, models, resetDatabase } from '@teamkeel/testing';
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

const FLOW_TIMEOUT = 30_000;

// Timestamps set by the runtime are compared loosely against the test's clock.
const within = (a: Date | null, ms: number, of: number = Date.now()) =>
    a !== null && Math.abs(a.getTime() - of) < ms;

// A Date column holds a calendar day, and the two ways in treat a JS Date
// differently: an action's JSON input takes its UTC date, while a write through
// models takes local midnight. So actions get UTC midnight, models get local
// midnight, and reads go by local parts. These tests then hold in any timezone.
const apiDay = (iso: string) => new Date(iso);
const dbDay = (iso: string) => new Date(`${iso}T00:00:00`);
const dayOf = (d: Date | null) =>
    d === null
        ? null
        : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

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

        test('lands in the backlog whoever it is for and whenever it is due', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);
            const { user: sam } = await person({ operator: true });

            const task = await authed.createTeamTask({
                title: 'Book the courier',
                targetDate: apiDay('2026-10-31'),
                assignee: { id: sam.id },
            });

            expect(task.status).toBe(TeamTaskStatus.Backlog);
            expect(task.assigneeId).toBe(sam.id);
            expect(dayOf((await models.teamTask.findOne({ id: task.id }))!.targetDate)).toBe('2026-10-31');
        });

        test('has no target date unless one is given', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);

            const task = await authed.createTeamTask({ title: 'Whenever' });

            expect(task.targetDate).toBeNull();
        });

        test('records who wrote it down', async () => {
            const author = await person({ operator: true });
            const authed = actions.withIdentity(author.identity);

            const task = await authed.createTeamTask({ title: 'Count the pallets' });

            expect(task.createdById).toBe(author.user.id);
            expect((await models.teamTask.findOne({ id: task.id }))!.createdById).toBe(author.user.id);
        });

        test('is not complete', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);

            const task = await authed.createTeamTask({ title: 'Not yet' });

            expect(task.completedAt).toBeNull();
        });

        test('cannot be created in any other status', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);

            // The create action does not take a status, so asking for one is not
            // honoured: whatever the API does with the extra field, the task starts
            // in the backlog.
            const created = await authed
                .createTeamTask({ title: 'Sneak straight to done', status: TeamTaskStatus.Done } as never)
                .catch(() => null);

            const stored = await models.teamTask.findMany({ where: { title: { equals: 'Sneak straight to done' } } });
            for (const task of stored) expect(task.status).toBe(TeamTaskStatus.Backlog);
            if (created) expect(created.status).toBe(TeamTaskStatus.Backlog);
        });
    });

    describe('moving a task', () => {
        test('can put a task into every status, including waiting and done', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);
            const task = await authed.createTeamTask({ title: 'Walk through every status' });

            for (const status of [
                TeamTaskStatus.InProgress,
                TeamTaskStatus.Waiting,
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

            await authed.moveTeamTask({ where: { id: task.id }, values: { status: TeamTaskStatus.Waiting } });

            const stored = await models.teamTask.findOne({ id: task.id });
            expect(stored!.status).toBe(TeamTaskStatus.Waiting);
            expect(stored!.title).toBe('Unpack the Takealot delivery');
            expect(stored!.description).toBe('Check against the packing list');
            expect(stored!.assigneeId).toBe(sam.id);
        });
    });

    // completedAt is the moment a task went into Done, whichever action moved it
    // there, and it goes again when the task comes back out.
    describe('completing a task', () => {
        test('moving a task to Done records when', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);
            const task = await authed.createTeamTask({ title: 'Count the pallets' });

            const moved = await authed.moveTeamTask({ where: { id: task.id }, values: { status: TeamTaskStatus.Done } });

            expect(within(moved.completedAt, 5_000)).toBe(true);
            const stored = await models.teamTask.findOne({ id: task.id });
            expect(stored!.status).toBe(TeamTaskStatus.Done);
            expect(stored!.completedAt?.getTime()).toBe(moved.completedAt!.getTime());
        });

        test('the grid can complete a task too', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);
            const task = await authed.createTeamTask({ title: 'Count the pallets' });

            const edited = await authed.editTeamTaskInline({ where: { id: task.id }, values: { status: TeamTaskStatus.Done } });

            expect(within(edited.completedAt, 5_000)).toBe(true);
        });

        test('moving a done task back out of Done clears the time', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);
            const task = await authed.createTeamTask({ title: 'Count the pallets' });
            await authed.moveTeamTask({ where: { id: task.id }, values: { status: TeamTaskStatus.Done } });

            const reopened = await authed.moveTeamTask({ where: { id: task.id }, values: { status: TeamTaskStatus.InProgress } });

            expect(reopened.completedAt).toBeNull();
            expect((await models.teamTask.findOne({ id: task.id }))!.completedAt).toBeNull();
        });

        test('moving a done task to Done again keeps the time it was first finished', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);
            const task = await authed.createTeamTask({ title: 'Count the pallets' });
            const first = await authed.moveTeamTask({ where: { id: task.id }, values: { status: TeamTaskStatus.Done } });
            await new Promise((r) => setTimeout(r, 20));

            const again = await authed.moveTeamTask({ where: { id: task.id }, values: { status: TeamTaskStatus.Done } });

            expect(again.completedAt!.getTime()).toBe(first.completedAt!.getTime());
        });

        test('editing a done task without touching its status keeps the time', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);
            const { user: sam } = await person({ operator: true });
            const task = await authed.createTeamTask({ title: 'Count the pallets' });
            const done = await authed.moveTeamTask({ where: { id: task.id }, values: { status: TeamTaskStatus.Done } });
            await new Promise((r) => setTimeout(r, 20));

            await authed.updateTeamTask({ where: { id: task.id }, values: { title: 'Count pallets' } });
            await authed.assignTeamTask({ where: { id: task.id }, values: { assignee: { id: sam.id } } });
            await authed.editTeamTaskInline({ where: { id: task.id }, values: { targetDate: '2026-11-15' as never } });

            const stored = await models.teamTask.findOne({ id: task.id });
            expect(stored!.status).toBe(TeamTaskStatus.Done);
            expect(stored!.completedAt?.getTime()).toBe(done.completedAt!.getTime());
        });

        test('moving between unfinished statuses leaves a task incomplete', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);
            const task = await authed.createTeamTask({ title: 'Count the pallets' });

            await authed.moveTeamTask({ where: { id: task.id }, values: { status: TeamTaskStatus.InProgress } });
            await authed.editTeamTaskInline({ where: { id: task.id }, values: { status: TeamTaskStatus.Waiting } });

            expect((await models.teamTask.findOne({ id: task.id }))!.completedAt).toBeNull();
        });
    });

    describe('editing a task', () => {
        test('changes the title and description and nothing else', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);
            const { user: sam } = await person({ operator: true });
            const task = await models.teamTask.create({
                title: 'Chase the courier',
                description: 'Ask for a delivery slot',
                status: TeamTaskStatus.Waiting,
                assigneeId: sam.id,
                targetDate: dbDay('2026-10-31'),
            });

            await authed.updateTeamTask({
                where: { id: task.id },
                values: { title: 'Chase DHL', description: 'Ask for a Friday slot' },
            });

            const stored = await models.teamTask.findOne({ id: task.id });
            expect(stored!.title).toBe('Chase DHL');
            expect(stored!.description).toBe('Ask for a Friday slot');
            expect(stored!.status).toBe(TeamTaskStatus.Waiting);
            expect(stored!.assigneeId).toBe(sam.id);
            expect(dayOf(stored!.targetDate)).toBe('2026-10-31');
        });

        test('whoever edits, moves or reassigns a task, its creator stays the same', async () => {
            const author = await person({ operator: true });
            const editor = await person({ operator: true });
            const task = await actions.withIdentity(author.identity).createTeamTask({ title: 'Chase the courier' });
            const asEditor = actions.withIdentity(editor.identity);

            await asEditor.updateTeamTask({ where: { id: task.id }, values: { title: 'Chase DHL' } });
            await asEditor.moveTeamTask({ where: { id: task.id }, values: { status: TeamTaskStatus.InProgress } });
            await asEditor.assignTeamTask({ where: { id: task.id }, values: { assignee: { id: editor.user.id } } });
            await asEditor.editTeamTaskInline({ where: { id: task.id }, values: { targetDate: '2026-11-15' as never } });

            expect((await models.teamTask.findOne({ id: task.id }))!.createdById).toBe(author.user.id);
        });
    });

    // The grid edits through this one action, a cell at a time, so each field must
    // be changeable on its own without disturbing the rest.
    describe('editing in the grid', () => {
        test('changes one cell at a time and leaves the rest of the row alone', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);
            const { user: sam } = await person({ operator: true });
            const { user: alex } = await person({ operator: true });
            const task = await models.teamTask.create({
                title: 'Book the courier',
                description: 'Friday slot',
                status: TeamTaskStatus.InProgress,
                assigneeId: sam.id,
            });

            await authed.editTeamTaskInline({ where: { id: task.id }, values: { status: TeamTaskStatus.Waiting } });
            let stored = await models.teamTask.findOne({ id: task.id });
            expect([stored!.status, stored!.assigneeId, stored!.title, stored!.description]).toEqual([
                TeamTaskStatus.Waiting,
                sam.id,
                'Book the courier',
                'Friday slot',
            ]);

            await authed.editTeamTaskInline({ where: { id: task.id }, values: { assignee: { id: alex.id } } });
            stored = await models.teamTask.findOne({ id: task.id });
            expect([stored!.status, stored!.assigneeId, stored!.title]).toEqual([
                TeamTaskStatus.Waiting,
                alex.id,
                'Book the courier',
            ]);

            await authed.editTeamTaskInline({ where: { id: task.id }, values: { title: 'Book DHL' } });
            stored = await models.teamTask.findOne({ id: task.id });
            expect([stored!.status, stored!.assigneeId, stored!.title]).toEqual([
                TeamTaskStatus.Waiting,
                alex.id,
                'Book DHL',
            ]);
        });

        // The Console's grid sends a date cell as a plain YYYY-MM-DD string, so the
        // test sends the same.
        test('sets, changes and clears the target date without touching the rest', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);
            const { user: sam } = await person({ operator: true });
            const task = await models.teamTask.create({
                title: 'Book the courier',
                status: TeamTaskStatus.Waiting,
                assigneeId: sam.id,
            });
            const rest = async () => {
                const t = await models.teamTask.findOne({ id: task.id });
                return [t!.title, t!.status, t!.assigneeId];
            };

            await authed.editTeamTaskInline({ where: { id: task.id }, values: { targetDate: '2026-11-15' as never } });
            expect(dayOf((await models.teamTask.findOne({ id: task.id }))!.targetDate)).toBe('2026-11-15');
            expect(await rest()).toEqual(['Book the courier', TeamTaskStatus.Waiting, sam.id]);

            await authed.editTeamTaskInline({ where: { id: task.id }, values: { targetDate: '2026-12-01' as never } });
            expect(dayOf((await models.teamTask.findOne({ id: task.id }))!.targetDate)).toBe('2026-12-01');

            await authed.editTeamTaskInline({ where: { id: task.id }, values: { targetDate: null } });
            expect((await models.teamTask.findOne({ id: task.id }))!.targetDate).toBeNull();
            expect(await rest()).toEqual(['Book the courier', TeamTaskStatus.Waiting, sam.id]);
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
            const task = await models.teamTask.create({
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
            await models.teamTask.create({ title: 'Waiting one', status: TeamTaskStatus.Waiting });
            await models.teamTask.create({ title: 'In flight', status: TeamTaskStatus.InProgress });
            await models.teamTask.create({ title: 'Waiting two', status: TeamTaskStatus.Waiting });

            const waiting = await authed.listTeamTasks({
                where: { status: { equals: TeamTaskStatus.Waiting } },
            });

            expect(waiting.results.map((t) => t.title)).toEqual(['Waiting one', 'Waiting two']);
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
            await models.teamTask.create({ title: 'c', status: TeamTaskStatus.Waiting });
            await models.teamTask.create({ title: 'a', status: TeamTaskStatus.Done });
            await models.teamTask.create({ title: 'e', status: TeamTaskStatus.Backlog });
            await models.teamTask.create({ title: 'd', status: TeamTaskStatus.InProgress });

            const asc = await authed.listTeamTasks({ orderBy: [{ status: 'asc' }] });
            const desc = await authed.listTeamTasks({ orderBy: [{ status: 'desc' }] });

            // Enums are stored as text, so this is the status name's order (which
            // groups tasks by status) and not the workflow's: Done comes before
            // InProgress, and Waiting last. A workflow order would need its own
            // numeric column.
            expect(asc.results.map((t) => t.status)).toEqual([
                TeamTaskStatus.Backlog,
                TeamTaskStatus.Done,
                TeamTaskStatus.InProgress,
                TeamTaskStatus.Waiting,
            ]);
            expect(desc.results.map((t) => t.status)).toEqual(asc.results.map((t) => t.status).reverse());
        });

        test('can be sorted by target date, in either direction', async () => {
            const authed = actions.withIdentity((await person({ operator: true })).identity);
            // Created out of date order, with one that has no date at all.
            await models.teamTask.create({ title: 'December', targetDate: dbDay('2026-12-01') });
            await models.teamTask.create({ title: 'Unscheduled' });
            await models.teamTask.create({ title: 'October', targetDate: dbDay('2026-10-31') });
            await models.teamTask.create({ title: 'November', targetDate: dbDay('2026-11-15') });

            const asc = await authed.listTeamTasks({ orderBy: [{ targetDate: 'asc' }] });
            const desc = await authed.listTeamTasks({ orderBy: [{ targetDate: 'desc' }] });

            const dated = (r: typeof asc) => r.results.filter((t) => t.targetDate !== null).map((t) => t.title);
            expect(dated(asc)).toEqual(['October', 'November', 'December']);
            expect(dated(desc)).toEqual(['December', 'November', 'October']);

            // The task with no date sits at one end, not in the middle of the dated ones.
            for (const result of [asc, desc]) {
                const titles = result.results.map((t) => t.title);
                expect([0, titles.length - 1]).toContain(titles.indexOf('Unscheduled'));
            }
        });
    });

    // What the Console's user pickers for a task browse and search.
    describe('the people a task can be given to', () => {
        test('are the warehouse team and nobody else', async () => {
            const caller = await person({ operator: true });
            const sam = await models.user.create({ email: 'sam@tradeworks.test', name: 'Sam Smith', teams: [Team.Warehouse] });
            const alex = await models.user.create({ email: 'alex@tradeworks.test', name: 'Alex Adams', teams: [Team.Warehouse] });
            // Not in the warehouse: a SuperAdmin on its own, and a customer with no team at all.
            await models.user.create({ email: 'boss@tradeworks.test', name: 'Bo Boss', teams: [Team.SuperAdmin] });
            await models.user.create({ email: 'customer@example.test', name: 'Cass Customer' });

            const listed = await actions.withIdentity(caller.identity).listWarehouseUsers({});

            expect(listed.results.map((u) => u.email).sort()).toEqual(
                [caller.user.email, sam.email, alex.email].sort()
            );
        });

        test('someone in several teams is included once they are in the warehouse', async () => {
            const caller = await person({ operator: true });
            const both = await models.user.create({
                email: 'both@tradeworks.test',
                name: 'Bo Both',
                teams: [Team.SuperAdmin, Team.Warehouse],
            });

            const listed = await actions.withIdentity(caller.identity).listWarehouseUsers({});

            expect(listed.results.map((u) => u.id)).toContain(both.id);
        });

        test('come back alphabetically by name', async () => {
            const caller = await person({ operator: true });
            await models.user.create({ email: 'z@tradeworks.test', name: 'Zed Zane', teams: [Team.Warehouse] });
            await models.user.create({ email: 'a@tradeworks.test', name: 'Alex Adams', teams: [Team.Warehouse] });
            await models.user.create({ email: 'b@tradeworks.test', name: 'Bea Brown', teams: [Team.Warehouse] });

            const listed = await actions.withIdentity(caller.identity).listWarehouseUsers({});

            expect(listed.results.map((u) => u.name).filter((n) => n !== null)).toEqual([
                'Alex Adams',
                'Bea Brown',
                'Zed Zane',
            ]);
        });

        test('can be searched by name, and only finds warehouse people', async () => {
            const caller = await person({ operator: true });
            await models.user.create({ email: 'bea@tradeworks.test', name: 'Bea Brown', teams: [Team.Warehouse] });
            await models.user.create({ email: 'bea.outsider@example.test', name: 'Bea Outsider' });

            const found = await actions.withIdentity(caller.identity).listWarehouseUsers({ search: 'Bea' });

            expect(found.results.map((u) => u.name)).toEqual(['Bea Brown']);
        });

        test('are only listed to someone who is signed in', async () => {
            await expect(actions.listWarehouseUsers({})).toHaveAuthorizationError();
        });
    });

    // The one-off that finishes renaming Blocked to Waiting for the tasks that
    // were written before it: the enum changed, the rows did not.
    describe('moving stored Blocked tasks to Waiting', () => {
        const completion = (run: { steps: Array<{ type: string; ui?: unknown }> }) =>
            (run.steps.find((s) => s.type === 'COMPLETE')?.ui as { title?: string } | undefined)?.title;

        test('renames the tasks still stored as Blocked and leaves every other task alone', async () => {
            const operator = await person({ operator: true });
            // The old name has left the enum, so it goes in past the types, just as
            // it sits in the table.
            const stale = await models.teamTask.create({ title: 'Old blocked', status: 'Blocked' as TeamTaskStatus });
            const waiting = await models.teamTask.create({ title: 'Already waiting', status: TeamTaskStatus.Waiting });
            const doing = await models.teamTask.create({ title: 'In flight', status: TeamTaskStatus.InProgress });
            const authed = flows.moveBlockedTasksToWaiting.withIdentity(operator.identity);

            const run = await authed.untilFinished((await authed.start({})).id, FLOW_TIMEOUT);

            expect(run.status).toBe('COMPLETED');
            expect(completion(run)).toBe('1 task(s) moved to Waiting');
            expect((await models.teamTask.findOne({ id: stale.id }))!.status).toBe(TeamTaskStatus.Waiting);
            expect((await models.teamTask.findOne({ id: waiting.id }))!.status).toBe(TeamTaskStatus.Waiting);
            expect((await models.teamTask.findOne({ id: doing.id }))!.status).toBe(TeamTaskStatus.InProgress);
        });

        test('finds nothing to do when there are none', async () => {
            const operator = await person({ operator: true });
            await models.teamTask.create({ title: 'Already waiting', status: TeamTaskStatus.Waiting });
            const authed = flows.moveBlockedTasksToWaiting.withIdentity(operator.identity);

            const run = await authed.untilFinished((await authed.start({})).id, FLOW_TIMEOUT);

            expect(run.status).toBe('COMPLETED');
            expect(completion(run)).toBe('No tasks were still Blocked');
        });

        test('is for operators only', async () => {
            const outsider = await person({ operator: false });

            await expect(flows.moveBlockedTasksToWaiting.withIdentity(outsider.identity).start({})).rejects.toThrow();
        });
    });
});

// The hub's metric tiles read this aggregate: one number per call, counting
// the signed-in person's own tasks, narrowed to a status by the tile's inputs.
describe('countMyTeamTasks', () => {
    beforeEach(resetDatabase);

    test("counts the signed-in person's tasks, and only theirs, by status", async () => {
        const me = await person({ operator: true });
        const them = await person({ operator: true });
        const task = (title: string, status: TeamTaskStatus, assigneeId: string | null) =>
            models.teamTask.create({ title, status, assigneeId });
        await task('Mine, backlog', TeamTaskStatus.Backlog, me.user.id);
        await task('Mine, backlog too', TeamTaskStatus.Backlog, me.user.id);
        await task('Mine, in progress', TeamTaskStatus.InProgress, me.user.id);
        await task('Mine, done', TeamTaskStatus.Done, me.user.id);
        await task('Theirs, backlog', TeamTaskStatus.Backlog, them.user.id);
        await task('Theirs, waiting', TeamTaskStatus.Waiting, them.user.id);
        await task("Nobody's, backlog", TeamTaskStatus.Backlog, null);

        const mine = actions.withIdentity(me.identity);
        const count = async (status?: TeamTaskStatus) => {
            const res = await mine.countMyTeamTasks({ where: status ? { status: { equals: status } } : {} });
            // No grouping: the whole answer is the total, with no group rows.
            expect(res.results).toEqual([]);
            return Number(res.totals!.tasks);
        };

        expect(await count()).toBe(4);
        expect(await count(TeamTaskStatus.Backlog)).toBe(2);
        expect(await count(TeamTaskStatus.InProgress)).toBe(1);
        expect(await count(TeamTaskStatus.Waiting)).toBe(0);
        expect(await count(TeamTaskStatus.Done)).toBe(1);
    });

    test('is zero, not an error, for someone with nothing assigned', async () => {
        await models.teamTask.create({ title: 'Reorder tape' });
        const mine = actions.withIdentity((await person({ operator: true })).identity);

        const res = await mine.countMyTeamTasks({ where: {} });
        expect(Number(res.totals!.tasks)).toBe(0);
    });

    test('is for operators only', async () => {
        await models.teamTask.create({ title: 'Reorder tape' });
        const outsider = actions.withIdentity((await person({ operator: false })).identity);

        await expect(outsider.countMyTeamTasks({ where: {} })).toHaveAuthorizationError();
        await expect(actions.countMyTeamTasks({ where: {} })).toHaveAuthorizationError();
    });
});

// Calendar days relative to today, as local midnight: what a write through
// models stores in a Date column (see dbDay above).
const localDay = (offset: number) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offset);
    return d;
};

describe('listTeamTasksMine', () => {
    beforeEach(resetDatabase);

    test("lists the signed-in person's tasks and nobody else's, narrowed by status", async () => {
        const me = await person({ operator: true });
        const them = await person({ operator: true });
        await models.teamTask.create({ title: 'Mine, backlog', assigneeId: me.user.id });
        await models.teamTask.create({ title: 'Mine, done', status: TeamTaskStatus.Done, assigneeId: me.user.id });
        await models.teamTask.create({ title: 'Theirs', assigneeId: them.user.id });
        await models.teamTask.create({ title: "Nobody's" });

        const mine = actions.withIdentity(me.identity);
        expect((await mine.listTeamTasksMine({})).results.map((t) => t.title).sort()).toEqual(['Mine, backlog', 'Mine, done']);
        expect(
            (await mine.listTeamTasksMine({ where: { status: { equals: TeamTaskStatus.Done } } })).results.map((t) => t.title)
        ).toEqual(['Mine, done']);
    });

    test('is for operators only', async () => {
        const outsider = actions.withIdentity((await person({ operator: false })).identity);
        await expect(outsider.listTeamTasksMine({})).toHaveAuthorizationError();
        await expect(actions.listTeamTasksMine({})).toHaveAuthorizationError();
    });
});

describe('overdue tasks', () => {
    beforeEach(resetDatabase);

    // Everyone's open tasks: one due the day before yesterday, one yesterday
    // (both overdue), one today, one tomorrow, one with no date, and two past
    // their day but finished or archived.
    async function seed() {
        const me = await person({ operator: true });
        const them = await person({ operator: true });
        const task = (title: string, targetDate: Date | null, extra: { status?: TeamTaskStatus; assigneeId?: string } = {}) =>
            models.teamTask.create({ title, targetDate, ...extra });
        await task('Mine, two days late', localDay(-2), { assigneeId: me.user.id });
        await task('Theirs, a day late', localDay(-1), { assigneeId: them.user.id });
        await task('Mine, due today', localDay(0), { assigneeId: me.user.id });
        await task('Mine, due tomorrow', localDay(1), { assigneeId: me.user.id });
        await task('Mine, no date', null, { assigneeId: me.user.id });
        await task('Mine, late but done', localDay(-3), { assigneeId: me.user.id, status: TeamTaskStatus.Done });
        await task('Mine, late but archived', localDay(-3), { assigneeId: me.user.id, status: TeamTaskStatus.Archived });
        await task("Nobody's, a day late", localDay(-1), { status: TeamTaskStatus.Waiting });
        return { me, them };
    }

    test('the Overdue list has every open task past its day, soonest due first', async () => {
        const { me } = await seed();
        const res = await actions.withIdentity(me.identity).listTeamTasksOverdue({});
        expect(res.results.map((t) => t.title)).toEqual(['Mine, two days late', 'Theirs, a day late', "Nobody's, a day late"]);
    });

    test('the Overdue list narrows to one person', async () => {
        const { me, them } = await seed();
        const res = await actions
            .withIdentity(me.identity)
            .listTeamTasksOverdue({ where: { assignee: { id: { equals: them.user.id } } } });
        expect(res.results.map((t) => t.title)).toEqual(['Theirs, a day late']);
    });

    test("the Mine overdue tile counts only the signed-in person's open tasks past their day", async () => {
        const { me, them } = await seed();
        const mine = await actions.withIdentity(me.identity).countMyOverdueTeamTasks({});
        expect(mine.results).toEqual([]);
        expect(Number(mine.totals!.tasks)).toBe(1);

        const theirs = await actions.withIdentity(them.identity).countMyOverdueTeamTasks({});
        expect(Number(theirs.totals!.tasks)).toBe(1);

        const nobody = await actions.withIdentity((await person({ operator: true })).identity).countMyOverdueTeamTasks({});
        expect(Number(nobody.totals!.tasks)).toBe(0);
    });

    test('both are for operators only', async () => {
        await seed();
        const outsider = actions.withIdentity((await person({ operator: false })).identity);
        await expect(outsider.listTeamTasksOverdue({})).toHaveAuthorizationError();
        await expect(outsider.countMyOverdueTeamTasks({})).toHaveAuthorizationError();
        await expect(actions.listTeamTasksOverdue({})).toHaveAuthorizationError();
        await expect(actions.countMyOverdueTeamTasks({})).toHaveAuthorizationError();
    });
});

describe('archiveTeamTask', () => {
    beforeEach(resetDatabase);

    test('archives a task in one click and keeps when it was finished', async () => {
        const authed = actions.withIdentity((await person({ operator: true })).identity);
        const finishedAt = new Date('2026-10-01T09:00:00Z');
        const done = await models.teamTask.create({ title: 'Count the pallets', status: TeamTaskStatus.Done, completedAt: finishedAt });
        const open = await models.teamTask.create({ title: 'Never happening' });

        const archivedDone = await authed.archiveTeamTask({ where: { id: done.id } });
        expect(archivedDone.status).toBe(TeamTaskStatus.Archived);
        expect(archivedDone.completedAt).toEqual(finishedAt);

        const archivedOpen = await authed.archiveTeamTask({ where: { id: open.id } });
        expect(archivedOpen.status).toBe(TeamTaskStatus.Archived);
        expect(archivedOpen.completedAt).toBeNull();

        // Gone from every list, but still on the books behind its own page.
        expect((await authed.listTeamTasks({})).results).toEqual([]);
        expect((await authed.getTeamTask({ id: done.id }))!.status).toBe(TeamTaskStatus.Archived);
    });

    test('no task list shows an archived task, even asked for by status', async () => {
        const me = await person({ operator: true });
        const archived = { status: TeamTaskStatus.Archived, assigneeId: me.user.id, targetDate: localDay(-3) };
        await models.teamTask.create({ title: 'Mine, archived', ...archived });
        await models.teamTask.create({ title: 'Mine, archived too', ...archived });
        await models.teamTask.create({ title: 'Mine, done', status: TeamTaskStatus.Done, assigneeId: me.user.id });
        await models.teamTask.create({ title: 'Mine, late', assigneeId: me.user.id, targetDate: localDay(-3) });
        const mine = actions.withIdentity(me.identity);
        const titles = (res: { results: { title: string }[] }) => res.results.map((t) => t.title);
        const onlyArchived = { where: { status: { equals: TeamTaskStatus.Archived } } };

        expect(titles(await mine.listTeamTasks({}))).toEqual(['Mine, done', 'Mine, late']);
        expect(titles(await mine.listTeamTasks(onlyArchived))).toEqual([]);
        expect(titles(await mine.listTeamTasks({ where: { assignee: { id: { equals: me.user.id } } } }))).toEqual([
            'Mine, done',
            'Mine, late',
        ]);
        expect(titles(await mine.listTeamTasks({ search: 'archived' }))).toEqual([]);

        expect(titles(await mine.listTeamTasksMine({}))).toEqual(['Mine, done', 'Mine, late']);
        expect(titles(await mine.listTeamTasksMine(onlyArchived))).toEqual([]);

        expect(titles(await mine.listTeamTasksOverdue({}))).toEqual(['Mine, late']);
    });

    test('a finished task brought back out of the archive to Done keeps its time', async () => {
        const authed = actions.withIdentity((await person({ operator: true })).identity);
        const finishedAt = new Date('2026-10-01T09:00:00Z');
        const task = await models.teamTask.create({ title: 'Count the pallets', status: TeamTaskStatus.Done, completedAt: finishedAt });

        await authed.archiveTeamTask({ where: { id: task.id } });
        const back = await authed.moveTeamTask({ where: { id: task.id }, values: { status: TeamTaskStatus.Done } });
        expect(back.completedAt).toEqual(finishedAt);
    });

    test('is for operators only', async () => {
        const task = await models.teamTask.create({ title: 'Reorder tape' });
        const outsider = actions.withIdentity((await person({ operator: false })).identity);
        await expect(outsider.archiveTeamTask({ where: { id: task.id } })).toHaveAuthorizationError();
        await expect(actions.archiveTeamTask({ where: { id: task.id } })).toHaveAuthorizationError();
    });
});
