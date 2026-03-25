import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { eventRouter } from "@/app/events/eventRouter";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { parseTeamArtifactBody } from "@/utils/teamArtifacts";
import * as privacyKit from "privacy-kit";

import { findDuplicateExecutionConflict } from "./duplicateExecution";
import { cleanupActiveExecutionLinks } from "./executionLinks";
import { TaskOperationError, TASK_ERROR_CODES } from "./taskErrors";

/**
 * Server-side Task Orchestration Engine
 *
 * SINGLE SOURCE OF TRUTH for all task operations.
 * All task mutations go through this module, which:
 * 1. Validates and persists changes to artifact body
 * 2. Broadcasts updates via WebSocket to all connected clients
 * 3. Handles status propagation for nested tasks
 */

// === Type Definitions ===

export interface TaskExecutionLink {
    sessionId: string;
    linkedAt: number;
    role: 'primary' | 'supporting';
    status: 'active' | 'completed' | 'abandoned';
}

export interface TaskBlocker {
    id: string;
    type: 'dependency' | 'question' | 'resource' | 'technical';
    description: string;
    raisedAt: number;
    raisedBy?: string;
    resolvedAt?: number;
    resolvedBy?: string;
    resolution?: string;
}

export interface TaskComment {
    id: string;
    authorSessionId: string;
    authorRole?: string;
    authorDisplayName?: string;
    type: 'note' | 'status-change' | 'review-feedback' | 'handoff' | 'blocker' | 'decision' | 'human-override' | 'plan' | 'plan-review' | 'execution-check' | 'rework-request';
    content: string;
    createdAt: number;
    updatedAt?: number;
    fromStatus?: string;
    toStatus?: string;
    mentions?: string[];
}

export interface TaskCommentInput {
    sessionId: string;
    role?: string;
    displayName?: string;
    type?: TaskComment['type'];
    content: string;
    fromStatus?: string;
    toStatus?: string;
    mentions?: string[];
}

export interface TaskActorInfo {
    sessionId?: string;
    role?: string;
    displayName?: string;
    kind?: 'human' | 'agent';
}

export interface HumanStatusLock {
    mode: 'viewing' | 'editing' | 'manual-status';
    lockedAt: number;
    lockedBySessionId?: string;
    lockedByRole?: string;
    lockedByDisplayName?: string;
    reason?: string;
}

export interface StatusPropagation {
    autoCompleteParent: boolean;
    blockParentOnBlocked: boolean;
    cascadeDeleteSubtasks: boolean;
}

export interface KanbanTask {
    id: string;
    title: string;
    description?: string;
    status: string;
    assigneeId?: string | null;
    reporterId?: string;
    priority?: 'low' | 'medium' | 'high' | 'urgent';
    createdAt: number;
    updatedAt: number;
    parentTaskId?: string | null;
    subtaskIds?: string[];
    depth?: number;
    statusPropagation?: StatusPropagation;
    hasBlockedChild?: boolean;
    executionLinks?: TaskExecutionLink[];
    blockers?: TaskBlocker[];
    comments?: TaskComment[];
    labels?: string[];
    approvalStatus?: 'pending' | 'approved' | 'rejected';
    humanStatusLock?: HumanStatusLock | null;
}

export interface KanbanColumn {
    id: string;
    title: string;
}

export interface KanbanBoard {
    columns: KanbanColumn[];
    tasks: KanbanTask[];
    version?: number;
    updatedAt?: number;
    team?: any;
}

const DEFAULT_STATUS_PROPAGATION: StatusPropagation = {
    autoCompleteParent: true,
    blockParentOnBlocked: true,
    cascadeDeleteSubtasks: false
};

const DEFAULT_COLUMNS: KanbanColumn[] = [
    { id: 'todo', title: 'To Do' },
    { id: 'in-progress', title: 'In Progress' },
    { id: 'review', title: 'Review' },
    { id: 'done', title: 'Done' }
];

// === Task Orchestrator Class ===

