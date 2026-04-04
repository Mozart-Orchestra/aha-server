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
import { buildImageRefFields, resolveImageRef } from "@/app/team/imageRef";
import {
    AgentArtifactStatusSchema,
    AgentLifecycleSchema,
    buildActiveAgentLifecycle,
    buildPendingAgentLifecycle,
    getLifecycleRunStatus,
    normalizeAgentLifecycle,
} from "@/app/team/spawnState";

const GENOME_HUB_URL = process.env.GENOME_HUB_URL ?? 'http://localhost:3006';
const EXISTING_SESSION_LOOKUP_ATTEMPTS = 20;
const EXISTING_SESSION_LOOKUP_DELAY_MS = 250;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const AgentCreateSchema = z.object({
    displayName: z.string().min(1).max(100),
    genomeId: z.string().optional(),
    sourceImageId: z.string().optional(),
    sourceImageVersion: z.number().int().positive().nullable().optional(),
    genomeSpec: z.record(z.unknown()).optional(),
    sessionId: z.string().optional(),
    sessionTag: z.string().optional(),
    memberId: z.string().optional(),
    runtimeType: z.enum(['claude', 'codex']).default('claude'),
    modelId: z.string().optional(),
    lifecycle: AgentLifecycleSchema.optional(),
    metadata: z.record(z.unknown()).optional(),
});

