import { Socket } from "socket.io";

interface DaemonControlRequest {
    method: string;
    params?: Record<string, unknown>;
}

interface DaemonControlResult {
    ok: boolean;
    result?: unknown;
    error?: string;
}

const daemonControlSockets = new Map<string, Map<string, Socket>>();
const DAEMON_CONTROL_TIMEOUT_MS = 30_000;

export function registerDaemonControlSocket(userId: string, machineId: string, socket: Socket): void {
    let userSockets = daemonControlSockets.get(userId);
    if (!userSockets) {
        userSockets = new Map<string, Socket>();
        daemonControlSockets.set(userId, userSockets);
    }
    userSockets.set(machineId, socket);
}

export function unregisterDaemonControlSocket(userId: string, machineId: string, socket?: Socket): void {
    const userSockets = daemonControlSockets.get(userId);
    if (!userSockets) {
        return;
    }

    if (socket) {
        const currentSocket = userSockets.get(machineId);
        if (currentSocket && currentSocket !== socket) {
            return;
        }
    }

    userSockets.delete(machineId);
    if (userSockets.size === 0) {
        daemonControlSockets.delete(userId);
    }
}

export async function sendDaemonControl(
    userId: string,
    machineId: string,
    request: DaemonControlRequest
): Promise<DaemonControlResult> {
    const userSockets = daemonControlSockets.get(userId);
    if (!userSockets) {
        return { ok: false, error: 'No daemon connected' };
    }

    const socket = userSockets.get(machineId);
    if (!socket || !socket.connected) {
        return {
            ok: false,
            error: `Machine ${machineId} is not connected to daemon control`
        };
    }

    try {
        const response = await socket.timeout(DAEMON_CONTROL_TIMEOUT_MS).emitWithAck('daemon-control-request', {
            method: request.method,
            params: request.params || {}
        });
        return { ok: true, result: response };
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Daemon control request failed'
        };
    }
}

export function clearDaemonControlRegistry(): void {
    daemonControlSockets.clear();
}
