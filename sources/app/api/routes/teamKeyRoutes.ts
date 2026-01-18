import { Fastify } from "../types";
import { z } from "zod";
import { db } from "@/storage/db";
import { log } from "@/utils/log";
import * as privacyKit from "privacy-kit";

/**
 * Team Key Sharing Routes
 *
 * Implements secure team encryption key sharing between Kanban and CLI agents
 *
 * POST /v1/teams/:teamId/key - Request team encryption key (for team members)
 *
 * This solves the critical encryption mismatch issue where:
 * - Kanban creates sessions with Kanban encryption key
 * - CLI agents need to decrypt team artifacts and messages
 * - Solution: Team members can request the team encryption key
 */

export function teamKeyRoutes(app: Fastify) {
    log({ module: 'api' }, 'Registering teamKeyRoutes...');

    // POST /v1/teams/:teamId/key - Request team encryption key
    app.post('/v1/teams/:teamId/key', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string()
            }),
            body: z.object({
                sessionId: z.string().optional()
            }),
            response: {
                200: z.object({
                    teamKey: z.string(), // Base64-encoded team encryption key
                    keyId: z.string()
                }),
                403: z.object({
                    error: z.string()
                }),
                404: z.object({
                    error: z.literal('Team not found')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const { sessionId } = request.body as { sessionId?: string };

        try {
            log({ module: 'team-key', teamId, userId, sessionId },
                `Team key request from user ${userId} for team ${teamId}`);

            // Verify team exists and user is a member
            const team = await db.artifact.findFirst({
                where: {
                    id: teamId,
                    accountId: userId
                },
                select: {
                    id: true,
                    header: true,
                    body: true
                }
            });

            if (!team) {
                log({ module: 'team-key', teamId, userId, level: 'warn' },
                    `Team key request denied: Team ${teamId} not found or user not a member`);
                return reply.code(404).send({ error: 'Team not found' });
            }

            // Verify session belongs to user (if provided)
            if (sessionId) {
                const session = await db.session.findFirst({
                    where: {
                        id: sessionId,
                        accountId: userId
                    },
                    select: { id: true, dataEncryptionKey: true }
                });

                if (!session) {
                    return reply.code(403).send({
                        error: `Session ${sessionId} does not belong to you`
                    });
                }

                log({ module: 'team-key', sessionId },
                    `Session verified for team key request`);
            }

            // Extract team encryption key from artifact header
            // The header contains team metadata including encryption key info
            let teamKeyId: string;
            let teamEncryptionKey: Buffer;

            try {
                // Decode header
                const headerStr = privacyKit.encodeBase64(team.header);
                const header = JSON.parse(Buffer.from(headerStr, 'base64').toString());

                // Get or generate team encryption key ID
                teamKeyId = header.encryptionKeyId || `team_${teamId}_master`;

                // For now, we'll use a derived key approach
                // In production, you'd want to use a proper key management system
                // The key is derived from the team ID and a master secret
                const masterSecret = process.env.TEAM_KEY_MASTER_SECRET || 'default-team-key-secret';

                // Derive team-specific key using crypto
                const crypto = require('crypto');
                teamEncryptionKey = crypto.pbkdf2Sync(
                    `${teamId}_${teamKeyId}`,
                    masterSecret,
                    100000, // iterations
                    32, // key length (256 bits)
                    'sha256'
                );

                log({ module: 'team-key', teamId, teamKeyId },
                    `Derived team encryption key for team ${teamId}`);

            } catch (error) {
                log({ module: 'team-key', level: 'error' },
                    `Failed to decode team header: ${error}`);
                return reply.code(500).send({ error: 'Failed to derive team key' });
            }

            // Encode key as base64 for transmission
            const teamKeyBase64 = teamEncryptionKey.toString('base64');

            log({ module: 'team-key', teamId, userId },
                `Team key provided successfully for team ${teamId}`);

            return reply.send({
                teamKey: teamKeyBase64,
                keyId: teamKeyId
            });

        } catch (error) {
            log({ module: 'team-key', level: 'error' },
                `Failed to provide team key: ${error}`);
            return reply.code(500).send({ error: 'Failed to provide team key' });
        }
    });

    // GET /v1/teams/:teamId/key/info - Get team key information (without the actual key)
    app.get('/v1/teams/:teamId/key/info', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string()
            }),
            response: {
                200: z.object({
                    keyId: z.string(),
                    hasKey: z.boolean()
                }),
                404: z.object({
                    error: z.literal('Team not found')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };

        try {
            // Verify team exists
            const team = await db.artifact.findFirst({
                where: {
                    id: teamId,
                    accountId: userId
                },
                select: { id: true, header: true }
            });

            if (!team) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            // Decode header to get key info
            const headerStr = privacyKit.encodeBase64(team.header);
            const header = JSON.parse(Buffer.from(headerStr, 'base64').toString());
            const keyId = header.encryptionKeyId || `team_${teamId}_master`;

            return reply.send({
                keyId,
                hasKey: true // Team has a key configured
            });

        } catch (error) {
            log({ module: 'team-key', level: 'error' },
                `Failed to get team key info: ${error}`);
            return reply.code(500).send({ error: 'Failed to get team key info' });
        }
    });
}
