import { Fastify } from "../types";
import { z } from "zod";
import { log } from "@/utils/log";
import { db } from "@/storage/db";
import { eventRouter } from "@/app/events/eventRouter";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import {
    buildTeamMirrorSnapshot,
    extractTeamBoard,
    extractTeamMembers,
    getAccessibleTeamArtifact,
    listAccessibleTeamArtifacts,
    serializeTeamBoard,
    summarizeTeamArtifact,
} from "@/app/team/teamArtifacts";
import { buildImageRefFields, clearImageRefFields, resolveCandidateId, resolveImageRef } from "@/app/team/imageRef";
import { AgentLifecycle, AgentLifecycleSchema, normalizeAgentLifecycle } from "@/app/team/spawnState";
import { getTeamOverviewSnapshot, invalidateTeamOverviewSnapshot } from "@/app/team/teamOverview";
import { activityCache } from "@/app/presence/sessionCache";

/**
 * Team Management Routes
 *
 * Server-driven team operations:
 * - Add/remove members (with atomic updates)
 * - Archive team (archive all sessions)
 * - Delete team (delete all sessions)
 * - Rename team
 * - Batch session operations
 */

const DEFAULT_TEAM_COLUMNS = [
    { id: 'todo', title: 'To Do' },
    { id: 'in-progress', title: 'In Progress' },
    { id: 'review', title: 'Review' },
    { id: 'done', title: 'Done' },
];

const CorpsSeatSchema = z.object({
    id: z.string().optional(),
    genomeId: z.string().min(1).optional(),
    sourceImageId: z.string().min(1).optional(),
    genomeName: z.string().nullish(),
    genomeNamespace: z.string().nullish(),
    genomeVersion: z.number().int().positive().nullish(),
    sourceImageVersion: z.number().int().positive().nullish(),
    genomeDisplayName: z.string().nullish(),
    roleId: z.string().min(1),
    displayName: z.string().optional(),
    runtimeType: z.enum(['claude', 'codex']),
    machineId: z.string().optional(),
    workspacePath: z.string().optional(),
    quantity: z.number().int().min(1).max(24).default(1),
    customPrompt: z.string().optional(),
});

const CorpsCreateSchema = z.object({
    id: z.string().optional(),
    name: z.string().min(1).max(200),
    description: z.string().max(500).optional(),
    target: z.string().max(2000).optional(),
    machineId: z.string().optional(),
    workspacePath: z.string().optional(),
    seats: z.array(CorpsSeatSchema).min(1).max(128).optional(),
    roles: z.array(CorpsSeatSchema).min(1).max(128).optional(),
}).superRefine((value, ctx) => {
    const hasSeats = Array.isArray(value.seats) && value.seats.length > 0;
    const hasRoles = Array.isArray(value.roles) && value.roles.length > 0;

    if (!hasSeats && !hasRoles) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'At least one corps seat config is required',
            path: ['seats'],
        });
    }

    if (hasSeats && hasRoles) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Provide either seats or roles, not both',
            path: ['roles'],
        });
    }
});

const TeamMirrorMemberSchema = z.object({
    memberId: z.string().optional(),
    sessionId: z.string(),
    sessionTag: z.string().optional(),
    roleId: z.string().optional(),
    displayName: z.string().optional(),
    executionPlane: z.string().optional(),
    runtimeType: z.string().optional(),
    specId: z.string().optional(),
    genomeId: z.string().optional(),
    genomeVersion: z.number().nullable().optional(),
    sourceImageId: z.string().optional(),
    sourceImageVersion: z.number().nullable().optional(),
    workspacePath: z.string().optional(),
    machineId: z.string().optional(),
    lifecycle: AgentLifecycleSchema.optional(),
});

const TeamMirrorTaskSchema = z.object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    priority: z.string().nullable(),
    assigneeId: z.string().nullable(),
    parentTaskId: z.string().nullable(),
    approvalStatus: z.string().nullable(),
    labels: z.array(z.string()),
    acceptanceCriteria: z.array(z.string()),
    commentCount: z.number(),
    blockerCount: z.number(),
    updatedAt: z.number().nullable(),
});

const TeamMirrorSchema = z.object({
    sourceOfTruth: z.object({
        artifactId: z.string(),
        artifactBodyVersion: z.number(),
        artifactUpdatedAt: z.number(),
        source: z.literal('team-artifact'),
    }),
    team: z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        createdAt: z.number(),
        updatedAt: z.number(),
        boardVersion: z.number().nullable(),
    }),
    goal: z.object({
        initialObjective: z.string().nullable(),
    }),
    bootContext: z.record(z.string(), z.any()).nullable(),
    projectMap: z.any().nullable(),
    counts: z.object({
        members: z.number(),
        tasks: z.number(),
        todo: z.number(),
        inProgress: z.number(),
        review: z.number(),
        blocked: z.number(),
        done: z.number(),
    }),
    members: z.array(TeamMirrorMemberSchema),
    tasks: z.array(TeamMirrorTaskSchema),
});

interface CorpsSeatConfig {
    id?: string;
    genomeId: string;
    sourceImageId: string;
    genomeName?: string | null;
    genomeNamespace?: string | null;
    genomeVersion?: number | null;
    sourceImageVersion?: number | null;
    genomeDisplayName?: string | null;
    roleId: string;
    displayName?: string;
    runtimeType: 'claude' | 'codex';
    machineId: string;
    workspacePath: string;
    quantity: number;
    customPrompt?: string;
}

interface PlannedCorpsMember {
    memberId: string;
    sessionTag: string;
    roleId: string;
    displayName: string;
    genomeId: string;
    sourceImageId: string;
    sourceImageVersion?: number | null;
    candidateId: string;
    runtimeType: 'claude' | 'codex';
    machineId: string;
    workspacePath: string;
    customPrompt?: string;
}

interface CreateOrUpdateTeamArtifactResult {
    artifact: {
        id: string;
        body: Uint8Array | null;
        createdAt: Date;
        updatedAt: Date;
    };
    teamId: string;
    reusedExistingArtifact: boolean;
}

function buildDefaultTeamBoard(name: string, description?: string): Record<string, any> {
    return {
        name,
        description: description || '',
        columns: DEFAULT_TEAM_COLUMNS.map((column) => ({ ...column })),
        tasks: [],
        agreements: [],
        roles: [],
        team: {
            name,
            members: [],
        },
    };
}

function normalizeTeamBoard(board: Record<string, any>, name: string, description?: string): Record<string, any> {
    board.name = name;
    if (description !== undefined) {
        board.description = description;
    } else if (typeof board.description !== 'string') {
        board.description = '';
    }
    if (!board.team || typeof board.team !== 'object') {
        board.team = { members: [] };
    }
    board.team.name = name;
    if (!Array.isArray(board.team.members)) {
        board.team.members = [];
    }
    return board;
}

