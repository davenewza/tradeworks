import { FlowConfig, MoveBlockedTasksToWaiting, TeamTaskStatus } from '@teamkeel/sdk';
import { renameStoredTaskStatus } from '../lib/teamTaskHelpers';

const config = {
    title: 'Move Blocked tasks to Waiting',
    description: 'One-off after the rename: tasks still stored as Blocked become Waiting',
} as const satisfies FlowConfig;

// A one-off to finish renaming the Blocked status to Waiting. The schema change
// renamed the value but not the rows already holding it, so this rewrites those
// and reports how many there were. Nothing else is touched, and a second run
// finds nothing to do.
export default MoveBlockedTasksToWaiting(config, async (ctx) => {
    const moved = await ctx.step('move', async () => await renameStoredTaskStatus('Blocked', TeamTaskStatus.Waiting));

    return ctx.complete({
        title: moved === 0 ? 'No tasks were still Blocked' : `${moved} task(s) moved to Waiting`,
        content: [],
    });
});