export class TaskOrchestrator {
    /**
     * Get board from artifact body
     * If artifact doesn't exist, automatically creates it (lazy initialization)
     */
    async getBoard(userId: string, teamId: string): Promise<KanbanBoard | null> {
        // Query by teamId only - team artifacts are shared across all team members
        // The accountId filter was causing issues when different users access the same team
        let artifact = await db.artifact.findFirst({
            where: { id: teamId }
        });

        // Artifact must be created by client (Kanban) first - server cannot create encrypted artifacts
        // This is by design: encryption keys are negotiated in Kanban client only
        if (!artifact) {
            log({ module: 'task-orchestrator', teamId, userId, level: 'warn' },
                'Team artifact not found in database. Team must be created from Kanban UI first (encryption key requirement). See DOC/TEAM_CREATION_WORKFLOW.md');
            return null;
        }

        // Defensive check: artifact.body may be null if team not fully initialized
        if (!artifact.body) {
            log({ module: 'task-orchestrator', teamId, userId, level: 'warn' },
                'Team artifact exists but body is null - team initialization incomplete. Please open team in Kanban to complete setup.');
            return null;
        }

        try {
            const parsed = parseTeamArtifactBody(artifact.body) as Record<string, any>;
            return {
                columns: parsed.columns || DEFAULT_COLUMNS,
                tasks: parsed.tasks || [],
                version: parsed.version || artifact.bodyVersion,
                updatedAt: parsed.updatedAt || artifact.updatedAt.getTime(),
                team: parsed.team
            };
        } catch {
            return {
                columns: DEFAULT_COLUMNS,
                tasks: [],
                version: artifact.bodyVersion,
                updatedAt: artifact.updatedAt.getTime()
            };
        }
    }

    /**
     * Save board to artifact and broadcast update
     */
    private async saveBoard(
        userId: string,
        teamId: string,
        board: KanbanBoard,
        eventType: 'task-created' | 'task-updated' | 'task-deleted',
        taskId: string,
        taskData?: Partial<KanbanTask>
    ): Promise<void> {
        board.version = (board.version || 0) + 1;
        board.updatedAt = Date.now();

        const bodyBuffer = Buffer.from(JSON.stringify(board));

        await db.artifact.update({
            where: { id: teamId },
            data: {
                body: bodyBuffer,
                bodyVersion: { increment: 1 },
                updatedAt: new Date()
            }
        });

        // Broadcast to all connected clients via WebSocket
        await this.broadcastTaskEvent(userId, teamId, eventType, taskId, taskData);
    }

