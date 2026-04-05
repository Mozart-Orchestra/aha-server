import { log } from '@/utils/log';
import { randomKeyNaked } from '@/utils/randomKeyNaked';

import { requireBoard, type TaskOrchestratorContext } from './taskOrchestratorContext';
import {
    appendTaskComment,
    applyManualHumanStatusLock,
    assertHumanStatusLockAllowsMutation,
    buildAutomaticTransitionComment,
    buildHumanStatusLock,
    buildTaskActor,
    isHumanActor,
} from './taskOrchestratorHelpers';
import {
    collectSubtaskIds,
    getTaskDepth,
    handleTaskCompletion,
    propagateBlockerToParent,
} from './taskOrchestratorPropagation';
import { cleanupActiveExecutionLinks } from './executionLinks';
import { TaskOperationError, TASK_ERROR_CODES } from './taskErrors';
import {
    DEFAULT_STATUS_PROPAGATION,
    type HumanStatusLock,
    type KanbanTask,
    type TaskActorInfo,
    type TaskCommentInput,
} from './taskOrchestratorTypes';

export async function listTasks(
    context: TaskOrchestratorContext,
    userId: string,
    teamId: string,
    filters?: { status?: string; assigneeId?: string },
): Promise<{ tasks: KanbanTask[]; version: number }> {
    const board = await requireBoard(context, userId, teamId);

    let tasks = board.tasks;
    if (filters?.status) {
        tasks = tasks.filter((task) => task.status === filters.status);
    }
    if (filters?.assigneeId) {
        tasks = tasks.filter((task) => task.assigneeId === filters.assigneeId);
    }

    return { tasks, version: board.version || 1 };
}

export async function getTask(
    context: TaskOrchestratorContext,
    userId: string,
    teamId: string,
    taskId: string,
): Promise<KanbanTask | null> {
    const board = await context.getBoard(userId, teamId);
    if (!board) return null;
    return board.tasks.find((task) => task.id === taskId) || null;
}

export async function addTaskComment(
    context: TaskOrchestratorContext,
    userId: string,
    teamId: string,
    taskId: string,
    commentInput: TaskCommentInput,
): Promise<KanbanTask> {
    const board = await requireBoard(context, userId, teamId);

    const taskIndex = board.tasks.findIndex((task) => task.id === taskId);
    if (taskIndex === -1) throw new Error('Task not found');

    const task = board.tasks[taskIndex];
    appendTaskComment(task, commentInput);
    board.tasks[taskIndex] = task;

    await context.saveBoard(userId, teamId, board, 'task-updated', taskId, task);

    log({ module: 'task-orchestrator', teamId, taskId }, 'Task comment added');
    return task;
}

export async function setHumanStatusLock(
    context: TaskOrchestratorContext,
    userId: string,
    teamId: string,
    taskId: string,
    input: TaskActorInfo & {
        mode: HumanStatusLock['mode'];
        reason?: string;
        comment?: string;
    },
): Promise<KanbanTask> {
    const board = await requireBoard(context, userId, teamId);

    const taskIndex = board.tasks.findIndex((task) => task.id === taskId);
    if (taskIndex === -1) throw new Error('Task not found');

    const task = board.tasks[taskIndex];
    const actor = buildTaskActor({
        ...input,
        kind: input.kind ?? 'human',
    });
    task.humanStatusLock = buildHumanStatusLock({
        actor,
        mode: input.mode,
        reason: input.reason,
    });
    task.updatedAt = Date.now();

    if (input.comment?.trim()) {
        appendTaskComment(task, {
            sessionId: actor?.sessionId ?? 'user',
            role: actor?.role ?? 'user',
            displayName: actor?.displayName,
            type: 'human-override',
            content: input.comment.trim(),
        });
    }

    board.tasks[taskIndex] = task;
    await context.saveBoard(userId, teamId, board, 'task-updated', taskId, task);

    log({ module: 'task-orchestrator', teamId, taskId }, 'Human status lock set');
    return task;
}

export async function clearHumanStatusLock(
    context: TaskOrchestratorContext,
    userId: string,
    teamId: string,
    taskId: string,
    input?: TaskActorInfo & { comment?: string; mode?: HumanStatusLock['mode'] },
): Promise<KanbanTask> {
    const board = await requireBoard(context, userId, teamId);

    const taskIndex = board.tasks.findIndex((task) => task.id === taskId);
    if (taskIndex === -1) throw new Error('Task not found');

    const task = board.tasks[taskIndex];
    if (!task.humanStatusLock) {
        return task;
    }
    if (input?.mode && task.humanStatusLock.mode !== input.mode) {
        return task;
    }

    const actor = buildTaskActor(input ?? { kind: 'human' });
    task.humanStatusLock = null;
    task.updatedAt = Date.now();

    if (input?.comment?.trim()) {
        appendTaskComment(task, {
            sessionId: actor?.sessionId ?? 'user',
            role: actor?.role ?? 'user',
            displayName: actor?.displayName,
            type: 'human-override',
            content: input.comment.trim(),
        });
    }

    board.tasks[taskIndex] = task;
    await context.saveBoard(userId, teamId, board, 'task-updated', taskId, task);

    log({ module: 'task-orchestrator', teamId, taskId }, 'Human status lock cleared');
    return task;
}

