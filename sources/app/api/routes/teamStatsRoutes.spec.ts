import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Fastify as TypedFastify } from '../types';

const testState = vi.hoisted(() => {
    type Artifact = {
        id: string;
        accountId: string;
        type: string;
        body: Uint8Array | null;
        updatedAt: Date;
    };

    type TeamMessage = {
        id: string;
        teamId: string;
        type: string;
        content: string;
        createdAt: Date;
    };

    type Session = {
        id: string;
        lastActiveAt: Date;
    };

    type KVStore = {
        userId: string;
        key: string;
        value: string;
        updatedAt: Date;
    };

    const artifacts = new Map<string, Artifact>();
    const teamMessages: TeamMessage[] = [];
    const sessions = new Map<string, Session>();
    const kvStore: KVStore[] = [];

    let messageIdCounter = 1;

    return {
        artifacts,
        teamMessages,
        sessions,
        kvStore,
        reset() {
            artifacts.clear();
            teamMessages.length = 0;
            sessions.clear();
            kvStore.length = 0;
            messageIdCounter = 1;
        },
        seedTeam(userId: string, teamId: string, members: string[] = []) {
            const body = new Uint8Array(Buffer.from(JSON.stringify({
                team: { members: members.map(m => ({ sessionId: m })) }
            }), 'utf8'));
            artifacts.set(teamId, {
                id: teamId,
                accountId: userId,
                type: 'team',
                body,
                updatedAt: new Date()
            });
        },
        seedTeamWithNullBody(userId: string, teamId: string) {
            artifacts.set(teamId, {
                id: teamId,
                accountId: userId,
                type: 'team',
                body: null,
                updatedAt: new Date()
            });
        },
        seedBoard(userId: string, teamId: string, board: Record<string, unknown>) {
            const body = new Uint8Array(Buffer.from(JSON.stringify(board), 'utf8'));
            artifacts.set(teamId, {
                id: teamId,
                accountId: userId,
                type: 'team',
                body,
                updatedAt: new Date()
            });
        },
        seedMessage(teamId: string, type: string, content: string) {
            teamMessages.push({
                id: `msg-${messageIdCounter++}`,
                teamId,
                type,
                content,
                createdAt: new Date()
            });
        },
        seedSession(sessionId: string, active: boolean = true) {
            sessions.set(sessionId, {
                id: sessionId,
                lastActiveAt: active ? new Date() : new Date(Date.now() - 48 * 60 * 60 * 1000)
            });
        },
        seedUsage(teamId: string, model: string, tokens: number) {
            kvStore.push({
                userId: 'user-1',
                key: `usage:${teamId}:${Date.now()}-${Math.random()}`,
                value: JSON.stringify({ model, tokens }),
                updatedAt: new Date()
            });
        }
    };
});

vi.mock('@/storage/db', () => ({
    db: {
        artifact: {
            findFirst: vi.fn((args) => {
                const teamId = args.where?.id;
                const artifact = testState.artifacts.get(teamId);
                if (!artifact) return Promise.resolve(null);
                if (args.where?.accountId && artifact.accountId !== args.where.accountId) {
                    return Promise.resolve(null);
                }
                return Promise.resolve(artifact);
            })
        },
        session: {
            findMany: vi.fn((args) => {
                const ids = args.where?.id?.in || [];
                const gte = args.where?.lastActiveAt?.gte;
                return Promise.resolve(
                    ids.map((id: string) => testState.sessions.get(id)).filter((s: any) => {
                        if (!s) return false;
                        if (gte && s.lastActiveAt < gte) return false;
                        return true;
                    })
                );
            })
        },
        teamMessage: {
            count: vi.fn((args) => {
                const teamId = args.where?.teamId;
                const count = testState.teamMessages.filter(m => m.teamId === teamId).length;
                return Promise.resolve(count);
            }),
            findMany: vi.fn((args) => {
                const teamId = args.where?.teamId;
                const type = args.where?.type;
                return Promise.resolve(
                    testState.teamMessages.filter(m =>
                        m.teamId === teamId && (!type || m.type === type)
                    )
                );
            })
        },
        userKVStore: {
            findMany: vi.fn((args) => {
                const prefix = args.where?.key?.startsWith;
                const gte = args.where?.updatedAt?.gte;
                return Promise.resolve(
                    testState.kvStore.filter(k => {
                        if (prefix && !k.key.startsWith(prefix)) return false;
                        if (gte && k.updatedAt < gte) return false;
                        return true;
                    })
                );
            })
        },
        simpleCache: {
            findMany: vi.fn(() => Promise.resolve([]))
        }
    }
}));