const AgentPatchSchema = z.object({
    displayName: z.string().min(1).max(100).optional(),
    genomeId: z.string().optional(),
    sourceImageId: z.string().optional(),
    sourceImageVersion: z.number().int().positive().nullable().optional(),
    sessionId: z.string().optional(),
    sessionTag: z.string().optional(),
    memberId: z.string().optional(),
    runtimeType: z.enum(['claude', 'codex']).optional(),
    lifecycle: AgentLifecycleSchema.optional(),
    status: AgentArtifactStatusSchema.optional(),
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
    const lifecycle = normalizeAgentLifecycle(agent?.lifecycle);
    const runStatus = getLifecycleRunStatus(lifecycle);
    const imageRef = resolveImageRef({
        sourceImageId: board.sourceImageId ?? agent?.sourceImageId ?? null,
        sourceImageVersion: board.sourceImageVersion ?? agent?.sourceImageVersion ?? null,
        genomeId: board.genomeId ?? agent?.genomeId ?? null,
        genomeVersion: board.genomeVersion ?? agent?.genomeVersion ?? null,
        specId: agent?.specId ?? null,
    });

    return {
        id: artifact.id,
        displayName: agent?.displayName || board.name || `Agent ${artifact.id.slice(0, 8)}`,
        sessionId: agent?.sessionId || null,
        sessionTag: agent?.sessionTag || null,
        memberId: agent?.memberId || null,
        roleId: agent?.roleId || null,
        runtimeType: agent?.runtimeType || 'claude',
        sourceImageId: imageRef?.id ?? null,
        sourceImageVersion: imageRef?.version ?? null,
        genomeId: imageRef?.id ?? null,
        status: typeof board.status === 'string'
            ? board.status
            : (runStatus ?? 'active'),
        metadata: board.metadata || {},
        type,
        lifecycle,
        createdAt: artifact.createdAt.getTime(),
        updatedAt: artifact.updatedAt.getTime(),
    };
}

async function incrementLocalSpawnCount(genomeId: string, userId: string): Promise<void> {
    const localGenome = await db.genome.findFirst({
        where: {
            id: genomeId,
            deletedAt: null,
            OR: [{ accountId: userId }, { isPublic: true }],
        },
        select: { id: true },
    });

    if (!localGenome) {
        return;
    }

    await db.genome.update({
        where: { id: genomeId },
        data: {
            spawnCount: { increment: 1 },
            lastSpawnedAt: new Date(),
        },
    });
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
            sourceImageId,
            sourceImageVersion,
            genomeSpec,
            sessionId: existingSessionId,
            sessionTag,
            memberId,
            runtimeType,
            modelId,
            lifecycle,
            metadata,
        } = request.body as z.infer<typeof AgentCreateSchema>;

        try {
            const imageRef = resolveImageRef({
                sourceImageId,
                sourceImageVersion,
                genomeId,
            });
            const resolvedSourceImageId = imageRef?.id ?? null;
            const normalizedLifecycle = normalizeAgentLifecycle(lifecycle);
            // Must have genomeId or genomeSpec
            if (!resolvedSourceImageId && !genomeSpec) {
                return reply.code(400).send({
                    error: 'Either sourceImageId/genomeId or genomeSpec must be provided',
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
                if (resolvedSourceImageId) {
                    const hubGenome = await fetchGenomeFromHub(resolvedSourceImageId);
                    if (!hubGenome) {
                        log({ module: 'agents', level: 'warn' }, `genome-hub miss for ${resolvedSourceImageId} during agent creation, falling back to local DB`);
                        // Fallback to local genome table (transitional)
                        const localGenome = await tx.genome.findFirst({
                            where: {
                                id: resolvedSourceImageId,
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

                // Artifact-first: session is optional. When neither sessionId
                // nor sessionTag is supplied the agent is created as a
                // session-less artifact that can be patched later.
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
                        : null;

                // If caller explicitly asked for a session but it was not
                // found, that is an error.
                if ((existingSessionId || sessionTag) && !session) {
                    return { type: 'session-not-found' as const };
                }

                const resolvedSessionTag = sessionTag || session?.tag || defaultSessionTag;

                const board: Record<string, any> = {
                    type: 'standalone',
                    name: displayName,
                    status: getLifecycleRunStatus(normalizedLifecycle)
                        ?? (session ? 'active' : 'pending'),
                    ...buildImageRefFields(imageRef, { includeLegacyGenome: true }),
                    genomeSpec: genomeSpec || null,
                    metadata: metadata || {},
                    team: {
                        members: [{
                            ...(memberId ? { memberId } : {}),
                            ...(session ? { sessionId: session.id } : {}),
                            sessionTag: resolvedSessionTag,
                            roleId: 'standalone',
                            displayName,
                            ...buildImageRefFields(imageRef, { includeLegacySpec: true }),
                            runtimeType,
                            joinedAt: Date.now(),
                            lifecycle: normalizedLifecycle
                                ?? (session
                                    ? buildActiveAgentLifecycle()
                                    : buildPendingAgentLifecycle()),
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

                // NOTE: spawnCount is NOT incremented here at creation time.
                // It is incremented in the PATCH handler when lifecycle.runStatus
                // transitions to 'active', ensuring we only count successful spawns.

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

            // Fetch linked genome if present (sourceImageId is canonical, genomeId is legacy fallback)
            const resolvedGenomeLookupId = board.sourceImageId ?? board.genomeId;
            let genome = null;
            if (resolvedGenomeLookupId) {
                genome = await db.genome.findFirst({
                    where: {
                        id: resolvedGenomeLookupId as string,
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
            const members = extractTeamMembers(board);
            const primaryMember = members[0] ?? null;
            const previousRunStatus = getLifecycleRunStatus(normalizeAgentLifecycle(primaryMember?.lifecycle));
            const resolvedImageRef = resolveImageRef({
                sourceImageId: board.sourceImageId ?? primaryMember?.sourceImageId ?? null,
                sourceImageVersion: board.sourceImageVersion ?? primaryMember?.sourceImageVersion ?? null,
                genomeId: board.genomeId ?? primaryMember?.genomeId ?? null,
                genomeVersion: board.genomeVersion ?? primaryMember?.genomeVersion ?? null,
                specId: primaryMember?.specId ?? null,
            });
            const resolvedImageId = resolvedImageRef?.id ?? null;
            const normalizedLifecycleUpdate = normalizeAgentLifecycle(updates.lifecycle);

            let resolvedSessionForPatch: { id: string; tag: string } | null = null;
            if (updates.sessionId !== undefined) {
                resolvedSessionForPatch = await db.session.findFirst({
                    where: {
                        id: updates.sessionId,
                        accountId: userId,
                    },
                    select: {
                        id: true,
                        tag: true,
                    },
                });

                if (!resolvedSessionForPatch) {
                    return reply.code(404).send({ error: 'Session not found' });
                }
            }

            if (updates.displayName !== undefined) {
                board.name = updates.displayName;
                if (primaryMember) {
                    primaryMember.displayName = updates.displayName;
                }
            }

            const updatedImageRef = resolveImageRef({
                sourceImageId: updates.sourceImageId,
                sourceImageVersion: updates.sourceImageVersion,
                genomeId: updates.genomeId,
            });
            if (updatedImageRef) {
                // genome-hub is authoritative, local is fallback
                const hubGenome = await fetchGenomeFromHub(updatedImageRef.id);
                if (!hubGenome) {
                    log({ module: 'agents', level: 'warn' }, `genome-hub miss for ${updatedImageRef.id} during agent update, using local DB (data may be stale)`);
                    const localGenome = await db.genome.findFirst({
                        where: {
                            id: updatedImageRef.id,
                            deletedAt: null,
                            OR: [{ accountId: userId }, { isPublic: true }],
                        },
                        select: { id: true },
                    });
                    if (!localGenome) {
                        return reply.code(404).send({ error: 'Genome not found' });
                    }
                }
                Object.assign(board, buildImageRefFields(updatedImageRef, { includeLegacyGenome: true }));
                if (primaryMember) {
                    Object.assign(primaryMember, buildImageRefFields(updatedImageRef, { includeLegacySpec: true }));
                }
            }

            if (updates.sourceImageVersion !== undefined) {
                const currentImageRef = resolveImageRef({
                    sourceImageId: board.sourceImageId ?? primaryMember?.sourceImageId ?? null,
                    sourceImageVersion: updates.sourceImageVersion,
                    genomeId: board.genomeId ?? primaryMember?.genomeId ?? null,
                    specId: primaryMember?.specId ?? null,
                });
                Object.assign(board, buildImageRefFields(currentImageRef, { includeLegacyGenome: true }));
                if (primaryMember) {
                    Object.assign(primaryMember, buildImageRefFields(currentImageRef, { includeLegacySpec: true }));
                }
            }

            if (updates.sessionId !== undefined && primaryMember) {
                primaryMember.sessionId = updates.sessionId;
                if (resolvedSessionForPatch && updates.sessionTag === undefined) {
                    primaryMember.sessionTag = resolvedSessionForPatch.tag;
                }
            }

            if (updates.sessionTag !== undefined && primaryMember) {
                primaryMember.sessionTag = updates.sessionTag;
            }

            if (updates.memberId !== undefined && primaryMember) {
                primaryMember.memberId = updates.memberId;
            }

            if (updates.runtimeType !== undefined && primaryMember) {
                primaryMember.runtimeType = updates.runtimeType;
            }

            if (updates.lifecycle !== undefined && primaryMember) {
                const mergedLifecycle = normalizeAgentLifecycle({
                    ...(normalizeAgentLifecycle(primaryMember.lifecycle) ?? {}),
                    ...(normalizedLifecycleUpdate ?? {}),
                }) ?? undefined;
                primaryMember.lifecycle = mergedLifecycle;
                const nextBoardStatus = getLifecycleRunStatus(mergedLifecycle);
                if (nextBoardStatus) {
                    board.status = nextBoardStatus;
                }
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

            const nextRunStatus = getLifecycleRunStatus(normalizeAgentLifecycle(primaryMember?.lifecycle));
            const transitionedToActive = nextRunStatus === 'active' && previousRunStatus !== 'active';
            if (transitionedToActive && resolvedImageId) {
                incrementHubSpawnCount(resolvedImageId).catch(() => {});
                await incrementLocalSpawnCount(resolvedImageId, userId);
            }

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
