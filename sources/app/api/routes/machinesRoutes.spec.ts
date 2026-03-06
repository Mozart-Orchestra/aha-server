import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Fastify as TypedFastify } from '../types';

const testState = vi.hoisted(() => {
    type Machine = {
        id: string;
        accountId: string;
        metadata: string;
        metadataVersion: number;
        daemonState: string | null;
        daemonStateVersion: number;
        dataEncryptionKey: Uint8Array | null;
        seq: number;
        active: boolean;
        lastActiveAt: Date;
        createdAt: Date;
        updatedAt: Date;
    };

    type Session = {
        id: string;
        accountId: string;
        machineId: string | null;
        active: boolean;
        lastActiveAt: Date;
    };

    const machines = new Map<string, Machine>();
    const sessions = new Map<string, Session>();

    return {
        machines,
        sessions,
        reset() {
            machines.clear();
            sessions.clear();
        },
        seedMachine(userId: string, machineId: string, overrides: Partial<Machine> = {}) {
            machines.set(machineId, {
                id: machineId,
                accountId: userId,
                metadata: '{}',
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                dataEncryptionKey: null,
                seq: 1,
                active: true,
                lastActiveAt: new Date(),
                createdAt: new Date(),
                updatedAt: new Date(),
                ...overrides
            });
        },
        seedSession(
            userId: string,
            sessionId: string,
            machineId: string | null,
            active: boolean,
            overrides: Partial<Session> = {}
        ) {
            sessions.set(sessionId, {
                id: sessionId,
                accountId: userId,
                machineId,
                active,
                lastActiveAt: new Date(),
                ...overrides
            });
        }
    };
});

vi.mock('@/storage/db', () => ({
    db: {
        machine: {
            findFirst: vi.fn(async ({ where, select }: any) => {
                let machine = testState.machines.get(where.id) || null;
                if (machine && where.accountId && machine.accountId !== where.accountId) {
                    machine = null;
                }
                if (!machine) return null;
                if (!select) return machine;
                const picked: any = {};
                for (const key of Object.keys(select)) picked[key] = (machine as any)[key];
                return picked;
            }),
            findMany: vi.fn(async ({ where, orderBy, select }: any) => {
                let rows = Array.from(testState.machines.values())
                    .filter((m) => m.accountId === where.accountId);
                if (orderBy?.lastActiveAt === 'desc') {
                    rows = rows.sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime());
                }
                if (!select) return rows;
                return rows.map((row) => {
                    const picked: any = {};
                    for (const key of Object.keys(select)) picked[key] = (row as any)[key];
                    return picked;
                });
            }),
            create: vi.fn(async ({ data }: any) => {
                const machine = {
                    id: data.id,
                    accountId: data.accountId,
                    metadata: data.metadata,
                    metadataVersion: data.metadataVersion || 1,
                    daemonState: data.daemonState || null,
                    daemonStateVersion: data.daemonStateVersion || 0,
                    dataEncryptionKey: data.dataEncryptionKey || null,
                    seq: 1,
                    active: data.active ?? true,
                    lastActiveAt: new Date(),
                    createdAt: new Date(),
                    updatedAt: new Date()
                };
                testState.machines.set(machine.id, machine);
                return machine;
            }),
            update: vi.fn(async ({ where, data }: any) => {
                const machine = testState.machines.get(where.id);
                if (!machine) throw new Error('Machine not found');

                const next = { ...machine, ...data, updatedAt: new Date() } as any;
                if (data?.daemonStateVersion?.increment) {
                    next.daemonStateVersion = machine.daemonStateVersion + data.daemonStateVersion.increment;
                }
                if (data?.lastActiveAt) {
                    next.lastActiveAt = data.lastActiveAt;
                }
                if (data?.active !== undefined) {
                    next.active = data.active;
                }
                if (data?.daemonState !== undefined) {
                    next.daemonState = data.daemonState;
                }

                testState.machines.set(where.id, next);
                return next;
            })
        },
        session: {
            findMany: vi.fn(async ({ where, select }: any) => {
                let rows = Array.from(testState.sessions.values());
                if (where.accountId) rows = rows.filter((s) => s.accountId === where.accountId);
                if (where.active !== undefined) rows = rows.filter((s) => s.active === where.active);

                if (where.machineId?.in) {
                    const set = new Set(where.machineId.in);
                    rows = rows.filter((s) => s.machineId && set.has(s.machineId));
                } else if (typeof where.machineId === 'string') {
                    rows = rows.filter((s) => s.machineId === where.machineId);
                }

                if (where.id?.in) {
                    const set = new Set(where.id.in);
                    rows = rows.filter((s) => set.has(s.id));
                }
                if (where.lastActiveAt?.gte) {
                    rows = rows.filter((s) => s.lastActiveAt >= where.lastActiveAt.gte);
                }

                if (!select) return rows;
                return rows.map((row) => {
                    const picked: any = {};
                    for (const key of Object.keys(select)) picked[key] = (row as any)[key];
                    return picked;
                });
            }),
            updateMany: vi.fn(async ({ where, data }: any) => {
                let count = 0;
                const idSet = new Set(where.id?.in || []);
                for (const session of testState.sessions.values()) {
                    if (session.accountId !== where.accountId) continue;
                    if (!idSet.has(session.id)) continue;
                    if (data.active !== undefined) session.active = data.active;
                    if (data.lastActiveAt) session.lastActiveAt = data.lastActiveAt;
                    if (data.machineId !== undefined) session.machineId = data.machineId;
                    count += 1;
                }
                return { count };
            })
        }
    }
}));

