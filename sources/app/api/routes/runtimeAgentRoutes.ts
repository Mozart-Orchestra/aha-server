import { Fastify } from "../types";
import { z } from "zod";
import { log } from "@/utils/log";
import { db } from "@/storage/db";
import crypto from "node:crypto";
import { sendDaemonControl } from "@/app/api/socket/daemonControlRegistry";
import { getMetaActionContext } from "../utils/enablePermissionInterceptor";
import { emitAgentSpawnSystemMessage, emitBypassSpawnSystemMessage, emitBypassCompleteSystemMessage, emitBypassRecommendationSystemMessage } from "@/app/team/teamSystemMessage";
import { RolePermissionService } from "@/services/rolePermissionService";

/**
 * R6: Runtime Agent Management Routes
 *
 * Server-driven agent lifecycle management:
 * - Spawn agents via daemon control
 * - Stop/pause/resume agents
 * - List agents with status
 * - Track metrics (tokens, CPU, memory)
 */

const MAX_AGENTS_PER_TEAM = 10;
const MAX_AGENTS_PER_MACHINE = 5;

type AgentStatus = 'spawning' | 'running' | 'paused' | 'stopping' | 'stopped' | 'error';
type AgentMode = 'claude' | 'codex' | 'ralph';
type ExecutionPlane = 'mainline' | 'bypass';
type BypassTrigger = 'init' | 'periodic' | 'event' | 'manual';
type BypassProfile = 'org-manager' | 'evolution-bypass' | 'help-agent' | 'custom';
type OneShotBypassProfile = 'audit' | 'init' | 'repair';

interface BypassSpec {
    trigger: BypassTrigger;
    profile: BypassProfile;
    prompt: string;
    readAccess: string[];
    writeAccess: string[];
    autoTerminate: boolean;
    ttlMinutes: number;
}

interface RuntimeState {
    status: AgentStatus;
    currentTaskId: string | null;
    tokenUsed: number;
    cpuPercent: number;
    memoryMb: number;
    lastHeartbeatAt: string;
    error?: string;
}
const runtimeState = new Map<string, RuntimeState>();
const runtimeRolePermissionService = new RolePermissionService();

function normalizeRoleLookupToken(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[_/]+/g, ' ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-+/g, '-');
}

function buildRoleLookupAliases(value: string | undefined): string[] {
    if (!value || !value.trim()) {
        return [];
    }

    const trimmed = value.trim();
    const aliases = new Set<string>();
    const addAlias = (candidate: string | undefined) => {
        if (!candidate || !candidate.trim()) {
            return;
        }
        const normalized = normalizeRoleLookupToken(candidate);
        if (normalized) {
            aliases.add(normalized);
        }
    };

    addAlias(trimmed);
    addAlias(trimmed.split('/')[0]);

    const words = trimmed
        .split(/[\s/]+/)
        .map((part) => part.trim())
        .filter(Boolean);

    addAlias(words[0]);

    const acronym = words.map((word) => word[0]).join('');
    if (acronym.length > 1) {
        addAlias(acronym);
    }

    return Array.from(aliases);
}

const runtimeRoleAliasToId = (() => {
    const aliases = new Map<string, string>();
    const addAlias = (alias: string, roleId: string) => {
        if (!alias || aliases.has(alias)) {
            return;
        }
        aliases.set(alias, roleId);
    };

    for (const roleId of runtimeRolePermissionService.getAvailableRoles()) {
        const definition = runtimeRolePermissionService.getRoleDefinition(roleId) as ({ name?: string; title?: string } | undefined);
        for (const candidate of [roleId, definition?.name, definition?.title]) {
            for (const alias of buildRoleLookupAliases(candidate)) {
                addAlias(alias, roleId);
            }
        }
    }

    return aliases;
})();

function resolveCanonicalRuntimeRoleId(...candidates: Array<string | undefined>): string | undefined {
    for (const candidate of candidates) {
        for (const alias of buildRoleLookupAliases(candidate)) {
            const resolved = runtimeRoleAliasToId.get(alias);
            if (resolved) {
                return resolved;
            }
        }
    }

    return undefined;
}

function toDate(value: Date | string | null | undefined, fallback: Date = new Date()): Date {
    if (value instanceof Date) {
        return value;
    }

    if (typeof value === 'string' && value.trim()) {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) {
            return parsed;
        }
    }

    return fallback;
}

function toIsoString(value: Date | string | null | undefined, fallback: Date = new Date()): string {
    return toDate(value, fallback).toISOString();
}

function toRuntimeStateSnapshot(source: {
    status: AgentStatus;
    currentTaskId?: string | null;
    tokenUsed?: number | null;
    cpuPercent?: number | null;
    memoryMb?: number | null;
    lastHeartbeatAt?: Date | string | null;
    error?: string | null;
}): RuntimeState {
    const lastHeartbeat = toDate(source.lastHeartbeatAt);

    return {
        status: source.status,
        currentTaskId: source.currentTaskId ?? null,
        tokenUsed: source.tokenUsed ?? 0,
        cpuPercent: source.cpuPercent ?? 0,
        memoryMb: source.memoryMb ?? 0,
        lastHeartbeatAt: lastHeartbeat.toISOString(),
        ...(source.error ? { error: source.error } : {}),
    };
}