    private appendTaskComment(task: KanbanTask, input: TaskCommentInput): TaskComment {
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

    private buildAutomaticTransitionComment(input: {
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


    private buildTaskActor(input?: TaskActorInfo | null): TaskActorInfo | undefined {
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

    private isHumanActor(actor?: TaskActorInfo | null): boolean {
        if (!actor) {
            return false;
        }

        if (actor.kind === 'human') {
            return true;
        }

        const normalizedRole = actor.role?.trim().toLowerCase();
        return normalizedRole === 'user' || normalizedRole === 'human';
    }

    private buildHumanStatusLock(input: {
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

    private buildHumanLockErrorMessage(lock?: HumanStatusLock | null): string {
        if (lock?.mode === 'manual-status') {
            return 'TASK_LOCKED_BY_HUMAN: This task status was manually set by the user. Call list_tasks to see updated status.';
        }

        const lockedBy = lock?.lockedByDisplayName || lock?.lockedBySessionId || 'a human';
        return `TASK_LOCKED_BY_HUMAN: This task is currently locked by ${lockedBy}. Call list_tasks to see updated status.`;
    }

    private assertHumanStatusLockAllowsMutation(task: KanbanTask, actor?: TaskActorInfo): void {
        if (!task.humanStatusLock) {
            return;
        }

        if (this.isHumanActor(actor)) {
            return;
        }

        throw new TaskOperationError(
            TASK_ERROR_CODES.TASK_LOCKED_BY_HUMAN,
            this.buildHumanLockErrorMessage(task.humanStatusLock),
            {
                taskId: task.id,
                humanStatusLock: task.humanStatusLock,
                attemptedBySessionId: actor?.sessionId,
                attemptedByRole: actor?.role,
            },
        );
    }

    private applyManualHumanStatusLock(
        task: KanbanTask,
        actor: TaskActorInfo | undefined,
        previousStatus: string,
        nextStatus: string,
        explicitComment?: string,
    ): void {
        if (!this.isHumanActor(actor) || previousStatus === nextStatus) {
            return;
        }

        task.humanStatusLock = this.buildHumanStatusLock({
            actor,
            mode: 'manual-status',
            reason: explicitComment || `Manual status change to ${nextStatus}`,
        });

        this.appendTaskComment(task, {
            sessionId: actor?.sessionId ?? 'user',
            role: actor?.role ?? 'user',
            displayName: actor?.displayName,
            type: 'human-override',
            content: explicitComment || `${actor?.displayName || 'User'} manually changed status from ${previousStatus} to ${nextStatus}. Agent status changes are now locked until the human clears the lock.`,
            fromStatus: previousStatus,
            toStatus: nextStatus,
        });
    }

    /**
     * Broadcast task event to all team member sessions
     *
     * FIX: Previously only broadcasted to task creator's connections.
     * Now broadcasts to ALL team member sessions using specific-sessions filter,
     * matching the pattern used in teamMessagesRoutes.ts
     */
    private async broadcastTaskEvent(
        userId: string,
        teamId: string,
        eventType: 'task-created' | 'task-updated' | 'task-deleted',
        taskId: string,
        taskData?: Partial<KanbanTask>
    ): Promise<void> {
        const updSeq = await allocateUserSeq(userId);

        const payload = {
            id: randomKeyNaked(12),
            seq: updSeq,
            body: {
                t: eventType,
                teamId,
                taskId,
                task: taskData
            },
            createdAt: Date.now()
        };

        // Get all sessions for the user to broadcast to all team members
        // This matches the pattern used in teamMessagesRoutes.ts
        const allSessions = await db.session.findMany({
            where: { accountId: userId },
            select: { id: true }
        });

        const teamSessionIds = new Set<string>();
        for (const session of allSessions) {
            teamSessionIds.add(session.id);
        }

        if (teamSessionIds.size > 0) {
            // Broadcast to all team member sessions using specific-sessions filter
            // This ensures assignees receive task assignment notifications
            eventRouter.emitUpdate({
                userId,
                payload,
                recipientFilter: { type: 'specific-sessions', sessionIds: teamSessionIds }
            });

            log({ module: 'task-orchestrator', teamId, taskId },
                `Broadcasted ${eventType} to ${teamSessionIds.size} sessions`);
        } else {
            // Fallback to all-user-authenticated-connections if no sessions found
            eventRouter.emitUpdate({
                userId,
                payload,
                recipientFilter: { type: 'all-user-authenticated-connections' }
            });

            log({ module: 'task-orchestrator', teamId, taskId },
                `Broadcasted ${eventType} (fallback to all connections)`);
        }
    }

    /**
     * List all tasks with optional filtering
     */
    async listTasks(
        userId: string,
        teamId: string,
        filters?: { status?: string; assigneeId?: string }
    ): Promise<{ tasks: KanbanTask[]; version: number }> {
        const board = await this.getBoard(userId, teamId);
        if (!board) {
            throw new Error('Team not initialized. Please create/open this team in Kanban dashboard first. See DOC/TEAM_CREATION_WORKFLOW.md for details.');
        }

        let tasks = board.tasks;
        if (filters?.status) {
            tasks = tasks.filter(t => t.status === filters.status);
        }
        if (filters?.assigneeId) {
            tasks = tasks.filter(t => t.assigneeId === filters.assigneeId);
        }

        return { tasks, version: board.version || 1 };
    }

    /**
     * Get a single task by ID
     */
    async getTask(userId: string, teamId: string, taskId: string): Promise<KanbanTask | null> {
        const board = await this.getBoard(userId, teamId);
        if (!board) return null;
        return board.tasks.find(t => t.id === taskId) || null;
    }

    async addTaskComment(
        userId: string,
        teamId: string,
        taskId: string,
        commentInput: TaskCommentInput
    ): Promise<KanbanTask> {
        const board = await this.getBoard(userId, teamId);
        if (!board) throw new Error('Team not initialized. Please create/open this team in Kanban dashboard first. See DOC/TEAM_CREATION_WORKFLOW.md for details.');

        const taskIndex = board.tasks.findIndex((task) => task.id === taskId);
        if (taskIndex === -1) throw new Error('Task not found');

        const task = board.tasks[taskIndex];
        this.appendTaskComment(task, commentInput);
        board.tasks[taskIndex] = task;

        await this.saveBoard(userId, teamId, board, 'task-updated', taskId, task);

        log({ module: 'task-orchestrator', teamId, taskId }, 'Task comment added');
        return task;
    }

    async setHumanStatusLock(
        userId: string,
        teamId: string,
        taskId: string,
        input: TaskActorInfo & {
            mode: HumanStatusLock['mode'];
            reason?: string;
            comment?: string;
        }
    ): Promise<KanbanTask> {
        const board = await this.getBoard(userId, teamId);
        if (!board) throw new Error('Team not initialized. Please create/open this team in Kanban dashboard first. See DOC/TEAM_CREATION_WORKFLOW.md for details.');

        const taskIndex = board.tasks.findIndex((task) => task.id === taskId);
        if (taskIndex === -1) throw new Error('Task not found');

        const task = board.tasks[taskIndex];
        const actor = this.buildTaskActor({
            ...input,
            kind: input.kind ?? 'human',
        });
        task.humanStatusLock = this.buildHumanStatusLock({
            actor,
            mode: input.mode,
            reason: input.reason,
        });
        task.updatedAt = Date.now();

        if (input.comment?.trim()) {
            this.appendTaskComment(task, {
                sessionId: actor?.sessionId ?? 'user',
                role: actor?.role ?? 'user',
                displayName: actor?.displayName,
                type: 'human-override',
                content: input.comment.trim(),
            });
        }

        board.tasks[taskIndex] = task;
        await this.saveBoard(userId, teamId, board, 'task-updated', taskId, task);

        log({ module: 'task-orchestrator', teamId, taskId }, 'Human status lock set');
        return task;
    }

    async clearHumanStatusLock(
        userId: string,
        teamId: string,
        taskId: string,
        input?: TaskActorInfo & { comment?: string; mode?: HumanStatusLock['mode'] }
    ): Promise<KanbanTask> {
        const board = await this.getBoard(userId, teamId);
        if (!board) throw new Error('Team not initialized. Please create/open this team in Kanban dashboard first. See DOC/TEAM_CREATION_WORKFLOW.md for details.');

        const taskIndex = board.tasks.findIndex((task) => task.id === taskId);
        if (taskIndex === -1) throw new Error('Task not found');

        const task = board.tasks[taskIndex];
        if (!task.humanStatusLock) {
            return task;
        }
        if (input?.mode && task.humanStatusLock.mode !== input.mode) {
            return task;
        }

        const actor = this.buildTaskActor(input ?? { kind: 'human' });
        task.humanStatusLock = null;
        task.updatedAt = Date.now();

        if (input?.comment?.trim()) {
            this.appendTaskComment(task, {
                sessionId: actor?.sessionId ?? 'user',
                role: actor?.role ?? 'user',
                displayName: actor?.displayName,
                type: 'human-override',
                content: input.comment.trim(),
            });
        }

        board.tasks[taskIndex] = task;
        await this.saveBoard(userId, teamId, board, 'task-updated', taskId, task);

        log({ module: 'task-orchestrator', teamId, taskId }, 'Human status lock cleared');
        return task;
    }

    /**
     * Create a new task
     */
    async createTask(
        userId: string,
        teamId: string,
        task: Omit<KanbanTask, 'id' | 'createdAt' | 'updatedAt'>
    ): Promise<KanbanTask> {
        const board = await this.getBoard(userId, teamId);
        if (!board) throw new Error('Team not initialized. Please create/open this team in Kanban dashboard first. See DOC/TEAM_CREATION_WORKFLOW.md for details.');

        const newTask: KanbanTask = {
            ...task,
            id: randomKeyNaked(12),
            status: task.status || 'todo',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            comments: task.comments || [],
            depth: task.parentTaskId ? this.getTaskDepth(board, task.parentTaskId) + 1 : 0,
            statusPropagation: task.statusPropagation || { ...DEFAULT_STATUS_PROPAGATION }
        };

        // Validate max depth
        if (newTask.depth && newTask.depth > 3) {
            throw new Error('Maximum nesting depth (3) exceeded');
        }

        // If creating subtask, update parent
        if (task.parentTaskId) {
            const parent = board.tasks.find(t => t.id === task.parentTaskId);
            if (parent) {
                parent.subtaskIds = parent.subtaskIds || [];
                parent.subtaskIds.push(newTask.id);
                parent.updatedAt = Date.now();
                // Auto-start parent if it's todo
                if (parent.status === 'todo') {
                    parent.status = 'in-progress';
                }
            }
        }

        board.tasks.push(newTask);
        await this.saveBoard(userId, teamId, board, 'task-created', newTask.id, newTask);

        log({ module: 'task-orchestrator', teamId, taskId: newTask.id }, 'Task created');
        return newTask;
    }

    /**
     * Update an existing task
     */
    async updateTask(
        userId: string,
        teamId: string,
        taskId: string,
        updates: Partial<KanbanTask> & { comment?: TaskCommentInput; actor?: TaskActorInfo }
    ): Promise<KanbanTask> {
        const board = await this.getBoard(userId, teamId);
        if (!board) throw new Error('Team not initialized. Please create/open this team in Kanban dashboard first. See DOC/TEAM_CREATION_WORKFLOW.md for details.');

        const taskIndex = board.tasks.findIndex(t => t.id === taskId);
        if (taskIndex === -1) throw new Error('Task not found');

        const task = board.tasks[taskIndex];
        const previousStatus = task.status;
        const previousAssignee = task.assigneeId ?? null;
        const previousApprovalStatus = task.approvalStatus;
        const { comment, actor: rawActor, ...taskUpdates } = updates;
        const actor = this.buildTaskActor(rawActor ?? {
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
            this.assertHumanStatusLockAllowsMutation(task, actor);
        }

        const updatedTask: KanbanTask = {
            ...task,
            ...taskUpdates,
            id: taskId,
            createdAt: task.createdAt,
            updatedAt: Date.now()
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
            const isHuman = this.isHumanActor(actor);
            this.appendTaskComment(updatedTask, this.buildAutomaticTransitionComment({
                sessionId: actor?.sessionId ?? comment?.sessionId ?? updatedTask.assigneeId ?? task.assigneeId ?? 'system',
                role: actor?.role ?? comment?.role,
                displayName: actor?.displayName ?? comment?.displayName,
                type: taskUpdates.status === 'review' ? 'review-feedback' : 'status-change',
                content: isHuman
                    ? `Status changed from ${previousStatus} to ${taskUpdates.status}.`
                    : (explicitComment || `Status changed from ${previousStatus} to ${taskUpdates.status}.`),
                fromStatus: previousStatus,
                toStatus: taskUpdates.status,
            }));

            if (isHuman) {
                this.applyManualHumanStatusLock(updatedTask, actor, previousStatus, taskUpdates.status, explicitComment);
            }

            consumedExplicitComment = Boolean(explicitComment);
        } else if (comment?.content?.trim()) {
            this.appendTaskComment(updatedTask, comment);
            consumedExplicitComment = true;
        }

        if (taskUpdates.assigneeId !== undefined && taskUpdates.assigneeId !== previousAssignee) {
            this.appendTaskComment(updatedTask, this.buildAutomaticTransitionComment({
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
            this.appendTaskComment(updatedTask, this.buildAutomaticTransitionComment({
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
                await this.handleTaskCompletion(board, updatedTask);
            } else if (taskUpdates.status === 'blocked') {
                this.propagateBlockerToParent(board, task.parentTaskId);
            }
        }

        await this.saveBoard(userId, teamId, board, 'task-updated', taskId, updatedTask);

        log({ module: 'task-orchestrator', teamId, taskId }, 'Task updated');
        return updatedTask;
    }

    /**
     * Delete a task and optionally its subtasks
     */
    async deleteTask(userId: string, teamId: string, taskId: string): Promise<void> {
        const board = await this.getBoard(userId, teamId);
        if (!board) throw new Error('Team not initialized. Please create/open this team in Kanban dashboard first. See DOC/TEAM_CREATION_WORKFLOW.md for details.');

        const task = board.tasks.find(t => t.id === taskId);
        if (!task) throw new Error('Task not found');

        // Collect all IDs to delete (task + subtasks if cascade)
        const idsToDelete = new Set<string>([taskId]);
        if (task.statusPropagation?.cascadeDeleteSubtasks) {
            this.collectSubtaskIds(board, taskId, idsToDelete);
        }

        // Remove from parent's subtaskIds
        if (task.parentTaskId) {
            const parent = board.tasks.find(t => t.id === task.parentTaskId);
            if (parent?.subtaskIds) {
                parent.subtaskIds = parent.subtaskIds.filter(id => !idsToDelete.has(id));
                parent.updatedAt = Date.now();
            }
        }

        // Remove tasks
        board.tasks = board.tasks.filter(t => !idsToDelete.has(t.id));

        await this.saveBoard(userId, teamId, board, 'task-deleted', taskId);

        log({ module: 'task-orchestrator', teamId, taskId }, `Task deleted (${idsToDelete.size} total)`);
    }

    /**
     * Start working on a task - creates execution link
     */
    async startTask(
        userId: string,
        teamId: string,
        taskId: string,
        sessionId: string,
        role: string,
        comment?: Omit<TaskCommentInput, 'sessionId' | 'role' | 'fromStatus' | 'toStatus'>
    ): Promise<KanbanTask> {
        const board = await this.getBoard(userId, teamId);
        if (!board) throw new Error('Team not initialized. Please create/open this team in Kanban dashboard first. See DOC/TEAM_CREATION_WORKFLOW.md for details.');

        const task = board.tasks.find(t => t.id === taskId);
        if (!task) throw new Error('Task not found');

        const actor = this.buildTaskActor({
            sessionId,
            role,
            displayName: comment?.displayName,
            kind: role === 'user' ? 'human' : undefined,
        });
        this.assertHumanStatusLockAllowsMutation(task, actor);

        const activeLink = task.executionLinks?.find(l => l.status === 'active');
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
            sessionId
        );
        if (duplicateConflict) {
            throw new TaskOperationError(
                TASK_ERROR_CODES.DUPLICATE_EXECUTION_CONFLICT,
                `Task overlaps with active work on ${duplicateConflict.conflictingTaskId}`,
                duplicateConflict,
            );
        }

        task.executionLinks = task.executionLinks || [];
        const existingLink = task.executionLinks.find(l => l.sessionId === sessionId);
        if (existingLink) {
            existingLink.status = 'active';
            existingLink.linkedAt = Date.now();
            existingLink.role = 'primary';
        } else {
            task.executionLinks.push({
                sessionId,
                linkedAt: Date.now(),
                role: 'primary',
                status: 'active'
            });
        }

        const previousStatus = task.status;
        if (task.status === 'todo') {
            task.status = 'in-progress';
        }
        task.assigneeId = sessionId;
        task.updatedAt = Date.now();
        this.appendTaskComment(task, {
            sessionId,
            role,
            displayName: comment?.displayName,
            type: 'status-change',
            content: comment?.content?.trim() || `Task started by ${comment?.displayName || role || sessionId}.`,
            fromStatus: previousStatus,
            toStatus: task.status,
            mentions: comment?.mentions,
        });

        const taskIndex = board.tasks.findIndex(t => t.id === taskId);
        board.tasks[taskIndex] = task;

        await this.saveBoard(userId, teamId, board, 'task-updated', taskId, task);

        log({ module: 'task-orchestrator', teamId, taskId, sessionId }, 'Task started');
        return task;
    }

    /**
     * Complete a task - triggers status propagation
     */
    async completeTask(
        userId: string,
        teamId: string,
        taskId: string,
        sessionId: string,
        comment?: Omit<TaskCommentInput, 'sessionId' | 'fromStatus' | 'toStatus'>
    ): Promise<KanbanTask> {
        const board = await this.getBoard(userId, teamId);
        if (!board) throw new Error('Team not initialized. Please create/open this team in Kanban dashboard first. See DOC/TEAM_CREATION_WORKFLOW.md for details.');

        const task = board.tasks.find(t => t.id === taskId);
        if (!task) throw new Error('Task not found');

        this.assertHumanStatusLockAllowsMutation(task, this.buildTaskActor({
            sessionId,
            role: comment?.role,
            displayName: comment?.displayName,
            kind: comment?.role === 'user' ? 'human' : undefined,
        }));

        if (task.subtaskIds?.length) {
            const subtasks = board.tasks.filter(t => task.subtaskIds!.includes(t.id));
            const incomplete = subtasks.filter(st => st.status !== 'done');
            if (incomplete.length > 0) {
                throw new Error(`Cannot complete: ${incomplete.length} subtasks still pending`);
            }
        }

        task.executionLinks = cleanupActiveExecutionLinks(task.executionLinks, sessionId);

        const previousStatus = task.status;
        task.status = 'done';
        task.updatedAt = Date.now();
        this.appendTaskComment(task, {
            sessionId,
            role: comment?.role,
            displayName: comment?.displayName,
            type: 'status-change',
            content: comment?.content?.trim() || `Task completed by ${comment?.displayName || comment?.role || sessionId}.`,
            fromStatus: previousStatus,
            toStatus: 'done',
            mentions: comment?.mentions,
        });

        const taskIndex = board.tasks.findIndex(t => t.id === taskId);
        board.tasks[taskIndex] = task;

        await this.handleTaskCompletion(board, task);
        await this.saveBoard(userId, teamId, board, 'task-updated', taskId, task);

        log({ module: 'task-orchestrator', teamId, taskId }, 'Task completed');
        return task;
    }

    /**
     * Report a blocker on a task
     */
    async reportBlocker(
        userId: string,
        teamId: string,
        taskId: string,
        sessionId: string,
        blocker: { type: TaskBlocker['type']; description: string; role?: string; displayName?: string; mentions?: string[]; comment?: string }
    ): Promise<KanbanTask> {
        const board = await this.getBoard(userId, teamId);
        if (!board) throw new Error('Team not initialized. Please create/open this team in Kanban dashboard first. See DOC/TEAM_CREATION_WORKFLOW.md for details.');

        const task = board.tasks.find(t => t.id === taskId);
        if (!task) throw new Error('Task not found');

        this.assertHumanStatusLockAllowsMutation(task, this.buildTaskActor({
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
            raisedBy: sessionId
        };

        task.blockers = task.blockers || [];
        task.blockers.push(newBlocker);
        const previousStatus = task.status;
        task.status = 'blocked';
        task.updatedAt = Date.now();
        this.appendTaskComment(task, {
            sessionId,
            role: blocker.role,
            displayName: blocker.displayName,
            type: 'blocker',
            content: blocker.comment?.trim() || blocker.description,
            fromStatus: previousStatus,
            toStatus: 'blocked',
            mentions: blocker.mentions,
        });

        this.propagateBlockerToParent(board, task.parentTaskId);

        const taskIndex = board.tasks.findIndex(t => t.id === taskId);
        board.tasks[taskIndex] = task;

        await this.saveBoard(userId, teamId, board, 'task-updated', taskId, task);

        log({ module: 'task-orchestrator', teamId, taskId }, 'Blocker reported');
        return task;
    }

    /**
     * Resolve a blocker
     */
    async resolveBlocker(
        userId: string,
        teamId: string,
        taskId: string,
        blockerId: string,
        sessionId: string,
        resolution: string,
        comment?: Omit<TaskCommentInput, 'sessionId'>
    ): Promise<KanbanTask> {
        const board = await this.getBoard(userId, teamId);
        if (!board) throw new Error('Team not initialized. Please create/open this team in Kanban dashboard first. See DOC/TEAM_CREATION_WORKFLOW.md for details.');

        const task = board.tasks.find(t => t.id === taskId);
        if (!task) throw new Error('Task not found');

        const blocker = task.blockers?.find(b => b.id === blockerId);
        if (!blocker) throw new Error('Blocker not found');

        const actor = this.buildTaskActor({
            sessionId,
            role: comment?.role,
            displayName: comment?.displayName,
            kind: comment?.role === 'user' ? 'human' : undefined,
        });
        const unresolvedBlockers = task.blockers?.filter(b => !b.resolvedAt) || [];
        if (unresolvedBlockers.length <= 1) {
            this.assertHumanStatusLockAllowsMutation(task, actor);
        }

        blocker.resolvedAt = Date.now();
        blocker.resolvedBy = sessionId;
        blocker.resolution = resolution;

        const remainingBlockers = task.blockers?.filter(b => !b.resolvedAt) || [];
        if (remainingBlockers.length === 0) {
            task.status = 'in-progress';
        }
        task.updatedAt = Date.now();
        this.appendTaskComment(task, {
            sessionId,
            role: comment?.role,
            displayName: comment?.displayName,
            type: 'decision',
            content: comment?.content?.trim() || resolution,
            mentions: comment?.mentions,
        });

        this.updateParentBlockedStatus(board, task.parentTaskId);

        const taskIndex = board.tasks.findIndex(t => t.id === taskId);
        board.tasks[taskIndex] = task;

        await this.saveBoard(userId, teamId, board, 'task-updated', taskId, task);

        log({ module: 'task-orchestrator', teamId, taskId, blockerId }, 'Blocker resolved');
        return task;
    }

    // === Helper Methods ===

    private getTaskDepth(board: KanbanBoard, parentId: string | null | undefined): number {
        if (!parentId) return -1;
        const parent = board.tasks.find(t => t.id === parentId);
        return parent?.depth ?? 0;
    }

    private collectSubtaskIds(board: KanbanBoard, taskId: string, ids: Set<string>): void {
        const task = board.tasks.find(t => t.id === taskId);
        if (!task?.subtaskIds) return;

        for (const subtaskId of task.subtaskIds) {
            if (ids.has(subtaskId)) continue; // cycle guard
            ids.add(subtaskId);
            this.collectSubtaskIds(board, subtaskId, ids);
        }
    }

    private async handleTaskCompletion(board: KanbanBoard, task: KanbanTask, visited: Set<string> = new Set()): Promise<void> {
        if (!task.parentTaskId) return;
        if (visited.has(task.parentTaskId)) return; // cycle guard
        visited.add(task.parentTaskId);

        const propagation = task.statusPropagation ?? DEFAULT_STATUS_PROPAGATION;
        if (!propagation.autoCompleteParent) return;

        const parent = board.tasks.find(t => t.id === task.parentTaskId);
        if (!parent) return;

        // Check if all siblings are done
        const siblings = board.tasks.filter(t => parent.subtaskIds?.includes(t.id));
        const allDone = siblings.every(s => s.status === 'done');

        if (allDone && parent.status !== 'done') {
            parent.status = 'review'; // Move to review, not auto-done
            parent.updatedAt = Date.now();
            parent.executionLinks = cleanupActiveExecutionLinks(parent.executionLinks, parent.assigneeId);

            // Recurse up
            await this.handleTaskCompletion(board, parent, visited);
        }
    }

    private propagateBlockerToParent(board: KanbanBoard, parentId: string | null | undefined, visited: Set<string> = new Set()): void {
        if (!parentId) return;
        if (visited.has(parentId)) return; // cycle guard
        visited.add(parentId);

        const parent = board.tasks.find(t => t.id === parentId);
        if (!parent) return;

        const propagation = parent.statusPropagation ?? DEFAULT_STATUS_PROPAGATION;
        if (!propagation.blockParentOnBlocked) return;

        parent.hasBlockedChild = true;
        parent.updatedAt = Date.now();

        // Recurse up
        this.propagateBlockerToParent(board, parent.parentTaskId, visited);
    }

    private updateParentBlockedStatus(board: KanbanBoard, parentId: string | null | undefined, visited: Set<string> = new Set()): void {
        if (!parentId) return;
        if (visited.has(parentId)) return; // cycle guard
        visited.add(parentId);

        const parent = board.tasks.find(t => t.id === parentId);
        if (!parent) return;

        // Check if any subtask is still blocked
        const subtasks = board.tasks.filter(t => parent.subtaskIds?.includes(t.id));
        const hasBlockedSubtask = subtasks.some(st => st.status === 'blocked' || st.hasBlockedChild);

        parent.hasBlockedChild = hasBlockedSubtask;
        parent.updatedAt = Date.now();

        // Recurse up
        this.updateParentBlockedStatus(board, parent.parentTaskId, visited);
    }
}

// Singleton instance
export const taskOrchestrator = new TaskOrchestrator();
