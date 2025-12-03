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
    fromSessionId: z.string(),
    fromRole: z.string().optional(),
    fromDisplayName: z.string().optional(),
    content: z.string().max(2000),
    shortContent: z.string().optional(),
    type: z.enum(['chat', 'task-update', 'notification', 'role-assignment', 'system']),
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

    // GET /v1/teams/:teamId/messages - 获取团队消息
    app.get('/v1/teams/:teamId/messages', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string()
            }),
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(200).default(100),
                before: z.string().optional()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const { limit, before } = request.query as { limit?: number, before?: string };

        try {
            log({ module: 'team-messages', level: 'info' }, `Fetching messages for teamId: ${teamId}, userId: ${userId}`);

            // Verify team exists and belongs to the current user
            const team = await db.artifact.findFirst({
                where: {
                    id: teamId,
                    accountId: userId
                },
                select: { id: true }
            });

            if (!team) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            const prefix = `team_messages.${teamId}.`;
            const fetchLimit = Math.min((limit ?? 100) * 2, 500);
            const kvResult = await kvList({ uid: userId }, { prefix, limit: fetchLimit });

            const messages = kvResult.items.map(item => {
                try {
                    const messageKeyParts = item.key.split('.');
                    const messageId = messageKeyParts[messageKeyParts.length - 1];
                    const encrypted = Buffer.from(item.value, 'base64');
                    const decrypted = decryptString(buildEncryptionPath(userId, teamId, messageId), encrypted);
                    return JSON.parse(decrypted);
                } catch (parseError) {
                    log({ module: 'team-messages', level: 'warn' }, `Failed to decrypt message ${item.key}: ${parseError}`);
                    return null;
                }
            }).filter((message): message is NonNullable<typeof message> => !!message)
                .sort((a, b) => a.timestamp - b.timestamp);

            let filtered = messages;
            if (before) {
                const beforeIndex = filtered.findIndex(message => message.id === before);
                if (beforeIndex !== -1) {
                    filtered = filtered.slice(0, beforeIndex);
                }
            }

            const finalMessages = limit ? filtered.slice(-limit) : filtered;

            return reply.send({
                messages: finalMessages,
                hasMore: filtered.length > finalMessages.length,
                cursor: finalMessages[0]?.id
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
            console.error('[TeamMessages] Validation error:', JSON.stringify(parseResult.error.format(), null, 2));
            // @ts-ignore
            return reply.status(400).send({ error: 'Invalid message format', details: parseResult.error });
        }
        const message = parseResult.data;
        const { content, type, metadata, fromSessionId, fromRole, fromDisplayName, mentions } = message;

        try {
            log({ module: 'team-messages', level: 'info' }, `Sending message to teamId: ${teamId}, userId: ${userId}`);

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

            // Emit team-message event via WebSocket to all team members
            // We use 'all-interested-in-session' filter? No, that's for a specific session.
            // We want to send to all users who are members of this team.
            // But eventRouter doesn't support "all members of artifact".

            // We cannot parse the header because it is encrypted client-side.
            // Instead, we broadcast to all of the user's sessions.
            // The CLI/App agents will filter messages based on teamId.
            const sessionRecords = await db.session.findMany({
                where: { accountId: userId },
                select: { id: true, accountId: true }
            });
            console.log(`[TeamMessages] Broadcasting to all ${sessionRecords.length} user sessions`);

            if (sessionRecords.length > 0) {
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

                // Broadcast once to all user's connections (App + all CLI agents)
                // Clients will filter based on teamId and sessionId
                eventRouter.emitUpdate({
                    userId,
                    payload: messageEvent,
                    recipientFilter: { type: 'all-user-authenticated-connections' }
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
