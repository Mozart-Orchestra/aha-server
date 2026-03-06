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
        displayName: string | null;
        mode: string | null;
        machineId: string | null;
        roleId: string | null;
        rootPathHash: string | null;
        active: boolean;
        lastActiveAt: Date;
        createdAt: Date;
    };

    type Team = {
        id: string;
        accountId: string;
        name: string;
    };

    type TeamMember = {
        id: string;
        teamId: string;
        sessionId: string;
        roleId: string;
        displayName: string | null;
    };

    type TeamRole = {
        id: string;
        teamId: string;
        name: string;
    };

    type Machine = {
        id: string;
        accountId: string;
        active: boolean;
        lastActiveAt: Date;
    };

    const sessions = new Map<string, Session>();
    const teams = new Map<string, Team>();
    const teamMembers = new Map<string, TeamMember>();
    const teamRoles = new Map<string, TeamRole>();
    const machines = new Map<string, Machine>();

    return {
        sessions,
        teams,
        teamMembers,
        teamRoles,
        machines,
        reset() {
            sessions.clear();
            teams.clear();
            teamMembers.clear();
            teamRoles.clear();
            machines.clear();
        },
        seedTeam(userId: string, teamId: string) {
            teams.set(teamId, { id: teamId, accountId: userId, name: 'Test Team' });
        },
        seedTeamRole(teamId: string, roleId: string, name: string) {
            teamRoles.set(`${teamId}-${roleId}`, { id: roleId, teamId, name });
        },
        seedMachine(userId: string, machineId: string, active = true) {
            machines.set(machineId, {
                id: machineId,
                accountId: userId,
                active,
                lastActiveAt: new Date()
            });
        }
    };
});

