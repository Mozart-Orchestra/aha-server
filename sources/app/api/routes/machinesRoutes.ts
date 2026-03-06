import { Fastify } from "../types";
import { z } from "zod";
import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import {
    eventRouter,
    buildMachineActivityEphemeral,
    buildNewMachineUpdate,
    buildUpdateMachineUpdate
} from "@/app/events/eventRouter";
import { sendDaemonControl } from "@/app/api/socket/daemonControlRegistry";

const MACHINE_ONLINE_WINDOW_SEC_DEFAULT = 120;
const MACHINE_ONLINE_WINDOW_SEC_MAX = 24 * 60 * 60;

function isMachineOnline(lastActiveAt: Date, active: boolean, windowMs: number): boolean {
    return active && (Date.now() - lastActiveAt.getTime() <= windowMs);
}

const MachineHeartbeatStatusSchema = z.enum([
    'online',
    'offline',
    'running',
    'shutting-down',
    'active',
    'idle',
]);

function isHeartbeatActiveStatus(status: z.infer<typeof MachineHeartbeatStatusSchema>): boolean {
    return status !== 'offline' && status !== 'shutting-down';
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

export function machinesRoutes(app: Fastify) {
    app.post('/v1/machines', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                id: z.string(),
                metadata: z.string(), // Encrypted metadata
                daemonState: z.string().optional(), // Encrypted daemon state
                dataEncryptionKey: z.string().nullish()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id, metadata, daemonState, dataEncryptionKey } = request.body;

        // Check if machine exists (like sessions do)
        const machine = await db.machine.findFirst({
            where: {
                accountId: userId,
                id: id
            }
        });

        if (machine) {
            // Machine exists - just return it
            log({ module: 'machines', machineId: id, userId }, 'Found existing machine');
            return reply.send({
                machine: {
                    id: machine.id,
                    metadata: machine.metadata,
                    metadataVersion: machine.metadataVersion,
                    daemonState: machine.daemonState,
                    daemonStateVersion: machine.daemonStateVersion,
                    dataEncryptionKey: machine.dataEncryptionKey ? Buffer.from(machine.dataEncryptionKey).toString('base64') : null,
                    active: machine.active,
                    activeAt: machine.lastActiveAt.getTime(),  // Return as activeAt for API consistency
                    createdAt: machine.createdAt.getTime(),
                    updatedAt: machine.updatedAt.getTime()
                }
            });
        } else {
            // Create new machine
            log({ module: 'machines', machineId: id, userId }, 'Creating new machine');

            const newMachine = await db.machine.create({
                data: {
                    id,
                    accountId: userId,
                    metadata,
                    metadataVersion: 1,
                    daemonState: daemonState || null,
                    daemonStateVersion: daemonState ? 1 : 0,
                    dataEncryptionKey: dataEncryptionKey ? new Uint8Array(Buffer.from(dataEncryptionKey, 'base64')) : undefined,
                    // Default to offline - in case the user does not start daemon
                    active: false,
                    // lastActiveAt and activeAt defaults to now() in schema
                }
            });

            // Emit both new-machine and update-machine events for backward compatibility
            const updSeq1 = await allocateUserSeq(userId);
            const updSeq2 = await allocateUserSeq(userId);
            
            // Emit new-machine event with all data including dataEncryptionKey
            const newMachinePayload = buildNewMachineUpdate(newMachine, updSeq1, randomKeyNaked(12));
            eventRouter.emitUpdate({
                userId,
                payload: newMachinePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });

            // Emit update-machine event for backward compatibility (without dataEncryptionKey)
            const machineMetadata = {
                version: 1,
                value: metadata
            };
            const updatePayload = buildUpdateMachineUpdate(newMachine.id, updSeq2, randomKeyNaked(12), machineMetadata);
            eventRouter.emitUpdate({
                userId,
                payload: updatePayload,
                recipientFilter: { type: 'machine-scoped-only', machineId: newMachine.id }
            });

            return reply.send({
                machine: {
                    id: newMachine.id,
                    metadata: newMachine.metadata,
                    metadataVersion: newMachine.metadataVersion,
                    daemonState: newMachine.daemonState,
                    daemonStateVersion: newMachine.daemonStateVersion,
                    dataEncryptionKey: newMachine.dataEncryptionKey ? Buffer.from(newMachine.dataEncryptionKey).toString('base64') : null,
                    active: newMachine.active,
                    activeAt: newMachine.lastActiveAt.getTime(),  // Return as activeAt for API consistency
                    createdAt: newMachine.createdAt.getTime(),
                    updatedAt: newMachine.updatedAt.getTime()
                }
            });
        }
    });


    // Machines API
    app.get('/v1/machines', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;

        const machines = await db.machine.findMany({
            where: { accountId: userId },
            orderBy: { lastActiveAt: 'desc' }
        });

        return machines.map(m => ({
            id: m.id,
            metadata: m.metadata,
            metadataVersion: m.metadataVersion,
            daemonState: m.daemonState,
            daemonStateVersion: m.daemonStateVersion,
            dataEncryptionKey: m.dataEncryptionKey ? Buffer.from(m.dataEncryptionKey).toString('base64') : null,
            seq: m.seq,
            active: m.active,
            activeAt: m.lastActiveAt.getTime(),
            createdAt: m.createdAt.getTime(),
            updatedAt: m.updatedAt.getTime()
        }));
    });

    // GET /v1/machines/presence - Get machine online/presence summary
    app.get('/v1/machines/presence', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                windowSec: z.coerce.number().int().min(30).max(MACHINE_ONLINE_WINDOW_SEC_MAX)
                    .default(MACHINE_ONLINE_WINDOW_SEC_DEFAULT)
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const windowSec = request.query?.windowSec ?? MACHINE_ONLINE_WINDOW_SEC_DEFAULT;
        const windowMs = windowSec * 1000;
        const nowMs = Date.now();

        const machines = await db.machine.findMany({
            where: { accountId: userId },
            orderBy: { lastActiveAt: 'desc' },
            select: {
                id: true,
                active: true,
                lastActiveAt: true,
                daemonState: true,
                updatedAt: true,
                createdAt: true,
            }
        });

        const machineIds = machines.map((m) => m.id);
        const sessions = machineIds.length > 0
            ? await db.session.findMany({
                where: {
                    accountId: userId,
                    active: true,
                    machineId: { in: machineIds },
                    lastActiveAt: { gte: new Date(nowMs - windowMs) }
                },
                select: { id: true, machineId: true }
            })
            : [];

        const sessionCountByMachine = new Map<string, number>();
        for (const session of sessions) {
            if (!session.machineId) continue;
            sessionCountByMachine.set(session.machineId, (sessionCountByMachine.get(session.machineId) || 0) + 1);
        }

        const items = machines.map((machine) => {
            const online = isMachineOnline(machine.lastActiveAt, machine.active, windowMs);
            return {
                id: machine.id,
                online,
                lastHeartbeatAt: machine.lastActiveAt.getTime(),
                heartbeatAgeSec: Math.max(0, Math.floor((nowMs - machine.lastActiveAt.getTime()) / 1000)),
                activeSessionCount: sessionCountByMachine.get(machine.id) || 0,
                daemonState: machine.daemonState,
                createdAt: machine.createdAt.getTime(),
                updatedAt: machine.updatedAt.getTime(),
            };
        });

        return reply.send({
            machines: items,
            summary: {
                total: items.length,
                online: items.filter((m) => m.online).length,
                offline: items.filter((m) => !m.online).length,
                activeSessions: sessions.length,
            }
        });
    });

    // GET /v1/machines/:id - Get single machine by ID
    app.get('/v1/machines/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        const machine = await db.machine.findFirst({
            where: {
                accountId: userId,
                id: id
            }
        });

        if (!machine) {
            return reply.code(404).send({ error: 'Machine not found' });
        }

        return {
            machine: {
                id: machine.id,
                metadata: machine.metadata,
                metadataVersion: machine.metadataVersion,
                daemonState: machine.daemonState,
                daemonStateVersion: machine.daemonStateVersion,
                dataEncryptionKey: machine.dataEncryptionKey ? Buffer.from(machine.dataEncryptionKey).toString('base64') : null,
                seq: machine.seq,
                active: machine.active,
                activeAt: machine.lastActiveAt.getTime(),
                createdAt: machine.createdAt.getTime(),
                updatedAt: machine.updatedAt.getTime()
            }
        };
    });

    // GET /v1/machines/:id/presence - Presence for a single machine
    app.get('/v1/machines/:id/presence', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            querystring: z.object({
                windowSec: z.coerce.number().int().min(30).max(MACHINE_ONLINE_WINDOW_SEC_MAX)
                    .default(MACHINE_ONLINE_WINDOW_SEC_DEFAULT)
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;
        const windowSec = request.query?.windowSec ?? MACHINE_ONLINE_WINDOW_SEC_DEFAULT;
        const windowMs = windowSec * 1000;
        const nowMs = Date.now();

        const machine = await db.machine.findFirst({
            where: {
                accountId: userId,
                id
            },
            select: {
                id: true,
                active: true,
                lastActiveAt: true,
                daemonState: true,
                createdAt: true,
                updatedAt: true,
            }
        });

        if (!machine) {
            return reply.code(404).send({ error: 'Machine not found' });
        }

        const activeSessions = await db.session.findMany({
            where: {
                accountId: userId,
                active: true,
                machineId: id,
                lastActiveAt: { gte: new Date(nowMs - windowMs) }
            },
            select: { id: true }
        });

        return reply.send({
            machine: {
                id: machine.id,
                online: isMachineOnline(machine.lastActiveAt, machine.active, windowMs),
                lastHeartbeatAt: machine.lastActiveAt.getTime(),
                heartbeatAgeSec: Math.max(0, Math.floor((nowMs - machine.lastActiveAt.getTime()) / 1000)),
                activeSessionCount: activeSessions.length,
                daemonState: machine.daemonState,
                createdAt: machine.createdAt.getTime(),
                updatedAt: machine.updatedAt.getTime(),
            }
        });
    });

    // POST /v1/machines/:id/heartbeat - Send machine heartbeat
    app.post('/v1/machines/:id/heartbeat', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            body: z.object({
                status: MachineHeartbeatStatusSchema.optional().default('online'),
                sessions: z.array(z.string()).optional(),
                activeSessions: z.number().int().min(0).optional(),
                daemonPid: z.number().int().positive().optional(),
                daemonHttpPort: z.number().int().positive().optional(),
                time: z.number().int().positive().optional(),
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;
        const { status, sessions, daemonPid } = request.body;
        const heartbeatAt = new Date();
        const machineActive = isHeartbeatActiveStatus(status);

        // Verify machine belongs to user
        const machine = await db.machine.findFirst({
            where: {
                accountId: userId,
                id: id
            }
        });

        if (!machine) {
            return reply.code(404).send({ error: 'Machine not found' });
        }

        // Update machine heartbeat
        const updatedMachine = await db.machine.update({
            where: { id },
            data: {
                active: machineActive,
                lastActiveAt: heartbeatAt,
                updatedAt: heartbeatAt,
            }
        });

        let updatedSessions = 0;
        if (sessions && sessions.length > 0) {
            const sessionUpdate = await db.session.updateMany({
                where: {
                    accountId: userId,
                    id: { in: sessions }
                },
                data: {
                    active: true,
                    machineId: id,
                    lastActiveAt: heartbeatAt
                }
            });
            updatedSessions = sessionUpdate.count;
        }

        // Emit heartbeat event
        const updSeq = await allocateUserSeq(userId);
        eventRouter.emitUpdate({
            userId,
            payload: {
                id: randomKeyNaked(12),
                seq: updSeq,
                body: {
                    t: 'machine-heartbeat' as any,
                    machineId: id,
                    status,
                    sessions: sessions || [],
                    activeAt: updatedMachine.lastActiveAt.getTime()
                },
                createdAt: Date.now()
            },
            recipientFilter: { type: 'user-scoped-only' }
        });

        eventRouter.emitEphemeral({
            userId,
            payload: buildMachineActivityEphemeral(id, machineActive, updatedMachine.lastActiveAt.getTime()),
            recipientFilter: { type: 'user-scoped-only' }
        });

        log({ module: 'machines', machineId: id, userId, status }, 'Heartbeat received');

        return reply.send({
            success: true,
            machine: {
                id: updatedMachine.id,
                active: updatedMachine.active,
                activeAt: updatedMachine.lastActiveAt.getTime(),
                status,
                daemonPid: daemonPid ?? null
            },
            updatedSessions
        });
    });


    app.post('/v1/machines/:id/sessions/spawn', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            body: z.object({
                directory: z.string(),
                approvedNewDirectoryCreation: z.boolean().optional().default(true),
                agent: z.enum(['claude', 'codex', 'ralph']).optional().default('claude'),
                teamId: z.string().optional(),
                role: z.string().optional(),
                sessionName: z.string().optional(),
                sessionPath: z.string().optional(),
                env: z.record(z.string()).optional()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;
        const body = request.body;

        const machine = await db.machine.findFirst({
            where: {
                accountId: userId,
                id
            },
            select: {
                id: true,
                active: true,
                lastActiveAt: true
            }
        });

        if (!machine) {
            return reply.code(404).send({ error: 'machine_not_found', message: 'Machine not found' });
        }

        const online = isMachineOnline(machine.lastActiveAt, machine.active, MACHINE_ONLINE_WINDOW_SEC_DEFAULT * 1000);
        if (!online) {
            return reply.code(409).send({ error: 'machine_offline', message: 'Target machine is offline' });
        }

        const controlResult = await sendDaemonControl(userId, id, {
            method: 'spawn-session',
            params: {
                machineId: id,
                directory: body.directory,
                approvedNewDirectoryCreation: body.approvedNewDirectoryCreation,
                agent: body.agent,
                teamId: body.teamId,
                role: body.role,
                sessionName: body.sessionName,
                sessionPath: body.sessionPath,
                env: body.env
            }
        });

        if (!controlResult.ok) {
            return reply.code(503).send({
                error: 'daemon_control_failed',
                message: getDaemonControlError(controlResult)
            });
        }

        const payload = getDaemonControlPayload(controlResult);
        if (typeof payload?.error === 'string' && payload.error.trim()) {
            return reply.code(400).send({
                error: 'spawn_failed',
                message: payload.error,
                machineId: id,
                sessionId: typeof payload.sessionId === 'string' ? payload.sessionId : null
            });
        }

        return reply.send({
            success: true,
            machineId: id,
            sessionId: typeof payload?.sessionId === 'string' ? payload.sessionId : null
        });
    });

    app.post('/v1/machines/:id/sessions/:sessionId/stop', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string(),
                sessionId: z.string()
            }),
            body: z.object({
                graceful: z.boolean().optional().default(true)
            }).optional()
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id, sessionId } = request.params;
        const graceful = request.body?.graceful ?? true;

        const machine = await db.machine.findFirst({
            where: {
                accountId: userId,
                id
            },
            select: {
                id: true,
                active: true,
                lastActiveAt: true
            }
        });

        if (!machine) {
            return reply.code(404).send({ error: 'machine_not_found', message: 'Machine not found' });
        }

        const sessions = await db.session.findMany({
            where: {
                accountId: userId,
                id: { in: [sessionId] }
            },
            select: {
                id: true,
                machineId: true,
                active: true
            }
        });
        const session = sessions[0] || null;

        if (!session) {
            return reply.code(404).send({ error: 'session_not_found', message: 'Session not found' });
        }

        if (session.machineId && session.machineId !== id) {
            return reply.code(409).send({ error: 'machine_mismatch', message: 'Session belongs to a different machine' });
        }

        const controlResult = await sendDaemonControl(userId, id, {
            method: 'stop-session',
            params: {
                sessionId,
                graceful
            }
        });

        if (!controlResult.ok) {
            return reply.code(503).send({
                error: 'daemon_control_failed',
                message: getDaemonControlError(controlResult)
            });
        }

        const payload = getDaemonControlPayload(controlResult);
        if (typeof payload?.error === 'string' && payload.error.trim()) {
            return reply.code(400).send({
                error: 'stop_failed',
                message: payload.error
            });
        }

        await db.session.updateMany({
            where: {
                accountId: userId,
                id: { in: [sessionId] }
            },
            data: {
                active: false,
                machineId: id,
                lastActiveAt: new Date()
            }
        });

        return reply.send({
            success: true,
            status: graceful ? 'stopping' : 'stopped',
            sessionId,
            machineId: id
        });
    });

}
