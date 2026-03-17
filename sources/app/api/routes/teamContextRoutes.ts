import { z } from 'zod';

import { teamContextService, TEAM_CONTEXT_KINDS, TeamContextAccessError } from '@/app/teamContext/teamContextService';
import { log } from '@/utils/log';

import { Fastify } from '../types';

const TeamContextKindSchema = z.enum(TEAM_CONTEXT_KINDS);
const TeamContextValueSchema = z.any();
const TeamContextItemSchema = z.object({
    key: z.string(),
    kind: TeamContextKindSchema,
    value: TeamContextValueSchema,
    summary: z.string().optional(),
    tags: z.array(z.string()).optional(),
    version: z.number(),
    updatedBySessionId: z.string().optional(),
    updatedByRole: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
});

const TeamContextMutationBaseSchema = z.object({
    sessionId: z.string().optional(),
    role: z.string().optional(),
    key: z.string().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/),
    kind: TeamContextKindSchema.optional(),
    summary: z.string().max(500).optional(),
    tags: z.array(z.string().max(64)).max(20).optional(),
});

export function teamContextRoutes(app: Fastify) {
    log({ module: 'api' }, 'Registering teamContextRoutes...');

    app.get('/v1/teams/:teamId/context', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string(),
            }),
            querystring: z.object({
                sessionId: z.string().optional(),
                prefix: z.string().optional(),
                kind: TeamContextKindSchema.optional(),
                limit: z.coerce.number().int().min(1).max(500).default(100),
            }),
            response: {
                200: z.object({
                    items: z.array(TeamContextItemSchema),
                }),
                403: z.object({
                    error: z.string(),
                }),
                404: z.object({
                    error: z.string(),
                }),
                500: z.object({
                    error: z.literal('Failed to list team context'),
                }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const { sessionId, prefix, kind, limit } = request.query as {
            sessionId?: string;
            prefix?: string;
            kind?: z.infer<typeof TeamContextKindSchema>;
            limit?: number;
        };

        try {
            const result = await teamContextService.list(userId, teamId, {
                sessionId,
                prefix,
                kind,
                limit,
            });
            return reply.send(result);
        } catch (error) {
            if (error instanceof TeamContextAccessError) {
                return reply.code(error.statusCode).send({ error: error.message });
            }
            log({ module: 'team-context', level: 'error' }, `Failed to list team context: ${error}`);
            return reply.code(500).send({ error: 'Failed to list team context' });
        }
    });

    app.put('/v1/teams/:teamId/context', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string(),
            }),
            body: TeamContextMutationBaseSchema.extend({
                value: TeamContextValueSchema,
            }),
            response: {
                200: z.object({
                    item: TeamContextItemSchema,
                }),
                403: z.object({
                    error: z.string(),
                }),
                404: z.object({
                    error: z.string(),
                }),
                500: z.object({
                    error: z.literal('Failed to put team context'),
                }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const body = request.body as z.infer<typeof TeamContextMutationBaseSchema> & { value: unknown };

        try {
            const item = await teamContextService.put(userId, teamId, body as never);
            return reply.send({ item });
        } catch (error) {
            if (error instanceof TeamContextAccessError) {
                return reply.code(error.statusCode).send({ error: error.message });
            }
            log({ module: 'team-context', level: 'error' }, `Failed to put team context: ${error}`);
            return reply.code(500).send({ error: 'Failed to put team context' });
        }
    });

    app.patch('/v1/teams/:teamId/context', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string(),
            }),
            body: TeamContextMutationBaseSchema.extend({
                patch: TeamContextValueSchema,
            }),
            response: {
                200: z.object({
                    item: TeamContextItemSchema,
                }),
                403: z.object({
                    error: z.string(),
                }),
                404: z.object({
                    error: z.string(),
                }),
                500: z.object({
                    error: z.literal('Failed to patch team context'),
                }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const body = request.body as z.infer<typeof TeamContextMutationBaseSchema> & { patch: unknown };

        try {
            const item = await teamContextService.patch(userId, teamId, body as never);
            return reply.send({ item });
        } catch (error) {
            if (error instanceof TeamContextAccessError) {
                return reply.code(error.statusCode).send({ error: error.message });
            }
            log({ module: 'team-context', level: 'error' }, `Failed to patch team context: ${error}`);
            return reply.code(500).send({ error: 'Failed to patch team context' });
        }
    });

    app.delete('/v1/teams/:teamId/context', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string(),
            }),
            body: z.object({
                key: z.string().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/),
                sessionId: z.string().optional(),
            }),
            response: {
                200: z.object({
                    success: z.literal(true),
                }),
                403: z.object({
                    error: z.string(),
                }),
                404: z.object({
                    error: z.string(),
                }),
                500: z.object({
                    error: z.literal('Failed to delete team context'),
                }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const { key, sessionId } = request.body as { key: string; sessionId?: string };

        try {
            await teamContextService.delete(userId, teamId, { key, sessionId });
            return reply.send({ success: true as const });
        } catch (error) {
            if (error instanceof TeamContextAccessError) {
                return reply.code(error.statusCode).send({ error: error.message });
            }
            log({ module: 'team-context', level: 'error' }, `Failed to delete team context: ${error}`);
            return reply.code(500).send({ error: 'Failed to delete team context' });
        }
    });
}
