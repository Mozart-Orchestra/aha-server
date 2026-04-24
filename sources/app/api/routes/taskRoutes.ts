import path from "node:path";
import { Fastify } from "../types";
import { z } from "zod";
import { log } from "@/utils/log";
import { taskOrchestrator } from "@/app/task/taskOrchestrator";
import { isTaskOperationError, TASK_ERROR_CODES } from "@/app/task/taskErrors";
import { invalidateTeamOverviewSnapshot } from "@/app/team/teamOverview";
import { extractTeamBoard, extractTeamMembers, getTeamAccessContext, type TeamAccessContext, type TeamAccessFailure } from "@/app/team/teamArtifacts";
import { observeSessionActivity } from "@/app/presence/observeSessionActivity";
import { buildTeamScopeFromMetadata, normalizeTeamScope } from "@/app/team/teamScope";
import { db } from "@/storage/db";

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
    acceptanceCriteria: z.array(z.string().min(1).max(1000)).max(50).optional(),
    status: z.enum(['todo', 'in-progress', 'review', 'blocked', 'done']).default('todo'),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    assigneeId: z.string().nullable().optional(),
    reporterId: z.string().optional(),
    parentTaskId: z.string().nullable().optional(),
    labels: z.array(z.string()).optional(),
    approvalStatus: z.enum(['pending', 'approved', 'rejected']).optional(),
    scope: z.object({
        scopePath: z.string(),
        scopeLabel: z.string().optional(),
        repoName: z.string().optional(),
        visibility: z.enum(['scoped', 'global']).optional(),
    }).optional(),
});

const BlockerSchema = z.object({
    type: z.enum(['dependency', 'question', 'resource', 'technical']),
    description: z.string().min(1).max(1000)
});

const TaskCommentTypeSchema = z.enum([
    'note',
    'status-change',
    'review-feedback',
    'handoff',
    'blocker',
    'decision',
    'human-override',
    'plan',
    'plan-review',
    'execution-check',
    'rework-request',
]);

const TaskCommentSchema = z.object({
    sessionId: z.string(),
    role: z.string().optional(),
    displayName: z.string().optional(),
    type: TaskCommentTypeSchema.optional(),
    content: z.string().min(1).max(4000),
    fromStatus: z.string().optional(),
    toStatus: z.string().optional(),
    mentions: z.array(z.string()).optional(),
    commitHash: z.string().optional(),
});

const TaskActorSchema = z.object({
    sessionId: z.string().optional(),
    role: z.string().optional(),
    displayName: z.string().optional(),
    kind: z.enum(['human', 'agent']).optional(),
});

const HumanStatusLockSchema = TaskActorSchema.extend({
    mode: z.enum(['viewing', 'editing', 'manual-status']),
    reason: z.string().max(500).optional(),
    comment: z.string().max(4000).optional(),
});

const ClearHumanStatusLockSchema = TaskActorSchema.extend({
    mode: z.enum(['viewing', 'editing', 'manual-status']).optional(),
    comment: z.string().max(4000).optional(),
});

const TaskUpdateCommentSchema = z.union([
    z.string().min(1).max(4000),
    TaskCommentSchema,
]);

const TaskUpdateSchema = TaskSchema.partial().extend({
    comment: TaskUpdateCommentSchema.optional(),
    commentType: TaskCommentTypeSchema.optional(),
    actor: TaskActorSchema.optional(),
});

type TaskCommentPayload = z.infer<typeof TaskCommentSchema>;
type TaskUpdateCommentPayload = z.infer<typeof TaskUpdateCommentSchema>;

type ResolvedTaskSession = {
    sessionId: string;
    role?: string;
    displayName?: string;
    scope?: z.infer<typeof TaskSchema>['scope'] | null;
    activityAccountId?: string;
};

function normalizeOptionalString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function buildRosterTaskScope(member: Record<string, unknown>): z.infer<typeof TaskSchema>['scope'] | null {
    const workspacePath = normalizeOptionalString(member.workspacePath);
    if (!workspacePath) {
        return null;
    }

    return normalizeTeamScope({
        scopePath: workspacePath,
        scopeLabel: path.basename(workspacePath),
        visibility: 'scoped',
    });
}

