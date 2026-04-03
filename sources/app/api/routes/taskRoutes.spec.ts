import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

import { TaskOperationError, TASK_ERROR_CODES } from '@/app/task/taskErrors';

const mocked = vi.hoisted(() => ({
    listTasks: vi.fn(),
    getTask: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    setHumanStatusLock: vi.fn(),
    clearHumanStatusLock: vi.fn(),
    deleteTask: vi.fn(),
    startTask: vi.fn(),
    completeTask: vi.fn(),
    reportBlocker: vi.fn(),
    resolveBlocker: vi.fn(),
    addTaskComment: vi.fn(),
    invalidateTeamOverviewSnapshot: vi.fn(),
    observeSessionActivity: vi.fn(),
    getAccessibleTeamArtifact: vi.fn(),
}));

vi.mock('@/app/task/taskOrchestrator', () => ({
    taskOrchestrator: {
        listTasks: mocked.listTasks,
        getTask: mocked.getTask,
        createTask: mocked.createTask,
        updateTask: mocked.updateTask,
        setHumanStatusLock: mocked.setHumanStatusLock,
        clearHumanStatusLock: mocked.clearHumanStatusLock,
        deleteTask: mocked.deleteTask,
        startTask: mocked.startTask,
        completeTask: mocked.completeTask,
        reportBlocker: mocked.reportBlocker,
        resolveBlocker: mocked.resolveBlocker,
        addTaskComment: mocked.addTaskComment,
    },
}));

vi.mock('@/app/team/teamOverview', () => ({
    invalidateTeamOverviewSnapshot: mocked.invalidateTeamOverviewSnapshot,
}));

vi.mock('@/app/presence/observeSessionActivity', () => ({
    observeSessionActivity: mocked.observeSessionActivity,
}));

vi.mock('@/app/team/teamArtifacts', () => ({
    getAccessibleTeamArtifact: mocked.getAccessibleTeamArtifact,
}));

import { taskRoutes } from './taskRoutes';

function buildApp(options?: {
    authenticate?: (request: any, reply: any) => unknown | Promise<unknown>;
}) {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    typed.decorate('authenticate', options?.authenticate || (async (request: any) => {
        request.userId = 'user-1';
    }));
    taskRoutes(typed);
    return typed;
}

function buildTask(id = 'task-1') {
    return {
        id,
        title: `Task ${id}`,
        status: 'todo',
        createdAt: 1,
        updatedAt: 1,
    };
}

