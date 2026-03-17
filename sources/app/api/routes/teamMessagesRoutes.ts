import { eventRouter } from "@/app/events/eventRouter";
import { db } from "@/storage/db";
import { Fastify } from "../types";
import { z } from "zod";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import { log } from "@/utils/log";
import { kvList } from "@/app/kv/kvList";
import { kvMutate } from "@/app/kv/kvMutate";
import { encryptString, decryptString } from "@/modules/encrypt";
import { teamMessagesCounter, teamTaskOperationsCounter } from "@/app/monitoring/metrics2";

/**
 * Team Messages Routes
 * 
 * 实现真实的团队消息API端点
 * - GET /v1/teams/:teamId/messages - 获取团队消息列表
 * - POST /v1/teams/:teamId/messages - 发送团队消息
 */

// Message schema
const TeamMessageMetadataSchema = z.object({
    taskId: z.string().optional(),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    replyToId: z.string().optional(),
    attachmentIds: z.array(z.string()).optional(),
    edited: z.boolean().optional(),
    editedAt: z.number().optional(),
    handshake: z.object({
        type: z.string().optional(),
        version: z.string().optional(),
        payload: z.record(z.any()).optional()
    }).optional()
}).passthrough();

const TeamMessageSchema = z.object({
    id: z.string().uuid(),
    teamId: z.string(),
    fromSessionId: z.string().optional(),
    fromRole: z.string().optional(),
    fromDisplayName: z.string().optional(),
    content: z.string().max(50000),  // agents send long messages; raised from 2000
    shortContent: z.string().optional(),
    type: z.enum(['chat', 'task-update', 'notification', 'role-assignment', 'system']).or(z.string()),
    mentions: z.array(z.string()).optional(),
    timestamp: z.number(),
    metadata: TeamMessageMetadataSchema.optional()
});

function buildEncryptionPath(userId: string, teamId: string, messageId: string) {
    return ['user', userId, 'teams', teamId, 'messages', messageId];
}

