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

export type TaskBoardEventType = 'task-created' | 'task-updated' | 'task-deleted';

export const DEFAULT_STATUS_PROPAGATION: StatusPropagation = {
    autoCompleteParent: true,
    blockParentOnBlocked: true,
    cascadeDeleteSubtasks: false,
};

export const DEFAULT_COLUMNS: KanbanColumn[] = [
    { id: 'todo', title: 'To Do' },
    { id: 'in-progress', title: 'In Progress' },
    { id: 'review', title: 'Review' },
    { id: 'done', title: 'Done' },
];
