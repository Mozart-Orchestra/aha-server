import { cleanupActiveExecutionLinks } from './executionLinks';
import { DEFAULT_STATUS_PROPAGATION, type KanbanBoard, type KanbanTask } from './taskOrchestratorTypes';

export function getTaskDepth(board: KanbanBoard, parentId: string | null | undefined): number {
    if (!parentId) return -1;
    const parent = board.tasks.find((task) => task.id === parentId);
    return parent?.depth ?? 0;
}

export function collectSubtaskIds(board: KanbanBoard, taskId: string, ids: Set<string>): void {
    const task = board.tasks.find((candidate) => candidate.id === taskId);
    if (!task?.subtaskIds) return;

    for (const subtaskId of task.subtaskIds) {
        if (ids.has(subtaskId)) continue;
        ids.add(subtaskId);
        collectSubtaskIds(board, subtaskId, ids);
    }
}

export async function handleTaskCompletion(
    board: KanbanBoard,
    task: KanbanTask,
    visited: Set<string> = new Set(),
): Promise<void> {
    if (!task.parentTaskId) return;
    if (visited.has(task.parentTaskId)) return;
    visited.add(task.parentTaskId);

    const parent = board.tasks.find((candidate) => candidate.id === task.parentTaskId);
    if (!parent) return;

    const propagation = parent.statusPropagation ?? DEFAULT_STATUS_PROPAGATION;
    if (!propagation.autoCompleteParent) return;

    const siblings = board.tasks.filter((candidate) => parent.subtaskIds?.includes(candidate.id));
    const allDone = siblings.every((sibling) => sibling.status === 'done');

    if (allDone && parent.status !== 'done') {
        parent.status = 'review';
        parent.updatedAt = Date.now();
        parent.executionLinks = cleanupActiveExecutionLinks(parent.executionLinks, parent.assigneeId);

        await handleTaskCompletion(board, parent, visited);
    }
}

export function propagateBlockerToParent(
    board: KanbanBoard,
    parentId: string | null | undefined,
    visited: Set<string> = new Set(),
): void {
    if (!parentId) return;
    if (visited.has(parentId)) return;
    visited.add(parentId);

    const parent = board.tasks.find((candidate) => candidate.id === parentId);
    if (!parent) return;

    const propagation = parent.statusPropagation ?? DEFAULT_STATUS_PROPAGATION;
    if (!propagation.blockParentOnBlocked) return;

    parent.hasBlockedChild = true;
    parent.updatedAt = Date.now();

    propagateBlockerToParent(board, parent.parentTaskId, visited);
}

export function updateParentBlockedStatus(
    board: KanbanBoard,
    parentId: string | null | undefined,
    visited: Set<string> = new Set(),
): void {
    if (!parentId) return;
    if (visited.has(parentId)) return;
    visited.add(parentId);

    const parent = board.tasks.find((candidate) => candidate.id === parentId);
    if (!parent) return;

    const subtasks = board.tasks.filter((candidate) => parent.subtaskIds?.includes(candidate.id));
    const hasBlockedSubtask = subtasks.some((subtask) => subtask.status === 'blocked' || subtask.hasBlockedChild);

    parent.hasBlockedChild = hasBlockedSubtask;
    parent.updatedAt = Date.now();

    updateParentBlockedStatus(board, parent.parentTaskId, visited);
}
