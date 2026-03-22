export const TASK_ERROR_CODES = {
    TASK_ACK_REQUIRED: 'TASK_ACK_REQUIRED',
    DUPLICATE_EXECUTION_CONFLICT: 'DUPLICATE_EXECUTION_CONFLICT',
    TASK_LOCKED_BY_HUMAN: 'TASK_LOCKED_BY_HUMAN',
} as const;

export type TaskErrorCode = typeof TASK_ERROR_CODES[keyof typeof TASK_ERROR_CODES];

export class TaskOperationError extends Error {
    code: TaskErrorCode;
    details?: unknown;

    constructor(code: TaskErrorCode, message: string, details?: unknown) {
        super(message);
        this.name = 'TaskOperationError';
        this.code = code;
        this.details = details;
    }
}

export function isTaskOperationError(error: unknown, code?: TaskErrorCode): error is TaskOperationError {
    if (!(error instanceof Error) || !('code' in error)) {
        return false;
    }

    const taskErrorCode = (error as { code?: unknown }).code;
    if (typeof taskErrorCode !== 'string') {
        return false;
    }

    if (!code) {
        return Object.values(TASK_ERROR_CODES).includes(taskErrorCode as TaskErrorCode);
    }

    return taskErrorCode === code;
}
