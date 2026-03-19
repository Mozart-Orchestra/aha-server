import { Fastify } from "../types";
import { z } from "zod";
import { log } from "@/utils/log";
import { db } from "@/storage/db";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import {
    extractTeamBoard,
    extractTeamMembers,
    serializeTeamBoard,
} from "@/app/team/teamArtifacts";

const GENOME_HUB_URL = process.env.GENOME_HUB_URL ?? 'http://localhost:3006';
const EXISTING_SESSION_LOOKUP_ATTEMPTS = 20;
const EXISTING_SESSION_LOOKUP_DELAY_MS = 250;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const AgentCreateSchema = z.object({
    displayName: z.string().min(1).max(100),
    genomeId: z.string().optional(),
    genomeSpec: z.record(z.unknown()).optional(),
    sessionId: z.string().optional(),
    sessionTag: z.string().optional(),
    memberId: z.string().optional(),
    runtimeType: z.enum(['claude', 'codex']).default('claude'),
    modelId: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
});

const AgentPatchSchema = z.object({
    displayName: z.string().min(1).max(100).optional(),
    genomeId: z.string().optional(),
    status: z.enum(['active', 'paused', 'archived']).optional(),
    metadata: z.record(z.unknown()).optional(),
}).refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isStandaloneAgent(board: Record<string, any>): boolean {
    return board?.type === 'standalone';
}

function buildAgentResponse(
    artifact: { id: string; createdAt: Date; updatedAt: Date },
    board: Record<string, any>,
) {
    const members = extractTeamMembers(board);
    const agent = members[0];
    const type = isStandaloneAgent(board) ? 'standalone' : 'team';

    return {
        id: artifact.id,
        displayName: agent?.displayName || board.name || `Agent ${artifact.id.slice(0, 8)}`,
        sessionId: agent?.sessionId || null,
        sessionTag: agent?.sessionTag || null,
        memberId: agent?.memberId || null,
        roleId: agent?.roleId || null,
        runtimeType: agent?.runtimeType || 'claude',
        genomeId: board.genomeId || null,
        status: board.status || 'active',
        metadata: board.metadata || {},
        type,
        createdAt: artifact.createdAt.getTime(),
        updatedAt: artifact.updatedAt.getTime(),
    };
}