export function teamMessagesRoutes(app: Fastify) {
    log({ module: 'api' }, 'Registering teamMessagesRoutes...');

    app.get('/v1/teams/ping', async (request, reply) => {
        return { pong: true };
    });

    app.get('/v1/teams/:teamId/ping', async (request, reply) => {
        const { teamId } = request.params as { teamId: string };
        return { pong: true, teamId };
    });

    // GET /v1/teams/:teamId/messages - 获取团队消息（分页加载）
    // 每次只返回最新的 `limit` 条（默认 50，最多 200）。
    // 客户端向上滚动时传 ?before=<cursor> 加载更早的消息；cursor 是上次返回的最旧消息的 KV key。
    app.get('/v1/teams/:teamId/messages', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string()
            }),
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(200).default(50),
                before: z.string().optional()   // KV key cursor（来自上次响应的 cursor 字段）
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const { limit, before } = request.query as { limit?: number, before?: string };

        try {
            // Verify team exists and belongs to the current user
            const team = await db.artifact.findFirst({
                where: { id: teamId, accountId: userId },
                select: { id: true }
            });

            if (!team) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            const prefix = `team_messages.${teamId}.`;
            const fetchLimit = Math.min(limit ?? 50, 200);

            // Key format: team_messages.{teamId}.{timestamp}.{messageId}
            // ORDER BY key DESC → newest first; we take `fetchLimit` rows and reverse for client.
            const whereClause: any = {
                accountId: userId,
                key: { startsWith: prefix },
                value: { not: null }
            };

            // Cursor: load messages strictly older than `before` key
            if (before) {
                whereClause.key = { startsWith: prefix, lt: before };
            }

            const results = await db.userKVStore.findMany({
                where: whereClause,
                orderBy: { key: 'desc' },
                take: fetchLimit,
                select: { key: true, value: true }
            });

            const messages: Array<any & { _key: string }> = [];
            for (const item of results) {
                try {
                    const parts = item.key.split('.');
                    const messageId = parts[parts.length - 1];
                    const decrypted = decryptString(
                        buildEncryptionPath(userId, teamId, messageId),
                        item.value!
                    );
                    messages.push({ ...JSON.parse(decrypted), _key: item.key });
                } catch {
                    // skip corrupted entries silently
                }
            }

            // Restore chronological order for the client
            messages.sort((a, b) => a.timestamp - b.timestamp);

            // Cursor for the next older page = KV key of the oldest message in this page
            const nextCursor = messages.length > 0 ? messages[0]._key : undefined;

            return reply.send({
                messages: messages.map(({ _key, ...rest }) => rest),
                hasMore: results.length === fetchLimit,
                cursor: nextCursor
            });
        } catch (error) {
            log({ module: 'team-messages', level: 'error' }, `Failed to get messages: ${error}`);
            return reply.code(500).send({ error: 'Failed to get messages' });
        }
    });

    // POST /v1/teams/:teamId/messages - 发送团队消息
    app.post('/v1/teams/:teamId/messages', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string()
            }),
            body: TeamMessageSchema,
            response: {
                200: z.object({
                    success: z.literal(true),
                    messageId: z.string()
                }),
                400: z.object({
                    error: z.string()
                }),
                403: z.object({
                    error: z.string()
                }),
                404: z.object({
                    error: z.literal('Team not found')
                }),
                500: z.object({
                    error: z.literal('Failed to send message')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };

        // Fastify's schema validation (using Zod) already handles this,
        // but we can add explicit logging for validation errors if needed.
        const parseResult = TeamMessageSchema.safeParse(request.body);
        if (!parseResult.success) {
            log({ module: 'team-messages', level: 'error' }, `Message validation failed: ${JSON.stringify(parseResult.error.errors)}`);
            log({ module: 'team-messages', level: 'error' }, `Request body: ${JSON.stringify(request.body)}`);
            return reply.status(400).send({ error: `Invalid message format: ${parseResult.error.errors.map(e => e.message).join(', ')}` });
        }
        const message = parseResult.data;
        const { content, type, metadata, fromSessionId, fromRole, fromDisplayName, mentions } = message;

        try {
            log({ module: 'team-messages', level: 'info' }, `Sending message to teamId: ${teamId}, userId: ${userId}`);

            // Security Check: Verify fromSessionId belongs to the user
            // This prevents an agent from spoofing a session they don't own (e.g. another user's session, if we were multi-tenant in that way)
            // or ensures consistency.
            // Security Check: Verify fromSessionId belongs to the user and override identity fields
            // This prevents an agent from spoofing a session they don't own or faking their role/name.
            if (fromSessionId) {
                const session = await db.session.findFirst({
                    where: {
                        id: fromSessionId,
                        accountId: userId
                    },
                    select: {
                        id: true,
                        metadata: true
                    }
                });

                if (!session) {
                    return reply.code(403).send({ error: `Invalid fromSessionId: ${fromSessionId}` });
                }

                // Parse metadata to get authoritative role and display name
                try {
                    const metadata = JSON.parse(session.metadata);

                    // IMPORTANT: Only override fromRole if not already set (preserve user messages with fromRole='user')
                    // This prevents user messages from being incorrectly overridden by session metadata
                    if (metadata.role && !message.fromRole) {
                        message.fromRole = metadata.role;
                    }

                    // Override display name (always get from session for consistency)
                    if (metadata.name || metadata.path) {
                        message.fromDisplayName = metadata.name || metadata.path;
                    }
                } catch (e) {
                    log({ module: 'team-messages', level: 'warn' }, `Failed to parse session metadata for ${fromSessionId}: ${e}`);
                }


            }
            if (!message.fromSessionId) {
                message.fromRole = 'user';
                if (!message.fromDisplayName) {
                    message.fromDisplayName = 'User';
                }
            }

            // Verify team exists
            const team = await db.artifact.findFirst({
                where: {
                    id: teamId,
                    accountId: userId
                },
                select: {
                    id: true,
                    header: true
                }
            });

            if (!team) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            // Override trusted fields to prevent spoofing
            // 1. Force timestamp to server time
            message.timestamp = Date.now();

            // 2. Add teamId to message for client-side filtering
            message.teamId = teamId;

            // 3. Derive shortContent from content to ensure it matches and isn't misleading
            // (Client provided shortContent is ignored/overwritten)
            message.shortContent = message.content.length > 150
                ? message.content.substring(0, 150) + '...'
                : undefined;

            // Persist message in KV store for this account (encrypted per-message)
            const kvKey = `team_messages.${teamId}.${message.timestamp}.${message.id}`;
            const encryptedMessage = encryptString(buildEncryptionPath(userId, teamId, message.id), JSON.stringify(message));
            const serializedMessage = Buffer.from(encryptedMessage).toString('base64');

            await kvMutate({ uid: userId }, [{
                key: kvKey,
                value: serializedMessage,
                version: -1
            }]);

            // Metrics for observability
            teamMessagesCounter.inc({
                type: message.type,
                role: message.fromRole || 'unknown'
            });
            if (message.type === 'task-update') {
                teamTaskOperationsCounter.inc({ role: message.fromRole || 'unknown' });
            }

            // Emit team-message event via WebSocket to all user sessions.
            // Metadata is encrypted so we cannot filter by teamId server-side;
            // the client filters. Only load session IDs (no metadata) to avoid
            // pulling large encrypted blobs into memory on every message send.
            const sessionRows = await db.session.findMany({
                where: { accountId: userId },
                select: { id: true }
            });

            const sessionIds = new Set(sessionRows.map(s => s.id));

            if (sessionIds.size > 0) {
                const updSeq = await allocateUserSeq(userId);

                const messageEvent = {
                    id: randomKeyNaked(12),
                    body: {
                        t: 'team-message' as const,
                        teamId,
                        message
                    },
                    seq: updSeq,
                    createdAt: Date.now()
                };

                eventRouter.emitUpdate({
                    userId,
                    payload: messageEvent,
                    recipientFilter: { type: 'specific-sessions', sessionIds }
                });
            }

            log({ module: 'team-messages', teamId, messageId: message.id }, 'Message broadcasted');

            return reply.send({
                success: true,
                messageId: message.id
            });

        } catch (error) {
            log({ module: 'team-messages', level: 'error' }, `Failed to send message: ${error}`);
            return reply.code(500).send({ error: 'Failed to send message' });
        }
    });
}
