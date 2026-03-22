import { Fastify } from "../types";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eventRouter } from "@/app/events/eventRouter";
import { activityCache } from "@/app/presence/sessionCache";
import { allocateUserSeq } from "@/storage/seq";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { db } from "@/storage/db";
import {
    extractTeamBoard,
    extractTeamMembers,
    getAccessibleTeamArtifact,
    serializeTeamBoard,
} from "@/app/team/teamArtifacts";

const GenomeCreateSchema = z.object({
    id: z.string().optional(),
    name: z.string().min(1),
    description: z.string().optional(),
    spec: z.string(),
    parentSessionId: z.string().optional(),
    teamId: z.string().optional(),
    namespace: z.string().optional(),
    tags: z.string().optional(),
    category: z.string().optional(),
    isPublic: z.boolean().default(false),
    status: z.enum(['draft', 'unverified', 'verified', 'official', 'archived']).default('unverified'),
    origin: z.enum(['manual', 'auto-created', 'forked', 'mutated', 'market-installed']).optional(),
    variantOf: z.string().optional(),
    mutationNote: z.string().optional(),
});

const GenomePatchSchema = z.object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    spec: z.string().optional(),
    namespace: z.string().nullable().optional(),
    tags: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    isPublic: z.boolean().optional(),
    status: z.enum(['draft', 'unverified', 'verified', 'official', 'archived']).optional(),
    origin: z.enum(['manual', 'auto-created', 'forked', 'mutated', 'market-installed']).optional(),
    variantOf: z.string().nullable().optional(),
    mutationNote: z.string().nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
});

function buildGenomeVisibilityWhere(userId: string) {
    return {
        deletedAt: null,
        OR: [{ accountId: userId }, { isPublic: true }],
    };
}

function withGenomeFeedbackData<T extends { scorecard?: string | null }>(genome: T): T & { feedbackData: string | null } {
    return {
        ...genome,
        feedbackData: genome.scorecard ?? null,
    };
}

