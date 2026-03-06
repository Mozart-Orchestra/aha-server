import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

const testState = vi.hoisted(() => ({
    createTask: vi.fn(),
    updateTask: vi.fn(),
}));

vi.mock('@/app/task/taskOrchestrator', () => ({
    taskOrchestrator: {
        createTask: testState.createTask,
        updateTask: testState.updateTask,
        listTasks: vi.fn(),
        getTask: vi.fn(),
        deleteTask: vi.fn(),
        startTask: vi.fn(),
        completeTask: vi.fn(),
        addBlocker: vi.fn(),
        reorderTasks: vi.fn(),
        resolveBlocker: vi.fn(),
        refineTask: vi.fn(),
        rewriteTask: vi.fn(),
    },
}));

vi.mock('@/utils/log', () => ({
    log: vi.fn(),
}));

import { taskRoutes } from './taskRoutes';

function buildApp() {
    const app = fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorateRequest('userId', '');
    app.decorate('authenticate', async (request: { userId: string }) => {
        request.userId = 'user-1';
    });
    app.register(taskRoutes);
    return app;
}

describe('taskRoutes', () => {
    beforeEach(() => {
        testState.createTask.mockReset();
        testState.updateTask.mockReset();
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('accepts dueDate and dependencies when creating tasks', async () => {
        const app = buildApp();

        testState.createTask.mockResolvedValue({
            id: 'task-1',
            title: 'Ship gantt view',
            description: 'Add a real schedule bar',
            status: 'todo',
            priority: 'high',
            assigneeId: 'builder',
            createdAt: 1,
            updatedAt: 2,
            dueDate: 1_731_110_400_000,
            dependencies: ['task-0'],
        });

        const response = await app.inject({
            method: 'POST',
            url: '/v1/teams/team-1/tasks',
            payload: {
                title: 'Ship gantt view',
                description: 'Add a real schedule bar',
                status: 'todo',
                priority: 'high',
                assigneeId: 'builder',
                dueDate: 1_731_110_400_000,
                dependencies: ['task-0'],
            },
        });

        expect(response.statusCode).toBe(200);
        expect(testState.createTask).toHaveBeenCalledWith('user-1', 'team-1', expect.objectContaining({
            dueDate: 1_731_110_400_000,
            dependencies: ['task-0'],
        }));

        expect(response.json()).toEqual({
            success: true,
            task: expect.objectContaining({
                id: 'task-1',
                teamId: 'team-1',
                dueDate: 1_731_110_400_000,
                dependencies: ['task-0'],
            }),
        });

        await app.close();
    });

    it('accepts schedule edits when updating tasks', async () => {
        const app = buildApp();

        testState.updateTask.mockResolvedValue({
            id: 'task-2',
            title: 'Polish review states',
            status: 'review',
            createdAt: 1,
            updatedAt: 3,
            dueDate: null,
            dependencies: ['task-1', 'task-3'],
        });

        const response = await app.inject({
            method: 'PUT',
            url: '/v1/teams/team-9/tasks/task-2',
            payload: {
                dueDate: null,
                dependencies: ['task-1', 'task-3'],
                status: 'review',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(testState.updateTask).toHaveBeenCalledWith('user-1', 'team-9', 'task-2', expect.objectContaining({
            dueDate: null,
            dependencies: ['task-1', 'task-3'],
            status: 'review',
        }));

        expect(response.json()).toEqual({
            success: true,
            task: expect.objectContaining({
                id: 'task-2',
                teamId: 'team-9',
                dueDate: null,
                dependencies: ['task-1', 'task-3'],
                status: 'review',
            }),
        });

        await app.close();
    });
});