async function createOrUpdateTeamArtifact(
    userId: string,
    params: { id?: string; name: string; description?: string; board: Record<string, any> },
): Promise<CreateOrUpdateTeamArtifactResult> {
    const requestedTeamId = params.id?.trim() || undefined;
    let teamId = requestedTeamId || randomKeyNaked(24);
    const board = normalizeTeamBoard(
        JSON.parse(JSON.stringify(params.board)),
        params.name,
        params.description,
    );

    const existingArtifact = requestedTeamId
        ? await db.artifact.findUnique({
            where: { id: teamId },
            select: {
                id: true,
                accountId: true,
                body: true,
                createdAt: true,
                updatedAt: true,
            },
        })
        : null;

    if (existingArtifact && existingArtifact.accountId !== userId) {
        const fallbackTeamId = randomKeyNaked(24);
        log(
            { module: 'team-management', level: 'warn', requestedTeamId, fallbackTeamId, userId },
            `Requested team id ${requestedTeamId} belongs to another account; creating fallback team ${fallbackTeamId}`,
        );
        teamId = fallbackTeamId;
    }

    const writeTeamArtifact = async (artifactId: string) => {
        if (existingArtifact && existingArtifact.accountId === userId && artifactId === existingArtifact.id) {
            return await db.artifact.update({
                where: { id: artifactId },
                data: {
                    header: Buffer.from(JSON.stringify({ name: params.name, type: 'team' })),
                    body: serializeTeamBoard(board),
                    dataEncryptionKey: Buffer.from('team'),
                    bodyVersion: { increment: 1 },
                    updatedAt: new Date(),
                },
            });
        }

        return await db.artifact.create({
            data: {
                id: artifactId,
                accountId: userId,
                header: Buffer.from(JSON.stringify({ name: params.name, type: 'team' })),
                body: serializeTeamBoard(board),
                dataEncryptionKey: Buffer.from('team'),
            },
        });
    };

    let artifact;
    try {
        artifact = await writeTeamArtifact(teamId);
    } catch (error: any) {
        if (error?.code !== 'P2002') {
            throw error;
        }

        const conflictedArtifact = await db.artifact.findUnique({
            where: { id: teamId },
            select: {
                id: true,
                accountId: true,
                body: true,
                createdAt: true,
                updatedAt: true,
            },
        });

        if (conflictedArtifact?.accountId === userId) {
            artifact = await db.artifact.update({
                where: { id: teamId },
                data: {
                    header: Buffer.from(JSON.stringify({ name: params.name, type: 'team' })),
                    body: serializeTeamBoard(board),
                    dataEncryptionKey: Buffer.from('team'),
                    bodyVersion: { increment: 1 },
                    updatedAt: new Date(),
                },
            });
        } else {
            const fallbackTeamId = randomKeyNaked(24);
            log(
                { module: 'team-management', level: 'warn', requestedTeamId, conflictedTeamId: teamId, fallbackTeamId, userId },
                `Team create raced on ${teamId}; creating fallback team ${fallbackTeamId}`,
            );
            teamId = fallbackTeamId;
            artifact = await writeTeamArtifact(teamId);
        }
    }

    const reusedExistingArtifact = existingArtifact?.accountId === userId && existingArtifact.id === teamId;
    return { artifact, teamId, reusedExistingArtifact };
}

function normalizeCorpsSeatConfigs(
    body: z.infer<typeof CorpsCreateSchema>,
): { seats: CorpsSeatConfig[]; errors: string[] } {
    const rawSeats = body.seats ?? body.roles ?? [];
    const fallbackMachineId = body.machineId?.trim();
    const fallbackWorkspacePath = body.workspacePath?.trim();
    const seats: CorpsSeatConfig[] = [];
    const errors: string[] = [];

    rawSeats.forEach((rawSeat, index) => {
        const machineId = rawSeat.machineId?.trim() || fallbackMachineId || '';
        const workspacePath = rawSeat.workspacePath?.trim() || fallbackWorkspacePath || '';
        const displayName = rawSeat.displayName?.trim();
        const customPrompt = rawSeat.customPrompt?.trim();
        const imageRef = resolveImageRef({
            sourceImageId: rawSeat.sourceImageId?.trim() || null,
            sourceImageVersion: rawSeat.sourceImageVersion ?? null,
            genomeId: rawSeat.genomeId?.trim() || null,
            genomeVersion: rawSeat.genomeVersion ?? null,
        });
        const sourceImageId = imageRef?.id ?? '';

        if (!machineId) {
            errors.push(`Seat ${index + 1} is missing machineId`);
        }
        if (!workspacePath) {
            errors.push(`Seat ${index + 1} is missing workspacePath`);
        }
        if (!sourceImageId) {
            errors.push(`Seat ${index + 1} is missing sourceImageId/genomeId`);
            return;
        }

        seats.push({
            id: rawSeat.id?.trim() || undefined,
            genomeId: sourceImageId,
            sourceImageId,
            genomeName: rawSeat.genomeName?.trim() || null,
            genomeNamespace: rawSeat.genomeNamespace?.trim() || null,
            genomeVersion: imageRef?.version ?? null,
            sourceImageVersion: imageRef?.version ?? null,
            genomeDisplayName: rawSeat.genomeDisplayName?.trim() || null,
            roleId: rawSeat.roleId.trim(),
            displayName,
            runtimeType: rawSeat.runtimeType,
            machineId,
            workspacePath,
            quantity: rawSeat.quantity,
            customPrompt,
        });
    });

    return { seats, errors };
}

function buildPlannedCorpsMembers(teamId: string, seats: CorpsSeatConfig[]): PlannedCorpsMember[] {
    const members: PlannedCorpsMember[] = [];

    seats.forEach((seat, seatIndex) => {
        const baseMemberId = seat.id || `seat-${seatIndex + 1}`;
        const baseDisplayName = seat.displayName?.trim()
            || seat.genomeDisplayName?.trim()
            || seat.genomeName?.trim()
            || seat.roleId;

        for (let ordinal = 1; ordinal <= seat.quantity; ordinal += 1) {
            const memberId = seat.quantity > 1 ? `${baseMemberId}-${ordinal}` : baseMemberId;
            const imageRef = resolveImageRef({
                sourceImageId: seat.sourceImageId,
                sourceImageVersion: seat.sourceImageVersion ?? null,
                genomeId: seat.genomeId,
                genomeVersion: seat.genomeVersion ?? null,
            });
            members.push({
                memberId,
                sessionTag: `team:${teamId}:member:${memberId}`,
                roleId: seat.roleId,
                displayName: seat.quantity > 1 ? `${baseDisplayName} ${ordinal}` : baseDisplayName,
                genomeId: imageRef?.id ?? seat.genomeId,
                sourceImageId: imageRef?.id ?? seat.sourceImageId,
                sourceImageVersion: imageRef?.version ?? null,
                candidateId: resolveCandidateId(imageRef) ?? `spec:${imageRef?.id ?? seat.sourceImageId}`,
                runtimeType: seat.runtimeType,
                machineId: seat.machineId,
                workspacePath: seat.workspacePath,
                ...(seat.customPrompt ? { customPrompt: seat.customPrompt } : {}),
            });
        }
    });

    return members;
}

