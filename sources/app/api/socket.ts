import { onShutdown } from "@/utils/shutdown";
import { Fastify } from "./types";
import { buildMachineActivityEphemeral, buildSessionActivityEphemeral, ClientConnection, eventRouter } from "@/app/events/eventRouter";
import { Server, Socket } from "socket.io";
import { log } from "@/utils/log";
import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";
import { decrementWebSocketConnection, incrementWebSocketConnection, websocketEventsCounter } from "../monitoring/metrics2";
import { usageHandler } from "./socket/usageHandler";
import { rpcHandler } from "./socket/rpcHandler";
import { pingHandler } from "./socket/pingHandler";
import { sessionUpdateHandler } from "./socket/sessionUpdateHandler";
import { machineUpdateHandler } from "./socket/machineUpdateHandler";
import { artifactUpdateHandler } from "./socket/artifactUpdateHandler";
import { accessKeyHandler } from "./socket/accessKeyHandler";
import { getSocketCorsConfig } from "./utils/corsConfig";
import { activityCache } from "@/app/presence/sessionCache";
import { observeSessionActivity } from "@/app/presence/observeSessionActivity";

function readGracePeriodMs(envName: string, fallbackMs: number): number {
    const rawValue = process.env[envName];
    if (!rawValue) {
        return fallbackMs;
    }

    const parsed = Number(rawValue);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallbackMs;
}

function machineDisconnectTimerKey(userId: string, machineId: string): string {
    return `${userId}:${machineId}`;
}

