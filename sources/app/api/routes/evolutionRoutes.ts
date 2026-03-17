import { Fastify } from "../types";
import { z } from "zod";
import { log } from "@/utils/log";
import { db } from "@/storage/db";
import { parseTeamArtifactBody } from "@/utils/teamArtifacts";

/**
 * Evolution Routes
 *
 * Endpoints for the agent evolution system (v313):
 *   GET  /v1/teams/:teamId/bypass-agents  - List active bypass agents for a team
 *   GET  /v1/genomes                      - List genomes (filterable by teamId)
 *   POST /v1/genomes                      - Register a new genome
 *   GET  /v1/genomes/:namespace/:name/latest   - Latest version of a genome
 *   GET  /v1/genomes/:namespace/:name/versions - Version history of a genome
 *   GET  /v1/genomes/:namespace/:name/:version - Specific version (immutable, cacheable)
 *
 * Bypass agents are team members with executionPlane === 'bypass' (supervisor, help-agent).
 * They are stored in the team artifact body alongside regular members.
 *
 * Genomes are reusable agent specifications persisted in the Genome table.
 * They are created by agents via the MCP create_genome tool and can be
 * instantiated by create_agent.
 */
export function evolutionRoutes(app: Fastify) {
    log({ module: 'api' }, 'Registering evolutionRoutes...');

    // =========================================================================
    // GET /v1/teams/:teamId/bypass-agents
    // Returns team members whose executionPlane is 'bypass'.
    // These are supervisor and help-agent sessions.
    // =========================================================================
    app.get('/v1/teams/:teamId/bypass-agents', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
        }
    }, async (request, reply) => {
        const { teamId } = request.params as { teamId: string };

        try {
            const artifact = await db.artifact.findFirst({ where: { id: teamId } });
            if (!artifact) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            const board = artifact.body
                ? parseTeamArtifactBody(artifact.body) as Record<string, any>
                : {};

            const members: any[] = (board?.team?.members) ?? [];
            const bypassAgents = members
                .filter((m: any) => m.executionPlane === 'bypass')
                .map((m: any) => ({
                    agentId: m.sessionId,
                    teamId,
                    roleId: m.roleId || m.role || '',
                    profile: m.profile || 'periodic',
                    spawnedAt: m.joinedAt ? Math.floor(m.joinedAt / 1000) : 0,
                    expiresAt: 0,
                    permissions: {
                        canSpawnAgents: false,
                        canCreateTeams: false,
                        canDeployToProduction: false,
                    },
                }));

            return reply.send({ agents: bypassAgents });
        } catch (error: any) {
            log({ module: 'evolution', level: 'error' }, `bypass-agents error: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // =========================================================================
    // GET /v1/genomes/:id
    // Fetch a single genome by ID (used by CLI when spawning with specId).
    // Returns the genome if the caller owns it or it is public.
    // =========================================================================
    app.get('/v1/genomes/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params as { id: string };

        try {
            const genome = await db.genome.findFirst({
                where: {
                    id,
                    OR: [{ accountId: userId }, { isPublic: true }],
                },
            });
            if (!genome) {
                return reply.code(404).send({ error: 'Genome not found' });
            }
            return reply.send({ genome });
        } catch (error: any) {
            log({ module: 'evolution', level: 'error' }, `genome get error: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // =========================================================================
    // GET /v1/genomes
    // List genomes for the authenticated user.
    // Supports ?teamId=, ?parentSessionId=, ?limit=, ?offset=
    // =========================================================================
    app.get('/v1/genomes', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                teamId: z.string().optional(),
                parentSessionId: z.string().optional(),
                limit: z.coerce.number().int().min(1).max(100).default(20),
                offset: z.coerce.number().int().min(0).default(0),
            }),
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId, parentSessionId, limit, offset } = request.query as {
            teamId?: string;
            parentSessionId?: string;
            limit: number;
            offset: number;
        };

        try {
            const where: any = {
                OR: [
                    { accountId: userId },
                    { isPublic: true },
                ]
            };

            if (teamId) where.teamId = teamId;
            if (parentSessionId) where.parentSessionId = parentSessionId;

            const [genomes, total] = await Promise.all([
                db.genome.findMany({
                    where,
                    orderBy: { updatedAt: 'desc' },
                    take: limit,
                    skip: offset,
                }),
                db.genome.count({ where }),
            ]);

            return reply.send({ genomes, total });
        } catch (error: any) {
            log({ module: 'evolution', level: 'error' }, `genomes list error: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // =========================================================================
    // POST /v1/genomes
    // Register a new genome (called by create_genome MCP tool).
    // =========================================================================
    app.post('/v1/genomes', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                id: z.string().optional(),
                name: z.string(),
                description: z.string().optional(),
                spec: z.string(),                        // JSON string of GenomeSpec
                parentSessionId: z.string().optional(),
                teamId: z.string().optional(),
                isPublic: z.boolean().default(false),
            }),
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id, name, description, spec, parentSessionId, teamId, isPublic } = request.body as {
            id?: string;
            name: string;
            description?: string;
            spec: string;
            parentSessionId?: string;
            teamId?: string;
            isPublic: boolean;
        };

        try {
            const genome = id
                ? await db.genome.upsert({
                    where: { id },
                    create: {
                        id,
                        accountId: userId,
                        name,
                        description: description ?? null,
                        spec,
                        parentSessionId: parentSessionId ?? null,
                        teamId: teamId ?? null,
                        isPublic,
                    },
                    update: {
                        name,
                        description: description ?? null,
                        spec,
                        parentSessionId: parentSessionId ?? null,
                        teamId: teamId ?? null,
                        isPublic,
                    },
                })
                : await db.genome.create({
                    data: {
                        accountId: userId,
                        name,
                        description: description ?? null,
                        spec,
                        parentSessionId: parentSessionId ?? null,
                        teamId: teamId ?? null,
                        isPublic,
                    },
                });

            return reply.code(201).send({ genome });
        } catch (error: any) {
            log({ module: 'evolution', level: 'error' }, `genome create error: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // =========================================================================
    // GET /v1/genomes/:namespace/:name/latest
    // Returns the latest version of a genome by namespace + name.
    // =========================================================================
    app.get('/v1/genomes/:namespace/:name/latest', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ namespace: z.string(), name: z.string() }),
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { namespace, name } = request.params as { namespace: string; name: string };
        try {
            const genome = await db.genome.findFirst({
                where: {
                    namespace,
                    name,
                    OR: [{ accountId: userId }, { isPublic: true }],
                },
                orderBy: { version: 'desc' },
            });
            if (!genome) return reply.code(404).send({ error: 'Genome not found' });
            return reply.send({ genome });
        } catch (error: any) {
            log({ module: 'evolution', level: 'error' }, `genome latest error: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // =========================================================================
    // GET /v1/genomes/:namespace/:name/versions
    // Returns version history for a genome by namespace + name.
    // =========================================================================
    app.get('/v1/genomes/:namespace/:name/versions', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ namespace: z.string(), name: z.string() }),
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { namespace, name } = request.params as { namespace: string; name: string };
        try {
            const versions = await db.genome.findMany({
                where: {
                    namespace,
                    name,
                    OR: [{ accountId: userId }, { isPublic: true }],
                },
                orderBy: { version: 'asc' },
                select: { id: true, version: true, createdAt: true, updatedAt: true, description: true },
            });
            return reply.send({ versions });
        } catch (error: any) {
            log({ module: 'evolution', level: 'error' }, `genome versions error: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // =========================================================================
    // GET /v1/genomes/:namespace/:name/:version
    // Returns a specific version of a genome (immutable — safe to cache forever).
    // MUST be registered AFTER /latest and /versions to avoid param conflicts.
    // =========================================================================
    app.get('/v1/genomes/:namespace/:name/:version', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                namespace: z.string(),
                name: z.string(),
                version: z.coerce.number().int().min(1),
            }),
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { namespace, name, version } = request.params as { namespace: string; name: string; version: number };
        try {
            const genome = await db.genome.findFirst({
                where: {
                    namespace,
                    name,
                    version,
                    OR: [{ accountId: userId }, { isPublic: true }],
                },
            });
            if (!genome) return reply.code(404).send({ error: 'Genome not found' });
            // versioned genome is immutable — safe to cache forever
            reply.header('Cache-Control', 'public, immutable, max-age=31536000');
            return reply.send({ genome });
        } catch (error: any) {
            log({ module: 'evolution', level: 'error' }, `genome version error: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // =========================================================================
    // POST /v1/genomes/:id/publish
    // Publish a private genome from Channel Server to Marketplace Server.
    // =========================================================================
    app.post('/v1/genomes/:id/publish', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
            body: z.object({
                marketplaceUrl: z.string().url().optional(),
            }),
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params as { id: string };
        const { marketplaceUrl } = request.body as { marketplaceUrl?: string };

        try {
            const genome = await db.genome.findFirst({
                where: { id, accountId: userId },
            });
            if (!genome) {
                return reply.code(404).send({ error: 'Genome not found' });
            }

            const hubUrl = marketplaceUrl ?? process.env.GENOME_HUB_URL ?? 'http://localhost:3006';

            // 发布到 Marketplace Server
            const spec = JSON.parse(genome.spec);
            const publishBody = {
                namespace: genome.namespace ?? spec.namespace,
                name: genome.name,
                description: genome.description ?? undefined,
                spec: genome.spec,
                tags: genome.tags ? JSON.parse(genome.tags) : undefined,
                category: genome.category ?? spec.category,
                isPublic: true,
            };

            // 使用动态 import 避免循环依赖；axios 已存在于 happy-server
            const { default: axios } = await import('axios');
            const res = await axios.post(`${hubUrl}/genomes`, publishBody, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 10000,
            });

            log({ module: 'evolution' }, `Genome ${id} published to marketplace: ${hubUrl}`);
            return reply.code(201).send({ published: res.data });
        } catch (error: any) {
            log({ module: 'evolution', level: 'error' }, `genome publish error: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });
}
