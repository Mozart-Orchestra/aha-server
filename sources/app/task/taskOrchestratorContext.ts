import type { KanbanBoard, KanbanTask, TaskBoardEventType } from './taskOrchestratorTypes';

const TEAM_NOT_INITIALIZED_MESSAGE = 'Team not initialized. Please create/open this team in Kanban dashboard first. See DOC/TEAM_CREATION_WORKFLOW.md for details.';

export interface TaskOrchestratorContext {
    getBoard(userId: string, teamId: string): Promise<KanbanBoard | null>;
    saveBoard(
        userId: string,
        teamId: string,
        board: KanbanBoard,
        eventType: TaskBoardEventType,
        taskId: string,
        taskData?: Partial<KanbanTask>,
    ): Promise<void>;
}

export async function requireBoard(
    context: TaskOrchestratorContext,
    userId: string,
    teamId: string,
): Promise<KanbanBoard> {
    const board = await context.getBoard(userId, teamId);
    if (!board) {
        throw new Error(TEAM_NOT_INITIALIZED_MESSAGE);
    }
    return board;
}