vi.mock('@/utils/log', () => ({
    log: vi.fn()
}));

import { teamStatsRoutes } from './teamStatsRoutes';

function buildApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as TypedFastify;
    typed.decorate('authenticate', async (req: any, _reply: any) => {
        req.userId = 'user-1';
    });

    teamStatsRoutes(typed);
    return app;
}

describe('team stats routes', () => {
    let app: ReturnType<typeof buildApp>;

    beforeEach(() => {
        testState.reset();
        app = buildApp();
    });

    afterEach(async () => {
        await app.close();
    });

    describe('GET /v1/teams/:teamId/stats', () => {
        it('returns 404 when team not found', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/v1/teams/nonexistent/stats'
            });
            expect(res.statusCode).toBe(404);
            const body = JSON.parse(res.payload);
            expect(body.error).toBe('Team not found');
        });

        it('returns PRD team stats structure', async () => {
            testState.seedTeam('user-1', 'team-1', ['session-1', 'session-2']);
            testState.seedSession('session-1', true);
            testState.seedSession('session-2', false);
            testState.seedMessage('team-1', 'chat', 'Hello');
            testState.seedMessage('team-1', 'task', JSON.stringify({ status: 'todo', title: 'Task 1' }));
            testState.seedMessage('team-1', 'task', JSON.stringify({ status: 'in-progress', title: 'Task 2' }));

            const res = await app.inject({
                method: 'GET',
                url: '/v1/teams/team-1/stats'
            });
            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body).toHaveProperty('memberCount');
            expect(body).toHaveProperty('activeMemberCount');
            expect(body).toHaveProperty('messageCount');
            expect(body).toHaveProperty('taskStats');
            expect(body).toHaveProperty('tokenUsage');
            expect(body).toHaveProperty('modelDistribution');
            expect(body).toHaveProperty('codeMetrics');
            expect(body).toHaveProperty('lastActivityAt');
        });

        it('calculates member count correctly', async () => {
            testState.seedTeam('user-1', 'team-1', ['session-1', 'session-2', 'session-3']);

            const res = await app.inject({
                method: 'GET',
                url: '/v1/teams/team-1/stats'
            });
            const body = JSON.parse(res.payload);
            expect(body.memberCount).toBe(3);
        });

        it('calculates message count correctly', async () => {
            testState.seedTeam('user-1', 'team-1', ['session-1']);
            testState.seedMessage('team-1', 'chat', 'Hello 1');
            testState.seedMessage('team-1', 'chat', 'Hello 2');
            testState.seedMessage('team-1', 'chat', 'Hello 3');

            const res = await app.inject({
                method: 'GET',
                url: '/v1/teams/team-1/stats'
            });
            const body = JSON.parse(res.payload);
            expect(body.messageCount).toBe(3);
        });

        it('calculates task stats correctly', async () => {
            testState.seedTeam('user-1', 'team-1', ['session-1']);
            testState.seedMessage('team-1', 'task', JSON.stringify({ status: 'todo' }));
            testState.seedMessage('team-1', 'task', JSON.stringify({ status: 'in-progress' }));
            testState.seedMessage('team-1', 'task', JSON.stringify({ status: 'review' }));
            testState.seedMessage('team-1', 'task', JSON.stringify({ status: 'done' }));
            testState.seedMessage('team-1', 'task', JSON.stringify({ status: 'blocked' }));

            const res = await app.inject({
                method: 'GET',
                url: '/v1/teams/team-1/stats'
            });
            const body = JSON.parse(res.payload);
            expect(body.taskStats.total).toBe(5);
            expect(body.taskStats.todo).toBe(1);
            expect(body.taskStats.inProgress).toBe(1);
            expect(body.taskStats.review).toBe(1);
            expect(body.taskStats.done).toBe(1);
            expect(body.taskStats.blocked).toBe(1);
        });

        it('returns model distribution from the canonical stats payload', async () => {
            testState.seedTeam('user-1', 'team-1', ['session-1']);
            testState.seedUsage('team-1', 'claude-opus', 100);
            testState.seedUsage('team-1', 'gpt-4.1-mini', 300);

            const res = await app.inject({
                method: 'GET',
                url: '/v1/teams/team-1/stats'
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body.tokenUsage.total).toBe(400);
            expect(body.tokenUsage.byModel.opus).toBe(100);
            expect(body.modelDistribution).toEqual([
                { model: 'gpt-4.1-mini', tokenCount: 300, percentage: 75 },
                { model: 'claude-opus', tokenCount: 100, percentage: 25 },
            ]);
        });

        it('returns default stats when team artifact body is null', async () => {
            testState.seedTeamWithNullBody('user-1', 'team-null');

            const res = await app.inject({
                method: 'GET',
                url: '/v1/teams/team-null/stats'
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body.memberCount).toBe(0);
            expect(body.activeMemberCount).toBe(0);
            expect(body.taskStats.total).toBe(0);
        });
    });

    describe('GET /v1/teams/:teamId/board', () => {
        it('returns board payload and summary', async () => {
            testState.seedBoard('user-1', 'team-board-1', {
                name: 'Alpha Squad',
                version: 7,
                updatedAt: Date.now(),
                team: {
                    members: [{ sessionId: 's1' }, { sessionId: 's2' }],
                    roles: [{ id: 'builder' }],
                    agreements: { statusUpdates: 'daily' }
                },
                tasks: [
                    { id: 't1', status: 'todo' },
                    { id: 't2', status: 'in-progress' },
                    { id: 't3', status: 'done' }
                ]
            });

            const res = await app.inject({
                method: 'GET',
                url: '/v1/teams/team-board-1/board'
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body.teamId).toBe('team-board-1');
            expect(body.board.name).toBe('Alpha Squad');
            expect(body.board.tasks).toHaveLength(3);
            expect(body.summary.memberCount).toBe(2);
            expect(body.summary.taskStats.total).toBe(3);
            expect(body.summary.taskStats.todo).toBe(1);
            expect(body.summary.taskStats.inProgress).toBe(1);
            expect(body.summary.taskStats.done).toBe(1);
        });

        it('returns 404 when board team not found', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/v1/teams/missing-team/board'
            });

            expect(res.statusCode).toBe(404);
            const body = JSON.parse(res.payload);
            expect(body.error).toBe('Team not found');
        });

        it('returns empty board payload when body is null', async () => {
            testState.seedTeamWithNullBody('user-1', 'team-board-null');

            const res = await app.inject({
                method: 'GET',
                url: '/v1/teams/team-board-null/board'
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body.board.name).toBeNull();
            expect(body.board.team.members).toEqual([]);
            expect(body.board.tasks).toEqual([]);
            expect(body.summary.memberCount).toBe(0);
            expect(body.summary.taskStats.total).toBe(0);
        });
    });

    describe('GET /v1/teams/:teamId/info', () => {
        it('returns info payload for dashboard', async () => {
            testState.seedBoard('user-1', 'team-info-1', {
                name: 'Info Team',
                team: {
                    members: [{ sessionId: 'session-1' }, { sessionId: 'session-2' }]
                },
                tasks: [
                    { id: 't1', status: 'todo' },
                    { id: 't2', status: 'review' }
                ]
            });
            testState.seedSession('session-1', true);
            testState.seedSession('session-2', false);
            testState.seedMessage('team-info-1', 'chat', 'hello');
            testState.seedMessage('team-info-1', 'task', JSON.stringify({ status: 'review' }));
            testState.seedUsage('team-info-1', 'claude-opus', 500);
            testState.seedUsage('team-info-1', 'claude-sonnet', 250);

            const res = await app.inject({
                method: 'GET',
                url: '/v1/teams/team-info-1/info?period=week'
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body.teamId).toBe('team-info-1');
            expect(body.name).toBe('Info Team');
            expect(body.memberCount).toBe(2);
            expect(body.activeMemberCount).toBe(1);
            expect(body.messageCount).toBe(2);
            expect(body.tokenUsage.total).toBe(750);
            expect(body.tokenUsage.byModel.opus).toBe(500);
            expect(body.tokenUsage.byModel.sonnet).toBe(250);
        });

        it('returns default info payload when body is null', async () => {
            testState.seedTeamWithNullBody('user-1', 'team-info-null');

            const res = await app.inject({
                method: 'GET',
                url: '/v1/teams/team-info-null/info'
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body.name).toBeNull();
            expect(body.memberCount).toBe(0);
            expect(body.activeMemberCount).toBe(0);
            expect(body.taskStats.total).toBe(0);
            expect(body.tokenUsage.total).toBe(0);
        });
    });

    describe('POST /v1/teams/stats/batch', () => {
        it('returns stats for multiple teams', async () => {
            testState.seedTeam('user-1', 'team-1', ['s1', 's2']);
            testState.seedTeam('user-1', 'team-2', ['s3']);
            testState.seedMessage('team-1', 'chat', 'msg');
            testState.seedMessage('team-1', 'task', JSON.stringify({ status: 'todo' }));
            testState.seedMessage('team-2', 'task', JSON.stringify({ status: 'done' }));

            const res = await app.inject({
                method: 'POST',
                url: '/v1/teams/stats/batch',
                payload: { teamIds: ['team-1', 'team-2'] }
            });
            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body).toHaveProperty('team-1');
            expect(body).toHaveProperty('team-2');
            expect(body['team-1'].memberCount).toBe(2);
            expect(body['team-2'].memberCount).toBe(1);
        });

        it('returns empty object for non-existent teams', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/v1/teams/stats/batch',
                payload: { teamIds: ['nonexistent'] }
            });
            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(Object.keys(body)).toHaveLength(0);
        });
    });

    describe('GET /v1/teams/:teamId/usage/models', () => {
        it('returns 404 when team not found', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/v1/teams/nonexistent/usage/models'
            });
            expect(res.statusCode).toBe(404);
        });

        it('returns model distribution', async () => {
            testState.seedTeam('user-1', 'team-1', ['session-1']);
            testState.seedUsage('team-1', 'claude-opus', 1000);
            testState.seedUsage('team-1', 'claude-sonnet', 2000);
            testState.seedUsage('team-1', 'claude-haiku', 500);

            const res = await app.inject({
                method: 'GET',
                url: '/v1/teams/team-1/usage/models'
            });
            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body).toHaveProperty('distribution');
            expect(Array.isArray(body.distribution)).toBe(true);
            expect(body.distribution.length).toBeGreaterThan(0);

            // Check structure
            const first = body.distribution[0];
            expect(first).toHaveProperty('model');
            expect(first).toHaveProperty('tokenCount');
            expect(first).toHaveProperty('percentage');
        });

        it('calculates percentages correctly', async () => {
            testState.seedTeam('user-1', 'team-1', ['session-1']);
            testState.seedUsage('team-1', 'claude-opus', 100);
            testState.seedUsage('team-1', 'claude-sonnet', 300);
            // Total: 400, opus: 25%, sonnet: 75%

            const res = await app.inject({
                method: 'GET',
                url: '/v1/teams/team-1/usage/models'
            });
            const body = JSON.parse(res.payload);

            const opusEntry = body.distribution.find((d: any) => d.model.includes('opus'));
            const sonnetEntry = body.distribution.find((d: any) => d.model.includes('sonnet'));

            expect(opusEntry.percentage).toBe(25);
            expect(sonnetEntry.percentage).toBe(75);
        });
    });
});
