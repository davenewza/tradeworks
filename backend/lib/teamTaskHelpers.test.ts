import { TeamTaskStatus } from '@teamkeel/sdk';
import { describe, expect, test } from 'vitest';
import { completedAtAfterMove } from './teamTaskHelpers';

const earlier = new Date('2026-10-01T09:00:00Z');
const now = new Date('2026-10-07T14:30:00Z');

describe('completedAtAfterMove', () => {
    test('a task moved into Done is complete as of now', () => {
        expect(completedAtAfterMove({ from: TeamTaskStatus.InProgress, to: TeamTaskStatus.Done, completedAt: null, now })).toBe(
            now,
        );
    });

    test('a done task saved as Done again keeps the time it was first finished', () => {
        expect(completedAtAfterMove({ from: TeamTaskStatus.Done, to: TeamTaskStatus.Done, completedAt: earlier, now })).toBe(
            earlier,
        );
    });

    test('a done task moved back out of Done is no longer complete', () => {
        for (const to of [TeamTaskStatus.Backlog, TeamTaskStatus.InProgress, TeamTaskStatus.Waiting]) {
            expect(completedAtAfterMove({ from: TeamTaskStatus.Done, to, completedAt: earlier, now })).toBeNull();
        }
    });

    test('moving between unfinished statuses leaves a task incomplete', () => {
        expect(completedAtAfterMove({ from: TeamTaskStatus.Backlog, to: TeamTaskStatus.Waiting, completedAt: null, now })).toBeNull();
    });

    test('a write that does not touch the status leaves the time as it was', () => {
        expect(completedAtAfterMove({ from: TeamTaskStatus.Done, to: undefined, completedAt: earlier, now })).toBe(earlier);
        expect(completedAtAfterMove({ from: TeamTaskStatus.Backlog, to: undefined, completedAt: null, now })).toBeNull();
    });
});
