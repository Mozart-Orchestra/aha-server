import { Fastify } from "../types";
import { z } from "zod";
import { log } from "@/utils/log";
import { db } from "@/storage/db";
import { eventRouter } from "@/app/events/eventRouter";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { parseTeamArtifactBody } from "@/utils/teamArtifacts";

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

    // === Team Member Management ===

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
                const result = await archiveTeam(userId, teamId);
                results.push({ teamId, ...result });
            }
            return reply.send({ success: true, results });
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
                const result = await deleteTeam(userId, teamId);
                results.push({ teamId, ...result });
            }
            return reply.send({ success: true, results });
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
    // Query by teamId only - team artifacts are shared across all team members
    const artifact = await db.artifact.findFirst({
        where: { id: teamId }
    });

    if (!artifact) {
        throw new Error('Team not found');
    }

    // 防御性检查: artifact.body 可能为 null
    if (!artifact.body) {
        throw new Error('Team artifact not initialized - please open Kanban to initialize the team first');
    }

    const board = parseTeamArtifactBody(artifact.body) as Record<string, any>;

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
    const updatedWrapper = { body: JSON.stringify(board) };
    const bodyBuffer = Buffer.from(JSON.stringify(updatedWrapper));
    await db.artifact.update({
        where: { id: teamId },
        data: {
            body: bodyBuffer,
            bodyVersion: { increment: 1 },
            updatedAt: new Date()
        }
    });

    // Broadcast update
    await broadcastTeamUpdate(userId, teamId, 'member-added', { sessionId, roleId });

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
    // Query by teamId only - team artifacts are shared across all team members
    const artifact = await db.artifact.findFirst({
        where: { id: teamId }
    });

    if (!artifact) {
        throw new Error('Team not found');
    }

    // 防御性检查: artifact.body 可能为 null
    if (!artifact.body) {
        throw new Error('Team artifact not initialized - please open Kanban to initialize the team first');
    }

    const board = parseTeamArtifactBody(artifact.body) as Record<string, any>;

    if (!board.team?.members) {
        return { success: true };
    }

    board.team.members = board.team.members.filter((m: any) => m.sessionId !== sessionId);

    // Re-wrap in the same structure for storage
    const updatedWrapper = { body: JSON.stringify(board) };
    const bodyBuffer = Buffer.from(JSON.stringify(updatedWrapper));
    await db.artifact.update({
        where: { id: teamId },
        data: {
            body: bodyBuffer,
            bodyVersion: { increment: 1 },
            updatedAt: new Date()
        }
    });

    // Broadcast update
    await broadcastTeamUpdate(userId, teamId, 'member-removed', { sessionId });

    return { success: true };
}

async function archiveTeam(
    userId: string,
    teamId: string,
    sessionIds: string[] = []
): Promise<{ success: boolean; archivedSessions: number }> {
    // Get team artifact (just verify it exists)
    // Query by teamId only - team artifacts are shared across all team members
    const artifact = await db.artifact.findFirst({
        where: { id: teamId }
    });

    if (!artifact) {
        throw new Error('Team not found');
    }

    // Use sessionIds provided by client (since body is encrypted)
    // Archive all sessions (set active = false)
    if (sessionIds.length > 0) {
        await db.session.updateMany({
            where: {
                id: { in: sessionIds },
                accountId: userId
            },
            data: {
                active: false,
                updatedAt: new Date()
            }
        });
    }

    // Just increment version to trigger sync - client will handle body update
    // (We can't modify encrypted body on server)
    await db.artifact.update({
        where: { id: teamId },
        data: {
            bodyVersion: { increment: 1 },
            updatedAt: new Date()
        }
    });

    // Broadcast archive events for each session
    for (const sessionId of sessionIds) {
        await broadcastSessionUpdate(userId, sessionId, 'session-archived');
    }

    await broadcastTeamUpdate(userId, teamId, 'team-archived', { archivedSessions: sessionIds.length });

    return { success: true, archivedSessions: sessionIds.length };
}

async function deleteTeam(
    userId: string,
    teamId: string,
    sessionIds: string[] = []
): Promise<{ success: boolean; deletedSessions: number }> {
    // Get team artifact (just verify it exists)
    // Query by teamId only - team artifacts are shared across all team members
    const artifact = await db.artifact.findFirst({
        where: { id: teamId }
    });

    if (!artifact) {
        throw new Error('Team not found');
    }

    // Use sessionIds provided by client (since body is encrypted)
    // Delete all sessions
    if (sessionIds.length > 0) {
        await db.session.deleteMany({
            where: {
                id: { in: sessionIds },
                accountId: userId
            }
        });
    }

    // Delete team artifact
    await db.artifact.delete({
        where: { id: teamId }
    });

    // Broadcast delete events
    for (const sessionId of sessionIds) {
        await broadcastSessionUpdate(userId, sessionId, 'session-deleted');
    }

    await broadcastTeamUpdate(userId, teamId, 'team-deleted', { deletedSessions: sessionIds.length });

    return { success: true, deletedSessions: sessionIds.length };
}

async function renameTeam(
    userId: string,
    teamId: string,
    name: string
): Promise<{ success: boolean; name: string }> {
    // Query by teamId only - team artifacts are shared across all team members
    const artifact = await db.artifact.findFirst({
        where: { id: teamId }
    });

    if (!artifact) {
        throw new Error('Team not found');
    }

    // 防御性检查: artifact.body 可能为 null
    if (!artifact.body) {
        throw new Error('Team artifact not initialized - please open Kanban to initialize the team first');
    }

    const board = parseTeamArtifactBody(artifact.body) as Record<string, any>;

    board.name = name;
    if (board.team) {
        board.team.name = name;
    }

    // Re-wrap in the same structure for storage
    const updatedWrapper = { body: JSON.stringify(board) };
    const bodyBuffer = Buffer.from(JSON.stringify(updatedWrapper));
    await db.artifact.update({
        where: { id: teamId },
        data: {
            body: bodyBuffer,
            bodyVersion: { increment: 1 },
            updatedAt: new Date()
        }
    });

    await broadcastTeamUpdate(userId, teamId, 'team-renamed', { name });

    return { success: true, name };
}

async function batchArchiveSessions(
    userId: string,
    sessionIds: string[]
): Promise<{ success: boolean; archived: number }> {
    const result = await db.session.updateMany({
        where: {
            id: { in: sessionIds },
            accountId: userId
        },
        data: {
            active: false,
            updatedAt: new Date()
        }
    });

    for (const sessionId of sessionIds) {
        await broadcastSessionUpdate(userId, sessionId, 'session-archived');
    }

    return { success: true, archived: result.count };
}

async function batchDeleteSessions(
    userId: string,
    sessionIds: string[]
): Promise<{ success: boolean; deleted: number }> {
    const result = await db.session.deleteMany({
        where: {
            id: { in: sessionIds },
            accountId: userId
        }
    });

    for (const sessionId of sessionIds) {
        await broadcastSessionUpdate(userId, sessionId, 'session-deleted');
    }

    return { success: true, deleted: result.count };
}

async function renameSession(
    userId: string,
    sessionId: string,
    name: string
): Promise<{ success: boolean; name: string }> {
    // Get session
    const session = await db.session.findFirst({
        where: { id: sessionId, accountId: userId }
    });

    if (!session) {
        throw new Error('Session not found');
    }

    // Update metadata with new name
    // Note: This requires decryption/encryption which is done by the client
    // For now, we just broadcast the rename event and let clients update their local state

    await broadcastSessionUpdate(userId, sessionId, 'session-renamed', { name });

    return { success: true, name };
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
