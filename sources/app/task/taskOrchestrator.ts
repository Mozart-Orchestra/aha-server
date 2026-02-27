import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { eventRouter } from "@/app/events/eventRouter";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { parseTeamArtifactBody } from "@/utils/teamArtifacts";
import * as privacyKit from "privacy-kit";

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
    labels?: string[];
    approvalStatus?: 'pending' | 'approved' | 'rejected';
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

        const bodyBuffer = new Uint8Array(Buffer.from(JSON.stringify(board)));

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
        updates: Partial<KanbanTask>
    ): Promise<KanbanTask> {
        const board = await this.getBoard(userId, teamId);
        if (!board) throw new Error('Team not initialized. Please create/open this team in Kanban dashboard first. See DOC/TEAM_CREATION_WORKFLOW.md for details.');

        const taskIndex = board.tasks.findIndex(t => t.id === taskId);
        if (taskIndex === -1) throw new Error('Task not found');

        const task = board.tasks[taskIndex];
        const previousStatus = task.status;

        // Apply updates (preserve id, createdAt)
        const updatedTask: KanbanTask = {
            ...task,
            ...updates,
            id: taskId,
            createdAt: task.createdAt,
            updatedAt: Date.now()
        };

        board.tasks[taskIndex] = updatedTask;

        // Handle status change propagation
        if (updates.status && updates.status !== previousStatus) {
            if (updates.status === 'done') {
                await this.handleTaskCompletion(board, updatedTask);
            } else if (updates.status === 'blocked') {
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
        role: string
    ): Promise<KanbanTask> {
        const board = await this.getBoard(userId, teamId);
        if (!board) throw new Error('Team not initialized. Please create/open this team in Kanban dashboard first. See DOC/TEAM_CREATION_WORKFLOW.md for details.');

        const task = board.tasks.find(t => t.id === taskId);
        if (!task) throw new Error('Task not found');

        // Check for existing active link
        const activeLink = task.executionLinks?.find(l => l.status === 'active');
        if (activeLink && activeLink.sessionId !== sessionId) {
            throw new Error(`Task already being executed by session ${activeLink.sessionId}`);
        }

        // Add execution link
        task.executionLinks = task.executionLinks || [];
        task.executionLinks.push({
            sessionId,
            linkedAt: Date.now(),
            role: 'primary',
            status: 'active'
        });

        // Update status
        if (task.status === 'todo') {
            task.status = 'in-progress';
        }
        task.assigneeId = sessionId;
        task.updatedAt = Date.now();

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
        sessionId: string
    ): Promise<KanbanTask> {
        const board = await this.getBoard(userId, teamId);
        if (!board) throw new Error('Team not initialized. Please create/open this team in Kanban dashboard first. See DOC/TEAM_CREATION_WORKFLOW.md for details.');

        const task = board.tasks.find(t => t.id === taskId);
        if (!task) throw new Error('Task not found');

        // Check for incomplete subtasks
        if (task.subtaskIds?.length) {
            const subtasks = board.tasks.filter(t => task.subtaskIds!.includes(t.id));
            const incomplete = subtasks.filter(st => st.status !== 'done');
            if (incomplete.length > 0) {
                throw new Error(`Cannot complete: ${incomplete.length} subtasks still pending`);
            }
        }

        // Update execution link
        const activeLink = task.executionLinks?.find(l => l.sessionId === sessionId && l.status === 'active');
        if (activeLink) {
            activeLink.status = 'completed';
        }

        task.status = 'done';
        task.updatedAt = Date.now();

        const taskIndex = board.tasks.findIndex(t => t.id === taskId);
        board.tasks[taskIndex] = task;

        // Handle completion propagation
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
        blocker: { type: TaskBlocker['type']; description: string }
    ): Promise<KanbanTask> {
        const board = await this.getBoard(userId, teamId);
        if (!board) throw new Error('Team not initialized. Please create/open this team in Kanban dashboard first. See DOC/TEAM_CREATION_WORKFLOW.md for details.');

        const task = board.tasks.find(t => t.id === taskId);
        if (!task) throw new Error('Task not found');

        const newBlocker: TaskBlocker = {
            id: randomKeyNaked(8),
            type: blocker.type,
            description: blocker.description,
            raisedAt: Date.now(),
            raisedBy: sessionId
        };

        task.blockers = task.blockers || [];
        task.blockers.push(newBlocker);
        task.status = 'blocked';
        task.updatedAt = Date.now();

        // Propagate blocker to parent
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
        resolution: string
    ): Promise<KanbanTask> {
        const board = await this.getBoard(userId, teamId);
        if (!board) throw new Error('Team not initialized. Please create/open this team in Kanban dashboard first. See DOC/TEAM_CREATION_WORKFLOW.md for details.');

        const task = board.tasks.find(t => t.id === taskId);
        if (!task) throw new Error('Task not found');

        const blocker = task.blockers?.find(b => b.id === blockerId);
        if (!blocker) throw new Error('Blocker not found');

        blocker.resolvedAt = Date.now();
        blocker.resolvedBy = sessionId;
        blocker.resolution = resolution;

        // Check if all blockers resolved
        const unresolvedBlockers = task.blockers?.filter(b => !b.resolvedAt) || [];
        if (unresolvedBlockers.length === 0) {
            task.status = 'in-progress';
        }
        task.updatedAt = Date.now();

        // Update parent's hasBlockedChild
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
            ids.add(subtaskId);
            this.collectSubtaskIds(board, subtaskId, ids);
        }
    }

    private async handleTaskCompletion(board: KanbanBoard, task: KanbanTask): Promise<void> {
        if (!task.parentTaskId) return;

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

            // Recurse up
            await this.handleTaskCompletion(board, parent);
        }
    }

    private propagateBlockerToParent(board: KanbanBoard, parentId: string | null | undefined): void {
        if (!parentId) return;

        const parent = board.tasks.find(t => t.id === parentId);
        if (!parent) return;

        const propagation = parent.statusPropagation ?? DEFAULT_STATUS_PROPAGATION;
        if (!propagation.blockParentOnBlocked) return;

        parent.hasBlockedChild = true;
        parent.updatedAt = Date.now();

        // Recurse up
        this.propagateBlockerToParent(board, parent.parentTaskId);
    }

    private updateParentBlockedStatus(board: KanbanBoard, parentId: string | null | undefined): void {
        if (!parentId) return;

        const parent = board.tasks.find(t => t.id === parentId);
        if (!parent) return;

        // Check if any subtask is still blocked
        const subtasks = board.tasks.filter(t => parent.subtaskIds?.includes(t.id));
        const hasBlockedSubtask = subtasks.some(st => st.status === 'blocked' || st.hasBlockedChild);

        parent.hasBlockedChild = hasBlockedSubtask;
        parent.updatedAt = Date.now();

        // Recurse up
        this.updateParentBlockedStatus(board, parent.parentTaskId);
    }
}

// Singleton instance
export const taskOrchestrator = new TaskOrchestrator();