async function resolveTaskSession(
    access: TeamAccessContext,
    sessionId: string | undefined,
): Promise<ResolvedTaskSession | null> {
    const normalizedSessionId = sessionId?.trim();
    if (!normalizedSessionId) {
        return null;
    }

    let rosterMember: Record<string, unknown> | null = null;
    if (access.artifact.body) {
        try {
            const board = extractTeamBoard(access.artifact);
            const teamMembers = extractTeamMembers(board);
            if (teamMembers.length > 0) {
                rosterMember = teamMembers.find((member) => member?.sessionId === normalizedSessionId) ?? null;
                if (!rosterMember) {
                    return null;
                }
            }
        } catch {
            rosterMember = null;
        }
    }

    const session = await db.session.findFirst({
        where: {
            id: normalizedSessionId,
            accountId: {
                in: Array.from(new Set([access.currentAccountId, access.teamOwnerAccountId])),
            },
        },
        select: {
            id: true,
            accountId: true,
            metadata: true,
            deletedAt: true,
        },
    });

    if (!session) {
        if (!rosterMember) {
            return null;
        }

        const rosterRole = normalizeOptionalString(rosterMember.roleId)
            ?? normalizeOptionalString(rosterMember.role);
        const rosterDisplayName = normalizeOptionalString(rosterMember.displayName);
        const rosterScope = buildRosterTaskScope(rosterMember);

        return {
            sessionId: normalizedSessionId,
            ...(rosterRole ? { role: rosterRole } : {}),
            ...(rosterDisplayName ? { displayName: rosterDisplayName } : {}),
            ...(rosterScope ? { scope: rosterScope } : {}),
            activityAccountId: access.teamOwnerAccountId,
        };
    }

    if (session.deletedAt) {
        return null;
    }

    let parsedMetadata: Record<string, unknown> | null = null;
    try {
        parsedMetadata = JSON.parse(session.metadata) as Record<string, unknown>;
    } catch {
        parsedMetadata = null;
    }

    const scope = buildTeamScopeFromMetadata(parsedMetadata);
    const role = typeof parsedMetadata?.role === 'string' ? parsedMetadata.role : undefined;
    const displayName = typeof parsedMetadata?.name === 'string'
        ? parsedMetadata.name
        : (typeof parsedMetadata?.path === 'string' ? parsedMetadata.path : undefined);

    return {
        sessionId: normalizedSessionId,
        ...(role ? { role } : {}),
        ...(displayName ? { displayName } : {}),
        ...(scope ? { scope } : {}),
        activityAccountId: session.accountId,
    };
}

function normalizeTaskUpdateComment(
    comment: TaskUpdateCommentPayload | undefined,
    defaults?: {
        sessionId?: string;
        role?: string;
        displayName?: string;
        type?: TaskCommentPayload['type'];
    },
): TaskCommentPayload | undefined {
    if (!comment) {
        return undefined;
    }

    if (typeof comment === 'string') {
        return {
            sessionId: defaults?.sessionId || 'system',
            ...(defaults?.role ? { role: defaults.role } : {}),
            ...(defaults?.displayName ? { displayName: defaults.displayName } : {}),
            ...(defaults?.type ? { type: defaults.type } : {}),
            content: comment,
        };
    }

    return {
        ...comment,
        sessionId: comment.sessionId || defaults?.sessionId || 'system',
        ...(comment.role === undefined && defaults?.role ? { role: defaults.role } : {}),
        ...(comment.displayName === undefined && defaults?.displayName ? { displayName: defaults.displayName } : {}),
        ...(comment.type === undefined && defaults?.type ? { type: defaults.type } : {}),
    };
}

function resolveTaskScope(
    inputScope: unknown,
    fallbackScope?: z.infer<typeof TaskSchema>['scope'] | null,
): z.infer<typeof TaskSchema>['scope'] | undefined {
    const normalized = normalizeTeamScope(inputScope);
    if (normalized) {
        return normalized;
    }
    return fallbackScope ?? undefined;
}

function sendTeamAccessFailure(reply: any, failure: TeamAccessFailure) {
    return reply.code(failure.statusCode).send({
        error: failure.error,
        code: failure.code,
        currentAccountId: failure.currentAccountId,
        ...(failure.teamOwnerAccountId ? { teamOwnerAccountId: failure.teamOwnerAccountId } : {}),
    });
}

