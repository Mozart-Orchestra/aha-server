import { describe, expect, it } from 'vitest';

import { TaskOperationError, TASK_ERROR_CODES } from './taskErrors';
import { TaskOrchestrator, type KanbanTask } from './taskOrchestrator';

describe('taskOrchestrator human status lock helpers', () => {
    const orchestrator = new TaskOrchestrator() as any;

    const makeTask = (): KanbanTask => ({
        id: 'task-1',
        title: 'Locked task',
        status: 'review',
        createdAt: 1,
        updatedAt: 1,
        comments: [],
    });

    it('blocks agent mutation when a human lock is active', () => {
        const task = makeTask();
        task.humanStatusLock = {
            mode: 'manual-status',
            lockedAt: Date.now(),
            lockedByDisplayName: 'User',
            lockedBySessionId: 'user-session',
            lockedByRole: 'user',
        };

        expect(() => orchestrator.assertHumanStatusLockAllowsMutation(task, {
            sessionId: 'agent-1',
            role: 'builder',
            kind: 'agent',
        })).toThrowError(TaskOperationError);

        try {
            orchestrator.assertHumanStatusLockAllowsMutation(task, {
                sessionId: 'agent-1',
                role: 'builder',
                kind: 'agent',
            });
        } catch (error) {
            expect(error).toBeInstanceOf(TaskOperationError);
            expect((error as TaskOperationError).code).toBe(TASK_ERROR_CODES.TASK_LOCKED_BY_HUMAN);
            expect((error as Error).message).toContain('TASK_LOCKED_BY_HUMAN');
        }
    });

    it('allows human mutation when a human lock is active', () => {
        const task = makeTask();
        task.humanStatusLock = {
            mode: 'viewing',
            lockedAt: Date.now(),
            lockedByDisplayName: 'User',
        };

        expect(() => orchestrator.assertHumanStatusLockAllowsMutation(task, {
            sessionId: 'user-session',
            role: 'user',
            kind: 'human',
        })).not.toThrow();
    });

    it('applies a manual human status lock and comment when a user changes status', () => {
        const task = makeTask();

        orchestrator.applyManualHumanStatusLock(
            task,
            {
                sessionId: 'user-session',
                role: 'user',
                displayName: 'Workspace User',
                kind: 'human',
            },
            'review',
            'todo',
            'User manually moved this task back to todo.',
        );

        expect(task.humanStatusLock).toMatchObject({
            mode: 'manual-status',
            lockedBySessionId: 'user-session',
            lockedByRole: 'user',
            lockedByDisplayName: 'Workspace User',
            reason: 'User manually moved this task back to todo.',
        });
        expect(task.comments?.at(-1)).toMatchObject({
            type: 'human-override',
            content: 'User manually moved this task back to todo.',
            fromStatus: 'review',
            toStatus: 'todo',
        });
    });
});
