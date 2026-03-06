import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Fastify as TypedFastify } from '../types';

const testState = vi.hoisted(() => {
    type Session = {
        id: string;
        tag: string;
        accountId: string;
        metadata: string;
        metadataVersion: number;
        agentState: string | null;
        agentStateVersion: number;
        dataEncryptionKey: Uint8Array | null;
        seq: number;
        active: boolean;
        lastActiveAt: Date;
        createdAt: Date;
        updatedAt: Date;
        // R3 Session Parameters
        displayName: string | null;
        mode: string | null;
        machineId: string | null;
        roleId: string | null;
        rootPathHash: string | null;
    };

    type Machine = {
        id: string;
        accountId: string;
        active: boolean;
        lastActiveAt: Date;
        updatedAt: Date;
    };

    type TeamMember = {
        teamId: string;
        sessionId: string;
        roleId: string | null;
        displayName: string | null;
    };

    type EvidenceEntry = {
        key: string;
        value: string;
    };

    const sessions = new Map<string, Session>();
    const machines = new Map<string, Machine>();
    const teamMembers: TeamMember[] = [];
    const evidenceEntries: EvidenceEntry[] = [];
    let sessionSeq = 0;

    return {
        sessions,
        machines,
        teamMembers,
        evidenceEntries,
        reset() {
            sessions.clear();
            machines.clear();
            teamMembers.length = 0;
            evidenceEntries.length = 0;
            sessionSeq = 0;
        },
        seedSession(userId: string, sessionId: string, overrides: Partial<Session> = {}) {
            sessionSeq++;
            sessions.set(sessionId, {
                id: sessionId,
                tag: `tag-${sessionId}`,
                accountId: userId,
                metadata: '{}',
                metadataVersion: 1,
                agentState: null,
                agentStateVersion: 0,
                dataEncryptionKey: null,
                seq: sessionSeq,
                active: true,
                lastActiveAt: new Date(),
                createdAt: new Date(),
                updatedAt: new Date(),
                displayName: null,
                mode: null,
                machineId: null,
                roleId: null,
                rootPathHash: null,
                ...overrides
            });
        },
        seedMachine(userId: string, machineId: string, overrides: Partial<Machine> = {}) {
            machines.set(machineId, {
                id: machineId,
                accountId: userId,
                active: false,
                lastActiveAt: new Date(Date.now() - 60_000),
                updatedAt: new Date(Date.now() - 60_000),
                ...overrides
            });
        },
        seedTeamMember(teamId: string, sessionId: string, roleId: string | null = null, displayName: string | null = null) {
            teamMembers.push({ teamId, sessionId, roleId, displayName });
        }
    };
});