function buildManualCorpsBoard(params: {
    teamId: string;
    name: string;
    description?: string;
    target?: string;
    seats: CorpsSeatConfig[];
    plannedMembers: PlannedCorpsMember[];
}): Record<string, any> {
    const board = buildDefaultTeamBoard(params.name, params.description);
    const now = Date.now();
    const trimmedTarget = params.target?.trim();
    const plannedTeamMembers = params.plannedMembers.map((member) => ({
        ...buildImageRefFields(resolveImageRef({
            sourceImageId: member.sourceImageId,
            sourceImageVersion: member.sourceImageVersion ?? null,
            genomeId: member.genomeId,
            specId: member.sourceImageId,
        }), { includeLegacyGenome: true, includeLegacySpec: true }),
        memberId: member.memberId,
        sessionId: member.sessionTag,
        sessionTag: member.sessionTag,
        candidateId: member.candidateId,
        roleId: member.roleId,
        displayName: member.displayName,
        joinedAt: now,
        runtimeType: member.runtimeType,
        machineId: member.machineId,
        workspacePath: member.workspacePath,
        ...(member.customPrompt ? { customPrompt: member.customPrompt } : {}),
        lifecycle: {
            plannedAt: now,
        },
    }));

    board.team.members = plannedTeamMembers;

    if (trimmedTarget) {
        board.team.bootContext = {
            initialObjective: trimmedTarget,
        };
        board.tasks.push({
            id: 'team-goal',
            title: `Team Goal: ${trimmedTarget}`,
            description: 'This is the primary objective for this team.',
            status: 'todo',
            createdAt: now,
            updatedAt: now,
        });
    }

    board.corps = {
        id: params.teamId,
        mode: 'manual',
        target: trimmedTarget || '',
        createdAt: now,
        seats: params.seats.map((seat) => ({
            ...(seat.id ? { id: seat.id } : {}),
            ...buildImageRefFields(resolveImageRef({
                sourceImageId: seat.sourceImageId,
                sourceImageVersion: seat.sourceImageVersion ?? null,
                genomeId: seat.genomeId,
                genomeVersion: seat.genomeVersion ?? null,
            }), { includeLegacyGenome: true }),
            ...(seat.genomeName ? { genomeName: seat.genomeName } : {}),
            ...(seat.genomeNamespace ? { genomeNamespace: seat.genomeNamespace } : {}),
            ...(seat.genomeDisplayName ? { genomeDisplayName: seat.genomeDisplayName } : {}),
            roleId: seat.roleId,
            displayName: seat.displayName || seat.genomeDisplayName || seat.genomeName || seat.roleId,
            runtimeType: seat.runtimeType,
            machineId: seat.machineId,
            workspacePath: seat.workspacePath,
            quantity: seat.quantity,
            ...(seat.customPrompt ? { customPrompt: seat.customPrompt } : {}),
        })),
        plannedMembers: params.plannedMembers.map((member) => ({ ...member })),
    };

    return board;
}

