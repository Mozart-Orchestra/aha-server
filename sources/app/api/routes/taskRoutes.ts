import { Fastify } from "../types";
import { z } from "zod";
import { log } from "@/utils/log";
import { taskOrchestrator } from "@/app/task/taskOrchestrator";
import { isTaskOperationError, TASK_ERROR_CODES } from "@/app/task/taskErrors";
import { invalidateTeamOverviewSnapshot } from "@/app/team/teamOverview";
import { observeSessionActivity } from "@/app/presence/observeSessionActivity";

/**
 * Task Routes - Server-Driven Task Management API
 *
 * All task mutations go through server, which:
 * 1. Validates and persists changes
 * 2. Broadcasts updates via WebSocket to all connected clients (CLI + Kanban)
 *
 * This ensures:
 * - Single source of truth (no sync conflicts)
 * - Real-time updates across all clients
 * - Server can continue working even when clients disconnect
 */

const TaskSchema = z.object({
    title: z.string().min(1).max(500),
    description: z.string().max(5000).optional(),
    status: z.enum(['todo', 'in-progress', 'review', 'blocked', 'done']).default('todo'),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    assigneeId: z.string().nullable().optional(),
    reporterId: z.string().optional(),
    parentTaskId: z.string().nullable().optional(),
    labels: z.array(z.string()).optional(),
    approvalStatus: z.enum(['pending', 'approved', 'rejected']).optional()
});

const BlockerSchema = z.object({
    type: z.enum(['dependency', 'question', 'resource', 'technical']),
    description: z.string().min(1).max(1000)
});