async function upsertRuntimeAgentRecord(input: {
    sessionId: string;
    teamId: string;
    accountId: string;
    roleId: string;
    mode: AgentMode;
    machineId: string;
    displayName?: string | null;
    status: AgentStatus;
    currentTaskId?: string | null;
    tokenUsed?: number;
    cpuPercent?: number;
    memoryMb?: number;
    error?: string | null;
    rootPathHash?: string | null;
    spawnedAt?: Date | string;
    lastHeartbeatAt?: Date | string;
    stoppedAt?: Date | string | null;
}) {
    const spawnedAt = toDate(input.spawnedAt);
    const lastHeartbeatAt = toDate(input.lastHeartbeatAt, spawnedAt);
    const createData = {
        sessionId: input.sessionId,
        teamId: input.teamId,
        accountId: input.accountId,
        roleId: input.roleId,
        mode: input.mode,
        machineId: input.machineId,
        displayName: input.displayName ?? null,
        status: input.status,
        currentTaskId: input.currentTaskId ?? null,
        tokenUsed: input.tokenUsed ?? 0,
        cpuPercent: input.cpuPercent ?? 0,
        memoryMb: input.memoryMb ?? 0,
        error: input.error ?? null,
        rootPath: input.rootPathHash ?? null,
        spawnedAt,
        lastHeartbeatAt,
        stoppedAt: input.stoppedAt === undefined ? null : (input.stoppedAt === null ? null : toDate(input.stoppedAt, lastHeartbeatAt)),
    };
    const updateData: Record<string, unknown> = {
        teamId: input.teamId,
        accountId: input.accountId,
        roleId: input.roleId,
        mode: input.mode,
        machineId: input.machineId,
        status: input.status,
        lastHeartbeatAt,
    };

    if (input.displayName !== undefined) {
        updateData.displayName = input.displayName ?? null;
    }
    if (input.currentTaskId !== undefined) {
        updateData.currentTaskId = input.currentTaskId ?? null;
    }
    if (input.tokenUsed !== undefined) {
        updateData.tokenUsed = input.tokenUsed;
    }
    if (input.cpuPercent !== undefined) {
        updateData.cpuPercent = input.cpuPercent;
    }
    if (input.memoryMb !== undefined) {
        updateData.memoryMb = input.memoryMb;
    }
    if (input.error !== undefined) {
        updateData.error = input.error ?? null;
    }
    if (input.rootPathHash !== undefined) {
        updateData.rootPath = input.rootPathHash ?? null;
    }
    if (input.spawnedAt !== undefined) {
        updateData.spawnedAt = spawnedAt;
    }
    if (input.stoppedAt !== undefined) {
        updateData.stoppedAt = input.stoppedAt === null ? null : toDate(input.stoppedAt, lastHeartbeatAt);
    }

    await db.runtimeAgent.upsert({
        where: { sessionId: input.sessionId },
        create: createData,
        update: updateData,
    });
}

function getDaemonControlPayload(result: { ok: boolean; result?: unknown; error?: string }): Record<string, unknown> | null {
    if (!result.result || typeof result.result !== 'object') {
        return null;
    }

    return result.result as Record<string, unknown>;
}

function getDaemonControlError(result: { ok: boolean; result?: unknown; error?: string }): string {
    if (result.error) {
        return result.error;
    }

    const payload = getDaemonControlPayload(result);
    if (typeof payload?.error === 'string' && payload.error.trim()) {
        return payload.error;
    }

    return 'Daemon control request failed';
}

function resolveAgentStatusCallbackUrl(request: { protocol: string; headers: Record<string, unknown> }): string {
    const configuredServerUrl = process.env.SERVER_URL?.trim();
    if (configuredServerUrl) {
        return new URL('/v1/agent-status', configuredServerUrl).toString();
    }

    const hostHeader = request.headers.host;
    const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
    if (typeof host === 'string' && host.trim()) {
        return `${request.protocol}://${host}/v1/agent-status`;
    }

    return 'http://127.0.0.1:3005/v1/agent-status';
}

/**
 * Hash a path for storage (privacy)
 */
async function hashPath(path: string): Promise<string> {
    return crypto.createHash('sha256').update(path).digest('hex');
}

/**
 * Get default machine for a user
 */
async function getDefaultMachineId(userId: string): Promise<string | null> {
    const machine = await db.machine.findFirst({
        where: { accountId: userId, active: true },
        orderBy: { lastActiveAt: 'desc' }
    });
    return machine?.id || null;
}