export function teamManagementRoutes(app: Fastify) {
    log({ module: 'api' }, 'Registering teamManagementRoutes...');

    // POST /v1/teams - Create a new team
    app.post('/v1/teams', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                id: z.string().optional(),
                name: z.string().min(1).max(200),
                description: z.string().max(500).optional(),
                board: z.record(z.unknown()).optional(),
            }),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { id, name, description, board: incomingBoard } = request.body as {
            id?: string;
            name: string;
            description?: string;
            board?: Record<string, unknown>;
        };

        try {
            const board: Record<string, any> = incomingBoard
                ? JSON.parse(JSON.stringify(incomingBoard))
                : buildDefaultTeamBoard(name, description);
            const { artifact, reusedExistingArtifact, teamId } = await createOrUpdateTeamArtifact(userId, {
                id,
                name,
                description,
                board,
            });

            await invalidateTeamOverviewSnapshot(userId);
            log({ module: 'team-management' }, `Team created: ${teamId} by ${userId}`);

            return reply.code(reusedExistingArtifact ? 200 : 201).send({
                team: summarizeTeamArtifact(artifact),
            });
        } catch (error: any) {
            log({ module: 'team-management' }, `Failed to create team: ${error}`);
            return reply.code(500).send({ error: 'Failed to create team' });
        }
    });

    // POST /v1/corps - Create a manual corps/team plan with per-seat machine/runtime config
    app.post('/v1/corps', {
        preHandler: app.authenticate,
        schema: {
            body: CorpsCreateSchema,
            response: {
                200: z.object({
                    success: z.literal(true),
                    corps: z.object({
                        id: z.string(),
                        name: z.string(),
                        seatCount: z.number(),
                        plannedMemberCount: z.number(),
                    }),
                    team: z.object({
                        id: z.string(),
                        name: z.string(),
                        memberCount: z.number(),
                        taskCount: z.number(),
                        createdAt: z.number(),
                        updatedAt: z.number(),
                    }),
                    plannedMembers: z.array(z.object({
                        memberId: z.string(),
                        sessionTag: z.string(),
                        roleId: z.string(),
                        displayName: z.string(),
                        genomeId: z.string(),
                        sourceImageId: z.string(),
                        sourceImageVersion: z.number().nullable().optional(),
                        candidateId: z.string(),
                        runtimeType: z.enum(['claude', 'codex']),
                        machineId: z.string(),
                        workspacePath: z.string(),
                        customPrompt: z.string().optional(),
                    })),
                }),
                201: z.object({
                    success: z.literal(true),
                    corps: z.object({
                        id: z.string(),
                        name: z.string(),
                        seatCount: z.number(),
                        plannedMemberCount: z.number(),
                    }),
                    team: z.object({
                        id: z.string(),
                        name: z.string(),
                        memberCount: z.number(),
                        taskCount: z.number(),
                        createdAt: z.number(),
                        updatedAt: z.number(),
                    }),
                    plannedMembers: z.array(z.object({
                        memberId: z.string(),
                        sessionTag: z.string(),
                        roleId: z.string(),
                        displayName: z.string(),
                        genomeId: z.string(),
                        sourceImageId: z.string(),
                        sourceImageVersion: z.number().nullable().optional(),
                        candidateId: z.string(),
                        runtimeType: z.enum(['claude', 'codex']),
                        machineId: z.string(),
                        workspacePath: z.string(),
                        customPrompt: z.string().optional(),
                    })),
                }),
                400: z.object({
                    error: z.string(),
                }),
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const body = request.body as z.infer<typeof CorpsCreateSchema>;
        const { seats, errors } = normalizeCorpsSeatConfigs(body);

        if (errors.length > 0) {
            return reply.code(400).send({ error: errors.join('; ') });
        }

        try {
            const uniqueMachineIds = [...new Set(seats.map((seat) => seat.machineId))];
            const ownedMachines = await db.machine.findMany({
                where: {
                    accountId: userId,
                    id: { in: uniqueMachineIds },
                },
                select: { id: true },
            });
            const ownedMachineIds = new Set(ownedMachines.map((machine) => machine.id));
            const missingMachineIds = uniqueMachineIds.filter((machineId) => !ownedMachineIds.has(machineId));

            if (missingMachineIds.length > 0) {
                return reply.code(400).send({
                    error: `Unknown machineId(s): ${missingMachineIds.join(', ')}`,
                });
            }

            const teamId = body.id?.trim() || randomKeyNaked(24);
            const plannedMembers = buildPlannedCorpsMembers(teamId, seats);
            const board = buildManualCorpsBoard({
                teamId,
                name: body.name,
                description: body.description,
                target: body.target,
                seats,
                plannedMembers,
            });
            const { artifact, reusedExistingArtifact } = await createOrUpdateTeamArtifact(userId, {
                id: teamId,
                name: body.name,
                description: body.description,
                board,
            });

            await invalidateTeamOverviewSnapshot(userId);
            log({ module: 'team-management', teamId, seatCount: seats.length }, `Manual corps created: ${teamId}`);

            return reply.code(reusedExistingArtifact ? 200 : 201).send({
                success: true,
                corps: {
                    id: teamId,
                    name: body.name,
                    seatCount: seats.length,
                    plannedMemberCount: plannedMembers.length,
                },
                team: summarizeTeamArtifact(artifact),
                plannedMembers,
            });
        } catch (error: any) {
            log({ module: 'team-management', level: 'error' }, `Failed to create corps: ${error}`);
            return reply.code(500).send({ error: 'Failed to create corps' });
        }
    });

    // GET /v1/teams - List teams accessible to the current user
    app.get('/v1/teams', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    teams: z.array(z.object({
                        id: z.string(),
                        name: z.string(),
                        memberCount: z.number(),
                        taskCount: z.number(),
                        createdAt: z.number(),
                        updatedAt: z.number(),
                    })),
                }),
                500: z.object({
                    error: z.literal('Failed to list teams'),
                }),
            },
        },
    }, async (request, reply) => {
        try {
            const teams = await listAccessibleTeamArtifacts(request.userId);
            return reply.send({
                teams: teams.map(team => summarizeTeamArtifact(team)),
            });
        } catch (error: any) {
            log({ module: 'team-management', level: 'error' }, `Failed to list teams: ${error}`);
            return reply.code(500).send({ error: 'Failed to list teams' });
        }
    });

    app.get('/v1/teams/overview', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    overview: z.object({
                        generatedAt: z.number(),
                        teamCount: z.number(),
                        teamTotalTokens: z.number(),
                        agentTotalTokens: z.number(),
                        completedTasksTotal: z.number(),
                        teamUsageItems: z.array(z.object({
                            id: z.string(),
                            label: z.string(),
                            tokens: z.number(),
                        })),
                        agentUsageItems: z.array(z.object({
                            id: z.string(),
                            label: z.string(),
                            tokens: z.number(),
                        })),
                        completedTaskItems: z.array(z.object({
                            id: z.string(),
                            label: z.string(),
                            completedTasks: z.number(),
                        })),
                    }),
                }),
                500: z.object({
                    error: z.literal('Failed to get team overview'),
                }),
            },
        },
    }, async (request, reply) => {
        try {
            const overview = await getTeamOverviewSnapshot(request.userId);
            return reply.send({ overview });
        } catch (error: any) {
            log({ module: 'team-management', level: 'error' }, `Failed to get team overview: ${error}`);
            return reply.code(500).send({ error: 'Failed to get team overview' });
        }
    });

    // GET /v1/teams/:teamId - Fetch one team summary with members
    app.get('/v1/teams/:teamId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            response: {
                200: z.object({
                    team: z.object({
                        id: z.string(),
                        name: z.string(),
                        memberCount: z.number(),
                        taskCount: z.number(),
                        members: z.array(z.any()),
                        createdAt: z.number(),
                        updatedAt: z.number(),
                    }),
                }),
                404: z.object({
                    error: z.literal('Team not found'),
                }),
                500: z.object({
                    error: z.literal('Failed to get team'),
                }),
            },
        },
    }, async (request, reply) => {
        const { teamId } = request.params as { teamId: string };

        try {
            const artifact = await getAccessibleTeamArtifact(request.userId, teamId, { includeArchived: true });
            if (!artifact) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            const team = summarizeTeamArtifact(artifact, { includeMembers: true });
            return reply.send({
                team: {
                    ...team,
                    members: team.members ?? [],
                },
            });
        } catch (error: any) {
            log({ module: 'team-management', level: 'error' }, `Failed to get team ${teamId}: ${error}`);
            return reply.code(500).send({ error: 'Failed to get team' });
        }
    });

    // === Team Member Management ===

    // GET /v1/teams/:teamId/mirror - Canonical team mirror for agents
    app.get('/v1/teams/:teamId/mirror', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            response: {
                200: z.object({
                    mirror: TeamMirrorSchema,
                }),
                404: z.object({
                    error: z.literal('Team not found'),
                }),
                500: z.object({
                    error: z.literal('Failed to get team mirror'),
                }),
            },
        },
    }, async (request, reply) => {
        const { teamId } = request.params as { teamId: string };

        try {
            const artifact = await getAccessibleTeamArtifact(request.userId, teamId, { includeArchived: true });
            if (!artifact) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            return reply.send({
                mirror: buildTeamMirrorSnapshot(artifact),
            });
        } catch (error: any) {
            log({ module: 'team-management', level: 'error' }, `Failed to get team mirror ${teamId}: ${error}`);
            return reply.code(500).send({ error: 'Failed to get team mirror' });
        }
    });

    // GET /v1/teams/:teamId/members - List team members
    app.get('/v1/teams/:teamId/members', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            response: {
                200: z.object({
                    members: z.array(z.any()),
                }),
                404: z.object({
                    error: z.literal('Team not found'),
                }),
                500: z.object({
                    error: z.literal('Failed to list team members'),
                }),
            },
        },
    }, async (request, reply) => {
        const { teamId } = request.params as { teamId: string };

        try {
            const artifact = await getAccessibleTeamArtifact(request.userId, teamId, { includeArchived: true });
            if (!artifact) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            const board = extractTeamBoard(artifact);
            return reply.send({ members: extractTeamMembers(board) });
        } catch (error: any) {
            log({ module: 'team-management', level: 'error' }, `Failed to list members for ${teamId}: ${error}`);
            return reply.code(500).send({ error: 'Failed to list team members' });
        }
    });

    // POST /v1/teams/:teamId/members - Add member to team
    app.post('/v1/teams/:teamId/members', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            body: z.object({
                memberId: z.string().optional(),
                sessionId: z.string(),
                sessionTag: z.string().optional(),
                candidateId: z.string().optional(),
                roleId: z.string(),
                displayName: z.string().optional(),
                sourceImageId: z.string().optional(),
                sourceImageVersion: z.number().int().positive().nullable().optional(),
                specId: z.string().optional(),
                // Legacy aliases (corps seat callers)
                genomeId: z.string().optional(),
                genomeVersion: z.number().int().positive().nullable().optional(),
                customPrompt: z.string().optional(),
                parentSessionId: z.string().optional(),
                executionPlane: z.string().optional(),
                runtimeType: z.string().optional(),
                machineId: z.string().optional(),
                workspacePath: z.string().optional(),
                spawnError: z.string().optional(),
                lifecycle: AgentLifecycleSchema.optional(),
                authorities: z.array(z.string()).optional(),
                teamOverlay: z.record(z.string(), z.unknown()).optional()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const { memberId, sessionId, sessionTag, candidateId, roleId, displayName, sourceImageId: rawSourceImageId, sourceImageVersion: rawSourceImageVersion, specId, genomeId, genomeVersion, customPrompt, parentSessionId, executionPlane, runtimeType, machineId, workspacePath, spawnError, lifecycle, authorities, teamOverlay } = request.body as {
            memberId?: string;
            sessionId: string;
            sessionTag?: string;
            candidateId?: string;
            roleId: string;
            displayName?: string;
            sourceImageId?: string;
            sourceImageVersion?: number | null;
            specId?: string;
            genomeId?: string;
            genomeVersion?: number | null;
            customPrompt?: string;
            parentSessionId?: string;
            executionPlane?: string;
            runtimeType?: string;
            machineId?: string;
            workspacePath?: string;
            spawnError?: string;
            lifecycle?: AgentLifecycle;
            authorities?: string[];
            teamOverlay?: Record<string, unknown>;
        };

        // Normalize: sourceImageId is canonical, accept legacy aliases
        const sourceImageId = rawSourceImageId ?? genomeId ?? specId;
        const sourceImageVersion = rawSourceImageVersion ?? genomeVersion ?? null;

        try {
            const result = await addTeamMember(userId, teamId, memberId, sessionId, sessionTag, candidateId, roleId, displayName, sourceImageId, sourceImageVersion, specId, customPrompt, parentSessionId, executionPlane, runtimeType, machineId, workspacePath, spawnError, lifecycle, authorities, teamOverlay);
            return reply.send(result);
        } catch (error: any) {
            if (error.message === 'Team not found') {
                return reply.code(404).send({ error: error.message });
            }
            log({ module: 'team-management', level: 'error' }, `Failed to add member: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // DELETE /v1/teams/:teamId/members/:sessionId - Remove member from team
    app.delete('/v1/teams/:teamId/members/:sessionId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string(),
                sessionId: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId, sessionId } = request.params as { teamId: string; sessionId: string };

        try {
            const result = await removeTeamMember(userId, teamId, sessionId);
            return reply.send(result);
        } catch (error: any) {
            if (error.message === 'Team not found') {
                return reply.code(404).send({ error: error.message });
            }
            log({ module: 'team-management', level: 'error' }, `Failed to remove member: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // === Team Operations ===

    // POST /v1/teams/:teamId/archive - Archive team and all sessions
    // Note: Client must provide sessionIds since artifact body is encrypted
    app.post('/v1/teams/:teamId/archive', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            body: z.object({
                sessionIds: z.array(z.string()).optional() // Client provides session IDs
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const body = request.body as { sessionIds?: string[] } | undefined;
        const sessionIds = body?.sessionIds || [];

        try {
            const result = await archiveTeam(userId, teamId, sessionIds);
            log({ module: 'team-management', teamId }, `Team archived with ${result.archivedSessions} sessions`);
            return reply.send(result);
        } catch (error: any) {
            if (error.message === 'Team not found') {
                return reply.code(404).send({ error: error.message });
            }
            log({ module: 'team-management', level: 'error' }, `Failed to archive team: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // DELETE /v1/teams/:teamId - Delete team and all sessions
    // Note: Client must provide sessionIds since artifact body is encrypted
    app.delete('/v1/teams/:teamId', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            body: z.object({
                sessionIds: z.array(z.string()).optional() // Client provides session IDs
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const body = request.body as { sessionIds?: string[] } | undefined;
        const sessionIds = body?.sessionIds || [];

        try {
            const result = await deleteTeam(userId, teamId, sessionIds);
            log({ module: 'team-management', teamId }, `Team deleted with ${result.deletedSessions} sessions`);
            return reply.send(result);
        } catch (error: any) {
            if (error.message === 'Team not found') {
                return reply.code(404).send({ error: error.message });
            }
            log({ module: 'team-management', level: 'error' }, `Failed to delete team: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // PUT /v1/teams/:teamId/rename - Rename team
    app.put('/v1/teams/:teamId/rename', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            body: z.object({ name: z.string().min(1).max(100) })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const { name } = request.body as { name: string };

        try {
            const result = await renameTeam(userId, teamId, name);
            return reply.send(result);
        } catch (error: any) {
            if (error.message === 'Team not found') {
                return reply.code(404).send({ error: error.message });
            }
            log({ module: 'team-management', level: 'error' }, `Failed to rename team: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // === Batch Session Operations ===

    // POST /v1/sessions/batch/archive - Archive multiple sessions
    app.post('/v1/sessions/batch/archive', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                sessionIds: z.array(z.string()).min(1).max(100)
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionIds } = request.body as { sessionIds: string[] };

        try {
            const result = await batchArchiveSessions(userId, sessionIds);
            return reply.send(result);
        } catch (error: any) {
            log({ module: 'team-management', level: 'error' }, `Failed to batch archive: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // POST /v1/sessions/batch/delete - Delete multiple sessions
    app.post('/v1/sessions/batch/delete', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                sessionIds: z.array(z.string()).min(1).max(100)
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionIds } = request.body as { sessionIds: string[] };

        try {
            const result = await batchDeleteSessions(userId, sessionIds);
            return reply.send(result);
        } catch (error: any) {
            log({ module: 'team-management', level: 'error' }, `Failed to batch delete: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // PUT /v1/sessions/:sessionId/rename - Rename session
    app.put('/v1/sessions/:sessionId/rename', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: z.object({ name: z.string().min(1).max(100) })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params as { sessionId: string };
        const { name } = request.body as { name: string };

        try {
            const result = await renameSession(userId, sessionId, name);
            return reply.send(result);
        } catch (error: any) {
            if (error.message === 'Session not found') {
                return reply.code(404).send({ error: error.message });
            }
            log({ module: 'team-management', level: 'error' }, `Failed to rename session: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // === Batch Team Operations ===

    // POST /v1/teams/batch/archive - Archive multiple teams
    app.post('/v1/teams/batch/archive', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                teamIds: z.array(z.string()).min(1).max(50)
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamIds } = request.body as { teamIds: string[] };

        try {
            const results = [];
            for (const teamId of teamIds) {
                try {
                    const result = await archiveTeam(userId, teamId);
                    results.push({ teamId, ...result });
                } catch (error: any) {
                    results.push({ teamId, success: false, error: error.message });
                }
            }
            return reply.send({
                success: true,
                archived: results.filter(result => result.success).length,
                results,
            });
        } catch (error: any) {
            log({ module: 'team-management', level: 'error' }, `Failed to batch archive teams: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // POST /v1/sessions/batch/unarchive - Restore archived sessions
    app.post('/v1/sessions/batch/unarchive', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                sessionIds: z.array(z.string()).min(1).max(100)
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionIds } = request.body as { sessionIds: string[] };

        try {
            const result = await batchUnarchiveSessions(userId, sessionIds);
            return reply.send(result);
        } catch (error: any) {
            log({ module: 'team-management', level: 'error' }, `Failed to batch unarchive: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // POST /v1/teams/:teamId/unarchive - Restore archived team and its sessions
    app.post('/v1/teams/:teamId/unarchive', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            body: z.object({
                sessionIds: z.array(z.string()).optional()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const body = request.body as { sessionIds?: string[] } | undefined;
        const sessionIds = body?.sessionIds || [];

        try {
            const result = await unarchiveTeam(userId, teamId, sessionIds);
            log({ module: 'team-management', teamId }, `Team unarchived with ${result.restoredSessions} sessions`);
            return reply.send(result);
        } catch (error: any) {
            if (error.message === 'Team not found') {
                return reply.code(404).send({ error: error.message });
            }
            log({ module: 'team-management', level: 'error' }, `Failed to unarchive team: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    // POST /v1/teams/batch/delete - Delete multiple teams
    app.post('/v1/teams/batch/delete', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                teamIds: z.array(z.string()).min(1).max(50)
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamIds } = request.body as { teamIds: string[] };

        try {
            const results = [];
            for (const teamId of teamIds) {
                try {
                    const result = await deleteTeam(userId, teamId);
                    results.push({ teamId, ...result });
                } catch (error: any) {
                    results.push({ teamId, success: false, error: error.message });
                }
            }
            return reply.send({
                success: true,
                deleted: results.filter(result => result.success).length,
                results,
            });
        } catch (error: any) {
            log({ module: 'team-management', level: 'error' }, `Failed to batch delete teams: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });
}

// === Implementation Functions ===

async function addTeamMember(
    userId: string,
    teamId: string,
    memberId: string | undefined,
    sessionId: string,
    sessionTag: string | undefined,
    candidateId: string | undefined,
    roleId: string,
    displayName?: string,
    sourceImageId?: string,
    sourceImageVersion?: number | null,
    specId?: string,
    customPrompt?: string,
    parentSessionId?: string,
    executionPlane?: string,
    runtimeType?: string,
    machineId?: string,
    workspacePath?: string,
    spawnError?: string,
    lifecycle?: AgentLifecycle,
    authorities?: string[],
    teamOverlay?: Record<string, unknown>
): Promise<{ success: boolean; member: any }> {
    const artifact = await getAccessibleTeamArtifact(userId, teamId);

    if (!artifact) {
        throw new Error('Team not found');
    }

    const board = extractTeamBoard(artifact);

    if (!board.team) {
        board.team = { members: [] };
    }
    if (!Array.isArray(board.team.members)) {
        board.team.members = [];
    }

    const imageRef = resolveImageRef({
        sourceImageId,
        sourceImageVersion,
        specId,
    });
    const resolvedCandidateId = resolveCandidateId(imageRef, candidateId);
    const resolvedImageFields = buildImageRefFields(imageRef, { includeLegacyGenome: true, includeLegacySpec: true });
    const normalizedLifecycle = normalizeAgentLifecycle(lifecycle);

    // Check if already exists
    const existing = board.team.members.find((m: any) => {
        if (memberId && m.memberId) {
            return m.memberId === memberId;
        }
        if (sessionTag && m.sessionTag) {
            return m.sessionTag === sessionTag;
        }
        return m.sessionId === sessionId;
    });
    if (existing) {
        const runtimeChanged = runtimeType !== undefined && existing.runtimeType !== runtimeType;
        const shouldClearImageAttribution = runtimeChanged
            && Object.keys(resolvedImageFields).length === 0
            && candidateId === undefined;

        // Only write + broadcast if something actually changed
        const hasChanges =
            existing.sessionId !== sessionId ||
            existing.roleId !== roleId ||
            (memberId !== undefined && existing.memberId !== memberId) ||
            (sessionTag !== undefined && existing.sessionTag !== sessionTag) ||
            (resolvedCandidateId !== undefined && existing.candidateId !== resolvedCandidateId) ||
            (shouldClearImageAttribution && (
                existing.sourceImageId != null
                || existing.sourceImageVersion != null
                || existing.genomeId != null
                || existing.genomeVersion != null
                || existing.specId != null
                || existing.candidateId != null
            )) ||
            (displayName && existing.displayName !== displayName) ||
            Object.entries(resolvedImageFields).some(([key, value]) => existing[key] !== value) ||
            (customPrompt !== undefined && existing.customPrompt !== customPrompt) ||
            (parentSessionId !== undefined && existing.parentSessionId !== parentSessionId) ||
            (executionPlane !== undefined && existing.executionPlane !== executionPlane) ||
            (runtimeType !== undefined && existing.runtimeType !== runtimeType) ||
            (machineId !== undefined && existing.machineId !== machineId) ||
            (workspacePath !== undefined && existing.workspacePath !== workspacePath) ||
            (spawnError !== undefined && existing.spawnError !== spawnError) ||
            (normalizedLifecycle !== null && JSON.stringify(existing.lifecycle ?? null) !== JSON.stringify(normalizedLifecycle)) ||
            (authorities !== undefined && JSON.stringify(existing.authorities ?? []) !== JSON.stringify(authorities)) ||
            (teamOverlay !== undefined && JSON.stringify(existing.teamOverlay ?? null) !== JSON.stringify(teamOverlay));

        if (!hasChanges) {
            return { success: true, member: existing };
        }

        existing.sessionId = sessionId;
        if (memberId !== undefined) existing.memberId = memberId;
        existing.roleId = roleId;
        if (sessionTag !== undefined) existing.sessionTag = sessionTag;
        if (resolvedCandidateId !== undefined) existing.candidateId = resolvedCandidateId;
        existing.displayName = displayName || existing.displayName;
        if (Object.keys(resolvedImageFields).length > 0) {
            Object.assign(existing, resolvedImageFields);
        }
        if (shouldClearImageAttribution) {
            Object.assign(existing, clearImageRefFields({ includeLegacyGenome: true, includeLegacySpec: true }));
            delete existing.candidateId;
        }
        if (customPrompt !== undefined) existing.customPrompt = customPrompt;
        if (parentSessionId !== undefined) existing.parentSessionId = parentSessionId;
        if (executionPlane !== undefined) existing.executionPlane = executionPlane;
        if (runtimeType !== undefined) existing.runtimeType = runtimeType;
        if (machineId !== undefined) existing.machineId = machineId;
        if (workspacePath !== undefined) existing.workspacePath = workspacePath;
        if (spawnError !== undefined) existing.spawnError = spawnError;
        if (normalizedLifecycle !== null) existing.lifecycle = normalizedLifecycle;
        if (authorities !== undefined) existing.authorities = authorities;
        if (teamOverlay !== undefined) existing.teamOverlay = teamOverlay;
    } else {
        board.team.members.push({
            ...(memberId !== undefined && { memberId }),
            sessionId,
            ...(sessionTag !== undefined && { sessionTag }),
            ...(resolvedCandidateId !== undefined && { candidateId: resolvedCandidateId }),
            roleId,
            displayName: displayName || `Agent ${roleId}`,
            focusAreas: [],
            joinedAt: Date.now(),
            ...resolvedImageFields,
            ...(customPrompt !== undefined && { customPrompt }),
            ...(parentSessionId !== undefined && { parentSessionId }),
            ...(executionPlane !== undefined && { executionPlane }),
            ...(runtimeType !== undefined && { runtimeType }),
            ...(machineId !== undefined && { machineId }),
            ...(workspacePath !== undefined && { workspacePath }),
            ...(spawnError !== undefined && { spawnError }),
            ...(normalizedLifecycle !== null && { lifecycle: normalizedLifecycle }),
            ...(authorities !== undefined && { authorities }),
            ...(teamOverlay !== undefined && { teamOverlay })
        });
    }

    // Re-wrap in the same structure for storage
    await db.artifact.update({
        where: { id: teamId },
        data: {
            body: serializeTeamBoard(board),
            bodyVersion: { increment: 1 },
            updatedAt: new Date()
        }
    });

    // Broadcast update
    await broadcastTeamUpdate(userId, teamId, 'member-added', { sessionId, roleId });
    await invalidateTeamOverviewSnapshot(userId);

    return {
        success: true,
        member: existing || board.team.members[board.team.members.length - 1]
    };
}

async function removeTeamMember(
    userId: string,
    teamId: string,
    sessionId: string
): Promise<{ success: boolean }> {
    const artifact = await getAccessibleTeamArtifact(userId, teamId);

    if (!artifact) {
        throw new Error('Team not found');
    }

    const board = extractTeamBoard(artifact);

    if (!board.team?.members) {
        return { success: true };
    }

    board.team.members = board.team.members.filter((m: any) => m.sessionId !== sessionId);

    // Re-wrap in the same structure for storage
    await db.artifact.update({
        where: { id: teamId },
        data: {
            body: serializeTeamBoard(board),
            bodyVersion: { increment: 1 },
            updatedAt: new Date()
        }
    });

    // Broadcast update
    await broadcastTeamUpdate(userId, teamId, 'member-removed', { sessionId });
    await invalidateTeamOverviewSnapshot(userId);

    return { success: true };
}

async function archiveTeam(
    userId: string,
    teamId: string,
    sessionIds: string[] = []
): Promise<{ success: boolean; archivedSessions: number }> {
    const artifact = await getAccessibleTeamArtifact(userId, teamId);

    if (!artifact) {
        throw new Error('Team not found');
    }

    const board = extractTeamBoard(artifact);
    const managedSessionIds = Array.from(new Set([
        ...extractTeamMembers(board)
            .map((member) => member.sessionId)
            .filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.length > 0),
        ...sessionIds,
    ]));

    let archivedCount = 0;
    if (managedSessionIds.length > 0) {
        const result = await db.session.updateMany({
            where: {
                id: { in: managedSessionIds },
                accountId: userId
            },
            data: {
                active: false,
                updatedAt: new Date()
            }
        });
        archivedCount = result.count;
        managedSessionIds.forEach((sessionId) => activityCache.invalidateSession(sessionId));
    }

    const archivedAt = Date.now();
    board.archivedAt = archivedAt;
    if (!board.team || typeof board.team !== 'object') {
        board.team = { members: [] };
    }
    board.team.archivedAt = archivedAt;

    await db.artifact.update({
        where: { id: teamId },
        data: {
            body: serializeTeamBoard(board),
            bodyVersion: { increment: 1 },
            updatedAt: new Date()
        }
    });

    // Broadcast archive events for each session
    for (const sessionId of managedSessionIds) {
        await broadcastSessionUpdate(userId, sessionId, 'session-archived');
    }

    await broadcastTeamUpdate(userId, teamId, 'team-archived', { archivedSessions: archivedCount });
    await invalidateTeamOverviewSnapshot(userId);

    return { success: true, archivedSessions: archivedCount };
}

async function deleteTeam(
    userId: string,
    teamId: string,
    sessionIds: string[] = []
): Promise<{ success: boolean; deletedSessions: number }> {
    const artifact = await getAccessibleTeamArtifact(userId, teamId, { includeArchived: true });

    if (!artifact) {
        throw new Error('Team not found');
    }

    const board = extractTeamBoard(artifact);
    const managedSessionIds = Array.from(new Set([
        ...extractTeamMembers(board)
            .map((member) => member.sessionId)
            .filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.length > 0),
        ...sessionIds,
    ]));

    let deletedCount = 0;
    await db.$transaction(async (tx) => {
        if (managedSessionIds.length > 0) {
            await tx.sessionMessage.deleteMany({
                where: { sessionId: { in: managedSessionIds } }
            });
            await tx.usageReport.deleteMany({
                where: { sessionId: { in: managedSessionIds } }
            });
            await tx.accessKey.deleteMany({
                where: { sessionId: { in: managedSessionIds } }
            });
            const result = await tx.session.deleteMany({
                where: {
                    id: { in: managedSessionIds },
                    accountId: userId
                }
            });
            deletedCount = result.count;
        }

        await tx.teamContextEntry.deleteMany({
            where: {
                accountId: userId,
                teamId,
            },
        });

        // Delete team artifact last, after dependent team-scoped data is gone.
        await tx.artifact.delete({
            where: { id: teamId }
        });
    });

    managedSessionIds.forEach((sessionId) => activityCache.invalidateSession(sessionId));

    // Broadcast delete events
    for (const sessionId of managedSessionIds) {
        await broadcastSessionUpdate(userId, sessionId, 'session-deleted');
    }

    await broadcastTeamUpdate(userId, teamId, 'team-deleted', { deletedSessions: deletedCount });
    await invalidateTeamOverviewSnapshot(userId);

    return { success: true, deletedSessions: deletedCount };
}

async function renameTeam(
    userId: string,
    teamId: string,
    name: string
): Promise<{ success: boolean; team: { id: string; name: string } }> {
    const artifact = await getAccessibleTeamArtifact(userId, teamId);

    if (!artifact) {
        throw new Error('Team not found');
    }

    const board = extractTeamBoard(artifact);

    board.name = name;
    if (board.team) {
        board.team.name = name;
    }

    await db.artifact.update({
        where: { id: teamId },
        data: {
            body: serializeTeamBoard(board),
            bodyVersion: { increment: 1 },
            updatedAt: new Date()
        }
    });

    await broadcastTeamUpdate(userId, teamId, 'team-renamed', { name });
    await invalidateTeamOverviewSnapshot(userId);

    return {
        success: true,
        team: {
            id: teamId,
            name,
        },
    };
}

async function batchArchiveSessions(
    userId: string,
    sessionIds: string[]
): Promise<{ success: boolean; archived: number; results: Array<{ sessionId: string; success: boolean; error?: string }> }> {
    const ownedSessions = await db.session.findMany({
        where: {
            id: { in: sessionIds },
            accountId: userId,
        },
        select: { id: true },
    });

    const ownedSessionIds = new Set(ownedSessions.map(session => session.id));
    const archivableIds = [...ownedSessionIds];

    if (archivableIds.length > 0) {
        await db.session.updateMany({
            where: {
                id: { in: archivableIds },
                accountId: userId
            },
            data: {
                active: false,
                updatedAt: new Date()
            }
        });
        archivableIds.forEach((sessionId) => activityCache.invalidateSession(sessionId));

        // Remove archived sessions from all team member rosters so the kanban
        // frontend stops displaying them as offline members indefinitely.
        const archivableSet = new Set(archivableIds);
        const teamArtifacts = await listAccessibleTeamArtifacts(userId);
        for (const artifact of teamArtifacts) {
            const board = extractTeamBoard(artifact);
            const members = extractTeamMembers(board);
            const filteredMembers = members.filter(m => !archivableSet.has(m.sessionId));
            if (filteredMembers.length !== members.length) {
                if (!board.team) {
                    board.team = {};
                }
                board.team.members = filteredMembers;
                await db.artifact.update({
                    where: { id: artifact.id },
                    data: {
                        body: serializeTeamBoard(board),
                        bodyVersion: { increment: 1 },
                        updatedAt: new Date(),
                    },
                });
                const removedIds = archivableIds.filter(sid => members.some(m => m.sessionId === sid));
                await broadcastTeamUpdate(userId, artifact.id, 'member-removed', { sessionIds: removedIds });
                await invalidateTeamOverviewSnapshot(userId);
            }
        }
    }

    for (const sessionId of archivableIds) {
        await broadcastSessionUpdate(userId, sessionId, 'session-archived');
    }

    return {
        success: true,
        archived: archivableIds.length,
        results: sessionIds.map(sessionId => ownedSessionIds.has(sessionId)
            ? { sessionId, success: true }
            : { sessionId, success: false, error: 'Session not found or not owned by user' }),
    };
}

async function batchUnarchiveSessions(
    userId: string,
    sessionIds: string[]
): Promise<{ success: boolean; restored: number; results: Array<{ sessionId: string; success: boolean; error?: string }> }> {
    const ownedSessions = await db.session.findMany({
        where: {
            id: { in: sessionIds },
            accountId: userId,
        },
        select: { id: true },
    });

    const ownedSessionIds = new Set(ownedSessions.map(session => session.id));
    const restorableIds = [...ownedSessionIds];

    if (restorableIds.length > 0) {
        await db.session.updateMany({
            where: {
                id: { in: restorableIds },
                accountId: userId
            },
            data: {
                active: true,
                updatedAt: new Date()
            }
        });
        restorableIds.forEach((sessionId) => activityCache.invalidateSession(sessionId));
    }

    for (const sessionId of restorableIds) {
        await broadcastSessionUpdate(userId, sessionId, 'session-unarchived');
    }

    return {
        success: true,
        restored: restorableIds.length,
        results: sessionIds.map(sessionId => ownedSessionIds.has(sessionId)
            ? { sessionId, success: true }
            : { sessionId, success: false, error: 'Session not found or not owned by user' }),
    };
}

async function unarchiveTeam(
    userId: string,
    teamId: string,
    sessionIds: string[] = []
): Promise<{ success: boolean; restoredSessions: number }> {
    const artifact = await getAccessibleTeamArtifact(userId, teamId, { includeArchived: true });

    if (!artifact) {
        throw new Error('Team not found');
    }

    const board = extractTeamBoard(artifact);
    const managedSessionIds = Array.from(new Set([
        ...extractTeamMembers(board)
            .map((member) => member.sessionId)
            .filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.length > 0),
        ...sessionIds,
    ]));

    let restoredCount = 0;
    if (managedSessionIds.length > 0) {
        const result = await db.session.updateMany({
            where: {
                id: { in: managedSessionIds },
                accountId: userId
            },
            data: {
                active: true,
                updatedAt: new Date()
            }
        });
        restoredCount = result.count;
        managedSessionIds.forEach((sessionId) => activityCache.invalidateSession(sessionId));
    }

    delete board.archivedAt;
    if (board.team && typeof board.team === 'object') {
        delete board.team.archivedAt;
    }

    await db.artifact.update({
        where: { id: teamId },
        data: {
            body: serializeTeamBoard(board),
            bodyVersion: { increment: 1 },
            updatedAt: new Date()
        }
    });

    for (const sessionId of managedSessionIds) {
        await broadcastSessionUpdate(userId, sessionId, 'session-unarchived');
    }

    await broadcastTeamUpdate(userId, teamId, 'team-unarchived', { restoredSessions: restoredCount });
    await invalidateTeamOverviewSnapshot(userId);

    return { success: true, restoredSessions: restoredCount };
}

async function batchDeleteSessions(
    userId: string,
    sessionIds: string[]
): Promise<{ success: boolean; deleted: number; results: Array<{ sessionId: string; success: boolean; error?: string }> }> {
    const ownedSessions = await db.session.findMany({
        where: {
            id: { in: sessionIds },
            accountId: userId,
        },
        select: { id: true },
    });

    const ownedSessionIds = new Set(ownedSessions.map(session => session.id));
    const deletableIds = [...ownedSessionIds];

    if (deletableIds.length > 0) {
        await db.sessionMessage.deleteMany({
            where: { sessionId: { in: deletableIds } }
        });
        await db.usageReport.deleteMany({
            where: { sessionId: { in: deletableIds } }
        });
        await db.accessKey.deleteMany({
            where: { sessionId: { in: deletableIds } }
        });
        await db.session.deleteMany({
            where: {
                id: { in: deletableIds },
                accountId: userId
            }
        });
        deletableIds.forEach((sessionId) => activityCache.invalidateSession(sessionId));
    }

    for (const sessionId of deletableIds) {
        await broadcastSessionUpdate(userId, sessionId, 'session-deleted');
    }

    return {
        success: true,
        deleted: deletableIds.length,
        results: sessionIds.map(sessionId => ownedSessionIds.has(sessionId)
            ? { sessionId, success: true }
            : { sessionId, success: false, error: 'Session not found or not owned by user' }),
    };
}

async function renameSession(
    userId: string,
    sessionId: string,
    name: string
): Promise<{ success: boolean; session: { id: string; name: string } }> {
    // Get session
    const session = await db.session.findFirst({
        where: { id: sessionId, accountId: userId }
    });

    if (!session) {
        throw new Error('Session not found');
    }

    let nextMetadata = session.metadata;

    try {
        const parsed = JSON.parse(session.metadata);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            nextMetadata = JSON.stringify({
                ...parsed,
                name,
            });
        }
    } catch {
        // Leave existing metadata unchanged when it is not JSON.
    }

    if (nextMetadata !== session.metadata) {
        await db.session.update({
            where: { id: sessionId },
            data: {
                metadata: nextMetadata,
                metadataVersion: { increment: 1 },
                updatedAt: new Date(),
            },
        });
    }

    await broadcastSessionUpdate(userId, sessionId, 'session-renamed', { name });

    return {
        success: true,
        session: {
            id: sessionId,
            name,
        },
    };
}

// === Broadcast Helpers ===

async function broadcastTeamUpdate(
    userId: string,
    teamId: string,
    eventType: string,
    details: any
): Promise<void> {
    const updSeq = await allocateUserSeq(userId);

    eventRouter.emitUpdate({
        userId,
        payload: {
            id: randomKeyNaked(12),
            seq: updSeq,
            body: {
                t: 'team-update' as any,
                teamId,
                eventType,
                details
            },
            createdAt: Date.now()
        },
        recipientFilter: { type: 'all-user-authenticated-connections' }
    });
}

async function broadcastSessionUpdate(
    userId: string,
    sessionId: string,
    eventType: string,
    details?: any
): Promise<void> {
    const updSeq = await allocateUserSeq(userId);

    eventRouter.emitUpdate({
        userId,
        payload: {
            id: randomKeyNaked(12),
            seq: updSeq,
            body: {
                t: 'session-update' as any,
                sessionId,
                eventType,
                details
            },
            createdAt: Date.now()
        },
        recipientFilter: { type: 'all-user-authenticated-connections' }
    });
}
