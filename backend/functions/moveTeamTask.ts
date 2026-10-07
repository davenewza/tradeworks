import { MoveTeamTask, MoveTeamTaskHooks } from '@teamkeel/sdk';
import { completedAtAfterMove } from '../lib/teamTaskHelpers';

// Changes nothing but the status, and keeps completedAt in step with it: see
// completedAtAfterMove for the rule.
const hooks: MoveTeamTaskHooks = {
    beforeWrite: async (ctx, inputs, values, task) => ({
        ...values,
        completedAt: completedAtAfterMove({
            from: task.status,
            to: values.status,
            completedAt: task.completedAt,
            now: ctx.now(),
        }),
    }),
};

export default MoveTeamTask(hooks);
