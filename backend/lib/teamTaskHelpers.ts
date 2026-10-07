import { TeamTaskStatus } from '@teamkeel/sdk';

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