describe('taskRoutes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocked.getAccessibleTeamArtifact.mockResolvedValue({
            id: 'team-1',
            accountId: 'user-1',
            body: Buffer.from('{}'),
            createdAt: new Date('2026-03-17T00:00:00Z'),
            updatedAt: new Date('2026-03-17T00:05:00Z'),
        });
    });

    it('lists tasks with status and assignee filters', async () => {
        mocked.listTasks.mockResolvedValue({
            tasks: [buildTask()],
            version: 3,
        });

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/teams/team-1/tasks?status=todo&assigneeId=session-1',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            tasks: [expect.objectContaining({ id: 'task-1' })],
            version: 3,
        });
        expect(mocked.listTasks).toHaveBeenCalledWith('user-1', 'team-1', {
            status: 'todo',
            assigneeId: 'session-1',
        });

        await app.close();
    });

    it('returns 404 before listing tasks when the caller cannot access the team', async () => {
        mocked.getAccessibleTeamArtifact.mockResolvedValueOnce(null);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/teams/team-foreign/tasks',
        });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: 'Team not found' });
        expect(mocked.listTasks).not.toHaveBeenCalled();

        await app.close();
    });

    it('returns 404 when fetching a missing task', async () => {
        mocked.getTask.mockResolvedValue(null);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/teams/team-1/tasks/task-404',
        });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: 'Task not found' });

        await app.close();
    });

    it('creates a task and invalidates the team overview snapshot', async () => {
        mocked.createTask.mockResolvedValue(buildTask('task-new'));

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/teams/team-1/tasks',
            payload: {
                title: 'New task',
                status: 'todo',
                priority: 'high',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            success: true,
            task: expect.objectContaining({ id: 'task-new' }),
        });
        expect(mocked.invalidateTeamOverviewSnapshot).toHaveBeenCalledWith('user-1');

        await app.close();
    });

    it('maps maximum nesting depth errors to 400 on create', async () => {
        mocked.createTask.mockRejectedValue(new Error('Maximum nesting depth (3) exceeded'));

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/teams/team-1/tasks',
            payload: {
                title: 'Deep task',
                parentTaskId: 'parent-1',
            },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({ error: 'Maximum nesting depth (3) exceeded' });

        await app.close();
    });

    it('maps TASK_ACK_REQUIRED to 400 on update', async () => {
        mocked.updateTask.mockRejectedValue(new TaskOperationError(
            TASK_ERROR_CODES.TASK_ACK_REQUIRED,
            'Use start_task to move a task into in-progress; update_task cannot be used as task ack.',
        ));

        const app = buildApp();
        const response = await app.inject({
            method: 'PUT',
            url: '/v1/teams/team-1/tasks/task-1',
            payload: {
                status: 'in-progress',
                actor: { sessionId: 'session-1', role: 'builder' },
            },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({
            error: 'Use start_task to move a task into in-progress; update_task cannot be used as task ack.',
        });

        await app.close();
    });

    it('accepts shorthand string comments on update and normalizes them into TaskComment payloads', async () => {
        mocked.updateTask.mockResolvedValue(buildTask('task-1'));

        const app = buildApp();
        const response = await app.inject({
            method: 'PUT',
            url: '/v1/teams/team-1/tasks/task-1',
            payload: {
                assigneeId: 'session-replacement',
                comment: 'Migrated during replace_agent handoff',
                commentType: 'handoff',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(mocked.updateTask).toHaveBeenCalledWith('user-1', 'team-1', 'task-1', expect.objectContaining({
            assigneeId: 'session-replacement',
            comment: {
                sessionId: 'session-replacement',
                type: 'handoff',
                content: 'Migrated during replace_agent handoff',
            },
        }));

        await app.close();
    });

    it('sets and clears human status lock while observing session activity', async () => {
        mocked.setHumanStatusLock.mockResolvedValue(buildTask('task-lock'));
        mocked.clearHumanStatusLock.mockResolvedValue(buildTask('task-lock'));

        const app = buildApp();

        const lockResponse = await app.inject({
            method: 'POST',
            url: '/v1/teams/team-1/tasks/task-lock/human-lock',
            payload: {
                sessionId: 'session-1',
                role: 'user',
                kind: 'human',
                mode: 'manual-status',
                comment: 'Locked by user',
            },
        });

        expect(lockResponse.statusCode).toBe(200);
        expect(mocked.observeSessionActivity).toHaveBeenCalledWith('user-1', 'session-1', expect.any(Number));

        const clearResponse = await app.inject({
            method: 'POST',
            url: '/v1/teams/team-1/tasks/task-lock/human-lock/clear',
            payload: {
                sessionId: 'session-1',
                comment: 'Unlocked by user',
            },
        });

        expect(clearResponse.statusCode).toBe(200);
        expect(mocked.observeSessionActivity).toHaveBeenCalledWith('user-1', 'session-1', expect.any(Number));

        await app.close();
    });

    it('deletes a task and returns 404 when task is missing', async () => {
        mocked.deleteTask.mockRejectedValue(new Error('Task not found'));

        const app = buildApp();
        const response = await app.inject({
            method: 'DELETE',
            url: '/v1/teams/team-1/tasks/task-404',
        });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: 'Task not found' });

        await app.close();
    });

    it('starts a task and reports duplicate execution conflicts as 400', async () => {
        mocked.startTask.mockRejectedValue(new TaskOperationError(
            TASK_ERROR_CODES.DUPLICATE_EXECUTION_CONFLICT,
            'Task overlaps with active work on task-2',
        ));

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/teams/team-1/tasks/task-1/start',
            payload: {
                sessionId: 'session-1',
                role: 'builder',
                comment: {
                    content: 'Starting task',
                },
            },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({
            error: 'Task overlaps with active work on task-2',
        });

        await app.close();
    });

    it('returns 404 before starting a task when the caller cannot access the team', async () => {
        mocked.getAccessibleTeamArtifact.mockResolvedValueOnce(null);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/teams/team-foreign/tasks/task-1/start',
            payload: {
                sessionId: 'session-1',
                role: 'builder',
            },
        });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: 'Team not found' });
        expect(mocked.startTask).not.toHaveBeenCalled();
        expect(mocked.observeSessionActivity).not.toHaveBeenCalled();

        await app.close();
    });

    it('completes a task and maps incomplete subtasks errors to 400', async () => {
        mocked.completeTask.mockRejectedValue(new Error('Cannot complete: 1 subtasks still pending'));

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/teams/team-1/tasks/task-1/complete',
            payload: {
                sessionId: 'session-1',
                comment: {
                    role: 'builder',
                    content: 'Completing task',
                },
            },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json()).toEqual({
            error: 'Cannot complete: 1 subtasks still pending',
        });

        await app.close();
    });

    it('reports blocker and resolve blocker endpoints, mapping lock and missing blocker errors', async () => {
        mocked.reportBlocker.mockRejectedValue(new TaskOperationError(
            TASK_ERROR_CODES.TASK_LOCKED_BY_HUMAN,
            'TASK_LOCKED_BY_HUMAN: This task is currently locked by a human.',
        ));
        mocked.resolveBlocker.mockRejectedValue(new Error('Blocker not found'));

        const app = buildApp();

        const blockerResponse = await app.inject({
            method: 'POST',
            url: '/v1/teams/team-1/tasks/task-1/blocker',
            payload: {
                sessionId: 'session-1',
                type: 'technical',
                description: 'Blocked by dependency',
            },
        });

        expect(blockerResponse.statusCode).toBe(409);
        expect(blockerResponse.json()).toEqual({
            error: 'TASK_LOCKED_BY_HUMAN: This task is currently locked by a human.',
        });

        const resolveResponse = await app.inject({
            method: 'POST',
            url: '/v1/teams/team-1/tasks/task-1/blocker/blocker-1/resolve',
            payload: {
                sessionId: 'session-1',
                resolution: 'Fixed',
                comment: {
                    role: 'builder',
                    content: 'Resolved blocker',
                },
            },
        });

        expect(resolveResponse.statusCode).toBe(404);
        expect(resolveResponse.json()).toEqual({ error: 'Blocker not found' });

        await app.close();
    });

    it('adds a task comment and observes the commenter session', async () => {
        mocked.addTaskComment.mockResolvedValue(buildTask('task-1'));

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/teams/team-1/tasks/task-1/comments',
            payload: {
                sessionId: 'session-1',
                role: 'builder',
                content: 'Looks good',
                type: 'note',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            success: true,
            task: expect.objectContaining({ id: 'task-1' }),
        });
        expect(mocked.observeSessionActivity).toHaveBeenCalledWith('user-1', 'session-1', expect.any(Number));

        await app.close();
    });

    it('requires authentication for task routes', async () => {
        const app = buildApp({
            authenticate: async (_request, reply) => reply.code(401).send({ error: 'Unauthorized' }),
        });

        const response = await app.inject({
            method: 'GET',
            url: '/v1/teams/team-1/tasks',
        });

        expect(response.statusCode).toBe(401);
        expect(mocked.listTasks).not.toHaveBeenCalled();

        await app.close();
    });
});
