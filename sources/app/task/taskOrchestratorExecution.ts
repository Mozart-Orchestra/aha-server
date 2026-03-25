import { log } from '@/utils/log';
import { randomKeyNaked } from '@/utils/randomKeyNaked';

import { cleanupActiveExecutionLinks } from './executionLinks';
import { findDuplicateExecutionConflict } from './duplicateExecution';
import { requireBoard, type TaskOrchestratorContext } from './taskOrchestratorContext';
import {
    appendTaskComment,
    assertHumanStatusLockAllowsMutation,
    buildTaskActor,
} from './taskOrchestratorHelpers';
import {
    handleTaskCompletion,
    propagateBlockerToParent,
    updateParentBlockedStatus,
} from './taskOrchestratorPropagation';
import { TaskOperationError, TASK_ERROR_CODES } from './taskErrors';
import type { KanbanTask, TaskBlocker, TaskCommentInput } from './taskOrchestratorTypes';

export async function startTask(
    context: TaskOrchestratorContext,
    userId: string,
    teamId: string,
    taskId: string,
    sessionId: string,
    role: string,
    comment?: Omit<TaskCommentInput, 'sessionId' | 'role' | 'fromStatus' | 'toStatus'>,
): Promise<KanbanTask> {
    const board = await requireBoard(context, userId, teamId);

    const task = board.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error('Task not found');

    const actor = buildTaskActor({
        sessionId,
        role,
        displayName: comment?.displayName,
        kind: role === 'user' ? 'human' : undefined,
    });
    assertHumanStatusLockAllowsMutation(task, actor);

    const activeLink = task.executionLinks?.find((link) => link.status === 'active');
    if (activeLink && activeLink.sessionId !== sessionId) {
        throw new TaskOperationError(
            TASK_ERROR_CODES.DUPLICATE_EXECUTION_CONFLICT,
            `Task already being executed by session ${activeLink.sessionId}`,
            {
                conflictingTaskId: task.id,
                conflictingSessionId: activeLink.sessionId,
                reason: 'active-link',
            },
        );
    }

    const duplicateConflict = findDuplicateExecutionConflict(
        board.tasks as any,
        task as any,
        sessionId,
    );
    if (duplicateConflict) {
        throw new TaskOperationError(
            TASK_ERROR_CODES.DUPLICATE_EXECUTION_CONFLICT,
            `Task overlaps with active work on ${duplicateConflict.conflictingTaskId}`,
            duplicateConflict,
        );
    }

    task.executionLinks = task.executionLinks || [];
    const existingLink = task.executionLinks.find((link) => link.sessionId === sessionId);
    if (existingLink) {
        existingLink.status = 'active';
        existingLink.linkedAt = Date.now();
        existingLink.role = 'primary';
    } else {
        task.executionLinks.push({
            sessionId,
            linkedAt: Date.now(),
            role: 'primary',
            status: 'active',
        });
    }

    const previousStatus = task.status;
    if (task.status === 'todo') {
        task.status = 'in-progress';
    }
    task.assigneeId = sessionId;
    task.updatedAt = Date.now();
    appendTaskComment(task, {
        sessionId,
        role,
        displayName: comment?.displayName,
        type: 'status-change',
        content: comment?.content?.trim() || `Task started by ${comment?.displayName || role || sessionId}.`,
        fromStatus: previousStatus,
        toStatus: task.status,
        mentions: comment?.mentions,
    });

    const taskIndex = board.tasks.findIndex((candidate) => candidate.id === taskId);
    board.tasks[taskIndex] = task;

    await context.saveBoard(userId, teamId, board, 'task-updated', taskId, task);

    log({ module: 'task-orchestrator', teamId, taskId, sessionId }, 'Task started');
    return task;
}

