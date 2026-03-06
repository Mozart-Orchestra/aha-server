import { Fastify } from "../types";
import { z } from "zod";
import { log } from "@/utils/log";
import { db } from "@/storage/db";
import crypto from "node:crypto";
import { sendDaemonControl } from "@/app/api/socket/daemonControlRegistry";

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

            // Build agent list from sessions with runtime state overlay
            const agents = [];
            for (const member of team.members) {
                const session = member.session;
                if (!session) continue;

                // Apply filters
                if (query?.mode && session.mode !== query.mode) continue;
                if (query?.roleId && session.roleId !== query.roleId) continue;

                const runtime = runtimeState.get(session.id);
                const status = runtime?.status ?? (session.active ? 'spawning' : 'stopped');

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
                    spawnedAt: session.createdAt.toISOString(),
                    lastHeartbeatAt: runtime?.lastHeartbeatAt ?? session.lastActiveAt.toISOString()
                });
            }

            const summary = {
                total: agents.length,
                running: agents.filter((a: { status: string }) => a.status === 'running').length,
                paused: agents.filter((a: { status: string }) => a.status === 'paused').length,
                stopped: agents.filter((a: { status: string }) => a.status === 'stopped' || a.status === 'stopping').length
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
                count: z.number().int().min(1).max(10).optional().default(1)
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const { roleId, mode, machineId, rootPath, displayName, count } = request.body as {
            roleId: string;
            mode: AgentMode;
            machineId?: string;
            rootPath?: string;
            displayName?: string;
            count?: number;
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
                    message: 'Team not found'
                });
            }

            // Verify role exists in team
            const roleExists = await db.teamRole.findFirst({
                where: { teamId, id: roleId }
            });
            if (!roleExists) {
                return reply.code(400).send({
                    error: 'invalid_role',
                    message: 'Role not found in team'
                });
            }

            // Check spawn limit
            const currentCount = team._count.members;
            if (currentCount + (count || 1) > MAX_AGENTS_PER_TEAM) {
                return reply.code(429).send({
                    error: 'spawn_limit_exceeded',
                    message: 'Maximum agents per team reached',
                    limit: MAX_AGENTS_PER_TEAM,
                    current: currentCount
                });
            }

            // Verify machine exists and is online
            const targetMachineId = machineId || await getDefaultMachineId(userId);
            if (!targetMachineId) {
                return reply.code(400).send({
                    error: 'machine_offline',
                    message: 'No machine available for spawning agent'
                });
            }

            const machine = await db.machine.findFirst({
                where: { id: targetMachineId, accountId: userId }
            });
            if (!machine) {
                return reply.code(400).send({
                    error: 'machine_offline',
                    message: 'Target machine not found'
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
                    current: machineSessionCount.length
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
            }> = [];
            const failedSessions: Array<{
                sessionId: string;
                error: string;
                directory?: string;
            }> = [];

            const now = new Date().toISOString();

            for (let i = 0; i < (count || 1); i++) {
                const sessionTag = `team-${teamId}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

                // Create session in database with R3 fields
                const session = await db.session.create({
                    data: {
                        tag: sessionTag,
                        accountId: userId,
                        metadata: JSON.stringify({ teamId, roleId, spawnedForTeam: true }),
                        metadataVersion: 1,
                        displayName: displayName || `${mode}-${roleId}`,
                        mode,
                        machineId: targetMachineId,
                        roleId,
                        rootPathHash: rootPath ? await hashPath(rootPath) : null,
                        active: true,
                        lastActiveAt: new Date()
                    }
                });

                // Add to team as member
                await db.teamMember.create({
                    data: {
                        teamId,
                        sessionId: session.id,
                        roleId,
                        displayName: displayName || `${mode}-${roleId}`
                    }
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
                        roleId,
                        mode,
                        rootPath: rootPath || process.cwd(),
                        displayName: displayName || `${mode}-${roleId}`,
                        sessionTag: sessionTag,
                        sessionId: session.id,
                        callbackUrl: `${process.env.SERVER_URL || ''}/v1/agent-status`
                    }
                });
                const rpcPayload = getDaemonControlPayload(rpcResult);
                const rpcError = !rpcResult.ok
                    ? getDaemonControlError(rpcResult)
                    : (typeof rpcPayload?.error === 'string' ? rpcPayload.error : undefined);

                if (rpcError) {
                    log({ module: 'runtime-agents', level: 'error' }, `Daemon control failed: ${rpcError}`);
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

                    failedSessions.push({
                        sessionId: session.id,
                        error: rpcError,
                        directory: typeof rpcPayload?.directory === 'string' ? rpcPayload.directory : undefined
                    });
                }

                sessions.push({
                    sessionId: session.id,
                    roleId,
                    mode,
                    machineId: targetMachineId,
                    status: rpcError ? 'error' : 'spawning',
                    error: rpcError
                });
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
                    spawnedAt: now
                });
            }

            log({ module: 'runtime-agents', teamId }, `Spawned ${count} agent(s)`);

            return reply.send({
                sessions,
                spawnedAt: now
            });
        } catch (error: any) {
            log({ module: 'runtime-agents', level: 'error' }, `Failed to spawn agents: ${error}`);
            return reply.code(500).send({ error: 'internal_error', message: error.message });
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

            const now = new Date().toISOString();
            const status = typeof rpcPayload?.status === 'string' ? rpcPayload.status : (graceful ? 'stopping' : 'stopped');

            await db.session.update({
                where: { id: sessionId },
                data: {
                    active: false,
                    lastActiveAt: new Date()
                }
            });

            const existingRuntime = runtimeState.get(sessionId);
            if (status === 'stopped') {
                runtimeState.delete(sessionId);
            } else {
                runtimeState.set(sessionId, {
                    status: status === 'stopped' ? 'stopped' : 'stopping',
                    currentTaskId: existingRuntime?.currentTaskId ?? null,
                    tokenUsed: existingRuntime?.tokenUsed ?? 0,
                    cpuPercent: existingRuntime?.cpuPercent ?? 0,
                    memoryMb: existingRuntime?.memoryMb ?? 0,
                    lastHeartbeatAt: now,
                    error: existingRuntime?.error
                });
            }

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

            // Check if agent is running (has runtime state)
            const runtime = runtimeState.get(sessionId);
            if (!runtime) {
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

            const now = new Date().toISOString();
            const updatedRuntime = runtimeState.get(sessionId);
            if (updatedRuntime) {
                updatedRuntime.status = 'paused';
                updatedRuntime.lastHeartbeatAt = now;
            }
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

            const now = new Date().toISOString();
            const runtime = runtimeState.get(sessionId);
            if (runtime) {
                runtime.status = 'running';
                runtime.lastHeartbeatAt = now;
            }
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
            select: { id: true, accountId: true }
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

        const existingState = runtimeState.get(body.sessionId);
        const currentTaskId = existingState?.currentTaskId || null;
        const tokenUsed = body.metrics?.tokenUsed ?? existingState?.tokenUsed ?? 0;
        const cpuPercent = body.metrics?.cpuPercent ?? existingState?.cpuPercent ?? 0;
        const memoryMb = body.metrics?.memoryMb ?? existingState?.memoryMb ?? 0;

        if (body.status === 'stopped' && !body.error) {
            runtimeState.delete(body.sessionId);
        } else {
            runtimeState.set(body.sessionId, {
                status: body.status,
                currentTaskId,
                tokenUsed,
                cpuPercent,
                memoryMb,
                lastHeartbeatAt: new Date(safeTimestamp).toISOString(),
                error: body.error ?? existingState?.error
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

        return reply.send({
            success: true,
            sessionId: body.sessionId,
            status: body.status,
            active,
            updatedAt: safeTimestamp
        });
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
