import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/storage/db', () => ({
    db: {
        artifact: {
            findFirst: vi.fn(),
            update: vi.fn(),
        },
        session: {
            findMany: vi.fn(),
        },
    },
}));

vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: {
        emitUpdate: vi.fn(),
    },
}));

vi.mock('@/storage/seq', () => ({
    allocateUserSeq: vi.fn().mockResolvedValue(1),
}));

vi.mock('@/utils/randomKeyNaked', () => ({
    randomKeyNaked: vi.fn().mockReturnValue('generated-id'),
}));

import { TaskOperationError, TASK_ERROR_CODES } from './taskErrors';
import {
    TaskOrchestrator,
    type KanbanBoard,
    type KanbanTask,
    type StatusPropagation,
} from './taskOrchestrator';

const DEFAULT_PROPAGATION: StatusPropagation = {
    autoCompleteParent: true,
    blockParentOnBlocked: true,
    cascadeDeleteSubtasks: false,
};

function buildTask(overrides: Partial<KanbanTask> & Pick<KanbanTask, 'id' | 'title'>): KanbanTask {
    const { id, title, ...rest } = overrides;

    return {
        id,
        title,
        status: overrides.status ?? 'todo',
        createdAt: overrides.createdAt ?? 1,
        updatedAt: overrides.updatedAt ?? 1,
        comments: overrides.comments ?? [],
        statusPropagation: overrides.statusPropagation ?? { ...DEFAULT_PROPAGATION },
        ...rest,
    };
}

function buildBoard(tasks: KanbanTask[]): KanbanBoard {
    return {
        columns: [],
        tasks,
        version: 1,
        updatedAt: 1,
    };
}

function wireBoard(orchestrator: TaskOrchestrator, board: KanbanBoard) {
    vi.spyOn(orchestrator, 'getBoard').mockResolvedValue(board as never);
    return vi.spyOn(orchestrator as any, 'saveBoard').mockResolvedValue(undefined);
}

describe('TaskOrchestrator', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('starts a todo task, assigns the session, and records a status-change comment', async () => {
        const task = buildTask({
            id: 'task-1',
            title: 'Write orchestrator tests',
            status: 'todo',
        });
        const board = buildBoard([task]);
        const orchestrator = new TaskOrchestrator();
        const saveBoardSpy = wireBoard(orchestrator, board);

        const result = await orchestrator.startTask(
            'user-1',
            'team-1',
            'task-1',
            'session-1',
            'builder',
            {
                displayName: 'Backend Builder',
                content: '开始执行 orchestrator 测试',
            },
        );

        expect(result.status).toBe('in-progress');
        expect(result.assigneeId).toBe('session-1');
        expect(result.executionLinks).toEqual([
            expect.objectContaining({
                sessionId: 'session-1',
                role: 'primary',
                status: 'active',
            }),
        ]);
        expect(result.comments?.at(-1)).toMatchObject({
            type: 'status-change',
            content: '开始执行 orchestrator 测试',
            fromStatus: 'todo',
            toStatus: 'in-progress',
        });
        expect(saveBoardSpy).toHaveBeenCalledOnce();
    });

    it('rejects duplicate active execution from another session', async () => {
        const task = buildTask({
            id: 'task-1',
            title: 'Existing active task',
            executionLinks: [
                {
                    sessionId: 'session-existing',
                    linkedAt: 1,
                    role: 'primary',
                    status: 'active',
                },
            ],
        });
        const orchestrator = new TaskOrchestrator();
        wireBoard(orchestrator, buildBoard([task]));

        await expect(
            orchestrator.startTask('user-1', 'team-1', 'task-1', 'session-next', 'builder'),
        ).rejects.toMatchObject({
            code: TASK_ERROR_CODES.DUPLICATE_EXECUTION_CONFLICT,
        } satisfies Partial<TaskOperationError>);
    });

    it('requires start_task instead of update_task for todo → in-progress transition', async () => {
        const task = buildTask({
            id: 'task-1',
            title: 'Ack required task',
            status: 'todo',
        });
        const orchestrator = new TaskOrchestrator();
        wireBoard(orchestrator, buildBoard([task]));

        await expect(
            orchestrator.updateTask('user-1', 'team-1', 'task-1', {
                status: 'in-progress',
                actor: { sessionId: 'session-1', role: 'builder' },
            }),
        ).rejects.toMatchObject({
            code: TASK_ERROR_CODES.TASK_ACK_REQUIRED,
        } satisfies Partial<TaskOperationError>);
    });

    it('moves parent to review when all subtasks complete and parent propagation is enabled', async () => {
        const parent = buildTask({
            id: 'parent-1',
            title: 'Parent task',
            status: 'in-progress',
            assigneeId: 'parent-owner',
            subtaskIds: ['child-1'],
            executionLinks: [
                {
                    sessionId: 'parent-owner',
                    linkedAt: 1,
                    role: 'primary',
                    status: 'active',
                },
            ],
            statusPropagation: { ...DEFAULT_PROPAGATION, autoCompleteParent: true },
        });
        const child = buildTask({
            id: 'child-1',
            title: 'Child task',
            status: 'in-progress',
            parentTaskId: 'parent-1',
            executionLinks: [
                {
                    sessionId: 'session-1',
                    linkedAt: 1,
                    role: 'primary',
                    status: 'active',
                },
            ],
        });
        const board = buildBoard([parent, child]);
        const orchestrator = new TaskOrchestrator();
        wireBoard(orchestrator, board);

        await orchestrator.completeTask('user-1', 'team-1', 'child-1', 'session-1', {
            role: 'builder',
            displayName: 'Backend Builder',
            content: '完成子任务',
        });

        expect(child.status).toBe('done');
        expect(parent.status).toBe('review');
        expect(parent.executionLinks).toEqual([
            expect.objectContaining({
                sessionId: 'parent-owner',
                status: 'completed',
            }),
        ]);
    });

    it('does not auto-transition parent when the parent disables autoCompleteParent', async () => {
        const parent = buildTask({
            id: 'parent-1',
            title: 'Manual review parent',
            status: 'in-progress',
            subtaskIds: ['child-1'],
            statusPropagation: { ...DEFAULT_PROPAGATION, autoCompleteParent: false },
        });
        const child = buildTask({
            id: 'child-1',
            title: 'Child task',
            status: 'in-progress',
            parentTaskId: 'parent-1',
        });
        const board = buildBoard([parent, child]);
        const orchestrator = new TaskOrchestrator();
        wireBoard(orchestrator, board);

        await orchestrator.completeTask('user-1', 'team-1', 'child-1', 'session-1', {
            role: 'builder',
            content: '完成子任务',
        });

        expect(child.status).toBe('done');
        expect(parent.status).toBe('in-progress');
    });

    it('rejects creating a subtask when parentTaskId does not exist', async () => {
        const orchestrator = new TaskOrchestrator();
        const saveBoardSpy = wireBoard(orchestrator, buildBoard([]));

        await expect(
            orchestrator.createTask('user-1', 'team-1', {
                title: 'Orphan subtask',
                status: 'todo',
                parentTaskId: 'missing-parent',
            }),
        ).rejects.toThrow('Parent task not found');

        expect(saveBoardSpy).not.toHaveBeenCalled();
    });
});