async function waitForExistingSession(
    userId: string,
    opts: { sessionId?: string; sessionTag?: string },
): Promise<{ id: string; tag: string } | null> {
    const orClauses = [
        ...(opts.sessionId ? [{ id: opts.sessionId }] : []),
        ...(opts.sessionTag ? [{ tag: opts.sessionTag }] : []),
    ];

    if (orClauses.length === 0) {
        return null;
    }

    for (let attempt = 0; attempt < EXISTING_SESSION_LOOKUP_ATTEMPTS; attempt += 1) {
        const session = await db.session.findFirst({
            where: {
                accountId: userId,
                OR: orClauses,
            },
            select: {
                id: true,
                tag: true,
            },
        });

        if (session) {
            return session;
        }

        if (attempt < EXISTING_SESSION_LOOKUP_ATTEMPTS - 1) {
            await new Promise((resolve) => setTimeout(resolve, EXISTING_SESSION_LOOKUP_DELAY_MS));
        }
    }

    return null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Standalone Agent Routes
 *
 * CRUD for standalone (solo) agents — Mode 3 from architecture-v2.
 * A standalone agent is stored as an Artifact (team) with type='standalone'
 * containing a single member. It can later be promoted to a full team.
 *
 *   POST   /v1/agents              - Create a standalone agent
 *   GET    /v1/agents              - List agents (filterable by type)
 *   GET    /v1/agents/:id          - Get agent details
 *   PATCH  /v1/agents/:id          - Update agent config
 *   DELETE /v1/agents/:id          - Deactivate / archive agent
 *   POST   /v1/agents/:id/promote  - Promote standalone agent to full team
 */
export function agentRoutes(app: Fastify) {
    log({ module: 'api' }, 'Registering agentRoutes...');

    // =========================================================================
    // POST /v1/agents — Create a standalone agent
    // =========================================================================
    app.post('/v1/agents', {
        preHandler: app.authenticate,
        schema: { body: AgentCreateSchema },
    }, async (request, reply) => {
        const userId = request.userId;
        const {
            displayName,
            genomeId,
            genomeSpec,
            sessionId: existingSessionId,
            sessionTag,
            memberId,
            runtimeType,
            modelId,
            metadata,
        } = request.body as z.infer<typeof AgentCreateSchema>;

        try {
            // Must have genomeId or genomeSpec
            if (!genomeId && !genomeSpec) {
                return reply.code(400).send({
                    error: 'Either genomeId or genomeSpec must be provided',
                });
            }

            const reusableSession = existingSessionId || sessionTag
                ? await waitForExistingSession(userId, {
                    sessionId: existingSessionId,
                    sessionTag,
                })
                : null;

            const created = await db.$transaction(async (tx) => {
                // Validate genomeId: genome-hub is the authoritative source,
                // local DB is only a fallback (will be deprecated)
                if (genomeId) {
                    const hubGenome = await fetchGenomeFromHub(genomeId);
                    if (!hubGenome) {
                        // Fallback to local genome table (transitional)
                        const localGenome = await tx.genome.findFirst({
                            where: {
                                id: genomeId,
                                deletedAt: null,
                                OR: [{ accountId: userId }, { isPublic: true }],
                            },
                            select: { id: true },
                        });
                        if (!localGenome && !genomeSpec) {
                            return { type: 'genome-not-found' as const };
                        }
                    }
                }

                const agentId = randomKeyNaked(24);
                const defaultSessionTag = `standalone:${agentId}`;

                const session = reusableSession
                    ? reusableSession
                    : (existingSessionId || sessionTag)
                        ? await tx.session.findFirst({
                            where: {
                                accountId: userId,
                                OR: [
                                    ...(existingSessionId ? [{ id: existingSessionId }] : []),
                                    ...(sessionTag ? [{ tag: sessionTag }] : []),
                                ],
                            },
                            select: {
                                id: true,
                                tag: true,
                            },
                        })
                    : await tx.session.create({
                        data: {
                            tag: sessionTag || defaultSessionTag,
                            accountId: userId,
                            metadata: JSON.stringify({
                                name: displayName,
                                type: 'standalone-agent',
                                genomeId: genomeId || null,
                                runtimeType,
                                modelId: modelId || null,
                            }),
                        },
                        select: {
                            id: true,
                            tag: true,
                        },
                    });

                if (!session) {
                    return { type: 'session-not-found' as const };
                }

                const resolvedSessionTag = sessionTag || session.tag || defaultSessionTag;

                const board: Record<string, any> = {
                    type: 'standalone',
                    name: displayName,
                    status: 'active',
                    genomeId: genomeId || null,
                    genomeSpec: genomeSpec || null,
                    metadata: metadata || {},
                    team: {
                        members: [{
                            ...(memberId ? { memberId } : {}),
                            sessionId: session.id,
                            sessionTag: resolvedSessionTag,
                            roleId: 'standalone',
                            displayName,
                            runtimeType,
                            joinedAt: Date.now(),
                            lifecycle: {
                                spawnRequestedAt: Date.now(),
                            },
                        }],
                    },
                };

                const artifact = await tx.artifact.create({
                    data: {
                        id: agentId,
                        accountId: userId,
                        header: Buffer.from(JSON.stringify({
                            name: displayName,
                            type: 'standalone',
                        })),
                        body: serializeTeamBoard(board),
                        dataEncryptionKey: Buffer.from('standalone'),
                    },
                });

                if (genomeId) {
                    // Increment on genome-hub (authoritative)
                    incrementHubSpawnCount(genomeId).catch(() => {});
                    // Also increment locally if record exists (transitional fallback)
                    const localGenome = await tx.genome.findFirst({
                        where: { id: genomeId, deletedAt: null },
                        select: { id: true },
                    });
                    if (localGenome) {
                        await tx.genome.update({
                            where: { id: genomeId },
                            data: {
                                spawnCount: { increment: 1 },
                                lastSpawnedAt: new Date(),
                            },
                        });
                    }
                }

                return {
                    type: 'created' as const,
                    artifact,
                    board,
                };
            });

            if (created.type === 'genome-not-found') {
                return reply.code(404).send({ error: 'Genome not found' });
            }

            if (created.type === 'session-not-found') {
                return reply.code(404).send({ error: 'Session not found' });
            }

            log({ module: 'agents' }, `Standalone agent created: ${created.artifact.id}`);

            return reply.code(201).send({
                agent: buildAgentResponse(created.artifact, created.board),
            });
        } catch (error: any) {
            log({ module: 'agents', level: 'error' }, `agent create error: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // =========================================================================
    // GET /v1/agents — List agents (standalone by default)
    // =========================================================================
    app.get('/v1/agents', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                type: z.enum(['standalone', 'team', 'all']).default('standalone'),
                status: z.string().optional(),
                limit: z.coerce.number().int().min(1).max(100).default(20),
                offset: z.coerce.number().int().min(0).default(0),
            }),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { type, status, limit, offset } = request.query as {
            type: string;
            status?: string;
            limit: number;
            offset: number;
        };

        try {
            const artifacts = await db.artifact.findMany({
                where: { accountId: userId },
                orderBy: { updatedAt: 'desc' },
                select: {
                    id: true,
                    accountId: true,
                    body: true,
                    createdAt: true,
                    updatedAt: true,
                },
            });

            const agents = artifacts
                .map(artifact => {
                    const board = extractTeamBoard(artifact);
                    if (!board.team || typeof board.team !== 'object') return null;

                    const isStandalone = isStandaloneAgent(board);
                    if (type === 'standalone' && !isStandalone) return null;
                    if (type === 'team' && isStandalone) return null;
                    if (status && board.status !== status) return null;

                    return buildAgentResponse(artifact, board);
                })
                .filter((a): a is NonNullable<typeof a> => a !== null);

            const total = agents.length;
            const paged = agents.slice(offset, offset + limit);

            return reply.send({ agents: paged, total });
        } catch (error: any) {
            log({ module: 'agents', level: 'error' }, `agents list error: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // =========================================================================
    // GET /v1/agents/:id — Get agent details
    // =========================================================================
    app.get('/v1/agents/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params as { id: string };

        try {
            const artifact = await db.artifact.findFirst({
                where: { id, accountId: userId },
                select: {
                    id: true,
                    accountId: true,
                    body: true,
                    createdAt: true,
                    updatedAt: true,
                },
            });
            if (!artifact) {
                return reply.code(404).send({ error: 'Agent not found' });
            }

            const board = extractTeamBoard(artifact);
            if (!isStandaloneAgent(board)) {
                return reply.code(404).send({ error: 'Agent not found (not standalone)' });
            }

            // Fetch linked genome if present
            let genome = null;
            if (board.genomeId) {
                genome = await db.genome.findFirst({
                    where: {
                        id: board.genomeId as string,
                        deletedAt: null,
                    },
                });
            }

            return reply.send({
                agent: {
                    ...buildAgentResponse(artifact, board),
                    genomeSpec: board.genomeSpec || null,
                    genome: genome || null,
                },
            });
        } catch (error: any) {
            log({ module: 'agents', level: 'error' }, `agent get error: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // =========================================================================
    // PATCH /v1/agents/:id — Update agent config
    // =========================================================================
    app.patch('/v1/agents/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
            body: AgentPatchSchema,
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params as { id: string };
        const updates = request.body as z.infer<typeof AgentPatchSchema>;

        try {
            const artifact = await db.artifact.findFirst({
                where: { id, accountId: userId },
                select: {
                    id: true,
                    accountId: true,
                    body: true,
                    createdAt: true,
                    updatedAt: true,
                },
            });

            if (!artifact) {
                return reply.code(404).send({ error: 'Agent not found' });
            }

            const board = extractTeamBoard(artifact);
            if (!isStandaloneAgent(board)) {
                return reply.code(404).send({ error: 'Agent not found (not standalone)' });
            }

            // Apply updates
            if (updates.displayName !== undefined) {
                board.name = updates.displayName;
                const members = extractTeamMembers(board);
                if (members[0]) {
                    members[0].displayName = updates.displayName;
                }
            }

            if (updates.genomeId !== undefined) {
                // genome-hub is authoritative, local is fallback
                const hubGenome = await fetchGenomeFromHub(updates.genomeId);
                if (!hubGenome) {
                    const localGenome = await db.genome.findFirst({
                        where: {
                            id: updates.genomeId,
                            deletedAt: null,
                            OR: [{ accountId: userId }, { isPublic: true }],
                        },
                        select: { id: true },
                    });
                    if (!localGenome) {
                        return reply.code(404).send({ error: 'Genome not found' });
                    }
                }
                board.genomeId = updates.genomeId;
            }

            if (updates.status !== undefined) {
                board.status = updates.status;
            }

            if (updates.metadata !== undefined) {
                board.metadata = { ...(board.metadata || {}), ...updates.metadata };
            }

            const updated = await db.artifact.update({
                where: { id },
                data: {
                    body: serializeTeamBoard(board),
                    bodyVersion: { increment: 1 },
                    updatedAt: new Date(),
                },
            });

            return reply.send({
                agent: buildAgentResponse(
                    { ...updated, createdAt: updated.createdAt, updatedAt: updated.updatedAt },
                    board,
                ),
            });
        } catch (error: any) {
            log({ module: 'agents', level: 'error' }, `agent patch error: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // =========================================================================
    // DELETE /v1/agents/:id — Deactivate / archive agent
    // =========================================================================
    app.delete('/v1/agents/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params as { id: string };

        try {
            const artifact = await db.artifact.findFirst({
                where: { id, accountId: userId },
                select: {
                    id: true,
                    body: true,
                },
            });

            if (!artifact) {
                return reply.code(404).send({ error: 'Agent not found' });
            }

            const board = extractTeamBoard(artifact);
            if (!isStandaloneAgent(board)) {
                return reply.code(404).send({ error: 'Agent not found (not standalone)' });
            }

            // Deactivate agent session(s)
            const members = extractTeamMembers(board);
            const sessionIds = members
                .map(m => m.sessionId)
                .filter((s): s is string => typeof s === 'string');

            if (sessionIds.length > 0) {
                await db.session.updateMany({
                    where: {
                        id: { in: sessionIds },
                        accountId: userId,
                    },
                    data: {
                        active: false,
                        updatedAt: new Date(),
                    },
                });
            }

            // Mark as archived in board
            board.status = 'archived';
            await db.artifact.update({
                where: { id },
                data: {
                    body: serializeTeamBoard(board),
                    bodyVersion: { increment: 1 },
                    updatedAt: new Date(),
                },
            });

            log({ module: 'agents' }, `Standalone agent archived: ${id}`);

            return reply.send({ success: true, archivedAgentId: id });
        } catch (error: any) {
            log({ module: 'agents', level: 'error' }, `agent delete error: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // =========================================================================
    // POST /v1/agents/:id/promote — Promote standalone agent to full team
    // =========================================================================
    app.post('/v1/agents/:id/promote', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ id: z.string() }),
            body: z.object({
                teamName: z.string().min(1).max(100).optional(),
            }).optional(),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params as { id: string };
        const body = request.body as { teamName?: string } | undefined;

        try {
            const artifact = await db.artifact.findFirst({
                where: { id, accountId: userId },
                select: {
                    id: true,
                    accountId: true,
                    body: true,
                    createdAt: true,
                    updatedAt: true,
                },
            });

            if (!artifact) {
                return reply.code(404).send({ error: 'Agent not found' });
            }

            const board = extractTeamBoard(artifact);
            if (!isStandaloneAgent(board)) {
                return reply.code(400).send({
                    error: 'Agent is not standalone, cannot promote',
                });
            }

            const teamName = body?.teamName || board.name || `Team from ${id.slice(0, 8)}`;

            // Convert to full team: remove standalone marker, add kanban structure
            delete board.type;
            board.name = teamName;
            board.status = 'active';
            board.columns = [
                { id: 'todo', title: 'To Do' },
                { id: 'in-progress', title: 'In Progress' },
                { id: 'review', title: 'Review' },
                { id: 'done', title: 'Done' },
            ];
            board.tasks = [];

            if (board.team) {
                board.team.name = teamName;
            }

            const updated = await db.artifact.update({
                where: { id },
                data: {
                    body: serializeTeamBoard(board),
                    bodyVersion: { increment: 1 },
                    updatedAt: new Date(),
                },
            });

            log({ module: 'agents' }, `Standalone agent promoted to team: ${id}`);

            return reply.send({
                success: true,
                team: {
                    id: updated.id,
                    name: teamName,
                    memberCount: extractTeamMembers(board).length,
                    taskCount: 0,
                    createdAt: updated.createdAt.getTime(),
                    updatedAt: updated.updatedAt.getTime(),
                },
            });
        } catch (error: any) {
            log({ module: 'agents', level: 'error' }, `agent promote error: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });
}

// ---------------------------------------------------------------------------
// Genome-hub federation helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a genome record from genome-hub by ID.
 * Returns the genome object if found, null otherwise.
 */
async function fetchGenomeFromHub(genomeId: string): Promise<Record<string, unknown> | null> {
    try {
        const res = await fetch(`${GENOME_HUB_URL}/genomes/id/${genomeId}`);
        if (res.status === 404) return null;
        if (!res.ok) return null;
        return await res.json() as Record<string, unknown>;
    } catch {
        log({ module: 'agents', level: 'warn' }, `genome-hub unreachable for genome ${genomeId}`);
        return null;
    }
}

/**
 * Increment spawn count on genome-hub (fire-and-forget).
 */
async function incrementHubSpawnCount(genomeId: string): Promise<void> {
    try {
        await fetch(`${GENOME_HUB_URL}/genomes/id/${genomeId}/spawn`, { method: 'POST' });
    } catch {
        // Silently ignore — non-critical
    }
}