export async function completeTask(
    context: TaskOrchestratorContext,
    userId: string,
    teamId: string,
    taskId: string,
    sessionId: string,
    comment?: Omit<TaskCommentInput, 'sessionId' | 'fromStatus' | 'toStatus'>,
): Promise<KanbanTask> {
    const board = await requireBoard(context, userId, teamId);

    const task = board.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error('Task not found');

    assertHumanStatusLockAllowsMutation(task, buildTaskActor({
        sessionId,
        role: comment?.role,
        displayName: comment?.displayName,
        kind: comment?.role === 'user' ? 'human' : undefined,
    }));

    if (task.subtaskIds?.length) {
        const subtasks = board.tasks.filter((candidate) => task.subtaskIds!.includes(candidate.id));
        const incomplete = subtasks.filter((subtask) => subtask.status !== 'done');
        if (incomplete.length > 0) {
            throw new Error(`Cannot complete: ${incomplete.length} subtasks still pending`);
        }
    }

    task.executionLinks = cleanupActiveExecutionLinks(task.executionLinks, sessionId);

    const previousStatus = task.status;
    task.status = 'done';
    task.updatedAt = Date.now();
    appendTaskComment(task, {
        sessionId,
        role: comment?.role,
        displayName: comment?.displayName,
        type: 'status-change',
        content: comment?.content?.trim() || `Task completed by ${comment?.displayName || comment?.role || sessionId}.`,
        fromStatus: previousStatus,
        toStatus: 'done',
        mentions: comment?.mentions,
    });

    const taskIndex = board.tasks.findIndex((candidate) => candidate.id === taskId);
    board.tasks[taskIndex] = task;

    await handleTaskCompletion(board, task);
    await context.saveBoard(userId, teamId, board, 'task-updated', taskId, task);

    log({ module: 'task-orchestrator', teamId, taskId }, 'Task completed');
    return task;
}

export async function reportBlocker(
    context: TaskOrchestratorContext,
    userId: string,
    teamId: string,
    taskId: string,
    sessionId: string,
    blocker: { type: TaskBlocker['type']; description: string; role?: string; displayName?: string; mentions?: string[]; comment?: string },
): Promise<KanbanTask> {
    const board = await requireBoard(context, userId, teamId);

    const task = board.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error('Task not found');

    assertHumanStatusLockAllowsMutation(task, buildTaskActor({
        sessionId,
        role: blocker.role,
        displayName: blocker.displayName,
        kind: blocker.role === 'user' ? 'human' : undefined,
    }));

    const newBlocker: TaskBlocker = {
        id: randomKeyNaked(8),
        type: blocker.type,
        description: blocker.description,
        raisedAt: Date.now(),
        raisedBy: sessionId,
    };

    task.blockers = task.blockers || [];
    task.blockers.push(newBlocker);
    const previousStatus = task.status;
    task.status = 'blocked';
    task.updatedAt = Date.now();
    appendTaskComment(task, {
        sessionId,
        role: blocker.role,
        displayName: blocker.displayName,
        type: 'blocker',
        content: blocker.comment?.trim() || blocker.description,
        fromStatus: previousStatus,
        toStatus: 'blocked',
        mentions: blocker.mentions,
    });

    propagateBlockerToParent(board, task.parentTaskId);

    const taskIndex = board.tasks.findIndex((candidate) => candidate.id === taskId);
    board.tasks[taskIndex] = task;

    await context.saveBoard(userId, teamId, board, 'task-updated', taskId, task);

    log({ module: 'task-orchestrator', teamId, taskId }, 'Blocker reported');
    return task;
}

export async function resolveBlocker(
    context: TaskOrchestratorContext,
    userId: string,
    teamId: string,
    taskId: string,
    blockerId: string,
    sessionId: string,
    resolution: string,
    comment?: Omit<TaskCommentInput, 'sessionId'>,
): Promise<KanbanTask> {
    const board = await requireBoard(context, userId, teamId);

    const task = board.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error('Task not found');

    const blocker = task.blockers?.find((candidate) => candidate.id === blockerId);
    if (!blocker) throw new Error('Blocker not found');

    const actor = buildTaskActor({
        sessionId,
        role: comment?.role,
        displayName: comment?.displayName,
        kind: comment?.role === 'user' ? 'human' : undefined,
    });
    const unresolvedBlockers = task.blockers?.filter((candidate) => !candidate.resolvedAt) || [];
    if (unresolvedBlockers.length <= 1) {
        assertHumanStatusLockAllowsMutation(task, actor);
    }

    blocker.resolvedAt = Date.now();
    blocker.resolvedBy = sessionId;
    blocker.resolution = resolution;

    const remainingBlockers = task.blockers?.filter((candidate) => !candidate.resolvedAt) || [];
    if (remainingBlockers.length === 0) {
        task.status = 'in-progress';
    }
    task.updatedAt = Date.now();
    appendTaskComment(task, {
        sessionId,
        role: comment?.role,
        displayName: comment?.displayName,
        type: 'decision',
        content: comment?.content?.trim() || resolution,
        mentions: comment?.mentions,
    });

    updateParentBlockedStatus(board, task.parentTaskId);

    const taskIndex = board.tasks.findIndex((candidate) => candidate.id === taskId);
    board.tasks[taskIndex] = task;

    await context.saveBoard(userId, teamId, board, 'task-updated', taskId, task);

    log({ module: 'task-orchestrator', teamId, taskId, blockerId }, 'Blocker resolved');
    return task;
}
