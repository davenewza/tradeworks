import { EditTeamTaskInline, EditTeamTaskInlineHooks } from '@teamkeel/sdk';
import { completedAtAfterMove } from '../lib/teamTaskHelpers';

// The grid writes one cell at a time, so the status is usually not among the
// values; completedAtAfterMove then leaves completedAt as it is. When the status
// cell is what changed, completedAt follows it, exactly as it does for the Move
// button.
const hooks: EditTeamTaskInlineHooks = {
    beforeWrite: async (ctx, inputs, values, task) => {
        // The action takes the assignee as a nested { id }, or null to clear it;
        // what a hook returns is written as columns, so it goes back as the key.
        const { assignee, ...rest } = values;
        return {
            ...rest,
            ...(assignee !== undefined ? { assigneeId: assignee?.id ?? null } : {}),
            completedAt: completedAtAfterMove({
                from: task.status,
                to: values.status,
                completedAt: task.completedAt,
                now: ctx.now(),
            }),
        };
    },
};

export default EditTeamTaskInline(hooks);