vi.mock('@/storage/db', () => ({
    db: {
        session: {
            findMany: vi.fn(async ({ where, orderBy, take, select }: any) => {
                let results = Array.from(testState.sessions.values())
                    .filter(s => s.accountId === where.accountId);

                // Apply filters
                if (where.active !== undefined) {
                    results = results.filter(s => s.active === where.active);
                }
                if (where.mode) {
                    results = results.filter(s => s.mode === where.mode);
                }
                if (where.machineId) {
                    results = results.filter(s => s.machineId === where.machineId);
                }
                if (where.roleId) {
                    results = results.filter(s => s.roleId === where.roleId);
                }
                if (where.lastActiveAt?.gt) {
                    results = results.filter(s => s.lastActiveAt > where.lastActiveAt.gt);
                }

                // Sort
                if (orderBy?.updatedAt === 'desc') {
                    results.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
                }
                if (orderBy?.id === 'desc') {
                    results.sort((a, b) => b.id.localeCompare(a.id));
                }

                // Limit
                if (take) {
                    results = results.slice(0, take);
                }

                // Select fields
                if (select) {
                    return results.map(s => {
                        const selected: any = {};
                        for (const key of Object.keys(select)) {
                            selected[key] = (s as Record<string, unknown>)[key];
                        }
                        return selected;
                    });
                }

                return results;
            }),
            findFirst: vi.fn(async ({ where }: any) => {
                if (where.id) {
                    const session = testState.sessions.get(where.id);
                    // Check accountId if provided (for security)
                    if (session && where.accountId && session.accountId !== where.accountId) {
                        return null;
                    }
                    return session || null;
                }
                if (where.accountId && where.tag) {
                    return Array.from(testState.sessions.values())
                        .find(s => s.accountId === where.accountId && s.tag === where.tag) || null;
                }
                return null;
            }),
            create: vi.fn(async ({ data }: any) => {
                const id = `sess-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
                const session = {
                    id,
                    tag: data.tag,
                    accountId: data.accountId,
                    metadata: data.metadata,
                    metadataVersion: 1,
                    agentState: data.agentState || null,
                    agentStateVersion: 0,
                    dataEncryptionKey: data.dataEncryptionKey || null,
                    seq: 1,
                    active: true,
                    lastActiveAt: new Date(),
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    displayName: data.displayName || null,
                    mode: data.mode || null,
                    machineId: data.machineId || null,
                    roleId: data.roleId || null,
                    rootPathHash: data.rootPathHash || null,
                };
                testState.sessions.set(id, session);
                return session;
            }),
            update: vi.fn(async ({ where, data, select }: any) => {
                const session = testState.sessions.get(where.id);
                if (!session) throw new Error('Session not found');

                // Update fields
                Object.assign(session, data, { updatedAt: new Date() });

                if (select) {
                    const selected: any = {};
                    for (const key of Object.keys(select)) {
                        selected[key] = (session as Record<string, unknown>)[key];
                    }
                    return selected;
                }
                return session;
            })
        },
        teamMember: {
            findMany: vi.fn(async ({ where, select }: any) => {
                const rows = testState.teamMembers.filter((member) => member.sessionId === where.sessionId);
                if (!select) {
                    return rows;
                }
                return rows.map((row) => {
                    const selected: any = {};
                    for (const key of Object.keys(select)) {
                        selected[key] = (row as Record<string, unknown>)[key];
                    }
                    return selected;
                });
            })
        },
        simpleCache: {
            create: vi.fn(async ({ data }: any) => {
                testState.evidenceEntries.push({ key: data.key, value: data.value });
                return data;
            })
        },
        machine: {
            updateMany: vi.fn(async ({ where, data }: any) => {
                const machine = testState.machines.get(where.id);
                if (!machine) return { count: 0 };
                if (where.accountId && machine.accountId !== where.accountId) return { count: 0 };

                if (data.active !== undefined) machine.active = data.active;
                if (data.lastActiveAt) machine.lastActiveAt = data.lastActiveAt;
                if (data.updatedAt) machine.updatedAt = data.updatedAt;
                return { count: 1 };
            })
        }
    }
}));

vi.mock('@/storage/seq', () => ({
    allocateUserSeq: vi.fn(async () => 1)
}));

vi.mock('@/utils/randomKeyNaked', () => ({
    randomKeyNaked: vi.fn(() => 'test-key-123')
}));

vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: {
        emitUpdate: vi.fn(),
        emitEphemeral: vi.fn()
    },
    buildNewSessionUpdate: vi.fn(() => ({ type: 'new-session' })),
    buildUpdateSessionUpdate: vi.fn(() => ({ type: 'update-session' })),
    buildSessionActivityEphemeral: vi.fn(() => ({ type: 'activity' }))
}));

vi.mock('@/utils/log', () => ({
    log: vi.fn()
}));

vi.mock('@/utils/teamArtifacts', () => ({
    ensureSessionLinkedToTeam: vi.fn()
}));

vi.mock('@/app/session/sessionDelete', () => ({
    sessionDelete: vi.fn(async () => true)
}));

vi.mock('privacy-kit', () => ({
    default: {}
}));

import { sessionRoutes } from './sessionRoutes';

async function buildApp(defaultUserId = 'user-1') {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as TypedFastify;
    typed.decorate('authenticate', async (request: any) => {
        const headerUserId = request.headers['x-user-id'];
        request.userId = typeof headerUserId === 'string' ? headerUserId : defaultUserId;
    });

    sessionRoutes(typed);
    await typed.ready();
    return typed;
}

describe('Session Routes', () => {
    let app: Awaited<ReturnType<typeof buildApp>>;

    beforeEach(async () => {
        testState.reset();
        app = await buildApp();
    });

    afterEach(async () => {
        await app.close();
    });

    describe('GET /v1/sessions', () => {
        it('should return sessions with R3 params', async () => {
            const userId = 'user-1';
            const sessionId = 'sess-1';

            testState.seedSession(userId, sessionId, {
                displayName: 'Test Session',
                mode: 'codex',
                machineId: 'machine-1',
                roleId: 'builder',
                rootPathHash: 'hash123'
            });

            const res = await app.inject({
                method: 'GET',
                url: '/v1/sessions',
                headers: { 'x-user-id': userId }
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body.sessions).toHaveLength(1);
            expect(body.sessions[0].id).toBe(sessionId);
            expect(body.sessions[0].displayName).toBe('Test Session');
            expect(body.sessions[0].mode).toBe('codex');
            expect(body.sessions[0].machineId).toBe('machine-1');
            expect(body.sessions[0].roleId).toBe('builder');
            expect(body.sessions[0].rootPathHash).toBe('hash123');
        });

        it('should return null R3 params when not set', async () => {
            const userId = 'user-1';
            const sessionId = 'sess-1';

            testState.seedSession(userId, sessionId);

            const res = await app.inject({
                method: 'GET',
                url: '/v1/sessions',
                headers: { 'x-user-id': userId }
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body.sessions[0].displayName).toBeNull();
            expect(body.sessions[0].mode).toBeNull();
            expect(body.sessions[0].machineId).toBeNull();
            expect(body.sessions[0].roleId).toBeNull();
            expect(body.sessions[0].rootPathHash).toBeNull();
        });
    });

    describe('GET /v2/sessions/active', () => {
        it('should return active sessions with R3 params', async () => {
            const userId = 'user-1';
            const sessionId = 'sess-1';

            testState.seedSession(userId, sessionId, {
                displayName: 'Active Session',
                mode: 'claude',
                active: true,
                lastActiveAt: new Date()
            });

            // Inactive session
            testState.seedSession(userId, 'sess-2', {
                displayName: 'Inactive Session',
                active: false
            });

            const res = await app.inject({
                method: 'GET',
                url: '/v2/sessions/active',
                headers: { 'x-user-id': userId }
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body.sessions).toHaveLength(1);
            expect(body.sessions[0].id).toBe(sessionId);
            expect(body.sessions[0].displayName).toBe('Active Session');
            expect(body.sessions[0].mode).toBe('claude');
        });

        it('should respect limit parameter', async () => {
            const userId = 'user-1';

            for (let i = 0; i < 10; i++) {
                testState.seedSession(userId, `sess-${i}`, {
                    active: true,
                    lastActiveAt: new Date()
                });
            }

            const res = await app.inject({
                method: 'GET',
                url: '/v2/sessions/active?limit=5',
                headers: { 'x-user-id': userId }
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body.sessions).toHaveLength(5);
        });
    });

    describe('GET /v2/sessions', () => {
        it('should filter by mode', async () => {
            const userId = 'user-1';

            testState.seedSession(userId, 'sess-1', { mode: 'codex' });
            testState.seedSession(userId, 'sess-2', { mode: 'claude' });
            testState.seedSession(userId, 'sess-3', { mode: 'codex' });

            const res = await app.inject({
                method: 'GET',
                url: '/v2/sessions?mode=codex',
                headers: { 'x-user-id': userId }
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body.sessions).toHaveLength(2);
            expect(body.sessions.every((s: any) => s.mode === 'codex')).toBe(true);
        });

        it('should filter by machineId', async () => {
            const userId = 'user-1';

            testState.seedSession(userId, 'sess-1', { machineId: 'machine-1' });
            testState.seedSession(userId, 'sess-2', { machineId: 'machine-2' });

            const res = await app.inject({
                method: 'GET',
                url: '/v2/sessions?machineId=machine-1',
                headers: { 'x-user-id': userId }
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body.sessions).toHaveLength(1);
            expect(body.sessions[0].machineId).toBe('machine-1');
        });

        it('should filter by roleId', async () => {
            const userId = 'user-1';

            testState.seedSession(userId, 'sess-1', { roleId: 'builder' });
            testState.seedSession(userId, 'sess-2', { roleId: 'architect' });

            const res = await app.inject({
                method: 'GET',
                url: '/v2/sessions?roleId=builder',
                headers: { 'x-user-id': userId }
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body.sessions).toHaveLength(1);
            expect(body.sessions[0].roleId).toBe('builder');
        });
    });

    describe('POST /v1/sessions', () => {
        it('should create session with R3 params', async () => {
            const userId = 'user-1';

            const res = await app.inject({
                method: 'POST',
                url: '/v1/sessions',
                headers: { 'content-type': 'application/json', 'x-user-id': userId },
                payload: {
                    tag: 'test-session',
                    metadata: '{}',
                    displayName: 'My Session',
                    mode: 'codex',
                    machineId: 'machine-1',
                    roleId: 'builder',
                    rootPathHash: 'hash123'
                }
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body.session).toBeDefined();
            expect(body.session.id).toBeDefined();
        });

        it('should return existing session when tag matches', async () => {
            const userId = 'user-1';
            const existingId = 'sess-existing';

            testState.seedSession(userId, existingId, {
                tag: 'existing-tag',
                displayName: 'Existing Session'
            });

            const res = await app.inject({
                method: 'POST',
                url: '/v1/sessions',
                headers: { 'content-type': 'application/json', 'x-user-id': userId },
                payload: {
                    tag: 'existing-tag',
                    metadata: '{}'
                }
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body.session.id).toBe(existingId);
        });
    });

    describe('PATCH /v1/sessions/:sessionId/params', () => {
        it('should update R3 params on existing session', async () => {
            const userId = 'user-1';
            const sessionId = 'sess-1';

            testState.seedSession(userId, sessionId);

            const res = await app.inject({
                method: 'PATCH',
                url: `/v1/sessions/${sessionId}/params`,
                headers: { 'content-type': 'application/json', 'x-user-id': userId },
                payload: {
                    displayName: 'Updated Name',
                    mode: 'ralph',
                    machineId: 'machine-2',
                    roleId: 'architect',
                    rootPathHash: 'newhash'
                }
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body.success).toBe(true);
            expect(body.session.displayName).toBe('Updated Name');
            expect(body.session.mode).toBe('ralph');
            expect(body.session.machineId).toBe('machine-2');
            expect(body.session.roleId).toBe('architect');
            expect(body.session.rootPathHash).toBe('newhash');
        });

        it('should update only provided fields', async () => {
            const userId = 'user-1';
            const sessionId = 'sess-1';

            testState.seedSession(userId, sessionId, {
                displayName: 'Original Name',
                mode: 'claude',
                machineId: 'machine-1'
            });

            const res = await app.inject({
                method: 'PATCH',
                url: `/v1/sessions/${sessionId}/params`,
                headers: { 'content-type': 'application/json', 'x-user-id': userId },
                payload: {
                    displayName: 'New Name'
                }
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body.session.displayName).toBe('New Name');
            // Other fields should remain unchanged
            const updated = testState.sessions.get(sessionId);
            expect(updated?.mode).toBe('claude');
            expect(updated?.machineId).toBe('machine-1');
        });

        it('should return 404 for non-existent session', async () => {
            const res = await app.inject({
                method: 'PATCH',
                url: '/v1/sessions/nonexistent/params',
                headers: { 'content-type': 'application/json', 'x-user-id': 'user-1' },
                payload: { displayName: 'Test' }
            });

            expect(res.statusCode).toBe(404);
            const body = JSON.parse(res.payload);
            expect(body.error).toBe('Session not found');
        });

        it('should return 404 when updating another user\'s session', async () => {
            const userId = 'user-1';
            const otherUserId = 'user-2';
            const sessionId = 'sess-1';

            testState.seedSession(otherUserId, sessionId);

            const res = await app.inject({
                method: 'PATCH',
                url: `/v1/sessions/${sessionId}/params`,
                headers: { 'content-type': 'application/json', 'x-user-id': userId },
                payload: { displayName: 'Test' }
            });

            expect(res.statusCode).toBe(404);
            const body = JSON.parse(res.payload);
            expect(body.error).toBe('Session not found');
        });

        it('should allow clearing R3 params with null', async () => {
            const userId = 'user-1';
            const sessionId = 'sess-1';

            testState.seedSession(userId, sessionId, {
                displayName: 'Test',
                mode: 'claude'
            });

            const res = await app.inject({
                method: 'PATCH',
                url: `/v1/sessions/${sessionId}/params`,
                headers: { 'content-type': 'application/json', 'x-user-id': userId },
                payload: {
                    displayName: '',
                    mode: ''
                }
            });

            expect(res.statusCode).toBe(200);
            const updated = testState.sessions.get(sessionId);
            expect(updated?.displayName).toBeNull();
            expect(updated?.mode).toBeNull();
        });
    });

    describe('Session Lifecycle Routes', () => {
        it('POST /v1/sessions/:sessionId/lifecycle marks session active', async () => {
            const userId = 'user-1';
            const sessionId = 'sess-lifecycle-1';
            const heartbeatTime = Date.now() - 1000;

            testState.seedSession(userId, sessionId, {
                active: false
            });

            const res = await app.inject({
                method: 'POST',
                url: `/v1/sessions/${sessionId}/lifecycle`,
                headers: { 'content-type': 'application/json', 'x-user-id': userId },
                payload: {
                    event: 'heartbeat',
                    timestamp: heartbeatTime,
                    thinking: true,
                    machineId: 'machine-a'
                }
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body.success).toBe(true);
            expect(body.event).toBe('heartbeat');
            expect(body.session.active).toBe(true);
            expect(body.session.machineId).toBe('machine-a');

            const updated = testState.sessions.get(sessionId);
            expect(updated?.active).toBe(true);
            expect(updated?.machineId).toBe('machine-a');
        });

        it('POST /v1/sessions/:sessionId/end marks session inactive', async () => {
            const userId = 'user-1';
            const sessionId = 'sess-lifecycle-2';

            testState.seedSession(userId, sessionId, {
                active: true
            });

            const res = await app.inject({
                method: 'POST',
                url: `/v1/sessions/${sessionId}/end`,
                headers: { 'content-type': 'application/json', 'x-user-id': userId },
                payload: {}
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body.success).toBe(true);
            expect(body.event).toBe('end');
            expect(body.session.active).toBe(false);

            const updated = testState.sessions.get(sessionId);
            expect(updated?.active).toBe(false);
        });

        it('POST /v1/sessions/:sessionId/heartbeat returns 400 on invalid timestamp', async () => {
            const userId = 'user-1';
            const sessionId = 'sess-lifecycle-3';

            testState.seedSession(userId, sessionId);

            const res = await app.inject({
                method: 'POST',
                url: `/v1/sessions/${sessionId}/heartbeat`,
                headers: { 'content-type': 'application/json', 'x-user-id': userId },
                payload: {
                    timestamp: Date.now() + 10 * 60 * 1000
                }
            });

            expect(res.statusCode).toBe(400);
            const body = JSON.parse(res.payload);
            expect(body.error).toBe('Invalid timestamp');
        });

        it('POST /v1/sessions/:sessionId/heartbeat refreshes linked machine presence', async () => {
            const userId = 'user-1';
            const sessionId = 'sess-lifecycle-4';
            const machineId = 'machine-linked';
            const heartbeatTs = Date.now() - 2_000;

            testState.seedSession(userId, sessionId, {
                machineId,
                active: true,
                lastActiveAt: new Date(Date.now() - 60_000)
            });
            testState.seedMachine(userId, machineId, {
                active: false
            });

            const res = await app.inject({
                method: 'POST',
                url: `/v1/sessions/${sessionId}/heartbeat`,
                headers: { 'content-type': 'application/json', 'x-user-id': userId },
                payload: {
                    timestamp: heartbeatTs
                }
            });

            expect(res.statusCode).toBe(200);
            const machine = testState.machines.get(machineId);
            expect(machine?.active).toBe(true);
            expect(machine?.lastActiveAt.getTime()).toBe(heartbeatTs);
        });

        it('POST /v1/sessions/:sessionId/heartbeat records runtime evidence for linked teams', async () => {
            const userId = 'user-1';
            const sessionId = 'sess-lifecycle-5';

            testState.seedSession(userId, sessionId, {
                machineId: 'machine-evidence',
                roleId: 'coordinator'
            });
            testState.seedTeamMember('team-1', sessionId, 'coordinator', 'Coordinator');

            const res = await app.inject({
                method: 'POST',
                url: `/v1/sessions/${sessionId}/heartbeat`,
                headers: { 'content-type': 'application/json', 'x-user-id': userId },
                payload: {
                    timestamp: Date.now(),
                    thinking: true,
                    machineId: 'machine-evidence'
                }
            });

            expect(res.statusCode).toBe(200);
            expect(testState.evidenceEntries).toHaveLength(1);
            expect(testState.evidenceEntries[0].key).toContain('evidence:team:team-1:');
        });
    });
});