vi.mock('@/storage/db', () => ({
    db: {
        session: {
            create: vi.fn(async ({ data }: any) => {
                const session = {
                    id: data.id || `sess-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
                    tag: data.tag,
                    accountId: data.accountId,
                    metadata: data.metadata,
                    metadataVersion: data.metadataVersion || 1,
                    displayName: data.displayName || null,
                    mode: data.mode || null,
                    machineId: data.machineId || null,
                    roleId: data.roleId || null,
                    rootPathHash: data.rootPathHash || null,
                    active: data.active ?? true,
                    lastActiveAt: data.lastActiveAt || new Date(),
                    createdAt: new Date()
                };
                testState.sessions.set(session.id, session);
                return session;
            }),
            update: vi.fn(async ({ where, data }: any) => {
                const session = testState.sessions.get(where.id);
                if (!session) throw new Error('Session not found');
                if (data.active !== undefined) session.active = data.active;
                if (data.lastActiveAt !== undefined) session.lastActiveAt = data.lastActiveAt;
                return session;
            }),
            findMany: vi.fn(async ({ where, select }: any) => {
                let sessions = Array.from(testState.sessions.values());
                if (where?.accountId) {
                    sessions = sessions.filter(s => s.accountId === where.accountId);
                }
                if (where?.machineId) {
                    sessions = sessions.filter(s => s.machineId === where.machineId);
                }
                if (where?.active !== undefined) {
                    sessions = sessions.filter(s => s.active === where.active);
                }

                if (!select) return sessions;
                return sessions.map((session) => {
                    const picked: any = {};
                    for (const key of Object.keys(select)) {
                        picked[key] = (session as Record<string, unknown>)[key];
                    }
                    return picked;
                });
            }),
            findFirst: vi.fn(async ({ where }: any) => {
                return testState.sessions.get(where.id) || null;
            })
        },
        team: {
            findFirst: vi.fn(async ({ where, include }: any) => {
                const team = testState.teams.get(where.id);
                if (!team) return null;

                const members = Array.from(testState.teamMembers.values())
                    .filter(m => m.teamId === team.id)
                    .map(m => ({
                        ...m,
                        session: testState.sessions.get(m.sessionId)
                    }));

                return {
                    ...team,
                    members,
                    _count: { members: members.length }
                };
            })
        },
        teamMember: {
            create: vi.fn(async ({ data }: any) => {
                const member = {
                    id: `tm-${Date.now()}`,
                    teamId: data.teamId,
                    sessionId: data.sessionId,
                    roleId: data.roleId,
                    displayName: data.displayName || null
                };
                testState.teamMembers.set(member.id, member);
                return member;
            }),
            findFirst: vi.fn(async ({ where, include }: any) => {
                // Handle nested team.accountId check - access teamId from the top level
                if (where.team && where.team.accountId) {
                    const team = testState.teams.get(where.teamId);
                    if (!team || team.accountId !== where.team.accountId) return null;
                }

                // If no teamId or sessionId in where, return null
                if (!where.teamId || !where.sessionId) return null;

                const member = Array.from(testState.teamMembers.values()).find(m =>
                    m.teamId === where.teamId && m.sessionId === where.sessionId
                );

                if (!member) return null;

                // Handle include: { session: true }
                if (include?.session) {
                    const session = testState.sessions.get(member.sessionId);
                    return { ...member, session: session || null };
                }

                return member;
            })
        },
        teamRole: {
            findFirst: vi.fn(async ({ where }: any) => {
                return testState.teamRoles.get(`${where.teamId}-${where.id}`) || null;
            })
        },
        machine: {
            findFirst: vi.fn(async ({ where }: any) => {
                return Array.from(testState.machines.values()).find(m =>
                    m.id === where.id && m.accountId === where.accountId
                ) || null;
            })
        }
    }
}));

vi.mock('@/utils/log', () => ({
    log: vi.fn()
}));

import { runtimeAgentRoutes } from './runtimeAgentRoutes';
import { clearDaemonControlRegistry, registerDaemonControlSocket } from '@/app/api/socket/daemonControlRegistry';

// Create a mock socket that returns success for RPC
// The actual code uses: socket.timeout(ms).emitWithAck('rpc-request', { method, params })
function createMockSocket(response: any = { status: 'spawning', sessionId: 'mock-session' }) {
    const mockEmit = vi.fn().mockResolvedValue(response);
    return {
        connected: true,
        timeout: vi.fn().mockReturnValue({
            emitWithAck: mockEmit
        }),
        emitWithAck: mockEmit,  // Some calls bypass timeout
        __emitWithAck: mockEmit
    };
}

async function buildApp(defaultUserId = 'user-1') {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as TypedFastify;
    typed.decorate('authenticate', async (request: any) => {
        const headerUserId = request.headers['x-user-id'];
        request.userId = typeof headerUserId === 'string' ? headerUserId : defaultUserId;
    });

    runtimeAgentRoutes(typed);
    await typed.ready();
    return typed;
}

describe('runtime agent management', () => {
    let app: Awaited<ReturnType<typeof buildApp>>;

    beforeEach(async () => {
        testState.reset();
        app = await buildApp();
    });

    afterEach(async () => {
        clearDaemonControlRegistry();
        await app.close();
    });

    it('POST /agents/spawn creates session and returns session info', async () => {
        const userId = 'user-1';
        const teamId = 'team-abc';
        const machineId = 'machine-1';

        testState.seedTeam(userId, teamId);
        testState.seedTeamRole(teamId, 'builder', 'Builder Role');
        testState.seedMachine(userId, machineId);

        // Register mock daemon RPC socket
        const mockSocket = createMockSocket();
        registerDaemonControlSocket(userId, machineId, mockSocket as any);

        const res = await app.inject({
            method: 'POST',
            url: `/v1/teams/${teamId}/agents/spawn`,
            headers: { 'content-type': 'application/json', 'x-user-id': userId },
            payload: { roleId: 'builder', mode: 'codex', machineId }
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.sessions).toHaveLength(1);
        expect(body.sessions[0].roleId).toBe('builder');
        expect(body.sessions[0].mode).toBe('codex');
        expect(body.sessions[0].machineId).toBe(machineId);
        expect(body.sessions[0].status).toBe('spawning');
        expect(body.spawnedAt).toBeDefined();
        expect((mockSocket as any).__emitWithAck).toHaveBeenCalledWith(
            'daemon-control-request',
            expect.objectContaining({
                method: 'add-team-agent',
                params: expect.objectContaining({
                    machineId,
                    roleId: 'builder',
                    mode: 'codex'
                })
            })
        );
    });

    it('POST /agents/spawn returns 502 and marks the session inactive when daemon control reports an error', async () => {
        const userId = 'user-1';
        const teamId = 'team-abc';
        const machineId = 'machine-1';

        testState.seedTeam(userId, teamId);
        testState.seedTeamRole(teamId, 'builder', 'Builder Role');
        testState.seedMachine(userId, machineId);

        const mockSocket = createMockSocket({ error: 'directory-creation-required', directory: '/tmp/project' });
        registerDaemonControlSocket(userId, machineId, mockSocket as any);

        const res = await app.inject({
            method: 'POST',
            url: `/v1/teams/${teamId}/agents/spawn`,
            headers: { 'content-type': 'application/json', 'x-user-id': userId },
            payload: { roleId: 'builder', mode: 'codex', machineId, rootPath: '/tmp/project' }
        });

        expect(res.statusCode).toBe(502);
        const body = JSON.parse(res.payload);
        expect(body.error).toBe('spawn_failed');
        expect(body.machineId).toBe(machineId);
        expect(body.directory).toBe('/tmp/project');
        expect(body.sessions).toHaveLength(1);
        expect(body.sessions[0].status).toBe('error');
        expect(body.sessions[0].error).toBe('directory-creation-required');

        const [createdSession] = Array.from(testState.sessions.values());
        expect(createdSession?.active).toBe(false);
    });

    it('POST /agents/spawn returns 404 for non-existent team', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/v1/teams/nonexistent/agents/spawn',
            headers: { 'content-type': 'application/json', 'x-user-id': 'user-1' },
            payload: { roleId: 'builder', mode: 'codex' }
        });

        expect(res.statusCode).toBe(404);
        const body = JSON.parse(res.payload);
        expect(body.error).toBe('team_not_found');
    });

    it('POST /agents/spawn returns 400 for invalid role', async () => {
        const userId = 'user-1';
        const teamId = 'team-abc';

        testState.seedTeam(userId, teamId);

        const res = await app.inject({
            method: 'POST',
            url: `/v1/teams/${teamId}/agents/spawn`,
            headers: { 'content-type': 'application/json', 'x-user-id': userId },
            payload: { roleId: 'nonexistent', mode: 'codex' }
        });

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.payload);
        expect(body.error).toBe('invalid_role');
    });

    it('POST /agents/spawn returns 400 for offline machine', async () => {
        const userId = 'user-1';
        const teamId = 'team-abc';

        testState.seedTeam(userId, teamId);
        testState.seedTeamRole(teamId, 'builder', 'Builder Role');

        const res = await app.inject({
            method: 'POST',
            url: `/v1/teams/${teamId}/agents/spawn`,
            headers: { 'content-type': 'application/json', 'x-user-id': userId },
            payload: { roleId: 'builder', mode: 'codex', machineId: 'nonexistent' }
        });

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.payload);
        expect(body.error).toBe('machine_offline');
    });

    it('POST /agents/:id/stop marks session inactive', async () => {
        const userId = 'user-1';
        const teamId = 'team-abc';
        const machineId = 'machine-1';
        const sessionId = 'sess-123';

        testState.seedTeam(userId, teamId);
        testState.seedTeamRole(teamId, 'builder', 'Builder Role');
        testState.seedMachine(userId, machineId);

        // Create a session and team member
        testState.sessions.set(sessionId, {
            id: sessionId,
            tag: 'test-tag',
            accountId: userId,
            metadata: '{}',
            metadataVersion: 1,
            displayName: 'Test Agent',
            mode: 'codex',
            machineId,
            roleId: 'builder',
            rootPathHash: null,
            active: true,
            lastActiveAt: new Date(),
            createdAt: new Date()
        });

        testState.teamMembers.set('tm-1', {
            id: 'tm-1',
            teamId,
            sessionId,
            roleId: 'builder',
            displayName: 'Test Agent'
        });

        const mockSocket = createMockSocket({ status: 'stopping', sessionId });
        registerDaemonControlSocket(userId, machineId, mockSocket as any);

        const res = await app.inject({
            method: 'POST',
            url: `/v1/teams/${teamId}/agents/${sessionId}/stop`,
            headers: { 'content-type': 'application/json', 'x-user-id': userId },
            payload: { graceful: true }
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.status).toBe('stopping');
        expect(body.sessionId).toBe(sessionId);
        expect(body.stoppedAt).toBeDefined();
        expect(testState.sessions.get(sessionId)?.active).toBe(false);
    });

    it('POST /agents/:id/stop returns 503 and leaves the session active when daemon control is unavailable', async () => {
        const userId = 'user-1';
        const teamId = 'team-abc';
        const machineId = 'machine-1';
        const sessionId = 'sess-keep-running';

        testState.seedTeam(userId, teamId);
        testState.seedMachine(userId, machineId);
        testState.sessions.set(sessionId, {
            id: sessionId,
            tag: 'test-tag',
            accountId: userId,
            metadata: '{}',
            metadataVersion: 1,
            displayName: 'Test Agent',
            mode: 'codex',
            machineId,
            roleId: 'builder',
            rootPathHash: null,
            active: true,
            lastActiveAt: new Date(),
            createdAt: new Date()
        });
        testState.teamMembers.set('tm-stop-fail', {
            id: 'tm-stop-fail',
            teamId,
            sessionId,
            roleId: 'builder',
            displayName: 'Test Agent'
        });

        const res = await app.inject({
            method: 'POST',
            url: `/v1/teams/${teamId}/agents/${sessionId}/stop`,
            headers: { 'content-type': 'application/json', 'x-user-id': userId },
            payload: { graceful: true }
        });

        expect(res.statusCode).toBe(503);
        const body = JSON.parse(res.payload);
        expect(body.error).toBe('rpc_failed');
        expect(testState.sessions.get(sessionId)?.active).toBe(true);
    });

    it('POST /agents/:id/stop returns 404 for non-existent agent', async () => {
        const userId = 'user-1';
        const teamId = 'team-abc';

        testState.seedTeam(userId, teamId);

        const res = await app.inject({
            method: 'POST',
            url: `/v1/teams/${teamId}/agents/nonexistent/stop`,
            headers: { 'content-type': 'application/json', 'x-user-id': userId },
            payload: {}
        });

        expect(res.statusCode).toBe(404);
        const body = JSON.parse(res.payload);
        expect(body.error).toBe('agent_not_found');
    });

    it('GET /agents returns agent list with summary', async () => {
        const userId = 'user-1';
        const teamId = 'team-abc';
        const sessionId = 'sess-123';

        testState.seedTeam(userId, teamId);

        // Create a session and team member
        testState.sessions.set(sessionId, {
            id: sessionId,
            tag: 'test-tag',
            accountId: userId,
            metadata: '{}',
            metadataVersion: 1,
            displayName: 'Test Agent',
            mode: 'codex',
            machineId: 'machine-1',
            roleId: 'builder',
            rootPathHash: null,
            active: true,
            lastActiveAt: new Date(),
            createdAt: new Date()
        });

        testState.teamMembers.set('tm-1', {
            id: 'tm-1',
            teamId,
            sessionId,
            roleId: 'builder',
            displayName: 'Test Agent'
        });

        const res = await app.inject({
            method: 'GET',
            url: `/v1/teams/${teamId}/agents`,
            headers: { 'x-user-id': userId }
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.agents).toHaveLength(1);
        expect(body.agents[0]).toHaveProperty('status');
        expect(body.agents[0].sessionId).toBe(sessionId);
        expect(body.summary).toBeDefined();
        expect(body.summary.total).toBe(1);
    });

    it('GET /agents returns empty list for non-existent team', async () => {
        const res = await app.inject({
            method: 'GET',
            url: '/v1/teams/nonexistent/agents',
            headers: { 'x-user-id': 'user-1' }
        });

        expect(res.statusCode).toBe(404);
        const body = JSON.parse(res.payload);
        expect(body.error).toBe('team_not_found');
    });

    it('POST /agents/:id/pause returns 400 for non-running agent', async () => {
        const userId = 'user-1';
        const teamId = 'team-abc';
        const sessionId = 'sess-pause-123';

        testState.seedTeam(userId, teamId);

        // Create inactive session
        testState.sessions.set(sessionId, {
            id: sessionId,
            tag: 'test-tag',
            accountId: userId,
            metadata: '{}',
            metadataVersion: 1,
            displayName: 'Test Agent',
            mode: 'codex',
            machineId: 'machine-1',
            roleId: 'builder',
            rootPathHash: null,
            active: false,
            lastActiveAt: new Date(),
            createdAt: new Date()
        });

        testState.teamMembers.set('tm-1', {
            id: 'tm-1',
            teamId,
            sessionId,
            roleId: 'builder',
            displayName: 'Test Agent'
        });

        const res = await app.inject({
            method: 'POST',
            url: `/v1/teams/${teamId}/agents/${sessionId}/pause`,
            headers: { 'x-user-id': userId }
        });

        expect(res.statusCode).toBe(400);
        const body = JSON.parse(res.payload);
        expect(body.error).toBe('invalid_state');
    });

    it('POST /agents/:id/resume returns 404 for non-existent agent', async () => {
        const userId = 'user-1';
        const teamId = 'team-abc';

        testState.seedTeam(userId, teamId);

        const res = await app.inject({
            method: 'POST',
            url: `/v1/teams/${teamId}/agents/nonexistent/resume`,
            headers: { 'content-type': 'application/json', 'x-user-id': userId },
            payload: {}
        });

        expect(res.statusCode).toBe(404);
        const body = JSON.parse(res.payload);
        expect(body.error).toBe('agent_not_found');
    });

    it('POST /v1/agent-status updates active session state', async () => {
        const userId = 'user-1';
        const teamId = 'team-abc';
        const sessionId = 'sess-status-1';

        testState.seedTeam(userId, teamId);
        testState.sessions.set(sessionId, {
            id: sessionId,
            tag: 'status-tag',
            accountId: userId,
            metadata: '{}',
            metadataVersion: 1,
            displayName: 'Status Agent',
            mode: 'codex',
            machineId: 'machine-1',
            roleId: 'builder',
            rootPathHash: null,
            active: true,
            lastActiveAt: new Date(),
            createdAt: new Date()
        });

        const res = await app.inject({
            method: 'POST',
            url: '/v1/agent-status',
            headers: { 'content-type': 'application/json' },
            payload: {
                sessionId,
                status: 'running',
                metrics: { tokenUsed: 128, cpuPercent: 12.5, memoryMb: 256 }
            }
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.success).toBe(true);
        expect(body.status).toBe('running');
        expect(body.active).toBe(true);

        const updatedSession = testState.sessions.get(sessionId);
        expect(updatedSession?.active).toBe(true);
    });

    it('POST /v1/agent-status marks session inactive when stopped', async () => {
        const userId = 'user-1';
        const teamId = 'team-abc';
        const sessionId = 'sess-status-2';

        testState.seedTeam(userId, teamId);
        testState.sessions.set(sessionId, {
            id: sessionId,
            tag: 'status-tag-2',
            accountId: userId,
            metadata: '{}',
            metadataVersion: 1,
            displayName: 'Stop Agent',
            mode: 'codex',
            machineId: 'machine-1',
            roleId: 'builder',
            rootPathHash: null,
            active: true,
            lastActiveAt: new Date(),
            createdAt: new Date()
        });

        const res = await app.inject({
            method: 'POST',
            url: '/v1/agent-status',
            headers: { 'content-type': 'application/json' },
            payload: {
                sessionId,
                status: 'stopped'
            }
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload);
        expect(body.success).toBe(true);
        expect(body.status).toBe('stopped');
        expect(body.active).toBe(false);

        const updatedSession = testState.sessions.get(sessionId);
        expect(updatedSession?.active).toBe(false);
    });
});
