import { randomKeyNaked } from '@/utils/randomKeyNaked';

import { TaskOperationError, TASK_ERROR_CODES } from './taskErrors';
import type {
    HumanStatusLock,
    KanbanTask,
    TaskActorInfo,
    TaskComment,
    TaskCommentInput,
} from './taskOrchestratorTypes';

export function appendTaskComment(task: KanbanTask, input: TaskCommentInput): TaskComment {
    const comment: TaskComment = {
        id: randomKeyNaked(10),
        authorSessionId: input.sessionId,
        authorRole: input.role,
        authorDisplayName: input.displayName,
        type: input.type ?? 'note',
        content: input.content.trim(),
        createdAt: Date.now(),
        ...(input.fromStatus ? { fromStatus: input.fromStatus } : {}),
        ...(input.toStatus ? { toStatus: input.toStatus } : {}),
        ...(input.mentions?.length ? { mentions: input.mentions } : {}),
    };

    task.comments = task.comments || [];
    task.comments.push(comment);
    task.updatedAt = Date.now();

    return comment;
}

export function buildAutomaticTransitionComment(input: {
    sessionId: string;
    role?: string;
    displayName?: string;
    type: TaskComment['type'];
    content: string;
    fromStatus?: string;
    toStatus?: string;
}): TaskCommentInput {
    return {
        sessionId: input.sessionId,
        role: input.role,
        displayName: input.displayName,
        type: input.type,
        content: input.content,
        fromStatus: input.fromStatus,
        toStatus: input.toStatus,
    };
}

export function buildTaskActor(input?: TaskActorInfo | null): TaskActorInfo | undefined {
    if (!input) {
        return undefined;
    }

    const sessionId = input.sessionId?.trim();
    const role = input.role?.trim();
    const displayName = input.displayName?.trim();
    const kind = input.kind;

    if (!sessionId && !role && !displayName && !kind) {
        return undefined;
    }

    return {
        ...(sessionId ? { sessionId } : {}),
        ...(role ? { role } : {}),
        ...(displayName ? { displayName } : {}),
        ...(kind ? { kind } : {}),
    };
}

export function isHumanActor(actor?: TaskActorInfo | null): boolean {
    if (!actor) {
        return false;
    }

    if (actor.kind === 'human') {
        return true;
    }

    const normalizedRole = actor.role?.trim().toLowerCase();
    return normalizedRole === 'user' || normalizedRole === 'human';
}

export function buildHumanStatusLock(input: {
    actor?: TaskActorInfo;
    mode: HumanStatusLock['mode'];
    reason?: string;
}): HumanStatusLock {
    return {
        mode: input.mode,
        lockedAt: Date.now(),
        ...(input.actor?.sessionId ? { lockedBySessionId: input.actor.sessionId } : {}),
        ...(input.actor?.role ? { lockedByRole: input.actor.role } : {}),
        ...(input.actor?.displayName ? { lockedByDisplayName: input.actor.displayName } : {}),
        ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    };
}

export function buildHumanLockErrorMessage(lock?: HumanStatusLock | null): string {
    if (lock?.mode === 'manual-status') {
        return 'TASK_LOCKED_BY_HUMAN: This task status was manually set by the user. Call list_tasks to see updated status.';
    }

    const lockedBy = lock?.lockedByDisplayName || lock?.lockedBySessionId || 'a human';
    return `TASK_LOCKED_BY_HUMAN: This task is currently locked by ${lockedBy}. Call list_tasks to see updated status.`;
}

export function assertHumanStatusLockAllowsMutation(task: KanbanTask, actor?: TaskActorInfo): void {
    if (!task.humanStatusLock) {
        return;
    }

    if (isHumanActor(actor)) {
        return;
    }

    throw new TaskOperationError(
        TASK_ERROR_CODES.TASK_LOCKED_BY_HUMAN,
        buildHumanLockErrorMessage(task.humanStatusLock),
        {
            taskId: task.id,
            humanStatusLock: task.humanStatusLock,
            attemptedBySessionId: actor?.sessionId,
            attemptedByRole: actor?.role,
        },
    );
}

export function applyManualHumanStatusLock(
    task: KanbanTask,
    actor: TaskActorInfo | undefined,
    previousStatus: string,
    nextStatus: string,
    explicitComment?: string,
): void {
    if (!isHumanActor(actor) || previousStatus === nextStatus) {
        return;
    }

    task.humanStatusLock = buildHumanStatusLock({
        actor,
        mode: 'manual-status',
        reason: explicitComment || `Manual status change to ${nextStatus}`,
    });

    appendTaskComment(task, {
        sessionId: actor?.sessionId ?? 'user',
        role: actor?.role ?? 'user',
        displayName: actor?.displayName,
        type: 'human-override',
        content: explicitComment || `${actor?.displayName || 'User'} manually changed status from ${previousStatus} to ${nextStatus}. Agent status changes are now locked until the human clears the lock.`,
        fromStatus: previousStatus,
        toStatus: nextStatus,
    });
}
