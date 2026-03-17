import { describe, expect, it } from 'vitest';

import { isTaskOperationError, TaskOperationError, TASK_ERROR_CODES } from './taskErrors';

describe('taskErrors', () => {
    it('creates typed task operation errors with code and details', () => {
        const error = new TaskOperationError(
            TASK_ERROR_CODES.DUPLICATE_EXECUTION_CONFLICT,
            'duplicate execution blocked',
            { conflictingTaskId: 'task-1' },
        );

        expect(error.code).toBe(TASK_ERROR_CODES.DUPLICATE_EXECUTION_CONFLICT);
        expect(error.details).toEqual({ conflictingTaskId: 'task-1' });
        expect(isTaskOperationError(error)).toBe(true);
        expect(isTaskOperationError(error, TASK_ERROR_CODES.DUPLICATE_EXECUTION_CONFLICT)).toBe(true);
    });

    it('matches only the requested typed error code', () => {
        const error = new TaskOperationError(
            TASK_ERROR_CODES.TASK_ACK_REQUIRED,
            'use start_task',
        );

        expect(isTaskOperationError(error, TASK_ERROR_CODES.TASK_ACK_REQUIRED)).toBe(true);
        expect(isTaskOperationError(error, TASK_ERROR_CODES.DUPLICATE_EXECUTION_CONFLICT)).toBe(false);
    });

    it('rejects plain errors without typed task codes', () => {
        const error = new Error('plain error');

        expect(isTaskOperationError(error)).toBe(false);
        expect(isTaskOperationError(error, TASK_ERROR_CODES.TASK_ACK_REQUIRED)).toBe(false);
    });
});
