import { eventRouter, buildNewSessionUpdate, buildUpdateSessionUpdate } from "@/app/events/eventRouter";
import { type Fastify } from "../types";
import { db } from "@/storage/db";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import { sessionDelete } from "@/app/session/sessionDelete";
import * as privacyKit from "privacy-kit";

function toSessionResponse(v: {
    id: string;
    seq: number;
    createdAt: Date;
    updatedAt: Date;
    metadata: string;
    metadataVersion: number;
    agentState: string | null;
    agentStateVersion: number;
    dataEncryptionKey: Uint8Array | null;
    active: boolean;
    lastActiveAt: Date;
    _count?: {
        messages?: number;
    };
}) {
    return {
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
        persistedMessageCount: v._count?.messages ?? 0,
    };
}

export function sessionRoutes(app: Fastify) {

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
                _count: {
                    select: {
                        messages: true,
                    }
                },
                // messages: {
                //     orderBy: { seq: 'desc' },
                //     take: 1,
                //     select: {
                //         id: true,
                //         seq: true,
                //         content: true,
                //         localId: true,
                //         createdAt: true
                //     }
                // }
            }
        });

        return reply.send({
            sessions: sessions.map((v) => ({
                ...toSessionResponse(v),
                lastMessage: null,
            }))
        });
    });

    // Get single session
    app.get('/v1/sessions/:sessionId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                sessionId: z.string(),
            }),
            response: {
                200: z.object({
                    session: z.object({
                        id: z.string(),
                        seq: z.number(),
                        createdAt: z.number(),
                        updatedAt: z.number(),
                        active: z.boolean(),
                        activeAt: z.number(),
                        metadata: z.string(),
                        metadataVersion: z.number(),
                        agentState: z.string().nullable(),
                        agentStateVersion: z.number(),
                        dataEncryptionKey: z.string().nullable(),
                        persistedMessageCount: z.number(),
                    }),
                }),
                403: z.object({
                    error: z.literal('Session not owned by user'),
                }),
                404: z.object({
                    error: z.literal('Session not found'),
                }),
                500: z.object({
                    error: z.literal('Failed to get session'),
                }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params;

        try {
            const session = await db.session.findFirst({
                where: {
                    id: sessionId,
                },
                select: {
                    id: true,
                    accountId: true,
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
                    _count: {
                        select: {
                            messages: true,
                        },
                    },
                },
            });

            if (!session) {
                return reply.code(404).send({ error: 'Session not found' });
            }

            if (session.accountId !== userId) {
                return reply.code(403).send({ error: 'Session not owned by user' });
            }

            return reply.send({
                session: toSessionResponse(session),
            });
        } catch (error) {
            log({ module: 'api', level: 'error' }, `Failed to get session: ${error}`);
            return reply.code(500).send({ error: 'Failed to get session' });
        }
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
                _count: {
                    select: {
                        messages: true,
                    }
                },
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
                persistedMessageCount: v._count.messages,
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
                changedSince: z.coerce.number().int().positive().optional()
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { cursor, limit = 50, changedSince } = request.query || {};

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
                _count: {
                    select: {
                        messages: true,
                    }
                },
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
                persistedMessageCount: v._count.messages,
            })),
            nextCursor,
            hasNext
        });
    });

    // Create or load session by tag
    app.post('/v1/sessions', {
        schema: {
            body: z.object({
                sessionId: z.string().optional(),
                tag: z.string(),
                metadata: z.string(),
                agentState: z.string().nullish(),
                dataEncryptionKey: z.string().nullish()
            })
        },
        preHandler: app.authenticate
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId, tag, metadata, dataEncryptionKey } = request.body;

        if (sessionId) {
            let exactSession = await db.session.findFirst({
                where: {
                    id: sessionId,
                    accountId: userId,
                }
            });

            if (exactSession) {
                if (exactSession.tag !== tag) {
                    const conflictingSession = await db.session.findFirst({
                        where: {
                            accountId: userId,
                            tag,
                        },
                        select: { id: true },
                    });

                    if (!conflictingSession || conflictingSession.id === exactSession.id) {
                        exactSession = await db.session.update({
                            where: { id: exactSession.id },
                            data: { tag },
                        });
                        log({ module: 'session-create', sessionId: exactSession.id, userId, tag }, `Migrated recovered session to stable tag ${tag}`);
                    }
                }

                log({ module: 'session-create', sessionId: exactSession.id, userId, tag }, `Recovered existing session by id: ${exactSession.id}`);
                return reply.send({
                    session: {
                        id: exactSession.id,
                        seq: exactSession.seq,
                        metadata: exactSession.metadata,
                        metadataVersion: exactSession.metadataVersion,
                        agentState: exactSession.agentState,
                        agentStateVersion: exactSession.agentStateVersion,
                        dataEncryptionKey: exactSession.dataEncryptionKey ? Buffer.from(exactSession.dataEncryptionKey).toString('base64') : null,
                        active: exactSession.active,
                        activeAt: exactSession.lastActiveAt.getTime(),
                        createdAt: exactSession.createdAt.getTime(),
                        updatedAt: exactSession.updatedAt.getTime(),
                        lastMessage: null,
                        tag: exactSession.tag,
                    }
                });
            }
        }

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
                    tag: session.tag,
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
                    lastMessage: null
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
                    dataEncryptionKey: dataEncryptionKey ? new Uint8Array(Buffer.from(dataEncryptionKey, 'base64')) : undefined
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
                    log({ module: 'session-artifact-link', sessionId: session.id, teamId }, `Attempting to link session to team artifact ${teamId}`);

                    // Find the team artifact
                    const artifact = await db.artifact.findFirst({
                        where: { id: teamId, accountId: userId }
                    });

                    if (artifact) {
                        try {
                            // Decode header
                            const headerStr = privacyKit.encodeBase64(artifact.header);
                            const header = JSON.parse(Buffer.from(headerStr, 'base64').toString());

                            // Add session ID if not already present
                            if (!header.sessions || !header.sessions.includes(session.id)) {
                                header.sessions = [...(header.sessions || []), session.id];

                                // Encode updated header
                                const newHeaderStr = Buffer.from(JSON.stringify(header)).toString('base64');
                                const newHeader = privacyKit.decodeBase64(newHeaderStr);

                                // Update artifact
                                await db.artifact.update({
                                    where: { id: artifact.id },
                                    data: {
                                        header: newHeader as any,
                                        headerVersion: artifact.headerVersion + 1,
                                        seq: artifact.seq + 1,
                                        updatedAt: new Date()
                                    }
                                });

                                log({ module: 'session-artifact-link', sessionId: session.id, teamId, artifactId: artifact.id },
                                    `Successfully linked session to artifact. New headerVersion: ${artifact.headerVersion + 1}`);
                            } else {
                                log({ module: 'session-artifact-link', sessionId: session.id, teamId },
                                    `Session already linked to artifact`);
                            }
                        } catch (headerError) {
                            // This is expected for encrypted artifacts
                            // log({ module: 'session-artifact-link', level: 'debug' }, `Skipping link for encrypted artifact header`);
                        }
                    } else {
                        log({ module: 'session-artifact-link', sessionId: session.id, teamId, level: 'warn' },
                            `Team artifact ${teamId} not found. Session not linked.`);
                    }
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
                    tag: session.tag,
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
                    lastMessage: null
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
            },
            select: { id: true, accountId: true }
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        if (session.accountId !== userId) {
            return reply.code(403).send({ error: 'Session not owned by user' });
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

        const totalCount = await db.sessionMessage.count({
            where: { sessionId }
        });

        return reply.send({
            totalCount,
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
            },
            select: { id: true, accountId: true, metadataVersion: true }
        });

        if (!session) {
            return reply.code(404).send({ error: 'Session not found' });
        }

        if (session.accountId !== userId) {
            return reply.code(403).send({ error: 'Session not owned by user' });
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
}
