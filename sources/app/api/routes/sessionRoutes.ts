import {
    eventRouter,
    buildNewSessionUpdate,
    buildUpdateSessionUpdate,
    buildSessionActivityEphemeral
} from "@/app/events/eventRouter";
import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import { sessionDelete } from "@/app/session/sessionDelete";
import * as privacyKit from "privacy-kit";
import { ensureSessionLinkedToTeam } from "@/utils/teamArtifacts";
import { appendTeamEvidence } from "@/services/evolutionEvidenceService";

export function sessionRoutes(app: Fastify) {

    type SessionLifecycleEvent = 'start' | 'heartbeat' | 'end';

    const normalizeLifecycleTimestamp = (rawTimestamp?: number): number | null => {
        const now = Date.now();
        if (rawTimestamp === undefined) return now;
        if (!Number.isFinite(rawTimestamp)) return null;
        if (rawTimestamp > now + 60_000) return null;
        if (rawTimestamp < now - 24 * 60 * 60 * 1000) return null;
        return Math.floor(rawTimestamp);
    };

    const applySessionLifecycle = async (
        userId: string,
        sessionId: string,
        event: SessionLifecycleEvent,
        options: { timestamp?: number; thinking?: boolean; machineId?: string }
    ): Promise<{ statusCode: number; payload: Record<string, unknown> }> => {
        const session = await db.session.findFirst({
            where: {
                id: sessionId,
                accountId: userId
            }
        });

        if (!session) {
            return {
                statusCode: 404,
                payload: { error: 'Session not found' }
            };
        }

        const normalizedTimestamp = normalizeLifecycleTimestamp(options.timestamp);
        if (normalizedTimestamp === null) {
            return {
                statusCode: 400,
                payload: { error: 'Invalid timestamp' }
            };
        }

        const active = event !== 'end';
        const normalizedMachineId = typeof options.machineId === 'string'
            ? options.machineId.trim()
            : undefined;
        const updateData: Prisma.SessionUpdateInput = {
            active,
            lastActiveAt: new Date(normalizedTimestamp),
        };

        if (options.machineId !== undefined) {
            updateData.machineId = normalizedMachineId || null;
        }

        const lifecycleMachineId = options.machineId !== undefined
            ? (normalizedMachineId || null)
            : (session.machineId || null);

        const updatedSession = await db.session.update({
            where: { id: sessionId },
            data: updateData,
            select: {
                id: true,
                active: true,
                lastActiveAt: true,
                machineId: true,
                updatedAt: true,
            }
        });

        // Keep machine presence fresh when lifecycle calls are used without machine heartbeats.
        if (active && lifecycleMachineId && typeof (db as any).machine?.updateMany === 'function') {
            await (db as any).machine.updateMany({
                where: {
                    accountId: userId,
                    id: lifecycleMachineId
                },
                data: {
                    active: true,
                    lastActiveAt: new Date(normalizedTimestamp),
                    updatedAt: new Date()
                }
            });
        }

        eventRouter.emitEphemeral({
            userId,
            payload: buildSessionActivityEphemeral(
                sessionId,
                updatedSession.active,
                updatedSession.lastActiveAt.getTime(),
                updatedSession.active ? (options.thinking || false) : false
            ),
            recipientFilter: { type: 'user-scoped-only' }
        });

        if (typeof (db as any).teamMember?.findMany === 'function') {
            try {
                const memberships = await (db as any).teamMember.findMany({
                    where: { sessionId },
                    select: {
                        teamId: true,
                        roleId: true,
                        displayName: true,
                    },
                });

                for (const membership of memberships as Array<{ teamId: string; roleId?: string | null; displayName?: string | null }>) {
                    await appendTeamEvidence({
                        teamId: membership.teamId,
                        category: 'runtime',
                        source: 'session-lifecycle',
                        title: `Session ${event}: ${membership.displayName || membership.roleId || sessionId}`,
                        summary: `${event} on ${lifecycleMachineId || 'unassigned machine'}${options.thinking ? ' while thinking' : ''}.`,
                        actor: sessionId,
                        refs: [{ type: 'session', id: sessionId }],
                        metadata: {
                            event,
                            machineId: lifecycleMachineId,
                            roleId: membership.roleId || null,
                            thinking: options.thinking || false,
                        },
                        timestamp: normalizedTimestamp,
                    });
                }
            } catch {
                // Keep lifecycle updates non-blocking even if evidence persistence fails.
            }
        }

        return {
            statusCode: 200,
            payload: {
                success: true,
                event,
                session: {
                    id: updatedSession.id,
                    active: updatedSession.active,
                    activeAt: updatedSession.lastActiveAt.getTime(),
                    machineId: updatedSession.machineId,
                    updatedAt: updatedSession.updatedAt.getTime(),
                }
            }
        };
    };

    // Sessions API
    app.get('/v1/sessions', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;

        const sessions = await db.session.findMany({
            where: { accountId: userId },
            orderBy: { updatedAt: 'desc' },
            take: 150,
            select: {
                id: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                active: true,
                lastActiveAt: true,
                // R3 Session Parameters
                displayName: true,
                mode: true,
                machineId: true,
                roleId: true,
                rootPathHash: true,
            }
        });

        return reply.send({
            sessions: sessions.map((v) => ({
                id: v.id,
                seq: v.seq,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime(),
                active: v.active,
                activeAt: v.lastActiveAt.getTime(),
                metadata: v.metadata,
                metadataVersion: v.metadataVersion,
                agentState: v.agentState,
                agentStateVersion: v.agentStateVersion,
                dataEncryptionKey: v.dataEncryptionKey ? Buffer.from(v.dataEncryptionKey).toString('base64') : null,
                lastMessage: null,
                // R3 Session Parameters
                displayName: v.displayName,
                mode: v.mode,
                machineId: v.machineId,
                roleId: v.roleId,
                rootPathHash: v.rootPathHash,
            }))
        });
    });

    // V2 Sessions API - Active sessions only
    app.get('/v2/sessions/active', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(500).default(150)
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const limit = request.query?.limit || 150;

        const sessions = await db.session.findMany({
            where: {
                accountId: userId,
                active: true,
                lastActiveAt: { gt: new Date(Date.now() - 1000 * 60 * 15) /* 15 minutes */ }
            },
            orderBy: { lastActiveAt: 'desc' },
            take: limit,
            select: {
                id: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                active: true,
                lastActiveAt: true,
                // R3 Session Parameters
                displayName: true,
                mode: true,
                machineId: true,
                roleId: true,
                rootPathHash: true,
            }
        });

        return reply.send({
            sessions: sessions.map((v) => ({
                id: v.id,
                seq: v.seq,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime(),
                active: v.active,
                activeAt: v.lastActiveAt.getTime(),
                metadata: v.metadata,
                metadataVersion: v.metadataVersion,
                agentState: v.agentState,
                agentStateVersion: v.agentStateVersion,
                dataEncryptionKey: v.dataEncryptionKey ? Buffer.from(v.dataEncryptionKey).toString('base64') : null,
                // R3 Session Parameters
                displayName: v.displayName,
                mode: v.mode,
                machineId: v.machineId,
                roleId: v.roleId,
                rootPathHash: v.rootPathHash,
            }))
        });
    });

    // V2 Sessions API - Cursor-based pagination with change tracking
    app.get('/v2/sessions', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                cursor: z.string().optional(),
                limit: z.coerce.number().int().min(1).max(200).default(50),
                changedSince: z.coerce.number().int().positive().optional(),
                // R3 Session Parameters - query filters
                mode: z.enum(['claude', 'codex', 'ralph']).optional(),
                machineId: z.string().optional(),
                roleId: z.string().optional(),
                active: z.coerce.boolean().optional(),
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { cursor, limit = 50, changedSince, mode, machineId, roleId, active } = request.query || {};

        // Decode cursor - simple ID-based cursor
        let cursorSessionId: string | undefined;
        if (cursor) {
            if (cursor.startsWith('cursor_v1_')) {
                cursorSessionId = cursor.substring(10);
            } else {
                return reply.code(400).send({ error: 'Invalid cursor format' });
            }
        }

        // Build where clause
        const where: Prisma.SessionWhereInput = { accountId: userId };

        // Add changedSince filter (just a filter, doesn't affect pagination)
        if (changedSince) {
            where.updatedAt = {
                gt: new Date(changedSince)
            };
        }

        // R3 Session Parameters - add filters
        if (mode) {
            where.mode = mode;
        }
        if (machineId) {
            where.machineId = machineId;
        }
        if (roleId) {
            where.roleId = roleId;
        }
        if (active !== undefined) {
            where.active = active;
        }

        // Add cursor pagination - always by ID descending (most recent first)
        if (cursorSessionId) {
            where.id = {
                lt: cursorSessionId  // Get sessions with ID less than cursor (for desc order)
            };
        }

        // Always sort by ID descending for consistent pagination
        const orderBy = { id: 'desc' as const };

        const sessions = await db.session.findMany({
            where,
            orderBy,
            take: limit + 1, // Fetch one extra to determine if there are more
            select: {
                id: true,
                seq: true,
                createdAt: true,
                updatedAt: true,
                metadata: true,
                metadataVersion: true,
                agentState: true,
                agentStateVersion: true,
                dataEncryptionKey: true,
                active: true,
                lastActiveAt: true,
                // R3 Session Parameters
                displayName: true,
                mode: true,
                machineId: true,
                roleId: true,
                rootPathHash: true,
            }
        });

        // Check if there are more results
        const hasNext = sessions.length > limit;
        const resultSessions = hasNext ? sessions.slice(0, limit) : sessions;

        // Generate next cursor - simple ID-based cursor
        let nextCursor: string | null = null;
        if (hasNext && resultSessions.length > 0) {
            const lastSession = resultSessions[resultSessions.length - 1];
            nextCursor = `cursor_v1_${lastSession.id}`;
        }

        return reply.send({
            sessions: resultSessions.map((v) => ({
                id: v.id,
                seq: v.seq,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime(),
                active: v.active,
                activeAt: v.lastActiveAt.getTime(),
                metadata: v.metadata,
                metadataVersion: v.metadataVersion,
                agentState: v.agentState,
                agentStateVersion: v.agentStateVersion,
                dataEncryptionKey: v.dataEncryptionKey ? Buffer.from(v.dataEncryptionKey).toString('base64') : null,
                // R3 Session Parameters
                displayName: v.displayName,
                mode: v.mode,
                machineId: v.machineId,
                roleId: v.roleId,
                rootPathHash: v.rootPathHash,
            })),
            nextCursor,
            hasNext
        });
    });

    // Create or load session by tag
    app.post('/v1/sessions', {
        schema: {
            body: z.object({
                tag: z.string(),
                metadata: z.string(),
                agentState: z.string().nullish(),
                dataEncryptionKey: z.string().nullish(),
                // R3 Session Parameters
                displayName: z.string().max(100).optional(),
                mode: z.enum(['claude', 'codex', 'ralph']).optional(),
                machineId: z.string().optional(),
                roleId: z.string().optional(),
                rootPathHash: z.string().optional(),
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { tag, metadata, dataEncryptionKey, displayName, mode, machineId, roleId, rootPathHash } = request.body;

        const session = await db.session.findFirst({
            where: {
                accountId: userId,
                tag: tag
            }
        });
        if (session) {
            log({ module: 'session-create', sessionId: session.id, userId, tag }, `Found existing session: ${session.id} for tag ${tag}`);
            return reply.send({
                session: {
                    id: session.id,
                    seq: session.seq,
                    metadata: session.metadata,
                    metadataVersion: session.metadataVersion,
                    agentState: session.agentState,
                    agentStateVersion: session.agentStateVersion,
                    dataEncryptionKey: session.dataEncryptionKey ? Buffer.from(session.dataEncryptionKey).toString('base64') : null,
                    active: session.active,
                    activeAt: session.lastActiveAt.getTime(),
                    createdAt: session.createdAt.getTime(),
                    updatedAt: session.updatedAt.getTime(),
                    lastMessage: null,
                    // R3 Session Parameters
                    displayName: session.displayName,
                    mode: session.mode,
                    machineId: session.machineId,
                    roleId: session.roleId,
                    rootPathHash: session.rootPathHash,
                }
            });
        } else {

            // Resolve seq
            const updSeq = await allocateUserSeq(userId);

            // Create session
            log({ module: 'session-create', userId, tag }, `Creating new session for user ${userId} with tag ${tag}`);
            const session = await db.session.create({
                data: {
                    accountId: userId,
                    tag: tag,
                    metadata: metadata,
                    dataEncryptionKey: dataEncryptionKey ? new Uint8Array(Buffer.from(dataEncryptionKey, 'base64')) : undefined,
                    // R3 Session Parameters
                    displayName: displayName,
                    mode: mode,
                    machineId: machineId,
                    roleId: roleId,
                    rootPathHash: rootPathHash,
                }
            });
            log({ module: 'session-create', sessionId: session.id, userId }, `Session created: ${session.id}`);

            // Auto-link session to team artifact if metadata contains teamId
            try {
                // Safeguard against encrypted metadata which is not valid JSON
                let parsedMetadata: any = {};
                try {
                    parsedMetadata = metadata ? JSON.parse(metadata) : {};
                } catch (e) {
                    // This is expected for encrypted sessions
                    // log({ module: 'session-create', level: 'debug' }, `Skipping auto-link for encrypted session metadata`);
                }

                const teamId = parsedMetadata.teamId;

                if (teamId) {
                    await ensureSessionLinkedToTeam(db, userId, session.id, teamId, privacyKit, log);
                }
            } catch (error) {
                // Don't fail session creation if artifact linking fails
                log({ module: 'session-artifact-link', sessionId: session.id, level: 'error' },
                    `Failed to link session to artifact: ${error}`);
            }

            // Emit new session update
            const updatePayload = buildNewSessionUpdate(session, updSeq, randomKeyNaked(12));
            log({
                module: 'session-create',
                userId,
                sessionId: session.id,
                updateType: 'new-session',
                updatePayload: JSON.stringify(updatePayload)
            }, `Emitting new-session update to user-scoped connections`);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            return reply.send({
                session: {
                    id: session.id,
                    seq: session.seq,
                    metadata: session.metadata,
                    metadataVersion: session.metadataVersion,
                    agentState: session.agentState,
                    agentStateVersion: session.agentStateVersion,
                    dataEncryptionKey: session.dataEncryptionKey ? Buffer.from(session.dataEncryptionKey).toString('base64') : null,
                    active: session.active,
                    activeAt: session.lastActiveAt.getTime(),
                    createdAt: session.createdAt.getTime(),
                    updatedAt: session.updatedAt.getTime(),
                    lastMessage: null,
                    // R3 Session Parameters
                    displayName: session.displayName,
                    mode: session.mode,
                    machineId: session.machineId,
                    roleId: session.roleId,
                    rootPathHash: session.rootPathHash,
                }
            });
        }
    });

    app.get('/v1/sessions/:sessionId/messages', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        // Verify session belongs to user
        const session = await db.session.findFirst({
            where: {
                id: sessionId,
                accountId: userId
            }
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        const messages = await db.sessionMessage.findMany({
            where: { sessionId },
            orderBy: { createdAt: 'desc' },
            take: 150,
            select: {
                id: true,
                seq: true,
                localId: true,
                content: true,
                createdAt: true,
                updatedAt: true
            }
        });

        return reply.send({
            messages: messages.map((v) => ({
                id: v.id,
                seq: v.seq,
                content: v.content,
                localId: v.localId,
                createdAt: v.createdAt.getTime(),
                updatedAt: v.updatedAt.getTime()
            }))
        });
    });

    // Delete session
    app.delete('/v1/sessions/:sessionId', {
        schema: {
            params: z.object({
                sessionId: z.string()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        const deleted = await sessionDelete({ uid: userId }, sessionId);

        if (!deleted) {
            return reply.code(404).send({ error: 'Session not found or not owned by user' });
        }

        return reply.send({ success: true });
    });

    // Update session metadata
    app.post('/v1/sessions/:sessionId/metadata', {
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            body: z.object({
                metadata: z.string(),
                expectedVersion: z.number().int().optional()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { metadata, expectedVersion } = request.body;

        // Verify session belongs to user
        const session = await db.session.findFirst({
            where: {
                id: sessionId,
                accountId: userId
            }
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Check version if provided
        if (expectedVersion !== undefined && session.metadataVersion !== expectedVersion) {
            return reply.code(409).send({
                error: 'Version mismatch',
                currentVersion: session.metadataVersion
            });
        }

        // Update session
        const updatedSession = await db.session.update({
            where: { id: sessionId },
            data: {
                metadata: metadata,
                metadataVersion: { increment: 1 }
            }
        });

        // Emit update
        const updSeq = await allocateUserSeq(userId);
        const updatePayload = buildUpdateSessionUpdate(
            session.id,
            updSeq,
            randomKeyNaked(12),
            {
                value: updatedSession.metadata,
                version: updatedSession.metadataVersion
            }
        );

        eventRouter.emitUpdate({
            userId,
            payload: updatePayload,
            recipientFilter: { type: 'all-interested-in-session', sessionId: session.id }
        });

        return reply.send({
            success: true,
            version: updatedSession.metadataVersion
        });
    });

    // Update R3 Session Parameters
    app.patch('/v1/sessions/:sessionId/params', {
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            body: z.object({
                displayName: z.string().max(100).optional(),
                mode: z.union([z.enum(['claude', 'codex', 'ralph']), z.literal('')]).optional(),
                machineId: z.string().optional(),
                roleId: z.string().optional(),
                rootPathHash: z.string().optional(),
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { displayName, mode, machineId, roleId, rootPathHash } = request.body;

        // Verify session belongs to user
        const session = await db.session.findFirst({
            where: {
                id: sessionId,
                accountId: userId
            }
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        // Build update data - only include provided fields
        // Convert empty strings to null for clearing values
        const updateData: Partial<{
            displayName: string | null;
            mode: string | null;
            machineId: string | null;
            roleId: string | null;
            rootPathHash: string | null;
        }> = {};

        if (displayName !== undefined) updateData.displayName = displayName || null;
        if (mode !== undefined) updateData.mode = (mode === '' ? null : mode);
        if (machineId !== undefined) updateData.machineId = machineId || null;
        if (roleId !== undefined) updateData.roleId = roleId || null;
        if (rootPathHash !== undefined) updateData.rootPathHash = rootPathHash || null;

        // Update session
        const updatedSession = await db.session.update({
            where: { id: sessionId },
            data: updateData,
            select: {
                id: true,
                seq: true,
                displayName: true,
                mode: true,
                machineId: true,
                roleId: true,
                rootPathHash: true,
                updatedAt: true,
            }
        });

        // Note: buildUpdateSessionUpdate currently only supports metadata/agentState payloads.
        // R3 session params are returned directly in response and can be refreshed by clients.

        return reply.send({
            success: true,
            session: {
                id: updatedSession.id,
                displayName: updatedSession.displayName,
                mode: updatedSession.mode,
                machineId: updatedSession.machineId,
                roleId: updatedSession.roleId,
                rootPathHash: updatedSession.rootPathHash,
                updatedAt: updatedSession.updatedAt.getTime(),
            }
        });
    });

    // Session lifecycle API for app/CLI integrations that do not use socket events
    app.post('/v1/sessions/:sessionId/lifecycle', {
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            body: z.object({
                event: z.enum(['start', 'heartbeat', 'end']),
                timestamp: z.number().int().optional(),
                thinking: z.boolean().optional(),
                machineId: z.string().optional(),
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const { event, timestamp, thinking, machineId } = request.body;

        const result = await applySessionLifecycle(userId, sessionId, event, { timestamp, thinking, machineId });
        return reply.code(result.statusCode).send(result.payload);
    });

    app.post('/v1/sessions/:sessionId/heartbeat', {
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            body: z.object({
                timestamp: z.number().int().optional(),
                thinking: z.boolean().optional(),
                machineId: z.string().optional(),
            }).optional()
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const payload = request.body as { timestamp?: number; thinking?: boolean; machineId?: string } | undefined;
        const result = await applySessionLifecycle(userId, sessionId, 'heartbeat', {
            timestamp: payload?.timestamp,
            thinking: payload?.thinking,
            machineId: payload?.machineId,
        });
        return reply.code(result.statusCode).send(result.payload);
    });

    app.post('/v1/sessions/:sessionId/end', {
        schema: {
            params: z.object({
                sessionId: z.string()
            }),
            body: z.object({
                timestamp: z.number().int().optional()
            }).optional()
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;
        const payload = request.body as { timestamp?: number } | undefined;
        const result = await applySessionLifecycle(userId, sessionId, 'end', {
            timestamp: payload?.timestamp
        });
        return reply.code(result.statusCode).send(result.payload);
    });
}