vi.mock('@/storage/seq', () => ({
    allocateUserSeq: vi.fn(async () => 1)
}));

vi.mock('@/utils/randomKeyNaked', () => ({
    randomKeyNaked: vi.fn(() => 'machine-event-id')
}));

vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: {
        emitUpdate: vi.fn(),
        emitEphemeral: vi.fn()
    },
    buildNewMachineUpdate: vi.fn((machine: any) => ({
        id: 'new-machine-update',
        seq: 1,
        body: { t: 'new-machine', machineId: machine.id },
        createdAt: Date.now()
    })),
    buildUpdateMachineUpdate: vi.fn((machineId: string) => ({
        id: 'update-machine-update',
        seq: 2,
        body: { t: 'update-machine', machineId },
        createdAt: Date.now()
    })),
    buildMachineActivityEphemeral: vi.fn((machineId: string, active: boolean, activeAt: number) => ({
        type: 'machine-activity',
        id: machineId,
        active,
        activeAt
    }))
}));

vi.mock('@/utils/log', () => ({
    log: vi.fn()
}));

import { machinesRoutes } from './machinesRoutes';
import { clearDaemonControlRegistry, registerDaemonControlSocket } from '@/app/api/socket/daemonControlRegistry';

async function buildApp(defaultUserId = 'user-1') {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as TypedFastify;
    typed.decorate('authenticate', async (request: any) => {
        const headerUserId = request.headers['x-user-id'];
        request.userId = typeof headerUserId === 'string' ? headerUserId : defaultUserId;
    });

    machinesRoutes(typed);
    await typed.ready();
    return typed;
}