export function taskRoutes(app: Fastify) {
    log({ module: 'api' }, 'Registering taskRoutes...');

    // GET /v1/teams/:teamId/tasks - List all tasks
    app.get('/v1/teams/:teamId/tasks', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string()
            }),
            querystring: z.object({
                status: z.enum(['todo', 'in-progress', 'review', 'blocked', 'done']).optional(),
                assigneeId: z.string().optional()
            }),
            response: {
                200: z.object({
                    tasks: z.array(z.any()),
                    version: z.number()
                }),
                404: z.object({
                    error: z.literal('Team not found')
                }),
                500: z.object({
                    error: z.literal('Failed to list tasks')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const { status, assigneeId } = request.query as { status?: string; assigneeId?: string };

        try {
            const result = await taskOrchestrator.listTasks(userId, teamId, { status, assigneeId });
            return reply.send(result);
        } catch (error: any) {
            if (error.message === 'Team not found') {
                return reply.code(404).send({ error: 'Team not found' });
            }
            log({ module: 'task-routes', level: 'error' }, `Failed to list tasks: ${error}`);
            return reply.code(500).send({ error: 'Failed to list tasks' });
        }
    });

    // GET /v1/teams/:teamId/tasks/:taskId - Get single task
    app.get('/v1/teams/:teamId/tasks/:taskId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string(),
                taskId: z.string()
            }),
            response: {
                200: z.any(),
                404: z.object({
                    error: z.string()
                }),
                500: z.object({
                    error: z.literal('Failed to get task')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId, taskId } = request.params as { teamId: string; taskId: string };

        try {
            const task = await taskOrchestrator.getTask(userId, teamId, taskId);
            if (!task) {
                return reply.code(404).send({ error: 'Task not found' });
            }
            return reply.send(task);
        } catch (error) {
            log({ module: 'task-routes', level: 'error' }, `Failed to get task: ${error}`);
            return reply.code(500).send({ error: 'Failed to get task' });
        }
    });

    // POST /v1/teams/:teamId/tasks - Create task
    app.post('/v1/teams/:teamId/tasks', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string()
            }),
            body: TaskSchema,
            response: {
                200: z.object({
                    success: z.literal(true),
                    task: z.any()
                }),
                400: z.object({
                    error: z.string()
                }),
                404: z.object({
                    error: z.literal('Team not found')
                }),
                500: z.object({
                    error: z.literal('Failed to create task')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const taskData = request.body as z.infer<typeof TaskSchema>;

        try {
            const task = await taskOrchestrator.createTask(userId, teamId, taskData);
            await invalidateTeamOverviewSnapshot(userId);
            log({ module: 'task-routes', teamId, taskId: task.id }, 'Task created');
            return reply.send({ success: true, task });
        } catch (error: any) {
            if (error.message === 'Team not found') {
                return reply.code(404).send({ error: 'Team not found' });
            }
            if (error.message?.includes('Maximum nesting depth')) {
                return reply.code(400).send({ error: error.message });
            }
            log({ module: 'task-routes', level: 'error' }, `Failed to create task: ${error}`);
            return reply.code(500).send({ error: 'Failed to create task' });
        }
    });

    // PUT /v1/teams/:teamId/tasks/:taskId - Update task
    app.put('/v1/teams/:teamId/tasks/:taskId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string(),
                taskId: z.string()
            }),
            body: TaskSchema.partial(),
            response: {
                200: z.object({
                    success: z.literal(true),
                    task: z.any()
                }),
                404: z.object({
                    error: z.string()
                }),
                500: z.object({
                    error: z.literal('Failed to update task')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId, taskId } = request.params as { teamId: string; taskId: string };
        const updates = request.body as Partial<z.infer<typeof TaskSchema>>;

        try {
            const task = await taskOrchestrator.updateTask(userId, teamId, taskId, updates);
            await invalidateTeamOverviewSnapshot(userId);
            log({ module: 'task-routes', teamId, taskId }, 'Task updated');
            return reply.send({ success: true, task });
        } catch (error: any) {
            if (isTaskOperationError(error, TASK_ERROR_CODES.TASK_ACK_REQUIRED)) {
                return reply.code(400).send({ error: error.message });
            }
            if (error.message === 'Task not found' || error.message === 'Team not found') {
                return reply.code(404).send({ error: error.message });
            }
            log({ module: 'task-routes', level: 'error' }, `Failed to update task: ${error}`);
            return reply.code(500).send({ error: 'Failed to update task' });
        }
    });

    // DELETE /v1/teams/:teamId/tasks/:taskId - Delete task
    app.delete('/v1/teams/:teamId/tasks/:taskId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string(),
                taskId: z.string()
            }),
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                404: z.object({
                    error: z.string()
                }),
                500: z.object({
                    error: z.literal('Failed to delete task')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId, taskId } = request.params as { teamId: string; taskId: string };

        try {
            await taskOrchestrator.deleteTask(userId, teamId, taskId);
            await invalidateTeamOverviewSnapshot(userId);
            log({ module: 'task-routes', teamId, taskId }, 'Task deleted');
            return reply.send({ success: true });
        } catch (error: any) {
            if (error.message === 'Task not found' || error.message === 'Team not found') {
                return reply.code(404).send({ error: error.message });
            }
            log({ module: 'task-routes', level: 'error' }, `Failed to delete task: ${error}`);
            return reply.code(500).send({ error: 'Failed to delete task' });
        }
    });

    // POST /v1/teams/:teamId/tasks/:taskId/start - Start working on task
    app.post('/v1/teams/:teamId/tasks/:taskId/start', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string(),
                taskId: z.string()
            }),
            body: z.object({
                sessionId: z.string(),
                role: z.string().default('builder')
            }),
            response: {
                200: z.object({
                    success: z.literal(true),
                    task: z.any()
                }),
                400: z.object({
                    error: z.string()
                }),
                404: z.object({
                    error: z.string()
                }),
                500: z.object({
                    error: z.literal('Failed to start task')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId, taskId } = request.params as { teamId: string; taskId: string };
        const { sessionId, role } = request.body as { sessionId: string; role: string };

        try {
            const task = await taskOrchestrator.startTask(userId, teamId, taskId, sessionId, role);
            await observeSessionActivity(userId, sessionId, Date.now());
            log({ module: 'task-routes', teamId, taskId, sessionId }, 'Task started');
            return reply.send({ success: true, task });
        } catch (error: any) {
            if (error.message === 'Task not found' || error.message === 'Team not found') {
                return reply.code(404).send({ error: error.message });
            }
            if (isTaskOperationError(error, TASK_ERROR_CODES.DUPLICATE_EXECUTION_CONFLICT)) {
                return reply.code(400).send({ error: error.message });
            }
            log({ module: 'task-routes', level: 'error' }, `Failed to start task: ${error}`);
            return reply.code(500).send({ error: 'Failed to start task' });
        }
    });

    // POST /v1/teams/:teamId/tasks/:taskId/complete - Complete task
    app.post('/v1/teams/:teamId/tasks/:taskId/complete', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string(),
                taskId: z.string()
            }),
            body: z.object({
                sessionId: z.string()
            }),
            response: {
                200: z.object({
                    success: z.literal(true),
                    task: z.any()
                }),
                400: z.object({
                    error: z.string()
                }),
                404: z.object({
                    error: z.string()
                }),
                500: z.object({
                    error: z.literal('Failed to complete task')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId, taskId } = request.params as { teamId: string; taskId: string };
        const { sessionId } = request.body as { sessionId: string };

        try {
            const task = await taskOrchestrator.completeTask(userId, teamId, taskId, sessionId);
            await observeSessionActivity(userId, sessionId, Date.now());
            log({ module: 'task-routes', teamId, taskId, sessionId }, 'Task completed');
            return reply.send({ success: true, task });
        } catch (error: any) {
            if (error.message === 'Task not found' || error.message === 'Team not found') {
                return reply.code(404).send({ error: error.message });
            }
            if (error.message?.includes('Cannot complete')) {
                return reply.code(400).send({ error: error.message });
            }
            log({ module: 'task-routes', level: 'error' }, `Failed to complete task: ${error}`);
            return reply.code(500).send({ error: 'Failed to complete task' });
        }
    });

    // POST /v1/teams/:teamId/tasks/:taskId/blocker - Report blocker
    app.post('/v1/teams/:teamId/tasks/:taskId/blocker', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string(),
                taskId: z.string()
            }),
            body: z.object({
                sessionId: z.string(),
                ...BlockerSchema.shape
            }),
            response: {
                200: z.object({
                    success: z.literal(true),
                    task: z.any()
                }),
                404: z.object({
                    error: z.string()
                }),
                500: z.object({
                    error: z.literal('Failed to report blocker')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId, taskId } = request.params as { teamId: string; taskId: string };
        const { sessionId, type, description } = request.body as {
            sessionId: string;
            type: 'dependency' | 'question' | 'resource' | 'technical';
            description: string;
        };

        try {
            const task = await taskOrchestrator.reportBlocker(
                userId,
                teamId,
                taskId,
                sessionId,
                { type, description }
            );
            await observeSessionActivity(userId, sessionId, Date.now());
            log({ module: 'task-routes', teamId, taskId }, 'Blocker reported');
            return reply.send({ success: true, task });
        } catch (error: any) {
            if (error.message === 'Task not found' || error.message === 'Team not found') {
                return reply.code(404).send({ error: error.message });
            }
            log({ module: 'task-routes', level: 'error' }, `Failed to report blocker: ${error}`);
            return reply.code(500).send({ error: 'Failed to report blocker' });
        }
    });

    // POST /v1/teams/:teamId/tasks/:taskId/blocker/:blockerId/resolve - Resolve blocker
    app.post('/v1/teams/:teamId/tasks/:taskId/blocker/:blockerId/resolve', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string(),
                taskId: z.string(),
                blockerId: z.string()
            }),
            body: z.object({
                sessionId: z.string(),
                resolution: z.string().min(1).max(1000)
            }),
            response: {
                200: z.object({
                    success: z.literal(true),
                    task: z.any()
                }),
                404: z.object({
                    error: z.string()
                }),
                500: z.object({
                    error: z.literal('Failed to resolve blocker')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId, taskId, blockerId } = request.params as {
            teamId: string;
            taskId: string;
            blockerId: string;
        };
        const { sessionId, resolution } = request.body as { sessionId: string; resolution: string };

        try {
            const task = await taskOrchestrator.resolveBlocker(
                userId,
                teamId,
                taskId,
                blockerId,
                sessionId,
                resolution
            );
            await observeSessionActivity(userId, sessionId, Date.now());
            log({ module: 'task-routes', teamId, taskId, blockerId }, 'Blocker resolved');
            return reply.send({ success: true, task });
        } catch (error: any) {
            if (error.message === 'Task not found' ||
                error.message === 'Team not found' ||
                error.message === 'Blocker not found') {
                return reply.code(404).send({ error: error.message });
            }
            log({ module: 'task-routes', level: 'error' }, `Failed to resolve blocker: ${error}`);
            return reply.code(500).send({ error: 'Failed to resolve blocker' });
        }
    });
}