function parseStoredGenomeScorecard(scorecard: string | null | undefined): Record<string, unknown> | null {
    if (!scorecard) {
        return null;
    }

    try {
        const parsed = JSON.parse(scorecard) as Record<string, unknown> | null;
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

function resolveSupervisorStatePath(teamId: string): string | null {
    if (!/^[a-zA-Z0-9_-]+$/.test(teamId)) {
        return null;
    }
    const filename = `state-${teamId}.json`;
    const candidates = [
        join(process.cwd(), '.aha', 'supervisor', filename),
        join(process.cwd(), '..', '.aha', 'supervisor', filename),
    ];

    return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function readSupervisorStateSnapshot(teamId: string): {
    teamId: string;
    lastRunAt: number;
    lastConclusion: string;
    lastSessionId: string | null;
    terminated: boolean;
    idleRuns: number;
    pendingAction: {
        type: 'notify_help';
        message: string;
        requestType?: 'stuck' | 'context_overflow' | 'need_collaborator' | 'error' | 'custom';
        severity?: 'low' | 'medium' | 'high' | 'critical';
        description?: string;
        targetSessionId?: string;
    } | {
        type: 'conditional_escalation';
        condition: string;
        action: string;
        deadline: number;
    } | null;
    calibrationScore: number | null;
} | null {
    const statePath = resolveSupervisorStatePath(teamId);
    if (!statePath) {
        return null;
    }

    try {
        const raw = JSON.parse(readFileSync(statePath, 'utf-8'));
        return {
            teamId,
            lastRunAt: typeof raw.lastRunAt === 'number' ? raw.lastRunAt : 0,
            lastConclusion: typeof raw.lastConclusion === 'string' ? raw.lastConclusion : '',
            lastSessionId: typeof raw.lastSessionId === 'string' ? raw.lastSessionId : null,
            terminated: raw.terminated === true,
            idleRuns: typeof raw.idleRuns === 'number' ? raw.idleRuns : 0,
            pendingAction: raw.pendingAction ?? null,
            calibrationScore: typeof raw?.calibration?.calibrationScore === 'number'
                ? raw.calibration.calibrationScore
                : null,
        };
    } catch {
        return null;
    }
}

/**
 * Evolution Routes
 *
 * Endpoints for the agent evolution system (v313):
 *   GET  /v1/teams/:teamId/bypass-agents    - List active bypass agents for a team
 *   GET  /v1/teams/:teamId/repair-signals  - List repair signals for a team
 *   GET  /v1/teams/:teamId/supervisor-state - Read persisted supervisor facts for a team
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
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };

        try {
            const artifact = await getAccessibleTeamArtifact(userId, teamId);
            if (!artifact) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            const board = extractTeamBoard(artifact);
            const latestByBypassKey = new Map<string, any>();
            for (const member of extractTeamMembers(board).filter((m: any) => m.executionPlane === 'bypass')) {
                const roleId = member.roleId || member.role || '';
                const profile = member.profile || 'periodic';
                const key = `${roleId}:${profile}`;
                const previous = latestByBypassKey.get(key);
                const previousJoinedAt = typeof previous?.joinedAt === 'number' ? previous.joinedAt : 0;
                const currentJoinedAt = typeof member.joinedAt === 'number' ? member.joinedAt : 0;

                if (!previous || currentJoinedAt >= previousJoinedAt) {
                    latestByBypassKey.set(key, member);
                }
            }

            const bypassAgents = Array.from(latestByBypassKey.values())
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
    // GET /v1/teams/:teamId/repair-signals
    // Returns open (or all) repair signals emitted by supervisor agents.
    // No DB backing yet — returns empty list after passing the access check.
    // =========================================================================
    app.get('/v1/teams/:teamId/repair-signals', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            querystring: z.object({
                resolved: z.enum(['true', 'false']).optional(),
                limit: z.coerce.number().int().min(1).max(100).default(20),
            }),
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };

        try {
            const artifact = await getAccessibleTeamArtifact(userId, teamId);
            if (!artifact) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            return reply.send({ signals: [], total: 0 });
        } catch (error: any) {
            log({ module: 'evolution', level: 'error' }, `repair-signals error: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // =========================================================================
    // GET /v1/teams/:teamId/supervisor-state
    // Returns the persisted supervisor facts for a team, if a state file exists.
    // This is intentionally read-only and does not infer additional health states.
    // =========================================================================
    app.get('/v1/teams/:teamId/supervisor-state', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            response: {
                200: z.object({
                    state: z.object({
                        teamId: z.string(),
                        lastRunAt: z.number(),
                        lastConclusion: z.string(),
                        lastSessionId: z.string().nullable(),
                        terminated: z.boolean(),
                        idleRuns: z.number(),
                        pendingAction: z.union([
                            z.object({
                                type: z.literal('notify_help'),
                                message: z.string(),
                                requestType: z.enum(['stuck', 'context_overflow', 'need_collaborator', 'error', 'custom']).optional(),
                                severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
                                description: z.string().optional(),
                                targetSessionId: z.string().optional(),
                            }),
                            z.object({
                                type: z.literal('conditional_escalation'),
                                condition: z.string(),
                                action: z.string(),
                                deadline: z.number(),
                            }),
                            z.null(),
                        ]),
                        calibrationScore: z.number().nullable(),
                    }).nullable(),
                }),
                404: z.object({ error: z.string() }),
                500: z.object({ error: z.string() }),
            },
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };

        try {
            const artifact = await getAccessibleTeamArtifact(userId, teamId);
            if (!artifact) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            return reply.send({ state: readSupervisorStateSnapshot(teamId) });
        } catch (error: any) {
            log({ module: 'evolution', level: 'error' }, `supervisor-state error: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // =========================================================================
    // DELETE /v1/teams/:teamId/bypass-agents/:id
    // Retires a bypass agent by removing it from the team roster.
    // =========================================================================
    app.delete('/v1/teams/:teamId/bypass-agents/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string(),
                id: z.string(),
            }),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId, id } = request.params as { teamId: string; id: string };

        try {
            const artifact = await getAccessibleTeamArtifact(userId, teamId);
            if (!artifact) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            const board = extractTeamBoard(artifact);
            const members = extractTeamMembers(board);
            const hasTarget = members.some(member => member.sessionId === id && member.executionPlane === 'bypass');

            if (!hasTarget) {
                return reply.code(404).send({ error: 'Bypass agent not found' });
            }

            if (!board.team) {
                board.team = {};
            }
            board.team.members = members.filter(member => member.sessionId !== id);

            await db.artifact.update({
                where: { id: teamId },
                data: {
                    body: serializeTeamBoard(board),
                    bodyVersion: { increment: 1 },
                    updatedAt: new Date(),
                },
            });

            await db.session.updateMany({
                where: {
                    id,
                    accountId: userId,
                    active: true,
                },
                data: {
                    active: false,
                    updatedAt: new Date(),
                },
            });
            activityCache.invalidateSession(id);
            await broadcastSessionUpdate(userId, id, 'session-archived');
            await broadcastTeamUpdate(userId, teamId, 'member-removed', { sessionId: id, roleId: 'bypass' });

            return reply.send({ success: true, retiredAgentId: id });
        } catch (error: any) {
            log({ module: 'evolution', level: 'error' }, `bypass-agent retire error: ${error}`);
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
                    ...buildGenomeVisibilityWhere(userId),
                },
            });
            if (!genome) {
                return reply.code(404).send({ error: 'Genome not found' });
            }
            return reply.send({ genome: withGenomeFeedbackData(genome) });
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
                ownedOnly: z.enum(['true', 'false']).optional(),
                limit: z.coerce.number().int().min(1).max(200).default(20),
                offset: z.coerce.number().int().min(0).default(0),
            }),
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId, parentSessionId, ownedOnly, limit, offset } = request.query as {
            teamId?: string;
            parentSessionId?: string;
            ownedOnly?: string;
            limit: number;
            offset: number;
        };

        try {
            const where: any = ownedOnly === 'true'
                ? { accountId: userId, deletedAt: null }
                : { ...buildGenomeVisibilityWhere(userId) };

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

            return reply.send({ genomes: genomes.map(withGenomeFeedbackData), total });
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
            body: GenomeCreateSchema,
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const {
            id,
            name,
            description,
            spec,
            parentSessionId,
            teamId,
            namespace,
            tags,
            category,
            isPublic,
            status,
            origin,
            variantOf,
            mutationNote,
        } = request.body as z.infer<typeof GenomeCreateSchema>;

        try {
            if (id) {
                const existing = await db.genome.findUnique({
                    where: { id },
                    select: { id: true, accountId: true },
                });

                if (existing && existing.accountId !== userId) {
                    return reply.code(403).send({ error: 'Genome not found' });
                }
            }

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
                        namespace: namespace ?? null,
                        tags: tags ?? null,
                        category: category ?? null,
                        isPublic,
                        status,
                        origin: origin ?? null,
                        variantOf: variantOf ?? null,
                        mutationNote: mutationNote ?? null,
                    },
                    update: {
                        name,
                        description: description ?? null,
                        spec,
                        parentSessionId: parentSessionId ?? null,
                        teamId: teamId ?? null,
                        namespace: namespace ?? null,
                        tags: tags ?? null,
                        category: category ?? null,
                        isPublic,
                        deletedAt: null,
                        status,
                        origin: origin ?? null,
                        variantOf: variantOf ?? null,
                        mutationNote: mutationNote ?? null,
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
                        namespace: namespace ?? null,
                        tags: tags ?? null,
                        category: category ?? null,
                        isPublic,
                        status,
                        origin: origin ?? null,
                        variantOf: variantOf ?? null,
                        mutationNote: mutationNote ?? null,
                    },
                });

            return reply.code(201).send({ genome: withGenomeFeedbackData(genome) });
        } catch (error: any) {
            log({ module: 'evolution', level: 'error' }, `genome create error: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // =========================================================================
    // PATCH /v1/genomes/:id
    // Update genome metadata in place, or create a new version when spec changes.
    // =========================================================================
    app.patch('/v1/genomes/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
            body: GenomePatchSchema,
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params as { id: string };
        const updates = request.body as z.infer<typeof GenomePatchSchema>;

        try {
            const current = await db.genome.findFirst({
                where: {
                    id,
                    accountId: userId,
                    deletedAt: null,
                },
            });

            if (!current) {
                return reply.code(404).send({ error: 'Genome not found' });
            }

            const specChanged = typeof updates.spec === 'string' && updates.spec !== current.spec;

            if (!specChanged) {
                const genome = await db.genome.update({
                    where: { id: current.id },
                    data: {
                        ...(updates.name !== undefined ? { name: updates.name } : {}),
                        ...(updates.description !== undefined ? { description: updates.description } : {}),
                        ...(updates.namespace !== undefined ? { namespace: updates.namespace } : {}),
                        ...(updates.tags !== undefined ? { tags: updates.tags } : {}),
                        ...(updates.category !== undefined ? { category: updates.category } : {}),
                        ...(updates.isPublic !== undefined ? { isPublic: updates.isPublic } : {}),
                        ...(updates.status !== undefined ? { status: updates.status } : {}),
                        ...(updates.origin !== undefined ? { origin: updates.origin } : {}),
                        ...(updates.variantOf !== undefined ? { variantOf: updates.variantOf } : {}),
                        ...(updates.mutationNote !== undefined ? { mutationNote: updates.mutationNote } : {}),
                    },
                });

                return reply.send({ genome: withGenomeFeedbackData(genome), createdNewVersion: false });
            }

            const nextNamespace = updates.namespace !== undefined ? updates.namespace : current.namespace;
            const nextName = updates.name ?? current.name;
            const nextSpec = updates.spec;

            if (nextSpec === undefined) {
                return reply.code(400).send({ error: 'Spec is required when creating a new genome version' });
            }

            const latestVersion = await db.genome.findFirst({
                where: {
                    namespace: nextNamespace,
                    name: nextName,
                },
                orderBy: { version: 'desc' },
                select: { version: true },
            });

            const genome = await db.genome.create({
                data: {
                    accountId: current.accountId,
                    name: nextName,
                    description: updates.description !== undefined ? updates.description : current.description,
                    spec: nextSpec,
                    parentSessionId: current.parentSessionId,
                    teamId: current.teamId,
                    namespace: nextNamespace,
                    version: (latestVersion?.version ?? 0) + 1,
                    tags: updates.tags !== undefined ? updates.tags : current.tags,
                    category: updates.category !== undefined ? updates.category : current.category,
                    isPublic: false,
                    hubGenomeId: null,
                    status: updates.status ?? current.status,
                    origin: updates.origin !== undefined ? updates.origin : current.origin,
                    variantOf: updates.variantOf !== undefined ? updates.variantOf : current.variantOf,
                    mutationNote: updates.mutationNote !== undefined ? updates.mutationNote : current.mutationNote,
                },
            });

            return reply.send({ genome: withGenomeFeedbackData(genome), createdNewVersion: true });
        } catch (error: any) {
            log({ module: 'evolution', level: 'error' }, `genome patch error: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // =========================================================================
    // DELETE /v1/genomes/:id
    // Soft delete a genome owned by the current user.
    // =========================================================================
    app.delete('/v1/genomes/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params as { id: string };

        try {
            const current = await db.genome.findFirst({
                where: {
                    id,
                    accountId: userId,
                    deletedAt: null,
                },
                select: { id: true },
            });

            if (!current) {
                return reply.code(404).send({ error: 'Genome not found' });
            }

            await db.genome.update({
                where: { id: current.id },
                data: {
                    deletedAt: new Date(),
                    isPublic: false,
                    updatedAt: new Date(),
                },
            });

            return reply.send({ success: true });
        } catch (error: any) {
            log({ module: 'evolution', level: 'error' }, `genome delete error: ${error}`);
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
                    ...buildGenomeVisibilityWhere(userId),
                },
                orderBy: { version: 'desc' },
            });
            if (!genome) return reply.code(404).send({ error: 'Genome not found' });
            return reply.send({ genome: withGenomeFeedbackData(genome) });
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
                    ...buildGenomeVisibilityWhere(userId),
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
                    ...buildGenomeVisibilityWhere(userId),
                },
            });
            if (!genome) return reply.code(404).send({ error: 'Genome not found' });
            // versioned genome is immutable — safe to cache forever
            reply.header('Cache-Control', 'public, immutable, max-age=31536000');
            return reply.send({ genome: withGenomeFeedbackData(genome) });
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
                where: { id, accountId: userId, deletedAt: null },
            });
            if (!genome) {
                return reply.code(404).send({ error: 'Genome not found' });
            }

            const hubUrl = marketplaceUrl ?? process.env.GENOME_HUB_URL ?? 'http://localhost:3006';

            // 发布到 Marketplace Server
            const spec = JSON.parse(genome.spec);
            const publishNamespace = genome.namespace ?? spec.namespace ?? '@public';
            const publishBody = {
                namespace: publishNamespace,
                name: genome.name,
                version: genome.version,
                description: genome.description ?? undefined,
                spec: genome.spec,
                tags: genome.tags ?? undefined,
                category: genome.category ?? spec.category,
                isPublic: true,
            };

            // 使用动态 import 避免循环依赖；axios 已存在于 happy-server
            const { default: axios } = await import('axios');
            const hubPublishKey = process.env.GENOME_HUB_PUBLISH_KEY;
            const res = await axios.post(`${hubUrl}/genomes`, publishBody, {
                headers: {
                    'Content-Type': 'application/json',
                    ...(hubPublishKey ? { Authorization: `Bearer ${hubPublishKey}` } : {}),
                },
                timeout: 10000,
            });

            const scorecardPayload = parseStoredGenomeScorecard(genome.scorecard);
            let feedbackSync: { attempted: boolean; synced: boolean; error?: string } | undefined;

            if (scorecardPayload) {
                try {
                    await axios.patch(
                        `${hubUrl}/genomes/${encodeURIComponent(publishNamespace)}/${encodeURIComponent(genome.name)}/feedback`,
                        scorecardPayload,
                        {
                            headers: {
                                'Content-Type': 'application/json',
                                ...(hubPublishKey ? { Authorization: `Bearer ${hubPublishKey}` } : {}),
                            },
                            timeout: 10000,
                        },
                    );
                    feedbackSync = { attempted: true, synced: true };
                } catch (feedbackError: any) {
                    feedbackSync = {
                        attempted: true,
                        synced: false,
                        error: feedbackError?.message ?? 'Failed to sync feedback',
                    };
                    log(
                        { module: 'evolution', level: 'warn' },
                        `Genome ${id} published but feedback sync failed: ${feedbackSync.error}`,
                    );
                }
            }

            const publishedGenome = res.data?.genome;
            const localGenome = await db.genome.update({
                where: { id: genome.id },
                data: {
                    isPublic: true,
                    hubGenomeId: typeof publishedGenome?.id === 'string' ? publishedGenome.id : null,
                },
            });

            log({ module: 'evolution' }, `Genome ${id} published to marketplace: ${hubUrl}`);
            return reply.code(201).send({
                published: res.data,
                genome: withGenomeFeedbackData(localGenome),
                ...(feedbackSync ? { feedbackSync } : {}),
            });
        } catch (error: any) {
            log({ module: 'evolution', level: 'error' }, `genome publish error: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });
}

async function broadcastSessionUpdate(
    userId: string,
    sessionId: string,
    eventType: string,
    details?: Record<string, unknown>
): Promise<void> {
    const updSeq = await allocateUserSeq(userId);

    eventRouter.emitUpdate({
        userId,
        payload: {
            id: randomKeyNaked(12),
            seq: updSeq,
            body: {
                t: 'session-update' as const,
                sessionId,
                eventType,
                details,
            },
            createdAt: Date.now(),
        },
        recipientFilter: { type: 'all-user-authenticated-connections' },
    });
}

async function broadcastTeamUpdate(
    userId: string,
    teamId: string,
    eventType: string,
    details?: Record<string, unknown>
): Promise<void> {
    const updSeq = await allocateUserSeq(userId);

    eventRouter.emitUpdate({
        userId,
        payload: {
            id: randomKeyNaked(12),
            seq: updSeq,
            body: {
                t: 'team-update' as const,
                teamId,
                eventType,
                details,
            },
            createdAt: Date.now(),
        },
        recipientFilter: { type: 'all-user-authenticated-connections' },
    });
}
