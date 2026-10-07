import { TeamTaskStatus, useDatabase } from '@teamkeel/sdk';
import { sql } from 'kysely';

// What a task's completedAt should be after an action has set its status. It is
// the moment the task went into Done, whichever action moved it: set on the way
// in, kept while the task stays there (saving a done task as Done again, or
// editing its title, is not finishing it a second time) and cleared on the way
// out, since a task pulled back into progress is no longer complete. A write
// that does not touch the status leaves it alone, and so does archiving: that
// is housekeeping, not a change to whether the work got done, so a finished
// task keeps its time into the archive and back out of it.
export function completedAtAfterMove(args: {
    from: TeamTaskStatus;
    to: TeamTaskStatus | undefined;
    completedAt: Date | null;
    now: Date;
}): Date | null {
    const { to, completedAt, now } = args;
    if (to === undefined || to === TeamTaskStatus.Archived) return completedAt;
    if (to !== TeamTaskStatus.Done) return null;
    // Already carrying a time (saved as Done again, or brought back to Done
    // from the archive having been finished before) keeps it; otherwise the
    // task is finished now.
    return completedAt ?? now;
}

// For the MoveBlockedTasksToWaiting one-off: rewrites the stored status of every
// task still carrying a name that has left the enum. Keel keeps an enum as plain
// text, so the rows survive the rename untouched, and because the old name is
// no longer a TeamTaskStatus neither the model API nor its types will say it;
// hence a plain statement. Returns how many tasks it changed.
export async function renameStoredTaskStatus(from: string, to: TeamTaskStatus): Promise<number> {
    const result = await sql`update team_task set status = ${to}, updated_at = now() where status = ${from}`.execute(
        useDatabase(),
    );
    return Number(result.numAffectedRows ?? 0);
}