export async function createTask(
    context: TaskOrchestratorContext,
    userId: string,
    teamId: string,
    task: Omit<KanbanTask, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<KanbanTask> {
    const board = await requireBoard(context, userId, teamId);

    const parentTask = task.parentTaskId
        ? board.tasks.find((candidate) => candidate.id === task.parentTaskId)
        : null;

    if (task.parentTaskId && !parentTask) {
        throw new Error('Parent task not found');
    }

    const newTask: KanbanTask = {
        ...task,
        id: randomKeyNaked(12),
        status: task.status || 'todo',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        comments: task.comments || [],
        depth: parentTask ? (parentTask.depth ?? 0) + 1 : 0,
        statusPropagation: task.statusPropagation || { ...DEFAULT_STATUS_PROPAGATION },
    };

    if (newTask.depth && newTask.depth > 3) {
        throw new Error('Maximum nesting depth (3) exceeded');
    }

    if (parentTask) {
        parentTask.subtaskIds = parentTask.subtaskIds || [];
        parentTask.subtaskIds.push(newTask.id);
        parentTask.updatedAt = Date.now();
        if (parentTask.status === 'todo') {
            parentTask.status = 'in-progress';
        }
    }

    board.tasks.push(newTask);
    await context.saveBoard(userId, teamId, board, 'task-created', newTask.id, newTask);

    log({ module: 'task-orchestrator', teamId, taskId: newTask.id }, 'Task created');
    return newTask;
}

export async function updateTask(
    context: TaskOrchestratorContext,
    userId: string,
    teamId: string,
    taskId: string,
    updates: Partial<KanbanTask> & { comment?: TaskCommentInput; actor?: TaskActorInfo },
): Promise<KanbanTask> {
    const board = await requireBoard(context, userId, teamId);

    const taskIndex = board.tasks.findIndex((task) => task.id === taskId);
    if (taskIndex === -1) throw new Error('Task not found');

    const task = board.tasks[taskIndex];
    const previousStatus = task.status;
    const previousAssignee = task.assigneeId ?? null;
    const previousApprovalStatus = task.approvalStatus;
    const { comment, actor: rawActor, ...taskUpdates } = updates;
    const actor = buildTaskActor(rawActor ?? {
        sessionId: comment?.sessionId,
        role: comment?.role,
        displayName: comment?.displayName,
        kind: comment?.role === 'user' ? 'human' : undefined,
    });

    if (taskUpdates.status === 'in-progress' && previousStatus !== 'in-progress') {
        throw new TaskOperationError(
            TASK_ERROR_CODES.TASK_ACK_REQUIRED,
            'Use start_task to move a task into in-progress; update_task cannot be used as task ack.',
        );
    }

    if (taskUpdates.status && taskUpdates.status !== previousStatus) {
        assertHumanStatusLockAllowsMutation(task, actor);
    }

    const updatedTask: KanbanTask = {
        ...task,
        ...taskUpdates,
        id: taskId,
        createdAt: task.createdAt,
        updatedAt: Date.now(),
    };

    if (taskUpdates.status === 'review' || taskUpdates.status === 'done') {
        updatedTask.executionLinks = cleanupActiveExecutionLinks(
            updatedTask.executionLinks,
            updatedTask.assigneeId,
        );
    }

    const explicitComment = comment?.content?.trim();
    let consumedExplicitComment = false;

    if (taskUpdates.status && taskUpdates.status !== previousStatus) {
        const humanActor = isHumanActor(actor);
        appendTaskComment(updatedTask, buildAutomaticTransitionComment({
            sessionId: actor?.sessionId ?? comment?.sessionId ?? updatedTask.assigneeId ?? task.assigneeId ?? 'system',
            role: actor?.role ?? comment?.role,
            displayName: actor?.displayName ?? comment?.displayName,
            type: taskUpdates.status === 'review' ? 'review-feedback' : 'status-change',
            content: humanActor
                ? `Status changed from ${previousStatus} to ${taskUpdates.status}.`
                : (explicitComment || `Status changed from ${previousStatus} to ${taskUpdates.status}.`),
            fromStatus: previousStatus,
            toStatus: taskUpdates.status,
        }));

        if (humanActor) {
            applyManualHumanStatusLock(updatedTask, actor, previousStatus, taskUpdates.status, explicitComment);
        }

        consumedExplicitComment = Boolean(explicitComment);
    } else if (comment?.content?.trim()) {
        appendTaskComment(updatedTask, comment);
        consumedExplicitComment = true;
    }

    if (taskUpdates.assigneeId !== undefined && taskUpdates.assigneeId !== previousAssignee) {
        appendTaskComment(updatedTask, buildAutomaticTransitionComment({
            sessionId: actor?.sessionId ?? comment?.sessionId ?? previousAssignee ?? updatedTask.assigneeId ?? 'system',
            role: actor?.role ?? comment?.role,
            displayName: actor?.displayName ?? comment?.displayName,
            type: 'handoff',
            content: consumedExplicitComment
                ? `Task reassigned from ${previousAssignee ?? 'unassigned'} to ${taskUpdates.assigneeId ?? 'unassigned'}.`
                : (explicitComment || `Task reassigned from ${previousAssignee ?? 'unassigned'} to ${taskUpdates.assigneeId ?? 'unassigned'}.`),
        }));
    }

    if (taskUpdates.approvalStatus && taskUpdates.approvalStatus !== previousApprovalStatus) {
        appendTaskComment(updatedTask, buildAutomaticTransitionComment({
            sessionId: actor?.sessionId ?? comment?.sessionId ?? updatedTask.assigneeId ?? 'system',
            role: actor?.role ?? comment?.role,
            displayName: actor?.displayName ?? comment?.displayName,
            type: taskUpdates.approvalStatus === 'rejected' ? 'review-feedback' : 'decision',
            content: consumedExplicitComment
                ? `Approval status changed to ${taskUpdates.approvalStatus}.`
                : (explicitComment || `Approval status changed to ${taskUpdates.approvalStatus}.`),
        }));
    }

    board.tasks[taskIndex] = updatedTask;

    if (taskUpdates.status && taskUpdates.status !== previousStatus) {
        if (taskUpdates.status === 'done') {
            await handleTaskCompletion(board, updatedTask);
        } else if (taskUpdates.status === 'blocked') {
            propagateBlockerToParent(board, task.parentTaskId);
        }
    }

    await context.saveBoard(userId, teamId, board, 'task-updated', taskId, updatedTask);

    log({ module: 'task-orchestrator', teamId, taskId }, 'Task updated');
    return updatedTask;
}

export async function deleteTask(
    context: TaskOrchestratorContext,
    userId: string,
    teamId: string,
    taskId: string,
): Promise<void> {
    const board = await requireBoard(context, userId, teamId);

    const task = board.tasks.find((candidate) => candidate.id === taskId);
    if (!task) throw new Error('Task not found');

    const idsToDelete = new Set<string>([taskId]);
    if (task.statusPropagation?.cascadeDeleteSubtasks) {
        collectSubtaskIds(board, taskId, idsToDelete);
    }

    if (task.parentTaskId) {
        const parent = board.tasks.find((candidate) => candidate.id === task.parentTaskId);
        if (parent?.subtaskIds) {
            parent.subtaskIds = parent.subtaskIds.filter((id) => !idsToDelete.has(id));
            parent.updatedAt = Date.now();
        }
    }

    board.tasks = board.tasks.filter((candidate) => !idsToDelete.has(candidate.id));

    await context.saveBoard(userId, teamId, board, 'task-deleted', taskId);

    log({ module: 'task-orchestrator', teamId, taskId }, `Task deleted (${idsToDelete.size} total)`);
}

/**
 * Release all active task execution locks held by a dead session.
 *
 * Called by the daemon when heartbeat detects a session has died without
 * calling retire_self. Marks the session's execution links as 'abandoned'
 * so other agents can claim those tasks via start_task.
 *
 * Returns the IDs of tasks that were unlocked.
 */
export async function releaseSessionTaskLocks(
    context: TaskOrchestratorContext,
    userId: string,
    teamId: string,
    sessionId: string,
): Promise<string[]> {
    const board = await requireBoard(context, userId, teamId);

    const unlockedTaskIds: string[] = [];

    for (const task of board.tasks) {
        const activeLink = task.executionLinks?.find(
            (link) => link.status === 'active' && link.sessionId === sessionId,
        );
        if (!activeLink) continue;

        activeLink.status = 'abandoned';
        task.updatedAt = Date.now();
        unlockedTaskIds.push(task.id);
    }

    if (unlockedTaskIds.length === 0) {
        return [];
    }

    // Persist one save that covers all unlocked tasks; broadcast the last one
    // (each task will be individually re-fetched by clients on next poll).
    const lastId = unlockedTaskIds[unlockedTaskIds.length - 1];
    const lastTask = board.tasks.find((t) => t.id === lastId);
    await context.saveBoard(userId, teamId, board, 'task-updated', lastId, lastTask);

    log(
        { module: 'task-orchestrator', teamId, sessionId },
        `Released execution locks for dead session on ${unlockedTaskIds.length} task(s): ${unlockedTaskIds.join(', ')}`,
    );

    return unlockedTaskIds;
}