describe('machines routes', () => {
    let app: Awaited<ReturnType<typeof buildApp>>;

    beforeEach(async () => {
        testState.reset();
        app = await buildApp();
    });

    afterEach(async () => {
        clearDaemonControlRegistry();
        await app.close();
    });

    it('GET /v1/machines/presence returns machine summary', async () => {
        const userId = 'user-1';
        testState.seedMachine(userId, 'machine-1', {
            active: true,
            lastActiveAt: new Date(Date.now() - 5_000)
        });
        testState.seedMachine(userId, 'machine-2', {
            active: false,
            lastActiveAt: new Date(Date.now() - 1_000_000)
        });
        testState.seedSession(userId, 'sess-1', 'machine-1', true);

        const res = await app.inject({
            method: 'GET',
            url: '/v1/machines/presence',
            headers: { 'x-user-id': userId }
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.machines).toHaveLength(2);
        expect(body.summary.total).toBe(2);
        expect(body.summary.online).toBe(1);
        expect(body.summary.activeSessions).toBe(1);
    });

    it('GET /v1/machines/presence excludes stale sessions from activeSessionCount', async () => {
        const userId = 'user-1';
        testState.seedMachine(userId, 'machine-1', {
            active: true,
            lastActiveAt: new Date(Date.now() - 1_000)
        });
        testState.seedSession(userId, 'sess-fresh', 'machine-1', true);
        testState.seedSession(userId, 'sess-stale', 'machine-1', true, {
            lastActiveAt: new Date(Date.now() - 10 * 60 * 1000)
        });

        const res = await app.inject({
            method: 'GET',
            url: '/v1/machines/presence?windowSec=120',
            headers: { 'x-user-id': userId }
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.summary.activeSessions).toBe(1);
        expect(body.machines[0].activeSessionCount).toBe(1);
    });

    it('POST /v1/machines/:id/heartbeat updates sessions and daemon pid', async () => {
        const userId = 'user-1';
        testState.seedMachine(userId, 'machine-1', { active: false });
        testState.seedSession(userId, 'sess-1', 'machine-1', false);
        testState.seedSession(userId, 'sess-2', 'machine-1', false);

        const res = await app.inject({
            method: 'POST',
            url: '/v1/machines/machine-1/heartbeat',
            headers: { 'content-type': 'application/json', 'x-user-id': userId },
            payload: {
                status: 'active',
                sessions: ['sess-1', 'sess-2'],
                daemonPid: 48231
            }
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.success).toBe(true);
        expect(body.updatedSessions).toBe(2);
        expect(body.machine.daemonPid).toBe(48231);
        expect(testState.sessions.get('sess-1')?.active).toBe(true);
        expect(testState.sessions.get('sess-2')?.active).toBe(true);
    });


    it('POST /v1/machines/:id/heartbeat accepts daemon-only CLI payload without overwriting daemon state', async () => {
        const userId = 'user-1';
        testState.seedMachine(userId, 'machine-1', {
            active: false,
            daemonState: 'encrypted-daemon-state',
            daemonStateVersion: 7,
        });

        const res = await app.inject({
            method: 'POST',
            url: '/v1/machines/machine-1/heartbeat',
            headers: { 'content-type': 'application/json', 'x-user-id': userId },
            payload: {
                status: 'online',
                activeSessions: 0,
                daemonPid: 48231,
                daemonHttpPort: 9123,
                time: 1_700_000_000_000,
            }
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.success).toBe(true);
        expect(body.updatedSessions).toBe(0);
        expect(body.machine.status).toBe('online');
        expect(body.machine.daemonPid).toBe(48231);
        expect(testState.machines.get('machine-1')?.active).toBe(true);
        expect(testState.machines.get('machine-1')?.daemonState).toBe('encrypted-daemon-state');
        expect(testState.machines.get('machine-1')?.daemonStateVersion).toBe(7);
    });

    it('POST /v1/machines/:id/heartbeat can mark a machine inactive when shutting down', async () => {
        const userId = 'user-1';
        testState.seedMachine(userId, 'machine-1', { active: true });

        const res = await app.inject({
            method: 'POST',
            url: '/v1/machines/machine-1/heartbeat',
            headers: { 'content-type': 'application/json', 'x-user-id': userId },
            payload: {
                status: 'shutting-down',
                daemonPid: 48231,
            }
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.machine.active).toBe(false);
        expect(body.machine.status).toBe('shutting-down');
        expect(testState.machines.get('machine-1')?.active).toBe(false);
    });

    it('POST /v1/machines/:id/heartbeat associates listed sessions to machine', async () => {
        const userId = 'user-1';
        testState.seedMachine(userId, 'machine-1', { active: false });
        testState.seedSession(userId, 'sess-a', null, false);
        testState.seedSession(userId, 'sess-b', null, false);

        const heartbeatRes = await app.inject({
            method: 'POST',
            url: '/v1/machines/machine-1/heartbeat',
            headers: { 'content-type': 'application/json', 'x-user-id': userId },
            payload: {
                sessions: ['sess-a', 'sess-b']
            }
        });

        expect(heartbeatRes.statusCode).toBe(200);
        expect(testState.sessions.get('sess-a')?.machineId).toBe('machine-1');
        expect(testState.sessions.get('sess-b')?.machineId).toBe('machine-1');

        const presenceRes = await app.inject({
            method: 'GET',
            url: '/v1/machines/presence',
            headers: { 'x-user-id': userId }
        });

        expect(presenceRes.statusCode).toBe(200);
        const body = JSON.parse(presenceRes.payload);
        expect(body.summary.activeSessions).toBe(2);
        expect(body.machines[0].activeSessionCount).toBe(2);
    });

    it('POST /v1/machines/:id/sessions/spawn relays to the target daemon', async () => {
        const userId = 'user-1';
        const machineId = 'machine-1';
        testState.seedMachine(userId, machineId, {
            active: true,
            lastActiveAt: new Date(Date.now() - 1_000)
        });

        const mockSocket = {
            connected: true,
            timeout: vi.fn().mockReturnValue({
                emitWithAck: vi.fn().mockResolvedValue({ success: true, sessionId: 'sess-remote-1' })
            })
        };
        registerDaemonControlSocket(userId, machineId, mockSocket as any);

        const res = await app.inject({
            method: 'POST',
            url: `/v1/machines/${machineId}/sessions/spawn`,
            headers: { 'content-type': 'application/json', 'x-user-id': userId },
            payload: {
                directory: '/tmp/project',
                agent: 'codex',
                sessionName: 'Remote Session'
            }
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.success).toBe(true);
        expect(body.machineId).toBe(machineId);
        expect(body.sessionId).toBe('sess-remote-1');
    });

    it('POST /v1/machines/:id/sessions/:sessionId/stop relays to the target daemon and marks session inactive', async () => {
        const userId = 'user-1';
        const machineId = 'machine-1';
        const sessionId = 'sess-remote-1';
        testState.seedMachine(userId, machineId, {
            active: true,
            lastActiveAt: new Date(Date.now() - 1_000)
        });
        testState.seedSession(userId, sessionId, machineId, true);

        const mockSocket = {
            connected: true,
            timeout: vi.fn().mockReturnValue({
                emitWithAck: vi.fn().mockResolvedValue({ success: true, sessionId, status: 'stopping' })
            })
        };
        registerDaemonControlSocket(userId, machineId, mockSocket as any);

        const res = await app.inject({
            method: 'POST',
            url: `/v1/machines/${machineId}/sessions/${sessionId}/stop`,
            headers: { 'content-type': 'application/json', 'x-user-id': userId },
            payload: { graceful: true }
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.success).toBe(true);
        expect(body.machineId).toBe(machineId);
        expect(body.sessionId).toBe(sessionId);
        expect(body.status).toBe('stopping');
        expect(testState.sessions.get(sessionId)?.active).toBe(false);
    });
});