// Grace-period timers for transient Socket.IO disconnects. We delay the offline
// DB write so reconnecting sockets do not make healthy agents/daemons flicker
// offline while they are still working through HTTP/MCP paths.
const SESSION_OFFLINE_GRACE_MS = readGracePeriodMs('AHA_SESSION_OFFLINE_GRACE_MS', 90_000);
const MACHINE_OFFLINE_GRACE_MS = readGracePeriodMs('AHA_MACHINE_OFFLINE_GRACE_MS', 90_000);
const disconnectGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const machineDisconnectGraceTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function startSocket(app: Fastify) {
    const io = new Server(app.server, {
        cors: getSocketCorsConfig(),
        transports: ['websocket', 'polling'],
        pingTimeout: 45000,
        pingInterval: 15000,
        path: '/v1/updates',
        allowUpgrades: true,
        upgradeTimeout: 10000,
        connectTimeout: 20000,
        serveClient: false // Don't serve the client files
    });

    let rpcListeners = new Map<string, Map<string, Socket>>();
    io.on("connection", async (socket) => {
        log({ module: 'websocket' }, `New connection attempt from socket: ${socket.id}`);
        const token = socket.handshake.auth.token as string;
        const clientType = socket.handshake.auth.clientType as 'session-scoped' | 'user-scoped' | 'machine-scoped' | undefined;
        const sessionId = socket.handshake.auth.sessionId as string | undefined;
        const machineId = socket.handshake.auth.machineId as string | undefined;

        if (!token) {
            log({ module: 'websocket' }, `No token provided`);
            socket.emit('error', { message: 'Missing authentication token' });
            socket.disconnect();
            return;
        }

        // Validate session-scoped clients have sessionId
        if (clientType === 'session-scoped' && !sessionId) {
            log({ module: 'websocket' }, `Session-scoped client missing sessionId`);
            socket.emit('error', { message: 'Session ID required for session-scoped clients' });
            socket.disconnect();
            return;
        }

        // Validate machine-scoped clients have machineId
        if (clientType === 'machine-scoped' && !machineId) {
            log({ module: 'websocket' }, `Machine-scoped client missing machineId`);
            socket.emit('error', { message: 'Machine ID required for machine-scoped clients' });
            socket.disconnect();
            return;
        }

        const verified = await auth.verifyToken(token);
        if (!verified) {
            log({ module: 'websocket' }, `Invalid token provided`);
            socket.emit('error', { message: 'Invalid authentication token' });
            socket.disconnect();
            return;
        }

        const userId = verified.userId;
        const account = await db.account.findUnique({
            where: { id: userId },
            select: { id: true },
        });
        if (!account) {
            log({ module: 'websocket', level: 'error', userId }, 'Token points to a missing account');
            socket.emit('error', { message: 'Account not found for token' });
            socket.disconnect();
            return;
        }
        log({ module: 'websocket' }, `Token verified: ${userId}, clientType: ${clientType || 'user-scoped'}, sessionId: ${sessionId || 'none'}, machineId: ${machineId || 'none'}, socketId: ${socket.id}`);

        // Store connection based on type
        const metadata = { clientType: clientType || 'user-scoped', sessionId, machineId };
        let connection: ClientConnection;
        if (metadata.clientType === 'session-scoped' && sessionId) {
            connection = {
                connectionType: 'session-scoped',
                socket,
                userId,
                sessionId
            };
        } else if (metadata.clientType === 'machine-scoped' && machineId) {
            connection = {
                connectionType: 'machine-scoped',
                socket,
                userId,
                machineId
            };
        } else {
            connection = {
                connectionType: 'user-scoped',
                socket,
                userId
            };
        }
        eventRouter.addConnection(userId, connection);
        incrementWebSocketConnection(connection.connectionType);

        if (connection.connectionType === 'session-scoped') {
            // Cancel any pending grace-period offline timer for this session.
            // If the session disconnected and reconnected within OFFLINE_GRACE_MS,
            // the DB was never written to active=false — nothing to undo.
            const pendingTimer = disconnectGraceTimers.get(connection.sessionId);
            if (pendingTimer) {
                clearTimeout(pendingTimer);
                disconnectGraceTimers.delete(connection.sessionId);
            }
            await observeSessionActivity(userId, connection.sessionId);
        }

        // Broadcast daemon online status
        if (connection.connectionType === 'machine-scoped') {
            const pendingMachineTimer = machineDisconnectGraceTimers.get(machineDisconnectTimerKey(userId, connection.machineId));
            if (pendingMachineTimer) {
                clearTimeout(pendingMachineTimer);
                machineDisconnectGraceTimers.delete(machineDisconnectTimerKey(userId, connection.machineId));
            }

            try {
                await db.machine.update({
                    where: {
                        accountId_id: {
                            accountId: userId,
                            id: machineId!
                        }
                    },
                    data: {
                        active: true,
                        lastActiveAt: new Date()
                    }
                });
                activityCache.invalidateMachine(connection.machineId);
            } catch (error) {
                log({ module: 'websocket', level: 'error' }, `Error marking machine ${connection.machineId} as online: ${error}`);
            }

            // Broadcast daemon online
            const machineActivity = buildMachineActivityEphemeral(connection.machineId, true, Date.now());
            eventRouter.emitEphemeral({
                userId,
                payload: machineActivity,
                recipientFilter: { type: 'user-scoped-only' }
            });
        }

        socket.on('disconnect', async () => {
            websocketEventsCounter.inc({ event_type: 'disconnect' });

            // Cleanup connections
            eventRouter.removeConnection(userId, connection);
            decrementWebSocketConnection(connection.connectionType);

            log({ module: 'websocket' }, `User disconnected: ${userId}`);

            // Broadcast daemon offline status
            if (connection.connectionType === 'machine-scoped') {
                const machineId = connection.machineId;
                const timerKey = machineDisconnectTimerKey(userId, machineId);
                const existingTimer = machineDisconnectGraceTimers.get(timerKey);
                if (existingTimer) {
                    clearTimeout(existingTimer);
                }

                const timer = setTimeout(async () => {
                    machineDisconnectGraceTimers.delete(timerKey);
                    const disconnectedAt = Date.now();

                    try {
                        await db.machine.update({
                            where: {
                                accountId_id: {
                                    accountId: userId,
                                    id: machineId
                                }
                            },
                            data: {
                                active: false,
                                lastActiveAt: new Date(disconnectedAt)
                            }
                        });
                        activityCache.invalidateMachine(machineId);
                        const machineActivity = buildMachineActivityEphemeral(machineId, false, disconnectedAt);
                        eventRouter.emitEphemeral({
                            userId,
                            payload: machineActivity,
                            recipientFilter: { type: 'user-scoped-only' }
                        });
                        log({ module: 'websocket' }, `Machine ${machineId} marked as offline after grace period`);
                    } catch (error) {
                        log({ module: 'websocket', level: 'error' }, `Error marking machine ${machineId} as offline: ${error}`);
                    }
                }, MACHINE_OFFLINE_GRACE_MS);

                machineDisconnectGraceTimers.set(timerKey, timer);
                log({ module: 'websocket' }, `Machine ${machineId} disconnect grace timer started (${MACHINE_OFFLINE_GRACE_MS}ms)`);
            }

            if (connection.connectionType === 'session-scoped') {
                // Defer the offline write by SESSION_OFFLINE_GRACE_MS.
                // Most Socket.IO disconnects are transient (reconnects within 1-5s);
                // writing active=false immediately causes agents to flicker offline
                // in the kanban even while they're actively executing MCP tools via HTTP.
                const sessionId = connection.sessionId;
                const timer = setTimeout(async () => {
                    disconnectGraceTimers.delete(sessionId);
                    const disconnectedAt = Date.now();
                    try {
                        const updated = await db.session.updateManyAndReturn({
                            where: {
                                id: sessionId,
                                accountId: userId,
                                active: true,
                            },
                            data: {
                                active: false,
                                lastActiveAt: new Date(disconnectedAt),
                            },
                        });

                        if (updated.length > 0) {
                            activityCache.invalidateSession(sessionId);
                            eventRouter.emitEphemeral({
                                userId,
                                payload: buildSessionActivityEphemeral(sessionId, false, disconnectedAt, false),
                                recipientFilter: { type: 'user-scoped-only' },
                            });
                            log({ module: 'websocket' }, `Session ${sessionId} marked as offline after grace period`);
                        }
                    } catch (error) {
                        log({ module: 'websocket', level: 'error' }, `Error marking session ${sessionId} as offline: ${error}`);
                    }
                }, SESSION_OFFLINE_GRACE_MS);
                disconnectGraceTimers.set(sessionId, timer);
                log({ module: 'websocket' }, `Session ${sessionId} disconnect grace timer started (${SESSION_OFFLINE_GRACE_MS}ms)`);
            }
        });

        // Handlers
        let userRpcListeners = rpcListeners.get(userId);
        if (!userRpcListeners) {
            userRpcListeners = new Map<string, Socket>();
            rpcListeners.set(userId, userRpcListeners);
        }
        rpcHandler(userId, socket, userRpcListeners);

        // After rpcHandler registers its disconnect cleanup, register our own to
        // prune the outer rpcListeners map once the user has no RPC listeners left.
        socket.on('disconnect', () => {
            const listeners = rpcListeners.get(userId);
            if (listeners && listeners.size === 0) {
                rpcListeners.delete(userId);
            }
        });
        usageHandler(userId, socket);
        sessionUpdateHandler(userId, socket, connection);
        pingHandler(socket);
        machineUpdateHandler(userId, socket);
        artifactUpdateHandler(userId, socket);
        accessKeyHandler(userId, socket);

        // Ready
        log({ module: 'websocket' }, `User connected: ${userId}`);
    });

    onShutdown('api', async () => {
        for (const timer of disconnectGraceTimers.values()) {
            clearTimeout(timer);
        }
        disconnectGraceTimers.clear();
        for (const timer of machineDisconnectGraceTimers.values()) {
            clearTimeout(timer);
        }
        machineDisconnectGraceTimers.clear();
        await io.close();
    });
}