export function runtimeAgentRoutes(app: Fastify) {
    log({ module: 'api' }, 'Registering runtimeAgentRoutes...');

    const AgentStatusUpdateSchema = z.object({
        sessionId: z.string(),
        status: z.enum(['spawning', 'running', 'paused', 'stopping', 'stopped', 'error']),
        teamId: z.string().optional(),
        error: z.string().optional(),
        timestamp: z.number().int().optional(),
        bypassResult: z.object({
            fitnessScore: z.number().min(0).max(100).optional(),
            summary: z.string().optional(),
            recommendation: z.string().optional(),
            targetAgent: z.string().optional(),
        }).optional(),
        metrics: z.object({
            tokenUsed: z.number().int().min(0).optional(),
            cpuPercent: z.number().min(0).max(100).optional(),
            memoryMb: z.number().int().min(0).optional(),
        }).optional(),
    });

    // === GET /v1/teams/:teamId/agents - List all agents ===

    app.get('/v1/teams/:teamId/agents', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            querystring: z.object({
                active: z.boolean().optional(),
                mode: z.string().optional(),
                roleId: z.string().optional()
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const query = request.query as { active?: boolean; mode?: string; roleId?: string } | undefined;

        try {
            // Get team composition to find associated session IDs
            const team = await db.team.findFirst({
                where: { id: teamId, accountId: userId },
                include: {
                    members: {
                        include: {
                            session: true
                        }
                    }
                }
            });

            if (!team) {
                return reply.code(404).send({
                    error: 'team_not_found',
                    message: 'Team not found'
                });
            }

            const persistedAgents = await db.runtimeAgent.findMany({
                where: { teamId, accountId: userId }
            });
            const persistedBySessionId = new Map(
                persistedAgents.map((agent) => [agent.sessionId, agent])
            );

            // Build agent list from sessions with runtime state overlay
            const agents = [];
            for (const member of team.members) {
                const session = member.session;
                if (!session) continue;

                // Apply filters
                if (query?.mode && session.mode !== query.mode) continue;
                if (query?.roleId && session.roleId !== query.roleId) continue;

                const persistedAgent = persistedBySessionId.get(session.id);
                const runtime = runtimeState.get(session.id)
                    ?? (persistedAgent ? toRuntimeStateSnapshot(persistedAgent) : undefined);
                const status = runtime?.status === 'spawning' && session.active && !runtime?.error
                    ? 'running'
                    : (runtime?.status ?? (session.active ? 'running' : 'stopped'));

                if (query?.active !== undefined) {
                    const isActive = status === 'running' || status === 'spawning' || status === 'paused';
                    if (query.active !== isActive) continue;
                }

                agents.push({
                    sessionId: session.id,
                    roleId: session.roleId,
                    displayName: session.displayName,
                    mode: session.mode,
                    status,
                    machineId: session.machineId,
                    currentTaskId: runtime?.currentTaskId ?? null,
                    tokenUsed: runtime?.tokenUsed ?? 0,
                    cpuPercent: runtime?.cpuPercent ?? 0,
                    memoryMb: runtime?.memoryMb ?? 0,
                    error: runtime?.error ?? persistedAgent?.error ?? null,
                    spawnedAt: persistedAgent?.spawnedAt?.toISOString?.() ?? session.createdAt.toISOString(),
                    lastHeartbeatAt: runtime?.lastHeartbeatAt ?? toIsoString(persistedAgent?.lastHeartbeatAt, session.lastActiveAt)
                });
            }

            const summary = {
                total: agents.length,
                spawning: agents.filter((a: { status: string }) => a.status === 'spawning').length,
                running: agents.filter((a: { status: string }) => a.status === 'running').length,
                paused: agents.filter((a: { status: string }) => a.status === 'paused').length,
                stopped: agents.filter((a: { status: string }) => a.status === 'stopped' || a.status === 'stopping').length,
                error: agents.filter((a: { status: string }) => a.status === 'error').length,
            };

            return reply.send({ agents, summary });
        } catch (error: any) {
            log({ module: 'runtime-agents', level: 'error' }, `Failed to list agents: ${error}`);
            return reply.code(500).send({ error: 'internal_error', message: error.message });
        }
    });

    // === POST /v1/teams/:teamId/agents/spawn - Spawn new agent ===

    app.post('/v1/teams/:teamId/agents/spawn', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            body: z.object({
                roleId: z.string(),
                mode: z.enum(['claude', 'codex', 'ralph']),
                machineId: z.string().optional(),
                rootPath: z.string().optional(),
                displayName: z.string().optional(),
                count: z.number().int().min(1).max(10).optional().default(1),
                executionPlane: z.enum(['mainline', 'bypass']).optional().default('mainline'),
                bypass: z.object({
                    trigger: z.enum(['init', 'periodic', 'event', 'manual']),
                    profile: z.enum(['org-manager', 'evolution-bypass', 'help-agent', 'custom']).optional().default('custom'),
                    prompt: z.string().min(1),
                    readAccess: z.array(z.string()).optional().default([]),
                    writeAccess: z.array(z.string()).optional().default([]),
                    autoTerminate: z.boolean().optional(),
                    ttlMinutes: z.number().int().min(1).max(1440).optional(),
                }).optional(),
                // One-shot bypass shorthand fields (F-023)
                oneShotBypass: z.boolean().optional(),
                bypassProfile: z.enum(['audit', 'init', 'repair']).optional(),
                autoTerminate: z.boolean().optional(),
                bypassPrompt: z.string().optional(),
                genomeId: z.string().optional(),
                taskProfile: z.object({
                    domain: z.array(z.string()),
                    stage: z.string(),
                    risk: z.string().optional(),
                    constraints: z.array(z.string()).optional(),
                }).optional(),
                parentSessionId: z.string().optional(),
            }).superRefine((value, ctx) => {
                if (value.executionPlane === 'bypass' && !value.bypass && !value.oneShotBypass) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        path: ['bypass'],
                        message: 'bypass spec is required when executionPlane is bypass',
                    });
                }
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const {
            roleId, mode, machineId, rootPath, displayName, count, executionPlane, bypass,
            oneShotBypass, bypassProfile: oneShotProfile, autoTerminate: oneShotAutoTerminate, bypassPrompt,
            genomeId, taskProfile, parentSessionId,
        } = request.body as {
            roleId: string;
            mode: AgentMode;
            machineId?: string;
            rootPath?: string;
            displayName?: string;
            count?: number;
            executionPlane?: ExecutionPlane;
            bypass?: {
                trigger: BypassTrigger;
                profile?: BypassProfile;
                prompt: string;
                readAccess?: string[];
                writeAccess?: string[];
                autoTerminate?: boolean;
                ttlMinutes?: number;
            };
            oneShotBypass?: boolean;
            bypassProfile?: OneShotBypassProfile;
            autoTerminate?: boolean;
            bypassPrompt?: string;
            genomeId?: string;
            taskProfile?: { domain: string[]; stage: string; risk?: string; constraints?: string[] };
            parentSessionId?: string;
        };

        // F-023: one-shot bypass shorthand — synthesize a full bypass spec
        const isOneShotBypass = oneShotBypass === true;
        const resolvedExecutionPlane: ExecutionPlane = isOneShotBypass
            ? 'bypass'
            : (executionPlane ?? 'mainline');
        const resolvedBypass = isOneShotBypass && !bypass
            ? {
                trigger: 'manual' as BypassTrigger,
                profile: 'custom' as BypassProfile,
                prompt: bypassPrompt ?? `Run ${oneShotProfile ?? 'audit'} bypass task.`,
                readAccess: [] as string[],
                writeAccess: [] as string[],
                autoTerminate: oneShotAutoTerminate ?? true,
                ttlMinutes: 10,
            }
            : bypass;
        const oneShotMeta: { bypass: true; profile: OneShotBypassProfile; autoTerminate: boolean; bypassPrompt?: string } | undefined = isOneShotBypass
            ? {
                bypass: true as const,
                profile: oneShotProfile ?? 'audit',
                autoTerminate: oneShotAutoTerminate ?? true,
                ...(bypassPrompt ? { bypassPrompt } : {}),
            }
            : undefined;
        const normalizedExecutionPlane: ExecutionPlane = resolvedExecutionPlane;
        const normalizedBypass: BypassSpec | undefined = normalizedExecutionPlane === 'bypass'
            ? {
                trigger: resolvedBypass?.trigger ?? 'manual',
                profile: resolvedBypass?.profile ?? 'custom',
                prompt: resolvedBypass?.prompt ?? '',
                readAccess: resolvedBypass?.readAccess ?? [],
                writeAccess: resolvedBypass?.writeAccess ?? [],
                autoTerminate: resolvedBypass?.autoTerminate ?? true,
                ttlMinutes: resolvedBypass?.ttlMinutes ?? 10,
            }
            : undefined;
        const buildMeta = (payload: Record<string, unknown>) => {
            const meta = getMetaActionContext(request, {
                teamId,
                roleId,
                executionPlane: normalizedExecutionPlane,
                ...(machineId ? { requestedMachineId: machineId } : {}),
                ...(normalizedBypass ? { bypassProfile: normalizedBypass.profile } : {}),
                ...(oneShotMeta ? { oneShot: oneShotMeta } : {}),
                ...payload,
            });

            return meta ? { meta } : {};
        };

        try {
            // Verify team exists and user has access
            const team = await db.team.findFirst({
                where: { id: teamId, accountId: userId },
                include: {
                    members: true,
                    _count: {
                        select: { members: true }
                    }
                }
            });

            if (!team) {
                return reply.code(404).send({
                    error: 'team_not_found',
                    message: 'Team not found',
                    ...buildMeta({})
                });
            }

            const availableRoles = await db.teamRole.findMany({
                where: { teamId },
                select: { id: true, name: true },
            });
            const requestedRuntimeRoleId = resolveCanonicalRuntimeRoleId(roleId);
            const roleExists = availableRoles.find((role) => {
                if (role.id === roleId || role.name === roleId) {
                    return true;
                }

                if (!requestedRuntimeRoleId) {
                    return false;
                }

                return resolveCanonicalRuntimeRoleId(role.id, role.name) === requestedRuntimeRoleId;
            });

            if (!roleExists) {
                log({
                    module: 'runtime-agents',
                    level: 'warn',
                    teamId,
                    requestedRole: roleId,
                    requestedRuntimeRoleId: requestedRuntimeRoleId ?? null,
                    availableRoleIds: availableRoles.map((role) => role.id),
                    availableRoleNames: availableRoles.map((role) => role.name),
                }, 'Rejected runtime agent spawn because requested role could not be resolved');
                return reply.code(400).send({
                    error: 'invalid_role',
                    message: 'Role not found in team',
                    ...buildMeta({})
                });
            }
            const resolvedRuntimeRoleId = resolveCanonicalRuntimeRoleId(roleId, roleExists.name, roleExists.id) || roleId;

            if (roleExists.id !== roleId || resolvedRuntimeRoleId !== roleId) {
                log({
                    module: 'runtime-agents',
                    teamId,
                    requestedRole: roleId,
                    matchedRoleId: roleExists.id,
                    matchedRoleName: roleExists.name,
                    resolvedRuntimeRoleId,
                }, 'Resolved runtime agent spawn role');
            }

            // Check spawn limit
            const currentCount = team._count.members;
            if (currentCount + (count || 1) > MAX_AGENTS_PER_TEAM) {
                return reply.code(429).send({
                    error: 'spawn_limit_exceeded',
                    message: 'Maximum agents per team reached',
                    limit: MAX_AGENTS_PER_TEAM,
                    current: currentCount,
                    ...buildMeta({})
                });
            }

            // Verify machine exists and is online
            const targetMachineId = machineId || await getDefaultMachineId(userId);
            if (!targetMachineId) {
                return reply.code(400).send({
                    error: 'machine_offline',
                    message: 'No machine available for spawning agent',
                    ...buildMeta({})
                });
            }

            const machine = await db.machine.findFirst({
                where: { id: targetMachineId, accountId: userId }
            });
            if (!machine) {
                return reply.code(400).send({
                    error: 'machine_offline',
                    message: 'Target machine not found',
                    ...buildMeta({ machineId: targetMachineId })
                });
            }

            const machineSessionCount = await db.session.findMany({
                where: {
                    accountId: userId,
                    machineId: targetMachineId,
                    active: true
                },
                select: { id: true }
            });

            if (machineSessionCount.length + (count || 1) > MAX_AGENTS_PER_MACHINE) {
                return reply.code(429).send({
                    error: 'machine_capacity_exceeded',
                    message: 'Maximum active agents per machine reached',
                    limit: MAX_AGENTS_PER_MACHINE,
                    current: machineSessionCount.length,
                    ...buildMeta({ machineId: targetMachineId })
                });
            }

            // Generate sessions
            const sessions: Array<{
                sessionId: string;
                roleId: string;
                mode: string;
                machineId: string;
                status: string;
                error?: string;
                executionPlane?: ExecutionPlane;
                bypass?: Pick<BypassSpec, 'trigger' | 'profile' | 'autoTerminate' | 'ttlMinutes'>;
                oneShot?: { bypass: true; profile: OneShotBypassProfile; autoTerminate: boolean; bypassPrompt?: string };
            }> = [];
            const failedSessions: Array<{
                sessionId: string;
                error: string;
                directory?: string;
            }> = [];

            const nowDate = new Date();
            const now = nowDate.toISOString();
            const callbackUrl = resolveAgentStatusCallbackUrl(request as { protocol: string; headers: Record<string, unknown> });

            for (let i = 0; i < (count || 1); i++) {
                const sessionTag = `team-${teamId}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
                const effectiveDisplayName = displayName || `${mode}-${roleId}`;
                const rootPathHash = rootPath ? await hashPath(rootPath) : null;

                // Create session in database with R3 fields
                const session = await db.session.create({
                    data: {
                        tag: sessionTag,
                        accountId: userId,
                        metadata: JSON.stringify({
                            teamId,
                            roleId: resolvedRuntimeRoleId,
                            spawnedForTeam: normalizedExecutionPlane === 'mainline',
                            executionPlane: normalizedExecutionPlane,
                            ...(normalizedBypass ? { bypass: normalizedBypass } : {}),
                            ...(oneShotMeta ? { oneShot: oneShotMeta } : {}),
                            ...(genomeId ? { genomeId } : {}),
                            ...(taskProfile ? { taskProfile } : {}),
                            ...(parentSessionId ? { parentSessionId } : {}),
                        }),
                        metadataVersion: 1,
                        displayName: effectiveDisplayName,
                        mode,
                        machineId: targetMachineId,
                        roleId: resolvedRuntimeRoleId,
                        rootPathHash,
                        active: true,
                        lastActiveAt: nowDate
                    }
                });

                // Add to team as member
                if (normalizedExecutionPlane === 'mainline') {
                    await db.teamMember.create({
                        data: {
                            teamId,
                            sessionId: session.id,
                            roleId: resolvedRuntimeRoleId,
                            displayName: effectiveDisplayName
                        }
                    });
                }

                await upsertRuntimeAgentRecord({
                    sessionId: session.id,
                    teamId,
                    accountId: userId,
                    roleId: resolvedRuntimeRoleId,
                    mode,
                    machineId: targetMachineId,
                    displayName: effectiveDisplayName,
                    status: 'spawning',
                    currentTaskId: null,
                    tokenUsed: 0,
                    cpuPercent: 0,
                    memoryMb: 0,
                    rootPathHash,
                    spawnedAt: session.createdAt,
                    lastHeartbeatAt: nowDate,
                    stoppedAt: null,
                });

                // Initialize runtime state
                runtimeState.set(session.id, {
                    status: 'spawning',
                    currentTaskId: null,
                    tokenUsed: 0,
                    cpuPercent: 0,
                    memoryMb: 0,
                    lastHeartbeatAt: now
                });

                const rpcResult = await sendDaemonControl(userId, targetMachineId, {
                    method: 'add-team-agent',
                    params: {
                        machineId: targetMachineId,
                        teamId,
                        roleId: resolvedRuntimeRoleId,
                        mode,
                        rootPath: rootPath || process.cwd(),
                        displayName: displayName || `${mode}-${roleId}`,
                        sessionTag: sessionTag,
                        sessionId: session.id,
                        callbackUrl,
                        callbackSecret: process.env.AGENT_STATUS_CALLBACK_SECRET || undefined,
                        executionPlane: normalizedExecutionPlane,
                        ...(normalizedBypass ? { bypass: normalizedBypass } : {}),
                        ...(oneShotMeta ? { oneShot: oneShotMeta } : {}),
                    }
                });
                const rpcPayload = getDaemonControlPayload(rpcResult);
                const rpcError = !rpcResult.ok
                    ? getDaemonControlError(rpcResult)
                    : (typeof rpcPayload?.error === 'string' ? rpcPayload.error : undefined);

                if (rpcError) {
                    log({
                        module: 'runtime-agents',
                        level: 'error',
                        teamId,
                        sessionId: session.id,
                        machineId: targetMachineId,
                        requestedRole: roleId,
                        matchedRoleId: roleExists.id,
                        matchedRoleName: roleExists.name,
                        resolvedRuntimeRoleId,
                    }, `Daemon control failed: ${rpcError}`);
                    const runtime = runtimeState.get(session.id);
                    if (runtime) {
                        runtime.status = 'error';
                        runtime.error = rpcError;
                        runtime.lastHeartbeatAt = now;
                    }

                    await db.session.update({
                        where: { id: session.id },
                        data: {
                            active: false,
                            lastActiveAt: new Date()
                        }
                    });

                    await upsertRuntimeAgentRecord({
                        sessionId: session.id,
                        teamId,
                        accountId: userId,
                        roleId: resolvedRuntimeRoleId,
                        mode,
                        machineId: targetMachineId,
                        displayName: effectiveDisplayName,
                        status: 'error',
                        currentTaskId: null,
                        tokenUsed: 0,
                        cpuPercent: 0,
                        memoryMb: 0,
                        error: rpcError,
                        rootPathHash,
                        spawnedAt: session.createdAt,
                        lastHeartbeatAt: new Date(),
                        stoppedAt: null,
                    });

                    failedSessions.push({
                        sessionId: session.id,
                        error: rpcError,
                        directory: typeof rpcPayload?.directory === 'string' ? rpcPayload.directory : undefined
                    });
                }

                const sessionEntry: typeof sessions[number] = {
                    sessionId: session.id,
                    roleId: resolvedRuntimeRoleId,
                    mode,
                    machineId: targetMachineId,
                    status: rpcError ? 'error' : 'spawning',
                    error: rpcError,
                    executionPlane: normalizedExecutionPlane,
                };
                if (normalizedBypass) {
                    sessionEntry.bypass = {
                        trigger: normalizedBypass.trigger,
                        profile: normalizedBypass.profile,
                        autoTerminate: normalizedBypass.autoTerminate,
                        ttlMinutes: normalizedBypass.ttlMinutes,
                    };
                }
                if (oneShotMeta) {
                    sessionEntry.oneShot = oneShotMeta;
                }
                sessions.push(sessionEntry);
            }

            if (failedSessions.length > 0) {
                const firstFailure = failedSessions[0];
                return reply.code(502).send({
                    error: 'spawn_failed',
                    message: firstFailure.error,
                    sessionId: firstFailure.sessionId,
                    machineId: targetMachineId,
                    directory: firstFailure.directory,
                    partialSuccess: failedSessions.length < sessions.length,
                    sessions,
                    spawnedAt: now,
                    ...buildMeta({
                        machineId: targetMachineId,
                        sessionIds: sessions.map((session) => session.sessionId),
                    })
                });
            }

            log({
                module: 'runtime-agents',
                teamId,
                machineId: targetMachineId,
                requestedRole: roleId,
                matchedRoleId: roleExists.id,
                matchedRoleName: roleExists.name,
                resolvedRuntimeRoleId,
                sessionIds: sessions.map((session) => session.sessionId),
            }, `Spawned ${count || 1} agent(s)`);

            // Emit system messages for each successfully spawned agent (non-blocking)
            for (const spawnedSession of sessions) {
                if (spawnedSession.status !== 'error' && normalizedExecutionPlane === 'mainline') {
                    const agentName = displayName || `${spawnedSession.mode}-${spawnedSession.roleId}`;
                    void emitAgentSpawnSystemMessage({
                        userId,
                        teamId,
                        agentName,
                        role: spawnedSession.roleId,
                        machine: spawnedSession.machineId,
                    });
                }
                if (spawnedSession.status !== 'error' && normalizedExecutionPlane === 'bypass') {
                    const agentName = displayName || `${spawnedSession.mode}-${spawnedSession.roleId}`;
                    const profile = oneShotMeta?.profile ?? normalizedBypass?.profile ?? 'custom';
                    void emitBypassSpawnSystemMessage({
                        userId,
                        teamId,
                        profile,
                        trigger: normalizedBypass?.trigger ?? 'manual',
                        agentName,
                        machine: spawnedSession.machineId,
                    });
                }
            }

            return reply.send({
                sessions,
                spawnedAt: now,
                ...buildMeta({
                    machineId: targetMachineId,
                    sessionIds: sessions.map((session) => session.sessionId),
                })
            });
        } catch (error: any) {
            log({ module: 'runtime-agents', level: 'error' }, `Failed to spawn agents: ${error}`);
            return reply.code(500).send({
                error: 'internal_error',
                message: error.message,
                ...buildMeta({})
            });
        }
    });

    // === POST /v1/teams/:teamId/agents/:sessionId/stop - Stop agent ===

    app.post('/v1/teams/:teamId/agents/:sessionId/stop', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string(),
                sessionId: z.string()
            }),
            body: z.object({
                graceful: z.boolean().optional().default(true)
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId, sessionId } = request.params as { teamId: string; sessionId: string };
        const body = request.body as { graceful?: boolean } | undefined;
        const graceful = body?.graceful ?? true;

        try {
            // Verify session exists and belongs to team
            const teamMember = await db.teamMember.findFirst({
                where: {
                    teamId,
                    sessionId,
                    team: { accountId: userId }
                },
                include: { session: true }
            });

            if (!teamMember || !teamMember.session) {
                return reply.code(404).send({
                    error: 'agent_not_found',
                    message: 'Session not found in team'
                });
            }

            const persistedRuntime = await db.runtimeAgent.findUnique({
                where: { sessionId }
            });
            const targetMachineId = teamMember.session.machineId;
            if (!targetMachineId) {
                return reply.code(400).send({
                    error: 'machine_offline',
                    message: 'Session is not attached to a machine'
                });
            }

            const rpcResult = await sendDaemonControl(userId, targetMachineId, {
                method: 'remove-team-agent',
                params: {
                    sessionId,
                    graceful
                }
            });

            if (!rpcResult.ok) {
                const message = getDaemonControlError(rpcResult);
                log({ module: 'runtime-agents', level: 'warn' }, `Stop daemon control failed: ${message}`);
                return reply.code(503).send({
                    error: 'rpc_failed',
                    message
                });
            }

            const rpcPayload = getDaemonControlPayload(rpcResult);
            if (typeof rpcPayload?.error === 'string' && rpcPayload.error.trim()) {
                log({ module: 'runtime-agents', level: 'warn' }, `Stop daemon control failed: ${rpcPayload.error}`);
                return reply.code(400).send({
                    error: 'stop_failed',
                    message: rpcPayload.error
                });
            }

            const nowDate = new Date();
            const now = nowDate.toISOString();
            const status = typeof rpcPayload?.status === 'string' ? rpcPayload.status : (graceful ? 'stopping' : 'stopped');

            await db.session.update({
                where: { id: sessionId },
                data: {
                    active: false,
                    lastActiveAt: nowDate
                }
            });

            const existingRuntime = runtimeState.get(sessionId);
            const nextRuntime = {
                status: (status === 'stopped' ? 'stopped' : 'stopping') as AgentStatus,
                currentTaskId: existingRuntime?.currentTaskId ?? persistedRuntime?.currentTaskId ?? null,
                tokenUsed: existingRuntime?.tokenUsed ?? persistedRuntime?.tokenUsed ?? 0,
                cpuPercent: existingRuntime?.cpuPercent ?? persistedRuntime?.cpuPercent ?? 0,
                memoryMb: existingRuntime?.memoryMb ?? persistedRuntime?.memoryMb ?? 0,
                lastHeartbeatAt: now,
                ...(existingRuntime?.error || persistedRuntime?.error ? { error: existingRuntime?.error ?? persistedRuntime?.error ?? undefined } : {}),
            };
            if (status === 'stopped') {
                runtimeState.delete(sessionId);
            } else {
                runtimeState.set(sessionId, nextRuntime);
            }

            await upsertRuntimeAgentRecord({
                sessionId,
                teamId,
                accountId: userId,
                roleId: teamMember.roleId,
                mode: (teamMember.session.mode ?? persistedRuntime?.mode ?? 'codex') as AgentMode,
                machineId: targetMachineId,
                displayName: teamMember.session.displayName ?? persistedRuntime?.displayName ?? teamMember.displayName ?? null,
                status: nextRuntime.status,
                currentTaskId: nextRuntime.currentTaskId,
                tokenUsed: nextRuntime.tokenUsed,
                cpuPercent: nextRuntime.cpuPercent,
                memoryMb: nextRuntime.memoryMb,
                error: null,
                rootPathHash: teamMember.session.rootPathHash ?? persistedRuntime?.rootPath ?? null,
                lastHeartbeatAt: nowDate,
                stoppedAt: status === 'stopped' ? nowDate : null,
            });

            log({ module: 'runtime-agents', teamId, sessionId }, `Agent stopping (graceful: ${graceful})`);

            return reply.send({
                status,
                sessionId,
                stoppedAt: now
            });
        } catch (error: any) {
            log({ module: 'runtime-agents', level: 'error' }, `Failed to stop agent: ${error}`);
            return reply.code(500).send({ error: 'internal_error', message: error.message });
        }
    });

    // === POST /v1/teams/:teamId/agents/:sessionId/pause - Pause agent ===

    app.post('/v1/teams/:teamId/agents/:sessionId/pause', {
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
            // Verify session exists and belongs to team
            const teamMember = await db.teamMember.findFirst({
                where: {
                    teamId,
                    sessionId,
                    team: { accountId: userId }
                },
                include: { session: true }
            });

            if (!teamMember || !teamMember.session) {
                return reply.code(404).send({
                    error: 'agent_not_found',
                    message: 'Session not found in team'
                });
            }

            const persistedRuntime = await db.runtimeAgent.findUnique({
                where: { sessionId }
            });
            const runtime = runtimeState.get(sessionId);
            const currentStatus = runtime?.status ?? persistedRuntime?.status;
            if (currentStatus !== 'running') {
                return reply.code(400).send({
                    error: 'invalid_state',
                    message: 'Can only pause running agents'
                });
            }

            const targetMachineId = teamMember.session.machineId;
            if (!targetMachineId) {
                return reply.code(400).send({
                    error: 'machine_offline',
                    message: 'Session is not attached to a machine'
                });
            }

            const rpcResult = await sendDaemonControl(userId, targetMachineId, {
                method: 'pause-team-agent',
                params: { sessionId }
            });

            if (!rpcResult.ok) {
                const message = getDaemonControlError(rpcResult);
                log({ module: 'runtime-agents', level: 'warn' }, `Pause daemon control failed: ${message}`);
                return reply.code(500).send({
                    error: 'rpc_failed',
                    message
                });
            }

            const nowDate = new Date();
            const now = nowDate.toISOString();
            const nextRuntime = {
                status: 'paused' as AgentStatus,
                currentTaskId: runtime?.currentTaskId ?? persistedRuntime?.currentTaskId ?? null,
                tokenUsed: runtime?.tokenUsed ?? persistedRuntime?.tokenUsed ?? 0,
                cpuPercent: runtime?.cpuPercent ?? persistedRuntime?.cpuPercent ?? 0,
                memoryMb: runtime?.memoryMb ?? persistedRuntime?.memoryMb ?? 0,
                lastHeartbeatAt: now,
                ...(runtime?.error || persistedRuntime?.error ? { error: runtime?.error ?? persistedRuntime?.error ?? undefined } : {}),
            };
            runtimeState.set(sessionId, nextRuntime);
            await upsertRuntimeAgentRecord({
                sessionId,
                teamId,
                accountId: userId,
                roleId: teamMember.roleId,
                mode: (teamMember.session.mode ?? persistedRuntime?.mode ?? 'codex') as AgentMode,
                machineId: targetMachineId,
                displayName: teamMember.session.displayName ?? persistedRuntime?.displayName ?? teamMember.displayName ?? null,
                status: 'paused',
                currentTaskId: nextRuntime.currentTaskId,
                tokenUsed: nextRuntime.tokenUsed,
                cpuPercent: nextRuntime.cpuPercent,
                memoryMb: nextRuntime.memoryMb,
                error: null,
                rootPathHash: teamMember.session.rootPathHash ?? persistedRuntime?.rootPath ?? null,
                lastHeartbeatAt: nowDate,
                stoppedAt: null,
            });
            log({ module: 'runtime-agents', teamId, sessionId }, `Agent paused`);

            return reply.send({
                status: 'paused',
                sessionId,
                pausedAt: now
            });
        } catch (error: any) {
            log({ module: 'runtime-agents', level: 'error' }, `Failed to pause agent: ${error}`);
            return reply.code(500).send({ error: 'internal_error', message: error.message });
        }
    });

    // === POST /v1/teams/:teamId/agents/:sessionId/resume - Resume agent ===

    app.post('/v1/teams/:teamId/agents/:sessionId/resume', {
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
            // Verify session exists and belongs to team
            const teamMember = await db.teamMember.findFirst({
                where: {
                    teamId,
                    sessionId,
                    team: { accountId: userId }
                },
                include: { session: true }
            });

            if (!teamMember || !teamMember.session) {
                return reply.code(404).send({
                    error: 'agent_not_found',
                    message: 'Session not found in team'
                });
            }

            const persistedRuntime = await db.runtimeAgent.findUnique({
                where: { sessionId }
            });
            const targetMachineId = teamMember.session.machineId;
            if (!targetMachineId) {
                return reply.code(400).send({
                    error: 'machine_offline',
                    message: 'Session is not attached to a machine'
                });
            }

            const rpcResult = await sendDaemonControl(userId, targetMachineId, {
                method: 'resume-team-agent',
                params: { sessionId }
            });

            if (!rpcResult.ok) {
                const message = getDaemonControlError(rpcResult);
                log({ module: 'runtime-agents', level: 'warn' }, `Resume daemon control failed: ${message}`);
                return reply.code(500).send({
                    error: 'rpc_failed',
                    message
                });
            }

            const nowDate = new Date();
            const now = nowDate.toISOString();
            const existingRuntime = runtimeState.get(sessionId);
            const nextRuntime = {
                status: 'running' as AgentStatus,
                currentTaskId: existingRuntime?.currentTaskId ?? persistedRuntime?.currentTaskId ?? null,
                tokenUsed: existingRuntime?.tokenUsed ?? persistedRuntime?.tokenUsed ?? 0,
                cpuPercent: existingRuntime?.cpuPercent ?? persistedRuntime?.cpuPercent ?? 0,
                memoryMb: existingRuntime?.memoryMb ?? persistedRuntime?.memoryMb ?? 0,
                lastHeartbeatAt: now,
                ...(existingRuntime?.error || persistedRuntime?.error ? { error: existingRuntime?.error ?? persistedRuntime?.error ?? undefined } : {}),
            };
            runtimeState.set(sessionId, nextRuntime);
            await upsertRuntimeAgentRecord({
                sessionId,
                teamId,
                accountId: userId,
                roleId: teamMember.roleId,
                mode: (teamMember.session.mode ?? persistedRuntime?.mode ?? 'codex') as AgentMode,
                machineId: targetMachineId,
                displayName: teamMember.session.displayName ?? persistedRuntime?.displayName ?? teamMember.displayName ?? null,
                status: 'running',
                currentTaskId: nextRuntime.currentTaskId,
                tokenUsed: nextRuntime.tokenUsed,
                cpuPercent: nextRuntime.cpuPercent,
                memoryMb: nextRuntime.memoryMb,
                error: null,
                rootPathHash: teamMember.session.rootPathHash ?? persistedRuntime?.rootPath ?? null,
                lastHeartbeatAt: nowDate,
                stoppedAt: null,
            });
            log({ module: 'runtime-agents', teamId, sessionId }, `Agent resumed`);

            return reply.send({
                status: 'running',
                sessionId,
                resumedAt: now
            });
        } catch (error: any) {
            log({ module: 'runtime-agents', level: 'error' }, `Failed to resume agent: ${error}`);
            return reply.code(500).send({ error: 'internal_error', message: error.message });
        }
    });

    // Daemon callback endpoint for runtime status/heartbeat updates.
    app.post('/v1/agent-status', {
        schema: {
            body: AgentStatusUpdateSchema
        }
    }, async (request, reply) => {
        const callbackSecret = process.env.AGENT_STATUS_CALLBACK_SECRET;
        if (callbackSecret) {
            const headerSecret = request.headers['x-agent-callback-secret'];
            const secret = Array.isArray(headerSecret) ? headerSecret[0] : headerSecret;
            if (secret !== callbackSecret) {
                return reply.code(401).send({ error: 'unauthorized' });
            }
        }

        const body = request.body as z.infer<typeof AgentStatusUpdateSchema>;
        const timestamp = body.timestamp && body.timestamp > 0 ? body.timestamp : Date.now();
        const safeTimestamp = Math.min(timestamp, Date.now());

        const session = await db.session.findFirst({
            where: { id: body.sessionId },
            select: {
                id: true,
                accountId: true,
                metadata: true,
                roleId: true,
                mode: true,
                machineId: true,
                displayName: true,
                rootPathHash: true,
                teamMembers: {
                    select: { teamId: true },
                    take: 1
                }
            }
        });

        if (!session) {
            return reply.code(404).send({ error: 'session_not_found' });
        }

        const active = body.status !== 'stopped' && body.status !== 'error';
        await db.session.update({
            where: { id: body.sessionId },
            data: {
                active,
                lastActiveAt: new Date(safeTimestamp)
            }
        });

        const persistedRuntime = await db.runtimeAgent.findUnique({
            where: { sessionId: body.sessionId }
        });
        const existingState = runtimeState.get(body.sessionId);
        const currentTaskId = existingState?.currentTaskId ?? persistedRuntime?.currentTaskId ?? null;
        const tokenUsed = body.metrics?.tokenUsed ?? existingState?.tokenUsed ?? persistedRuntime?.tokenUsed ?? 0;
        const cpuPercent = body.metrics?.cpuPercent ?? existingState?.cpuPercent ?? persistedRuntime?.cpuPercent ?? 0;
        const memoryMb = body.metrics?.memoryMb ?? existingState?.memoryMb ?? persistedRuntime?.memoryMb ?? 0;
        let metadataTeamId: string | undefined;
        if (typeof session.metadata === 'string' && session.metadata.trim()) {
            try {
                const parsedMetadata = JSON.parse(session.metadata) as { teamId?: unknown };
                if (typeof parsedMetadata.teamId === 'string' && parsedMetadata.teamId.trim()) {
                    metadataTeamId = parsedMetadata.teamId;
                }
            } catch {}
        }
        const resolvedTeamId = body.teamId ?? session.teamMembers?.[0]?.teamId ?? metadataTeamId ?? persistedRuntime?.teamId;
        const resolvedMode = (session.mode ?? persistedRuntime?.mode ?? null) as AgentMode | null;
        const resolvedRoleId = session.roleId ?? persistedRuntime?.roleId ?? null;
        const resolvedMachineId = session.machineId ?? persistedRuntime?.machineId ?? null;
        const callbackAt = new Date(safeTimestamp);

        if (body.status === 'stopped' && !body.error) {
            runtimeState.delete(body.sessionId);
        } else {
            runtimeState.set(body.sessionId, {
                status: body.status,
                currentTaskId,
                tokenUsed,
                cpuPercent,
                memoryMb,
                lastHeartbeatAt: callbackAt.toISOString(),
                error: body.error ?? existingState?.error ?? persistedRuntime?.error ?? undefined
            });
        }

        if (resolvedTeamId && resolvedMode && resolvedRoleId && resolvedMachineId) {
            await upsertRuntimeAgentRecord({
                sessionId: body.sessionId,
                teamId: resolvedTeamId,
                accountId: session.accountId,
                roleId: resolvedRoleId,
                mode: resolvedMode,
                machineId: resolvedMachineId,
                displayName: session.displayName ?? persistedRuntime?.displayName ?? null,
                status: body.status,
                currentTaskId,
                tokenUsed,
                cpuPercent,
                memoryMb,
                error: body.error ?? null,
                rootPathHash: session.rootPathHash ?? persistedRuntime?.rootPath ?? null,
                spawnedAt: persistedRuntime?.spawnedAt ?? callbackAt,
                lastHeartbeatAt: callbackAt,
                stoppedAt: body.status === 'stopped' ? callbackAt : null,
            });
        }

        log(
            {
                module: 'runtime-agents',
                sessionId: body.sessionId,
                status: body.status
            },
            'Received daemon agent-status callback'
        );

        // Emit bypass_complete system message when a bypass agent stops successfully
        if (body.status === 'stopped' && !body.error && resolvedTeamId) {
            try {
                const parsedMeta = typeof session.metadata === 'string' && session.metadata.trim()
                    ? JSON.parse(session.metadata) as {
                        executionPlane?: string;
                        bypass?: { profile?: string };
                        oneShot?: { bypass?: boolean; profile?: string };
                        bypassResult?: { fitnessScore?: number; summary?: string; recommendation?: string; targetAgent?: string };
                    }
                    : null;

                const isBypass = parsedMeta?.executionPlane === 'bypass';
                if (isBypass) {
                    const profile = parsedMeta?.oneShot?.profile ?? parsedMeta?.bypass?.profile ?? 'custom';
                    const result = body.bypassResult ?? parsedMeta?.bypassResult;

                    void emitBypassCompleteSystemMessage({
                        userId: session.accountId,
                        teamId: resolvedTeamId,
                        profile,
                        fitnessScore: result?.fitnessScore,
                        summary: result?.summary,
                    });

                    if (result?.recommendation) {
                        void emitBypassRecommendationSystemMessage({
                            userId: session.accountId,
                            teamId: resolvedTeamId,
                            profile,
                            recommendation: result.recommendation,
                            targetAgent: result.targetAgent,
                        });
                    }
                }
            } catch {
                // Metadata parse failure — skip bypass system messages silently
            }
        }

        return reply.send({
            success: true,
            sessionId: body.sessionId,
            status: body.status,
            active,
            updatedAt: safeTimestamp
        });
    });

    // === POST /v1/sessions/:sessionId/bypass-result ===
    // Called by bypass agents via the report_bypass_result MCP tool to persist
    // evaluation results before the session stop callback fires.

    app.post('/v1/sessions/:sessionId/bypass-result', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ sessionId: z.string() }),
            body: z.object({
                fitnessScore: z.number().min(0).max(100),
                summary: z.string(),
                recommendation: z.string(),
                directive: z.enum(['suggest', 'kill', 'resurrect', 'replace', 'pause_new_assignments']).optional(),
                targetAgent: z.string().optional(),
            }),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { sessionId } = request.params as { sessionId: string };
        const body = request.body as {
            fitnessScore: number;
            summary: string;
            recommendation: string;
            directive?: string;
            targetAgent?: string;
        };

        const session = await db.session.findFirst({
            where: { id: sessionId, accountId: userId },
            select: { id: true, metadata: true },
        });
        if (!session) {
            return reply.code(404).send({ error: 'session_not_found' });
        }

        let existingMeta: Record<string, unknown> = {};
        if (typeof session.metadata === 'string' && session.metadata.trim()) {
            try {
                existingMeta = JSON.parse(session.metadata) as Record<string, unknown>;
            } catch {
                // Ignore parse error — start fresh
            }
        }

        const updatedMeta = {
            ...existingMeta,
            bypassResult: {
                fitnessScore: body.fitnessScore,
                summary: body.summary,
                recommendation: body.recommendation,
                ...(body.directive ? { directive: body.directive } : {}),
                ...(body.targetAgent ? { targetAgent: body.targetAgent } : {}),
            },
        };

        await db.session.update({
            where: { id: sessionId },
            data: { metadata: JSON.stringify(updatedMeta) },
        });

        return reply.send({ ok: true });
    });

    // === WebSocket: Handle agent status callbacks from daemons ===

    // This would be registered in socket.ts
    // socket.on('agent-status-update', (data) => { ... })

    log({ module: 'api' }, 'runtimeAgentRoutes registered');
}

/**
 * Handle agent status updates from daemon callbacks
 */
export function handleAgentStatusUpdate(data: {
    sessionId: string;
    status: AgentStatus;
    error?: string;
    metrics?: {
        tokenUsed: number;
        cpuPercent: number;
        memoryMb: number;
    };
}) {
    const runtime = runtimeState.get(data.sessionId);
    if (runtime) {
        runtime.status = data.status;
        runtime.lastHeartbeatAt = new Date().toISOString();

        if (data.error) {
            runtime.error = data.error;
        }
        if (data.metrics) {
            runtime.tokenUsed = data.metrics.tokenUsed;
            runtime.cpuPercent = data.metrics.cpuPercent;
            runtime.memoryMb = data.metrics.memoryMb;
        }

        log({ module: 'runtime-agents', sessionId: data.sessionId }, `Status update: ${data.status}`);
    }
}
