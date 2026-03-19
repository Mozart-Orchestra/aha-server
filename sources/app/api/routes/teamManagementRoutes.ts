import { Fastify } from "../types";
import { z } from "zod";
import { log } from "@/utils/log";
import { db } from "@/storage/db";
import { eventRouter } from "@/app/events/eventRouter";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import {
    extractTeamBoard,
    extractTeamMembers,
    getAccessibleTeamArtifact,
    listAccessibleTeamArtifacts,
    serializeTeamBoard,
    summarizeTeamArtifact,
} from "@/app/team/teamArtifacts";
import { getTeamOverviewSnapshot, invalidateTeamOverviewSnapshot } from "@/app/team/teamOverview";
import { activityCache } from "@/app/presence/sessionCache";

/**
 * Team Management Routes
 *
 * Server-driven team operations:
 * - Add/remove members (with atomic updates)
 * - Archive team (archive all sessions)
 * - Delete team (delete all sessions)
 * - Rename team
 * - Batch session operations
 */

export function teamManagementRoutes(app: Fastify) {
    log({ module: 'api' }, 'Registering teamManagementRoutes...');

    // POST /v1/teams - Create a new team
    app.post('/v1/teams', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                id: z.string().optional(),
                name: z.string().min(1).max(200),
                description: z.string().max(500).optional(),
                board: z.record(z.unknown()).optional(),
            }),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { id, name, description, board: incomingBoard } = request.body as {
            id?: string;
            name: string;
            description?: string;
            board?: Record<string, unknown>;
        };

        try {
            const teamId = id || randomKeyNaked(24);

            const board: Record<string, any> = incomingBoard
                ? JSON.parse(JSON.stringify(incomingBoard))
                : {
                    name,
                    description: description || '',
                    columns: [
                        { id: 'todo', title: 'To Do' },
                        { id: 'in-progress', title: 'In Progress' },
                        { id: 'review', title: 'Review' },
                        { id: 'done', title: 'Done' },
                    ],
                    tasks: [],
                    agreements: [],
                    roles: [],
                    team: {
                        name,
                        members: [],
                    },
                };

            board.name = name;
            if (description !== undefined) {
                board.description = description;
            } else if (typeof board.description !== 'string') {
                board.description = '';
            }
            if (!board.team || typeof board.team !== 'object') {
                board.team = { members: [] };
            }
            board.team.name = name;
            if (!Array.isArray(board.team.members)) {
                board.team.members = [];
            }

            const existingArtifact = id
                ? await db.artifact.findUnique({
                    where: { id: teamId },
                    select: {
                        id: true,
                        accountId: true,
                        body: true,
                        createdAt: true,
                        updatedAt: true,
                    },
                })
                : null;

            if (existingArtifact && existingArtifact.accountId !== userId) {
                return reply.code(409).send({ error: 'Team id already belongs to another account' });
            }

            const artifact = existingArtifact
                ? await db.artifact.update({
                    where: { id: teamId },
                    data: {
                        header: Buffer.from(JSON.stringify({ name, type: 'team' })),
                        body: serializeTeamBoard(board),
                        dataEncryptionKey: Buffer.from('team'),
                        bodyVersion: { increment: 1 },
                        updatedAt: new Date(),
                    },
                })
                : await db.artifact.create({
                    data: {
                        id: teamId,
                        accountId: userId,
                        header: Buffer.from(JSON.stringify({ name, type: 'team' })),
                        body: serializeTeamBoard(board),
                        dataEncryptionKey: Buffer.from('team'),
                    },
                });

            await invalidateTeamOverviewSnapshot(userId);
            log({ module: 'team-management' }, `Team created: ${teamId} by ${userId}`);

            return reply.code(existingArtifact ? 200 : 201).send({
                team: summarizeTeamArtifact(artifact),
            });
        } catch (error: any) {
            log({ module: 'team-management' }, `Failed to create team: ${error}`);
            return reply.code(500).send({ error: 'Failed to create team' });
        }
    });

    // GET /v1/teams - List teams accessible to the current user
    app.get('/v1/teams', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    teams: z.array(z.object({
                        id: z.string(),
                        name: z.string(),
                        memberCount: z.number(),
                        taskCount: z.number(),
                        createdAt: z.number(),
                        updatedAt: z.number(),
                    })),
                }),
                500: z.object({
                    error: z.literal('Failed to list teams'),
                }),
            },
        },
    }, async (request, reply) => {
        try {
            const teams = await listAccessibleTeamArtifacts(request.userId);
            return reply.send({
                teams: teams.map(team => summarizeTeamArtifact(team)),
            });
        } catch (error: any) {
            log({ module: 'team-management', level: 'error' }, `Failed to list teams: ${error}`);
            return reply.code(500).send({ error: 'Failed to list teams' });
        }
    });

    app.get('/v1/teams/overview', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    overview: z.object({
                        generatedAt: z.number(),
                        teamCount: z.number(),
                        teamTotalTokens: z.number(),
                        agentTotalTokens: z.number(),
                        completedTasksTotal: z.number(),
                        teamUsageItems: z.array(z.object({
                            id: z.string(),
                            label: z.string(),
                            tokens: z.number(),
                        })),
                        agentUsageItems: z.array(z.object({
                            id: z.string(),
                            label: z.string(),
                            tokens: z.number(),
                        })),
                        completedTaskItems: z.array(z.object({
                            id: z.string(),
                            label: z.string(),
                            completedTasks: z.number(),
                        })),
                    }),
                }),
                500: z.object({
                    error: z.literal('Failed to get team overview'),
                }),
            },
        },
    }, async (request, reply) => {
        try {
            const overview = await getTeamOverviewSnapshot(request.userId);
            return reply.send({ overview });
        } catch (error: any) {
            log({ module: 'team-management', level: 'error' }, `Failed to get team overview: ${error}`);
            return reply.code(500).send({ error: 'Failed to get team overview' });
        }
    });

    // GET /v1/teams/:teamId - Fetch one team summary with members
    app.get('/v1/teams/:teamId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            response: {
                200: z.object({
                    team: z.object({
                        id: z.string(),
                        name: z.string(),
                        memberCount: z.number(),
                        taskCount: z.number(),
                        members: z.array(z.any()),
                        createdAt: z.number(),
                        updatedAt: z.number(),
                    }),
                }),
                404: z.object({
                    error: z.literal('Team not found'),
                }),
                500: z.object({
                    error: z.literal('Failed to get team'),
                }),
            },
        },
    }, async (request, reply) => {
        const { teamId } = request.params as { teamId: string };

        try {
            const artifact = await getAccessibleTeamArtifact(request.userId, teamId);
            if (!artifact) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            const team = summarizeTeamArtifact(artifact, { includeMembers: true });
            return reply.send({
                team: {
                    ...team,
                    members: team.members ?? [],
                },
            });
        } catch (error: any) {
            log({ module: 'team-management', level: 'error' }, `Failed to get team ${teamId}: ${error}`);
            return reply.code(500).send({ error: 'Failed to get team' });
        }
    });

    // === Team Member Management ===

    // GET /v1/teams/:teamId/members - List team members
    app.get('/v1/teams/:teamId/members', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            response: {
                200: z.object({
                    members: z.array(z.any()),
                }),
                404: z.object({
                    error: z.literal('Team not found'),
                }),
                500: z.object({
                    error: z.literal('Failed to list team members'),
                }),
            },
        },
    }, async (request, reply) => {
        const { teamId } = request.params as { teamId: string };

        try {
            const artifact = await getAccessibleTeamArtifact(request.userId, teamId);
            if (!artifact) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            const board = extractTeamBoard(artifact);
            return reply.send({ members: extractTeamMembers(board) });
        } catch (error: any) {
            log({ module: 'team-management', level: 'error' }, `Failed to list members for ${teamId}: ${error}`);
            return reply.code(500).send({ error: 'Failed to list team members' });
        }
    });

    // POST /v1/teams/:teamId/members - Add member to team
    app.post('/v1/teams/:teamId/members', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            body: z.object({
                memberId: z.string().optional(),
                sessionId: z.string(),
                sessionTag: z.string().optional(),
                roleId: z.string(),
                displayName: z.string().optional(),
                specId: z.string().optional(),
                parentSessionId: z.string().optional(),
                executionPlane: z.string().optional(),
                runtimeType: z.string().optional()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const { memberId, sessionId, sessionTag, roleId, displayName, specId, parentSessionId, executionPlane, runtimeType } = request.body as {
            memberId?: string;
            sessionId: string;
            sessionTag?: string;
            roleId: string;
            displayName?: string;
            specId?: string;
            parentSessionId?: string;
            executionPlane?: string;
            runtimeType?: string;
        };

        try {
            const result = await addTeamMember(userId, teamId, memberId, sessionId, sessionTag, roleId, displayName, specId, parentSessionId, executionPlane, runtimeType);
            return reply.send(result);
        } catch (error: any) {
            if (error.message === 'Team not found') {
                return reply.code(404).send({ error: error.message });
            }
            log({ module: 'team-management', level: 'error' }, `Failed to add member: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // DELETE /v1/teams/:teamId/members/:sessionId - Remove member from team
    app.delete('/v1/teams/:teamId/members/:sessionId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string(),
                sessionId: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId, sessionId } = request.params as { teamId: string; sessionId: string };

        try {
            const result = await removeTeamMember(userId, teamId, sessionId);
            return reply.send(result);
        } catch (error: any) {
            if (error.message === 'Team not found') {
                return reply.code(404).send({ error: error.message });
            }
            log({ module: 'team-management', level: 'error' }, `Failed to remove member: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // === Team Operations ===

    // POST /v1/teams/:teamId/archive - Archive team and all sessions
    // Note: Client must provide sessionIds since artifact body is encrypted
    app.post('/v1/teams/:teamId/archive', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            body: z.object({
                sessionIds: z.array(z.string()).optional() // Client provides session IDs
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const body = request.body as { sessionIds?: string[] } | undefined;
        const sessionIds = body?.sessionIds || [];

        try {
            const result = await archiveTeam(userId, teamId, sessionIds);
            log({ module: 'team-management', teamId }, `Team archived with ${result.archivedSessions} sessions`);
            return reply.send(result);
        } catch (error: any) {
            if (error.message === 'Team not found') {
                return reply.code(404).send({ error: error.message });
            }
            log({ module: 'team-management', level: 'error' }, `Failed to archive team: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // DELETE /v1/teams/:teamId - Delete team and all sessions
    // Note: Client must provide sessionIds since artifact body is encrypted
    app.delete('/v1/teams/:teamId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            body: z.object({
                sessionIds: z.array(z.string()).optional() // Client provides session IDs
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const body = request.body as { sessionIds?: string[] } | undefined;
        const sessionIds = body?.sessionIds || [];

        try {
            const result = await deleteTeam(userId, teamId, sessionIds);
            log({ module: 'team-management', teamId }, `Team deleted with ${result.deletedSessions} sessions`);
            return reply.send(result);
        } catch (error: any) {
            if (error.message === 'Team not found') {
                return reply.code(404).send({ error: error.message });
            }
            log({ module: 'team-management', level: 'error' }, `Failed to delete team: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // PUT /v1/teams/:teamId/rename - Rename team
    app.put('/v1/teams/:teamId/rename', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            body: z.object({ name: z.string().min(1).max(100) })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const { name } = request.body as { name: string };

        try {
            const result = await renameTeam(userId, teamId, name);
            return reply.send(result);
        } catch (error: any) {
            if (error.message === 'Team not found') {
                return reply.code(404).send({ error: error.message });
            }
            log({ module: 'team-management', level: 'error' }, `Failed to rename team: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // === Batch Session Operations ===

    // POST /v1/sessions/batch/archive - Archive multiple sessions
    app.post('/v1/sessions/batch/archive', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                sessionIds: z.array(z.string()).min(1).max(100)
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionIds } = request.body as { sessionIds: string[] };

        try {
            const result = await batchArchiveSessions(userId, sessionIds);
            return reply.send(result);
        } catch (error: any) {
            log({ module: 'team-management', level: 'error' }, `Failed to batch archive: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // POST /v1/sessions/batch/delete - Delete multiple sessions
    app.post('/v1/sessions/batch/delete', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                sessionIds: z.array(z.string()).min(1).max(100)
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionIds } = request.body as { sessionIds: string[] };

        try {
            const result = await batchDeleteSessions(userId, sessionIds);
            return reply.send(result);
        } catch (error: any) {
            log({ module: 'team-management', level: 'error' }, `Failed to batch delete: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // PUT /v1/sessions/:sessionId/rename - Rename session
    app.put('/v1/sessions/:sessionId/rename', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: z.object({ name: z.string().min(1).max(100) })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params as { sessionId: string };
        const { name } = request.body as { name: string };

        try {
            const result = await renameSession(userId, sessionId, name);
            return reply.send(result);
        } catch (error: any) {
            if (error.message === 'Session not found') {
                return reply.code(404).send({ error: error.message });
            }
            log({ module: 'team-management', level: 'error' }, `Failed to rename session: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // === Batch Team Operations ===

    // POST /v1/teams/batch/archive - Archive multiple teams
    app.post('/v1/teams/batch/archive', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                teamIds: z.array(z.string()).min(1).max(50)
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamIds } = request.body as { teamIds: string[] };

        try {
            const results = [];
            for (const teamId of teamIds) {
                try {
                    const result = await archiveTeam(userId, teamId);
                    results.push({ teamId, ...result });
                } catch (error: any) {
                    results.push({ teamId, success: false, error: error.message });
                }
            }
            return reply.send({
                success: true,
                archived: results.filter(result => result.success).length,
                results,
            });
        } catch (error: any) {
            log({ module: 'team-management', level: 'error' }, `Failed to batch archive teams: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // POST /v1/teams/batch/delete - Delete multiple teams
    app.post('/v1/teams/batch/delete', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                teamIds: z.array(z.string()).min(1).max(50)
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamIds } = request.body as { teamIds: string[] };

        try {
            const results = [];
            for (const teamId of teamIds) {
                try {
                    const result = await deleteTeam(userId, teamId);
                    results.push({ teamId, ...result });
                } catch (error: any) {
                    results.push({ teamId, success: false, error: error.message });
                }
            }
            return reply.send({
                success: true,
                deleted: results.filter(result => result.success).length,
                results,
            });
        } catch (error: any) {
            log({ module: 'team-management', level: 'error' }, `Failed to batch delete teams: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });
}

// === Implementation Functions ===

async function addTeamMember(
    userId: string,
    teamId: string,
    memberId: string | undefined,
    sessionId: string,
    sessionTag: string | undefined,
    roleId: string,
    displayName?: string,
    specId?: string,
    parentSessionId?: string,
    executionPlane?: string,
    runtimeType?: string
): Promise<{ success: boolean; member: any }> {
    const artifact = await getAccessibleTeamArtifact(userId, teamId);

    if (!artifact) {
        throw new Error('Team not found');
    }

    const board = extractTeamBoard(artifact);

    if (!board.team) {
        board.team = { members: [] };
    }
    if (!Array.isArray(board.team.members)) {
        board.team.members = [];
    }

    // Check if already exists
    const existing = board.team.members.find((m: any) => {
        if (memberId && m.memberId) {
            return m.memberId === memberId;
        }
        return m.sessionId === sessionId;
    });
    if (existing) {
        // Only write + broadcast if something actually changed
        const hasChanges =
            existing.sessionId !== sessionId ||
            existing.roleId !== roleId ||
            (memberId !== undefined && existing.memberId !== memberId) ||
            (sessionTag !== undefined && existing.sessionTag !== sessionTag) ||
            (displayName && existing.displayName !== displayName) ||
            (specId !== undefined && existing.specId !== specId) ||
            (parentSessionId !== undefined && existing.parentSessionId !== parentSessionId) ||
            (executionPlane !== undefined && existing.executionPlane !== executionPlane) ||
            (runtimeType !== undefined && existing.runtimeType !== runtimeType);

        if (!hasChanges) {
            return { success: true, member: existing };
        }

        existing.sessionId = sessionId;
        if (memberId !== undefined) existing.memberId = memberId;
        existing.roleId = roleId;
        if (sessionTag !== undefined) existing.sessionTag = sessionTag;
        existing.displayName = displayName || existing.displayName;
        if (specId !== undefined) existing.specId = specId;
        if (parentSessionId !== undefined) existing.parentSessionId = parentSessionId;
        if (executionPlane !== undefined) existing.executionPlane = executionPlane;
        if (runtimeType !== undefined) existing.runtimeType = runtimeType;
    } else {
        board.team.members.push({
            ...(memberId !== undefined && { memberId }),
            sessionId,
            ...(sessionTag !== undefined && { sessionTag }),
            roleId,
            displayName: displayName || `Agent ${roleId}`,
            focusAreas: [],
            joinedAt: Date.now(),
            ...(specId !== undefined && { specId }),
            ...(parentSessionId !== undefined && { parentSessionId }),
            ...(executionPlane !== undefined && { executionPlane }),
            ...(runtimeType !== undefined && { runtimeType })
        });
    }

    // Re-wrap in the same structure for storage
    await db.artifact.update({
        where: { id: teamId },
        data: {
            body: serializeTeamBoard(board),
            bodyVersion: { increment: 1 },
            updatedAt: new Date()
        }
    });

    // Broadcast update
    await broadcastTeamUpdate(userId, teamId, 'member-added', { sessionId, roleId });
    await invalidateTeamOverviewSnapshot(userId);

    return {
        success: true,
        member: existing || board.team.members[board.team.members.length - 1]
    };
}

async function removeTeamMember(
    userId: string,
    teamId: string,
    sessionId: string
): Promise<{ success: boolean }> {
    const artifact = await getAccessibleTeamArtifact(userId, teamId);

    if (!artifact) {
        throw new Error('Team not found');
    }

    const board = extractTeamBoard(artifact);

    if (!board.team?.members) {
        return { success: true };
    }

    board.team.members = board.team.members.filter((m: any) => m.sessionId !== sessionId);

    // Re-wrap in the same structure for storage
    await db.artifact.update({
        where: { id: teamId },
        data: {
            body: serializeTeamBoard(board),
            bodyVersion: { increment: 1 },
            updatedAt: new Date()
        }
    });

    // Broadcast update
    await broadcastTeamUpdate(userId, teamId, 'member-removed', { sessionId });
    await invalidateTeamOverviewSnapshot(userId);

    return { success: true };
}

async function archiveTeam(
    userId: string,
    teamId: string,
    sessionIds: string[] = []
): Promise<{ success: boolean; archivedSessions: number }> {
    const artifact = await getAccessibleTeamArtifact(userId, teamId);

    if (!artifact) {
        throw new Error('Team not found');
    }

    const board = extractTeamBoard(artifact);
    const managedSessionIds = Array.from(new Set([
        ...extractTeamMembers(board)
            .map((member) => member.sessionId)
            .filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.length > 0),
        ...sessionIds,
    ]));

    let archivedCount = 0;
    if (managedSessionIds.length > 0) {
        const result = await db.session.updateMany({
            where: {
                id: { in: managedSessionIds },
                accountId: userId
            },
            data: {
                active: false,
                updatedAt: new Date()
            }
        });
        archivedCount = result.count;
        managedSessionIds.forEach((sessionId) => activityCache.invalidateSession(sessionId));
    }

    const archivedAt = Date.now();
    board.archivedAt = archivedAt;
    if (!board.team || typeof board.team !== 'object') {
        board.team = { members: [] };
    }
    board.team.archivedAt = archivedAt;

    await db.artifact.update({
        where: { id: teamId },
        data: {
            body: serializeTeamBoard(board),
            bodyVersion: { increment: 1 },
            updatedAt: new Date()
        }
    });

    // Broadcast archive events for each session
    for (const sessionId of managedSessionIds) {
        await broadcastSessionUpdate(userId, sessionId, 'session-archived');
    }

    await broadcastTeamUpdate(userId, teamId, 'team-archived', { archivedSessions: archivedCount });
    await invalidateTeamOverviewSnapshot(userId);

    return { success: true, archivedSessions: archivedCount };
}

async function deleteTeam(
    userId: string,
    teamId: string,
    sessionIds: string[] = []
): Promise<{ success: boolean; deletedSessions: number }> {
    const artifact = await getAccessibleTeamArtifact(userId, teamId);

    if (!artifact) {
        throw new Error('Team not found');
    }

    const board = extractTeamBoard(artifact);
    const managedSessionIds = Array.from(new Set([
        ...extractTeamMembers(board)
            .map((member) => member.sessionId)
            .filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.length > 0),
        ...sessionIds,
    ]));

    let deletedCount = 0;
    if (managedSessionIds.length > 0) {
        const result = await db.session.deleteMany({
            where: {
                id: { in: managedSessionIds },
                accountId: userId
            }
        });
        deletedCount = result.count;
        managedSessionIds.forEach((sessionId) => activityCache.invalidateSession(sessionId));
    }

    // Delete team artifact
    await db.artifact.delete({
        where: { id: teamId }
    });

    // Broadcast delete events
    for (const sessionId of managedSessionIds) {
        await broadcastSessionUpdate(userId, sessionId, 'session-deleted');
    }

    await broadcastTeamUpdate(userId, teamId, 'team-deleted', { deletedSessions: deletedCount });
    await invalidateTeamOverviewSnapshot(userId);

    return { success: true, deletedSessions: deletedCount };
}

async function renameTeam(
    userId: string,
    teamId: string,
    name: string
): Promise<{ success: boolean; team: { id: string; name: string } }> {
    const artifact = await getAccessibleTeamArtifact(userId, teamId);

    if (!artifact) {
        throw new Error('Team not found');
    }

    const board = extractTeamBoard(artifact);

    board.name = name;
    if (board.team) {
        board.team.name = name;
    }

    await db.artifact.update({
        where: { id: teamId },
        data: {
            body: serializeTeamBoard(board),
            bodyVersion: { increment: 1 },
            updatedAt: new Date()
        }
    });

    await broadcastTeamUpdate(userId, teamId, 'team-renamed', { name });
    await invalidateTeamOverviewSnapshot(userId);

    return {
        success: true,
        team: {
            id: teamId,
            name,
        },
    };
}

async function batchArchiveSessions(
    userId: string,
    sessionIds: string[]
): Promise<{ success: boolean; archived: number; results: Array<{ sessionId: string; success: boolean; error?: string }> }> {
    const ownedSessions = await db.session.findMany({
        where: {
            id: { in: sessionIds },
            accountId: userId,
        },
        select: { id: true },
    });

    const ownedSessionIds = new Set(ownedSessions.map(session => session.id));
    const archivableIds = [...ownedSessionIds];

    if (archivableIds.length > 0) {
        await db.session.updateMany({
            where: {
                id: { in: archivableIds },
                accountId: userId
            },
            data: {
                active: false,
                updatedAt: new Date()
            }
        });
        archivableIds.forEach((sessionId) => activityCache.invalidateSession(sessionId));
    }

    for (const sessionId of archivableIds) {
        await broadcastSessionUpdate(userId, sessionId, 'session-archived');
    }

    return {
        success: true,
        archived: archivableIds.length,
        results: sessionIds.map(sessionId => ownedSessionIds.has(sessionId)
            ? { sessionId, success: true }
            : { sessionId, success: false, error: 'Session not found or not owned by user' }),
    };
}

async function batchDeleteSessions(
    userId: string,
    sessionIds: string[]
): Promise<{ success: boolean; deleted: number; results: Array<{ sessionId: string; success: boolean; error?: string }> }> {
    const ownedSessions = await db.session.findMany({
        where: {
            id: { in: sessionIds },
            accountId: userId,
        },
        select: { id: true },
    });

    const ownedSessionIds = new Set(ownedSessions.map(session => session.id));
    const deletableIds = [...ownedSessionIds];

    if (deletableIds.length > 0) {
        await db.session.deleteMany({
            where: {
                id: { in: deletableIds },
                accountId: userId
            }
        });
        deletableIds.forEach((sessionId) => activityCache.invalidateSession(sessionId));
    }

    for (const sessionId of deletableIds) {
        await broadcastSessionUpdate(userId, sessionId, 'session-deleted');
    }

    return {
        success: true,
        deleted: deletableIds.length,
        results: sessionIds.map(sessionId => ownedSessionIds.has(sessionId)
            ? { sessionId, success: true }
            : { sessionId, success: false, error: 'Session not found or not owned by user' }),
    };
}

async function renameSession(
    userId: string,
    sessionId: string,
    name: string
): Promise<{ success: boolean; session: { id: string; name: string } }> {
    // Get session
    const session = await db.session.findFirst({
        where: { id: sessionId, accountId: userId }
    });

    if (!session) {
        throw new Error('Session not found');
    }

    let nextMetadata = session.metadata;

    try {
        const parsed = JSON.parse(session.metadata);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            nextMetadata = JSON.stringify({
                ...parsed,
                name,
            });
        }
    } catch {
        // Leave existing metadata unchanged when it is not JSON.
    }

    if (nextMetadata !== session.metadata) {
        await db.session.update({
            where: { id: sessionId },
            data: {
                metadata: nextMetadata,
                metadataVersion: { increment: 1 },
                updatedAt: new Date(),
            },
        });
    }

    await broadcastSessionUpdate(userId, sessionId, 'session-renamed', { name });

    return {
        success: true,
        session: {
            id: sessionId,
            name,
        },
    };
}

// === Broadcast Helpers ===

async function broadcastTeamUpdate(
    userId: string,
    teamId: string,
    eventType: string,
    details: any
): Promise<void> {
    const updSeq = await allocateUserSeq(userId);

    eventRouter.emitUpdate({
        userId,
        payload: {
            id: randomKeyNaked(12),
            seq: updSeq,
            body: {
                t: 'team-update' as any,
                teamId,
                eventType,
                details
            },
            createdAt: Date.now()
        },
        recipientFilter: { type: 'all-user-authenticated-connections' }
    });
}

async function broadcastSessionUpdate(
    userId: string,
    sessionId: string,
    eventType: string,
    details?: any
): Promise<void> {
    const updSeq = await allocateUserSeq(userId);

    eventRouter.emitUpdate({
        userId,
        payload: {
            id: randomKeyNaked(12),
            seq: updSeq,
            body: {
                t: 'session-update' as any,
                sessionId,
                eventType,
                details
            },
            createdAt: Date.now()
        },
        recipientFilter: { type: 'all-user-authenticated-connections' }
    });
}