function getTaskTeamAccess(request: any): TeamAccessContext {
    return request.teamAccessContext as TeamAccessContext;
}

export function taskRoutes(app: Fastify) {
    log({ module: 'api' }, 'Registering taskRoutes...');

    const requireTaskTeamAccess = async (request: any, reply: any) => {
        const userId = request.userId as string | undefined;
        const teamId = (request.params as { teamId?: string } | undefined)?.teamId;

        if (!userId || !teamId) {
            return reply.code(404).send({ error: 'Team not found' });
        }

        const access = await getTeamAccessContext(userId, teamId);
        if (!access.ok) {
            return sendTeamAccessFailure(reply, access.failure);
        }
        request.teamAccessContext = access.context;
    };

    const taskRoutePreHandlers = [app.authenticate, requireTaskTeamAccess];

    // GET /v1/teams/:teamId/tasks - List all tasks
    app.get('/v1/teams/:teamId/tasks', {
        preHandler: taskRoutePreHandlers,
        schema: {
            params: z.object({
                teamId: z.string()
            }),
            querystring: z.object({
                status: z.enum(['todo', 'in-progress', 'review', 'blocked', 'done']).optional(),
                assigneeId: z.string().optional(),
                scopePath: z.string().optional(),
                repoName: z.string().optional(),
                includeGlobal: z.coerce.boolean().optional(),
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
        const teamOwnerAccountId = getTaskTeamAccess(request).teamOwnerAccountId;
        const { teamId } = request.params as { teamId: string };
        const { status, assigneeId, scopePath, repoName, includeGlobal } = request.query as {
            status?: string;
            assigneeId?: string;
            scopePath?: string;
            repoName?: string;
            includeGlobal?: boolean;
        };

        try {
            const result = await taskOrchestrator.listTasks(teamOwnerAccountId, teamId, { status, assigneeId, scopePath, repoName, includeGlobal });
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
        preHandler: taskRoutePreHandlers,
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
        const teamOwnerAccountId = getTaskTeamAccess(request).teamOwnerAccountId;
        const { teamId, taskId } = request.params as { teamId: string; taskId: string };

        try {
            const task = await taskOrchestrator.getTask(teamOwnerAccountId, teamId, taskId);
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
        preHandler: taskRoutePreHandlers,
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
        const teamAccess = getTaskTeamAccess(request);
        const teamOwnerAccountId = teamAccess.teamOwnerAccountId;
        const { teamId } = request.params as { teamId: string };
        const taskData = request.body as z.infer<typeof TaskSchema>;

        try {
            const reporter = await resolveTaskSession(teamAccess, taskData.reporterId);
            if (taskData.reporterId && !reporter) {
                return reply.code(400).send({ error: 'Invalid reporterId for this team' });
            }

            let task;
            const MAX_RETRIES = 3;
            for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
                try {
                    task = await taskOrchestrator.createTask(teamOwnerAccountId, teamId, {
                        ...taskData,
                        ...(resolveTaskScope(taskData.scope, reporter?.scope) ? { scope: resolveTaskScope(taskData.scope, reporter?.scope) } : {}),
                    });
                    break;
                } catch (retryError: any) {
                    if (retryError.message?.includes('Concurrent write conflict') && attempt < MAX_RETRIES - 1) {
                        log({ module: 'task-routes', teamId }, `Concurrent write conflict on attempt ${attempt + 1}, retrying`);
                        continue;
                    }
                    throw retryError;
                }
            }

            await invalidateTeamOverviewSnapshot(teamOwnerAccountId);
            log({ module: 'task-routes', teamId, taskId: task!.id }, 'Task created');
            return reply.send({ success: true, task });
        } catch (error: any) {
            if (error.message === 'Team not found') {
                return reply.code(404).send({ error: 'Team not found' });
            }
            if (error.message?.includes('Maximum nesting depth')) {
                return reply.code(400).send({ error: error.message });
            }
            if (error.message?.includes('Concurrent write conflict')) {
                return reply.code(409).send({ error: 'Concurrent modification - please retry' });
            }
            log({ module: 'task-routes', level: 'error' }, `Failed to create task: ${error}`);
            return reply.code(500).send({ error: 'Failed to create task' });
        }
    });

    // PUT /v1/teams/:teamId/tasks/:taskId - Update task
    app.put('/v1/teams/:teamId/tasks/:taskId', {
        preHandler: taskRoutePreHandlers,
        schema: {
            params: z.object({
                teamId: z.string(),
                taskId: z.string()
            }),
            body: TaskUpdateSchema,
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
        const teamAccess = getTaskTeamAccess(request);
        const teamOwnerAccountId = teamAccess.teamOwnerAccountId;
        const { teamId, taskId } = request.params as { teamId: string; taskId: string };
        const body = request.body as z.infer<typeof TaskUpdateSchema>;
        const { comment, commentType, actor, ...taskUpdates } = body;
        const resolvedActor = await resolveTaskSession(teamAccess, actor?.sessionId);
        if (actor?.sessionId && !resolvedActor) {
            return reply.code(400).send({ error: 'Invalid actor session for this team' });
        }

        const normalizedActor = resolvedActor
            ? {
                sessionId: resolvedActor.sessionId,
                ...(resolvedActor.role ? { role: resolvedActor.role } : {}),
                ...(resolvedActor.displayName ? { displayName: resolvedActor.displayName } : {}),
                ...(actor?.kind ? { kind: actor.kind } : {}),
            }
            : actor;

        const updates = {
            ...taskUpdates,
            ...(normalizedActor ? { actor: normalizedActor } : {}),
            ...(resolveTaskScope((taskUpdates as any).scope, resolvedActor?.scope) ? { scope: resolveTaskScope((taskUpdates as any).scope, resolvedActor?.scope) } : {}),
            ...(comment !== undefined
                ? {
                    comment: normalizeTaskUpdateComment(comment, {
                        sessionId: normalizedActor?.sessionId || taskUpdates.assigneeId || 'system',
                        role: normalizedActor?.role,
                        displayName: normalizedActor?.displayName,
                        type: commentType,
                    }),
                }
                : {}),
        };

        const normalizedComment = (updates as { comment?: TaskCommentPayload }).comment;
        if (normalizedComment?.sessionId && normalizedComment.sessionId !== normalizedActor?.sessionId) {
            const resolvedCommentActor = await resolveTaskSession(teamAccess, normalizedComment.sessionId);
            if (!resolvedCommentActor) {
                return reply.code(400).send({ error: 'Invalid comment session for this team' });
            }
            (updates as { comment?: TaskCommentPayload }).comment = {
                ...normalizedComment,
                sessionId: resolvedCommentActor.sessionId,
                role: resolvedCommentActor.role ?? normalizedComment.role,
                displayName: resolvedCommentActor.displayName ?? normalizedComment.displayName,
            };
        }

        try {
            const task = await taskOrchestrator.updateTask(teamOwnerAccountId, teamId, taskId, updates);
            await invalidateTeamOverviewSnapshot(teamOwnerAccountId);
            log({ module: 'task-routes', teamId, taskId }, 'Task updated');
            return reply.send({ success: true, task });
        } catch (error: any) {
            if (isTaskOperationError(error, TASK_ERROR_CODES.TASK_ACK_REQUIRED)) {
                return reply.code(400).send({ error: error.message });
            }
            if (isTaskOperationError(error, TASK_ERROR_CODES.TASK_LOCKED_BY_HUMAN)) {
                return reply.code(409).send({ error: error.message });
            }
            if (error.message === 'Task not found' || error.message === 'Team not found') {
                return reply.code(404).send({ error: error.message });
            }
            log({ module: 'task-routes', level: 'error' }, `Failed to update task: ${error}`);
            return reply.code(500).send({ error: 'Failed to update task' });
        }
    });

    app.post('/v1/teams/:teamId/tasks/:taskId/human-lock', {
        preHandler: taskRoutePreHandlers,
        schema: {
            params: z.object({
                teamId: z.string(),
                taskId: z.string(),
            }),
            body: HumanStatusLockSchema,
            response: {
                200: z.object({
                    success: z.literal(true),
                    task: z.any(),
                }),
                404: z.object({ error: z.string() }),
                500: z.object({ error: z.literal('Failed to set human status lock') }),
            },
        }
    }, async (request, reply) => {
        const teamAccess = getTaskTeamAccess(request);
        const teamOwnerAccountId = teamAccess.teamOwnerAccountId;
        const { teamId, taskId } = request.params as { teamId: string; taskId: string };
        const body = request.body as z.infer<typeof HumanStatusLockSchema>;
        const resolvedActor = await resolveTaskSession(teamAccess, body.sessionId);
        if (body.sessionId && !resolvedActor) {
            return reply.code(400).send({ error: 'Invalid human lock actor for this team' });
        }

        try {
            const task = await taskOrchestrator.setHumanStatusLock(teamOwnerAccountId, teamId, taskId, {
                ...body,
                ...(resolvedActor ? {
                    sessionId: resolvedActor.sessionId,
                    role: resolvedActor.role,
                    displayName: resolvedActor.displayName,
                } : {}),
            });
            if (resolvedActor?.sessionId) {
                await observeSessionActivity(resolvedActor.activityAccountId ?? teamOwnerAccountId, resolvedActor.sessionId, Date.now());
            }
            log({ module: 'task-routes', teamId, taskId }, 'Human status lock set');
            return reply.send({ success: true, task });
        } catch (error: any) {
            if (error.message === 'Task not found' || error.message === 'Team not found') {
                return reply.code(404).send({ error: error.message });
            }
            log({ module: 'task-routes', level: 'error' }, `Failed to set human status lock: ${error}`);
            return reply.code(500).send({ error: 'Failed to set human status lock' });
        }
    });

    app.post('/v1/teams/:teamId/tasks/:taskId/human-lock/clear', {
        preHandler: taskRoutePreHandlers,
        schema: {
            params: z.object({
                teamId: z.string(),
                taskId: z.string(),
            }),
            body: ClearHumanStatusLockSchema.optional(),
            response: {
                200: z.object({
                    success: z.literal(true),
                    task: z.any(),
                }),
                404: z.object({ error: z.string() }),
                500: z.object({ error: z.literal('Failed to clear human status lock') }),
            },
        }
    }, async (request, reply) => {
        const teamAccess = getTaskTeamAccess(request);
        const teamOwnerAccountId = teamAccess.teamOwnerAccountId;
        const { teamId, taskId } = request.params as { teamId: string; taskId: string };
        const body = (request.body ?? {}) as z.infer<typeof ClearHumanStatusLockSchema>;
        const resolvedActor = await resolveTaskSession(teamAccess, body.sessionId);
        if (body.sessionId && !resolvedActor) {
            return reply.code(400).send({ error: 'Invalid human lock actor for this team' });
        }

        try {
            const task = await taskOrchestrator.clearHumanStatusLock(teamOwnerAccountId, teamId, taskId, {
                ...body,
                ...(resolvedActor ? {
                    sessionId: resolvedActor.sessionId,
                    role: resolvedActor.role,
                    displayName: resolvedActor.displayName,
                } : {}),
            });
            if (resolvedActor?.sessionId) {
                await observeSessionActivity(resolvedActor.activityAccountId ?? teamOwnerAccountId, resolvedActor.sessionId, Date.now());
            }
            log({ module: 'task-routes', teamId, taskId }, 'Human status lock cleared');
            return reply.send({ success: true, task });
        } catch (error: any) {
            if (error.message === 'Task not found' || error.message === 'Team not found') {
                return reply.code(404).send({ error: error.message });
            }
            log({ module: 'task-routes', level: 'error' }, `Failed to clear human status lock: ${error}`);
            return reply.code(500).send({ error: 'Failed to clear human status lock' });
        }
    });

    // DELETE /v1/teams/:teamId/tasks/:taskId - Delete task
    app.delete('/v1/teams/:teamId/tasks/:taskId', {
        preHandler: taskRoutePreHandlers,
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
        const teamOwnerAccountId = getTaskTeamAccess(request).teamOwnerAccountId;
        const { teamId, taskId } = request.params as { teamId: string; taskId: string };

        try {
            await taskOrchestrator.deleteTask(teamOwnerAccountId, teamId, taskId);
            await invalidateTeamOverviewSnapshot(teamOwnerAccountId);
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
        preHandler: taskRoutePreHandlers,
        schema: {
            params: z.object({
                teamId: z.string(),
                taskId: z.string()
            }),
            body: z.object({
                sessionId: z.string(),
                role: z.string().default('builder'),
                comment: TaskCommentSchema.omit({ sessionId: true, role: true, fromStatus: true, toStatus: true }).optional(),
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
        const teamAccess = getTaskTeamAccess(request);
        const teamOwnerAccountId = teamAccess.teamOwnerAccountId;
        const { teamId, taskId } = request.params as { teamId: string; taskId: string };
        const { sessionId, role, comment } = request.body as {
            sessionId: string;
            role: string;
            comment?: { displayName?: string; content: string; mentions?: string[]; type?: 'note' | 'status-change' | 'review-feedback' | 'handoff' | 'blocker' | 'decision' | 'human-override' | 'plan' | 'plan-review' | 'execution-check' | 'rework-request' };
        };
        const resolvedActor = await resolveTaskSession(teamAccess, sessionId);
        if (!resolvedActor) {
            return reply.code(400).send({ error: 'Invalid session for this team' });
        }

        try {
            const task = await taskOrchestrator.startTask(
                teamOwnerAccountId,
                teamId,
                taskId,
                resolvedActor.sessionId,
                resolvedActor.role || role,
                comment ? {
                    ...comment,
                    displayName: resolvedActor.displayName ?? comment.displayName,
                } : undefined
            );
            await observeSessionActivity(resolvedActor.activityAccountId ?? teamOwnerAccountId, resolvedActor.sessionId, Date.now());
            log({ module: 'task-routes', teamId, taskId, sessionId }, 'Task started');
            return reply.send({ success: true, task });
        } catch (error: any) {
            if (error.message === 'Task not found' || error.message === 'Team not found') {
                return reply.code(404).send({ error: error.message });
            }
            if (isTaskOperationError(error, TASK_ERROR_CODES.DUPLICATE_EXECUTION_CONFLICT)) {
                return reply.code(400).send({ error: error.message });
            }
            if (isTaskOperationError(error, TASK_ERROR_CODES.TASK_LOCKED_BY_HUMAN)) {
                return reply.code(409).send({ error: error.message });
            }
            log({ module: 'task-routes', level: 'error' }, `Failed to start task: ${error}`);
            return reply.code(500).send({ error: 'Failed to start task' });
        }
    });

    // POST /v1/teams/:teamId/tasks/:taskId/complete - Complete task
    app.post('/v1/teams/:teamId/tasks/:taskId/complete', {
        preHandler: taskRoutePreHandlers,
        schema: {
            params: z.object({
                teamId: z.string(),
                taskId: z.string()
            }),
            body: z.object({
                sessionId: z.string(),
                comment: TaskCommentSchema.omit({ sessionId: true, fromStatus: true, toStatus: true }).optional(),
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
        const teamAccess = getTaskTeamAccess(request);
        const teamOwnerAccountId = teamAccess.teamOwnerAccountId;
        const { teamId, taskId } = request.params as { teamId: string; taskId: string };
        const { sessionId, comment } = request.body as {
            sessionId: string;
            comment?: { role?: string; displayName?: string; content: string; mentions?: string[]; type?: 'note' | 'status-change' | 'review-feedback' | 'handoff' | 'blocker' | 'decision' | 'human-override' | 'plan' | 'plan-review' | 'execution-check' | 'rework-request' };
        };
        const resolvedActor = await resolveTaskSession(teamAccess, sessionId);
        if (!resolvedActor) {
            return reply.code(400).send({ error: 'Invalid session for this team' });
        }

        try {
            const task = await taskOrchestrator.completeTask(
                teamOwnerAccountId,
                teamId,
                taskId,
                resolvedActor.sessionId,
                comment ? {
                    ...comment,
                    role: resolvedActor.role ?? comment.role,
                    displayName: resolvedActor.displayName ?? comment.displayName,
                } : undefined
            );
            await observeSessionActivity(resolvedActor.activityAccountId ?? teamOwnerAccountId, resolvedActor.sessionId, Date.now());
            log({ module: 'task-routes', teamId, taskId, sessionId }, 'Task completed');
            return reply.send({ success: true, task });
        } catch (error: any) {
            if (error.message === 'Task not found' || error.message === 'Team not found') {
                return reply.code(404).send({ error: error.message });
            }
            if (error.message?.includes('Cannot complete')) {
                return reply.code(400).send({ error: error.message });
            }
            if (isTaskOperationError(error, TASK_ERROR_CODES.TASK_LOCKED_BY_HUMAN)) {
                return reply.code(409).send({ error: error.message });
            }
            log({ module: 'task-routes', level: 'error' }, `Failed to complete task: ${error}`);
            return reply.code(500).send({ error: 'Failed to complete task' });
        }
    });

    // POST /v1/teams/:teamId/tasks/:taskId/blocker - Report blocker
    app.post('/v1/teams/:teamId/tasks/:taskId/blocker', {
        preHandler: taskRoutePreHandlers,
        schema: {
            params: z.object({
                teamId: z.string(),
                taskId: z.string()
            }),
            body: z.object({
                sessionId: z.string(),
                role: z.string().optional(),
                displayName: z.string().optional(),
                mentions: z.array(z.string()).optional(),
                comment: z.string().optional(),
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
        const teamAccess = getTaskTeamAccess(request);
        const teamOwnerAccountId = teamAccess.teamOwnerAccountId;
        const { teamId, taskId } = request.params as { teamId: string; taskId: string };
        const { sessionId, type, description, role, displayName, mentions, comment } = request.body as {
            sessionId: string;
            type: 'dependency' | 'question' | 'resource' | 'technical';
            description: string;
            role?: string;
            displayName?: string;
            mentions?: string[];
            comment?: string;
        };
        const resolvedActor = await resolveTaskSession(teamAccess, sessionId);
        if (!resolvedActor) {
            return reply.code(400).send({ error: 'Invalid session for this team' });
        }

        try {
            const task = await taskOrchestrator.reportBlocker(
                teamOwnerAccountId,
                teamId,
                taskId,
                resolvedActor.sessionId,
                {
                    type,
                    description,
                    role: resolvedActor.role ?? role,
                    displayName: resolvedActor.displayName ?? displayName,
                    mentions,
                    comment,
                }
            );
            await observeSessionActivity(resolvedActor.activityAccountId ?? teamOwnerAccountId, resolvedActor.sessionId, Date.now());
            log({ module: 'task-routes', teamId, taskId }, 'Blocker reported');
            return reply.send({ success: true, task });
        } catch (error: any) {
            if (error.message === 'Task not found' || error.message === 'Team not found') {
                return reply.code(404).send({ error: error.message });
            }
            if (isTaskOperationError(error, TASK_ERROR_CODES.TASK_LOCKED_BY_HUMAN)) {
                return reply.code(409).send({ error: error.message });
            }
            log({ module: 'task-routes', level: 'error' }, `Failed to report blocker: ${error}`);
            return reply.code(500).send({ error: 'Failed to report blocker' });
        }
    });

    // POST /v1/teams/:teamId/tasks/:taskId/blocker/:blockerId/resolve - Resolve blocker
    app.post('/v1/teams/:teamId/tasks/:taskId/blocker/:blockerId/resolve', {
        preHandler: taskRoutePreHandlers,
        schema: {
            params: z.object({
                teamId: z.string(),
                taskId: z.string(),
                blockerId: z.string()
            }),
            body: z.object({
                sessionId: z.string(),
                resolution: z.string().min(1).max(1000),
                comment: TaskCommentSchema.omit({ sessionId: true }).optional(),
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
        const teamAccess = getTaskTeamAccess(request);
        const teamOwnerAccountId = teamAccess.teamOwnerAccountId;
        const { teamId, taskId, blockerId } = request.params as {
            teamId: string;
            taskId: string;
            blockerId: string;
        };
        const { sessionId, resolution, comment } = request.body as {
            sessionId: string;
            resolution: string;
            comment?: { role?: string; displayName?: string; type?: 'note' | 'status-change' | 'review-feedback' | 'handoff' | 'blocker' | 'decision' | 'human-override' | 'plan' | 'plan-review' | 'execution-check' | 'rework-request'; content: string; fromStatus?: string; toStatus?: string; mentions?: string[] };
        };
        const resolvedActor = await resolveTaskSession(teamAccess, sessionId);
        if (!resolvedActor) {
            return reply.code(400).send({ error: 'Invalid session for this team' });
        }

        try {
            const task = await taskOrchestrator.resolveBlocker(
                teamOwnerAccountId,
                teamId,
                taskId,
                blockerId,
                resolvedActor.sessionId,
                resolution,
                comment ? {
                    ...comment,
                    role: resolvedActor.role ?? comment.role,
                    displayName: resolvedActor.displayName ?? comment.displayName,
                } : undefined
            );
            await observeSessionActivity(resolvedActor.activityAccountId ?? teamOwnerAccountId, resolvedActor.sessionId, Date.now());
            log({ module: 'task-routes', teamId, taskId, blockerId }, 'Blocker resolved');
            return reply.send({ success: true, task });
        } catch (error: any) {
            if (error.message === 'Task not found' ||
                error.message === 'Team not found' ||
                error.message === 'Blocker not found') {
                return reply.code(404).send({ error: error.message });
            }
            if (isTaskOperationError(error, TASK_ERROR_CODES.TASK_LOCKED_BY_HUMAN)) {
                return reply.code(409).send({ error: error.message });
            }
            log({ module: 'task-routes', level: 'error' }, `Failed to resolve blocker: ${error}`);
            return reply.code(500).send({ error: 'Failed to resolve blocker' });
        }
    });

    // POST /v1/teams/:teamId/tasks/:taskId/comments - Add task comment
    app.post('/v1/teams/:teamId/tasks/:taskId/comments', {
        preHandler: taskRoutePreHandlers,
        schema: {
            params: z.object({
                teamId: z.string(),
                taskId: z.string(),
            }),
            body: TaskCommentSchema,
            response: {
                200: z.object({
                    success: z.literal(true),
                    task: z.any(),
                }),
                404: z.object({
                    error: z.string(),
                }),
                500: z.object({
                    error: z.literal('Failed to add task comment'),
                }),
            },
        },
    }, async (request, reply) => {
        const teamAccess = getTaskTeamAccess(request);
        const teamOwnerAccountId = teamAccess.teamOwnerAccountId;
        const { teamId, taskId } = request.params as { teamId: string; taskId: string };
        const comment = request.body as z.infer<typeof TaskCommentSchema>;
        const resolvedActor = await resolveTaskSession(teamAccess, comment.sessionId);
        if (!resolvedActor) {
            return reply.code(400).send({ error: 'Invalid session for this team' });
        }

        try {
            const task = await taskOrchestrator.addTaskComment(teamOwnerAccountId, teamId, taskId, {
                ...comment,
                sessionId: resolvedActor.sessionId,
                role: resolvedActor.role ?? comment.role,
                displayName: resolvedActor.displayName ?? comment.displayName,
            });
            await observeSessionActivity(resolvedActor.activityAccountId ?? teamOwnerAccountId, resolvedActor.sessionId, Date.now());
            log({ module: 'task-routes', teamId, taskId }, 'Task comment added');
            return reply.send({ success: true, task });
        } catch (error: any) {
            if (error.message === 'Task not found' || error.message === 'Team not found') {
                return reply.code(404).send({ error: error.message });
            }
            log({ module: 'task-routes', level: 'error' }, `Failed to add task comment: ${error}`);
            return reply.code(500).send({ error: 'Failed to add task comment' });
        }
    });

    // POST /v1/teams/:teamId/sessions/:sessionId/release-locks
    // Called by the daemon when it detects a session has died (heartbeat timeout).
    // Marks all active execution links owned by that session as 'abandoned' so
    // other agents can claim those tasks via start_task.
    app.post('/v1/teams/:teamId/sessions/:sessionId/release-locks', {
        preHandler: taskRoutePreHandlers,
        schema: {
            params: z.object({
                teamId: z.string(),
                sessionId: z.string(),
            }),
            response: {
                200: z.object({
                    success: z.literal(true),
                    unlockedTaskIds: z.array(z.string()),
                }),
                500: z.object({
                    error: z.string(),
                }),
            },
        },
    }, async (request, reply) => {
        const teamOwnerAccountId = getTaskTeamAccess(request).teamOwnerAccountId;
        const { teamId, sessionId } = request.params as { teamId: string; sessionId: string };

        try {
            const unlockedTaskIds = await taskOrchestrator.releaseSessionTaskLocks(teamOwnerAccountId, teamId, sessionId);
            log({ module: 'task-routes', teamId, sessionId }, `Released task locks for dead session (${unlockedTaskIds.length} task(s))`);
            return reply.send({ success: true, unlockedTaskIds });
        } catch (error: any) {
            log({ module: 'task-routes', level: 'error' }, `Failed to release session task locks: ${error}`);
            return reply.code(500).send({ error: 'Failed to release session task locks' });
        }
    });
}
