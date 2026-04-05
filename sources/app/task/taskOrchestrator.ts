import {
    appendTaskComment,
    applyManualHumanStatusLock,
    assertHumanStatusLockAllowsMutation,
    buildAutomaticTransitionComment,
    buildTaskActor,
} from './taskOrchestratorHelpers';
import type { TaskOrchestratorContext } from './taskOrchestratorContext';
import {
    completeTask,
    reportBlocker,
    resolveBlocker,
    startTask,
} from './taskOrchestratorExecution';
import {
    addTaskComment,
    clearHumanStatusLock,
    createTask,
    deleteTask,
    getTask,
    listTasks,
    releaseSessionTaskLocks,
    setHumanStatusLock,
    updateTask,
} from './taskOrchestratorOperations';
import { getBoardFromArtifact, saveBoardToArtifact } from './taskOrchestratorStorage';
import type {
    HumanStatusLock,
    KanbanBoard,
    KanbanTask,
    TaskActorInfo,
    TaskBoardEventType,
    TaskComment,
    TaskCommentInput,
} from './taskOrchestratorTypes';

export type {
    HumanStatusLock,
    KanbanBoard,
    KanbanColumn,
    KanbanTask,
    StatusPropagation,
    TaskActorInfo,
    TaskBlocker,
    TaskBoardEventType,
    TaskComment,
    TaskCommentInput,
    TaskExecutionLink,
} from './taskOrchestratorTypes';

export { DEFAULT_COLUMNS, DEFAULT_STATUS_PROPAGATION } from './taskOrchestratorTypes';

/**
 * Server-side Task Orchestration Engine
 *
 * SINGLE SOURCE OF TRUTH for all task operations.
 * All task mutations go through this module, which:
 * 1. Validates and persists changes to artifact body
 * 2. Broadcasts updates via WebSocket to all connected clients
 * 3. Handles status propagation for nested tasks
 */
export class TaskOrchestrator {
    private context(): TaskOrchestratorContext {
        return {
            getBoard: this.getBoard.bind(this),
            saveBoard: this.saveBoard.bind(this),
        };
    }

    async getBoard(userId: string, teamId: string): Promise<KanbanBoard | null> {
        return getBoardFromArtifact(userId, teamId);
    }

    private async saveBoard(
        userId: string,
        teamId: string,
        board: KanbanBoard,
        eventType: TaskBoardEventType,
        taskId: string,
        taskData?: Partial<KanbanTask>,
    ): Promise<void> {
        await saveBoardToArtifact(userId, teamId, board, eventType, taskId, taskData);
    }

    private appendTaskComment(task: KanbanTask, input: TaskCommentInput): TaskComment {
        return appendTaskComment(task, input);
    }

    private buildAutomaticTransitionComment(input: {
        sessionId: string;
        role?: string;
        displayName?: string;
        type: TaskComment['type'];
        content: string;
        fromStatus?: string;
        toStatus?: string;
    }): TaskCommentInput {
        return buildAutomaticTransitionComment(input);
    }

    private buildTaskActor(input?: TaskActorInfo | null): TaskActorInfo | undefined {
        return buildTaskActor(input);
    }

    private assertHumanStatusLockAllowsMutation(task: KanbanTask, actor?: TaskActorInfo): void {
        assertHumanStatusLockAllowsMutation(task, actor);
    }

    private applyManualHumanStatusLock(
        task: KanbanTask,
        actor: TaskActorInfo | undefined,
        previousStatus: string,
        nextStatus: string,
        explicitComment?: string,
    ): void {
        applyManualHumanStatusLock(task, actor, previousStatus, nextStatus, explicitComment);
    }

    async listTasks(
        userId: string,
        teamId: string,
        filters?: { status?: string; assigneeId?: string },
    ): Promise<{ tasks: KanbanTask[]; version: number }> {
        return listTasks(this.context(), userId, teamId, filters);
    }

    async getTask(userId: string, teamId: string, taskId: string): Promise<KanbanTask | null> {
        return getTask(this.context(), userId, teamId, taskId);
    }

    async addTaskComment(
        userId: string,
        teamId: string,
        taskId: string,
        commentInput: TaskCommentInput,
    ): Promise<KanbanTask> {
        return addTaskComment(this.context(), userId, teamId, taskId, commentInput);
    }

    async setHumanStatusLock(
        userId: string,
        teamId: string,
        taskId: string,
        input: TaskActorInfo & {
            mode: HumanStatusLock['mode'];
            reason?: string;
            comment?: string;
        },
    ): Promise<KanbanTask> {
        return setHumanStatusLock(this.context(), userId, teamId, taskId, input);
    }

    async clearHumanStatusLock(
        userId: string,
        teamId: string,
        taskId: string,
        input?: TaskActorInfo & { comment?: string; mode?: HumanStatusLock['mode'] },
    ): Promise<KanbanTask> {
        return clearHumanStatusLock(this.context(), userId, teamId, taskId, input);
    }

    async createTask(
        userId: string,
        teamId: string,
        task: Omit<KanbanTask, 'id' | 'createdAt' | 'updatedAt'>,
    ): Promise<KanbanTask> {
        return createTask(this.context(), userId, teamId, task);
    }

    async updateTask(
        userId: string,
        teamId: string,
        taskId: string,
        updates: Partial<KanbanTask> & { comment?: TaskCommentInput; actor?: TaskActorInfo },
    ): Promise<KanbanTask> {
        return updateTask(this.context(), userId, teamId, taskId, updates);
    }

    async deleteTask(userId: string, teamId: string, taskId: string): Promise<void> {
        return deleteTask(this.context(), userId, teamId, taskId);
    }

    async startTask(
        userId: string,
        teamId: string,
        taskId: string,
        sessionId: string,
        role: string,
        comment?: Omit<TaskCommentInput, 'sessionId' | 'role' | 'fromStatus' | 'toStatus'>,
    ): Promise<KanbanTask> {
        return startTask(this.context(), userId, teamId, taskId, sessionId, role, comment);
    }

    async completeTask(
        userId: string,
        teamId: string,
        taskId: string,
        sessionId: string,
        comment?: Omit<TaskCommentInput, 'sessionId' | 'fromStatus' | 'toStatus'>,
    ): Promise<KanbanTask> {
        return completeTask(this.context(), userId, teamId, taskId, sessionId, comment);
    }

    async reportBlocker(
        userId: string,
        teamId: string,
        taskId: string,
        sessionId: string,
        blocker: { type: 'dependency' | 'question' | 'resource' | 'technical'; description: string; role?: string; displayName?: string; mentions?: string[]; comment?: string },
    ): Promise<KanbanTask> {
        return reportBlocker(this.context(), userId, teamId, taskId, sessionId, blocker);
    }

    async resolveBlocker(
        userId: string,
        teamId: string,
        taskId: string,
        blockerId: string,
        sessionId: string,
        resolution: string,
        comment?: Omit<TaskCommentInput, 'sessionId'>,
    ): Promise<KanbanTask> {
        return resolveBlocker(this.context(), userId, teamId, taskId, blockerId, sessionId, resolution, comment);
    }

    async releaseSessionTaskLocks(
        userId: string,
        teamId: string,
        sessionId: string,
    ): Promise<string[]> {
        return releaseSessionTaskLocks(this.context(), userId, teamId, sessionId);
    }
}

export const taskOrchestrator = new TaskOrchestrator();
