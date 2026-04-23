import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

const mocked = vi.hoisted(() => ({
    artifactFindFirst: vi.fn(),
    artifactFindUnique: vi.fn(),
    sessionFindFirst: vi.fn(),
    sessionFindMany: vi.fn(),
    userKVStoreFindMany: vi.fn(),
    kvMutate: vi.fn(),
    allocateUserSeq: vi.fn(),
    randomKeyNaked: vi.fn(),
    emitUpdate: vi.fn(),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
    observeSessionActivity: vi.fn(),
    pushToWeixinIfBound: vi.fn(),
    teamMessagesCounterInc: vi.fn(),
    teamTaskOperationsCounterInc: vi.fn(),
    parseTeamArtifactBody: vi.fn(),
}));

vi.mock('@/storage/db', () => ({
    db: {
        artifact: {
            findFirst: mocked.artifactFindFirst,
            findUnique: mocked.artifactFindUnique,
        },
        session: {
            findFirst: mocked.sessionFindFirst,
            findMany: mocked.sessionFindMany,
        },
        userKVStore: {
            findMany: mocked.userKVStoreFindMany,
        },
    },
}));

vi.mock('@/app/kv/kvMutate', () => ({
    kvMutate: mocked.kvMutate,
}));

vi.mock('@/storage/seq', () => ({
    allocateUserSeq: mocked.allocateUserSeq,
}));

vi.mock('@/utils/randomKeyNaked', () => ({
    randomKeyNaked: mocked.randomKeyNaked,
}));

vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: {
        emitUpdate: mocked.emitUpdate,
    },
}));

vi.mock('@/modules/encrypt', () => ({
    encryptString: mocked.encryptString,
    decryptString: mocked.decryptString,
}));

vi.mock('@/app/presence/observeSessionActivity', () => ({
    observeSessionActivity: mocked.observeSessionActivity,
}));

vi.mock('@/app/channels/weixinOutbound', () => ({
    pushToWeixinIfBound: mocked.pushToWeixinIfBound,
}));

vi.mock('@/app/monitoring/metrics2', () => ({
    teamMessagesCounter: { inc: mocked.teamMessagesCounterInc },
    teamTaskOperationsCounter: { inc: mocked.teamTaskOperationsCounterInc },
}));

vi.mock('@/utils/teamArtifacts', () => ({
    parseTeamArtifactBody: mocked.parseTeamArtifactBody,
}));

import { teamMessagesRoutes } from './teamMessagesRoutes';

function buildApp(options?: {
    authenticate?: (request: any, reply: any) => unknown | Promise<unknown>;
}) {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    typed.decorate('authenticate', options?.authenticate || (async (request: any) => {
        request.userId = 'user-1';
    }));
    teamMessagesRoutes(typed);
    return typed;
}

function buildMessage(overrides?: Partial<Record<string, unknown>>) {
    return {
        id: '123e4567-e89b-12d3-a456-426614174000',
        teamId: 'team-1',
        fromSessionId: 'session-1',
        fromRole: 'builder',
        fromDisplayName: 'Builder',
        content: 'Hello team',
        type: 'chat',
        timestamp: 1,
        ...overrides,
    };
}

function buildTeamArtifact(accountId = 'user-1') {
    return {
        id: 'team-1',
        accountId,
        body: Buffer.from('team-body'),
        bodyVersion: 1,
        createdAt: new Date('2026-04-23T00:00:00Z'),
        updatedAt: new Date('2026-04-23T00:00:00Z'),
    };
}

describe('teamMessagesRoutes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocked.artifactFindUnique.mockResolvedValue(buildTeamArtifact());
        mocked.parseTeamArtifactBody.mockReturnValue({
            team: {
                members: [
                    { sessionId: 'session-1', roleId: 'builder', displayName: 'Builder' },
                    { sessionId: 'session-2', roleId: 'qa', displayName: 'QA' },
                ],
            },
            tasks: [],
        });
        mocked.allocateUserSeq.mockResolvedValue(7);
        mocked.randomKeyNaked.mockReturnValue('event-id');
        mocked.encryptString.mockImplementation((_path, raw) => raw);
        mocked.decryptString.mockImplementation((_path, raw) => raw);
        mocked.pushToWeixinIfBound.mockResolvedValue(undefined);
        mocked.observeSessionActivity.mockResolvedValue(true);
    });

    it('serves ping endpoints without authentication', async () => {
        const app = buildApp();

        const globalPing = await app.inject({ method: 'GET', url: '/v1/teams/ping' });
        const teamPing = await app.inject({ method: 'GET', url: '/v1/teams/team-1/ping' });

        expect(globalPing.statusCode).toBe(200);
        expect(globalPing.json()).toEqual({ pong: true });
        expect(teamPing.statusCode).toBe(200);
        expect(teamPing.json()).toEqual({ pong: true, teamId: 'team-1' });

        await app.close();
    });

    it('returns 404 when listing messages for a team the user cannot access', async () => {
        mocked.artifactFindUnique.mockResolvedValue(null);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/teams/team-1/messages',
        });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({
            error: 'Team not found',
            code: 'TEAM_NOT_FOUND',
            currentAccountId: 'user-1',
        });

        await app.close();
    });

    it('returns account mismatch instead of a misleading 404 for existing inaccessible teams', async () => {
        mocked.artifactFindUnique.mockResolvedValue(buildTeamArtifact('owner-1'));
        mocked.sessionFindFirst.mockResolvedValue(null);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/teams/team-1/messages',
        });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({
            error: 'Team account mismatch',
            code: 'TEAM_ACCOUNT_MISMATCH',
            currentAccountId: 'user-1',
            teamOwnerAccountId: 'owner-1',
        });

        await app.close();
    });

    it('lists decrypted messages in chronological order with a cursor', async () => {
        mocked.userKVStoreFindMany.mockResolvedValue([
            {
                key: 'team_messages.team-1.200.msg-2',
                value: JSON.stringify({ id: 'msg-2', content: 'Second', timestamp: 200 }),
            },
            {
                key: 'team_messages.team-1.100.msg-1',
                value: JSON.stringify({ id: 'msg-1', content: 'First', timestamp: 100 }),
            },
        ]);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/teams/team-1/messages?limit=2',
        });

        expect(response.statusCode).toBe(200);
        expect(mocked.userKVStoreFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ accountId: 'user-1' }),
        }));
        expect(response.json()).toEqual({
            messages: [
                expect.objectContaining({ id: 'msg-1', content: 'First', timestamp: 100 }),
                expect.objectContaining({ id: 'msg-2', content: 'Second', timestamp: 200 }),
            ],
            hasMore: true,
            cursor: 'team_messages.team-1.100.msg-1',
        });

        await app.close();
    });

    it('reads shared-team messages from the owner account namespace', async () => {
        mocked.artifactFindUnique.mockResolvedValue(buildTeamArtifact('owner-1'));
        mocked.parseTeamArtifactBody.mockReturnValue({
            team: {
                members: [{ sessionId: 'member-session', roleId: 'builder' }],
            },
            tasks: [],
        });
        mocked.sessionFindFirst.mockResolvedValue({ id: 'member-session' });
        mocked.userKVStoreFindMany.mockResolvedValue([
            {
                key: 'team_messages.team-1.100.msg-1',
                value: JSON.stringify({ id: 'msg-1', content: 'First', timestamp: 100 }),
            },
        ]);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/teams/team-1/messages',
        });

        expect(response.statusCode).toBe(200);
        expect(mocked.userKVStoreFindMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ accountId: 'owner-1' }),
        }));
        expect(mocked.decryptString).toHaveBeenCalledWith(
            ['user', 'owner-1', 'teams', 'team-1', 'messages', 'msg-1'],
            JSON.stringify({ id: 'msg-1', content: 'First', timestamp: 100 }),
        );

        await app.close();
    });

    it('rejects sending a message with an invalid fromSessionId', async () => {
        mocked.sessionFindFirst.mockResolvedValue(null);
        mocked.parseTeamArtifactBody.mockReturnValue({ team: { members: [] }, tasks: [] });

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/teams/team-1/messages',
            payload: buildMessage(),
        });

        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({ error: 'Invalid fromSessionId: session-1' });

        await app.close();
    });

    it('falls back to the team roster when the sender session is not yet queryable', async () => {
        mocked.sessionFindFirst.mockResolvedValue(null);
        mocked.parseTeamArtifactBody.mockReturnValue({
            team: {
                members: [
                    {
                        sessionId: 'session-1',
                        roleId: 'researcher',
                        displayName: 'Researcher Name',
                    },
                ],
            },
        });
        mocked.sessionFindMany.mockResolvedValue([{ id: 'session-1' }, { id: 'session-2' }]);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/teams/team-1/messages',
            payload: buildMessage({
                fromRole: undefined,
                fromDisplayName: undefined,
            }),
        });

        expect(response.statusCode).toBe(200);
        expect(mocked.emitUpdate).toHaveBeenCalledWith({
            userId: 'user-1',
            payload: expect.objectContaining({
                body: expect.objectContaining({
                    t: 'team-message',
                    teamId: 'team-1',
                    message: expect.objectContaining({
                        fromSessionId: 'session-1',
                        fromRole: 'researcher',
                        fromDisplayName: 'Researcher Name',
                    }),
                }),
            }),
            recipientFilter: { type: 'specific-sessions', sessionIds: new Set(['session-1']) },
        });

        await app.close();
    });

    it('returns 404 when sending a message to an inaccessible team', async () => {
        mocked.sessionFindFirst.mockResolvedValue({
            id: 'session-1',
            metadata: JSON.stringify({ role: 'builder', name: 'Builder Name' }),
        });
        mocked.artifactFindUnique.mockResolvedValue(null);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/teams/team-404/messages',
            payload: buildMessage({ teamId: 'team-404' }),
        });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({
            error: 'Team not found',
            code: 'TEAM_NOT_FOUND',
            currentAccountId: 'user-1',
        });

        await app.close();
    });

    it('sends a message, persists it, broadcasts it, and observes session activity', async () => {
        mocked.sessionFindFirst.mockResolvedValue({
            id: 'session-1',
            metadata: JSON.stringify({ role: 'builder', name: 'Builder Name' }),
        });
        mocked.sessionFindMany.mockResolvedValue([{ id: 'session-1' }, { id: 'session-2' }]);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/teams/team-1/messages',
            payload: buildMessage({
                content: 'x'.repeat(180),
                shortContent: 'ignored',
            }),
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            success: true,
            messageId: '123e4567-e89b-12d3-a456-426614174000',
        });
        expect(mocked.kvMutate).toHaveBeenCalledWith(
            { uid: 'user-1' },
            [expect.objectContaining({
                key: expect.stringContaining('team_messages.team-1.'),
                version: -1,
            })],
        );
        expect(mocked.emitUpdate).toHaveBeenCalledWith({
            userId: 'user-1',
            payload: expect.objectContaining({
                id: 'event-id',
                seq: 7,
                body: expect.objectContaining({
                    t: 'team-message',
                    teamId: 'team-1',
                    message: expect.objectContaining({
                        fromRole: 'builder',
                        fromDisplayName: 'Builder Name',
                        shortContent: expect.stringMatching(/\.{3}$/),
                    }),
                }),
            }),
            recipientFilter: { type: 'specific-sessions', sessionIds: new Set(['session-1', 'session-2']) },
        });
        expect(mocked.observeSessionActivity).toHaveBeenCalledWith('user-1', 'session-1', expect.any(Number));

        await app.close();
    });

    it('treats messages without fromSessionId as user messages', async () => {
        mocked.sessionFindMany.mockResolvedValue([{ id: 'session-viewer' }]);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/teams/team-1/messages',
            payload: buildMessage({
                fromSessionId: undefined,
                fromRole: undefined,
                fromDisplayName: undefined,
                content: 'hello',
            }),
        });

        expect(response.statusCode).toBe(200);
        expect(mocked.kvMutate).toHaveBeenCalled();
        expect(mocked.emitUpdate).toHaveBeenCalledTimes(1);
        const message = mocked.emitUpdate.mock.calls[0][0].payload.body.message;
        expect(message.fromRole).toBe('user');
        expect(message.fromDisplayName).toBe('User');
        expect(mocked.observeSessionActivity).not.toHaveBeenCalled();

        await app.close();
    });

    it('returns 400 for invalid message payloads after schema validation logging', async () => {
        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/teams/team-1/messages',
            payload: {
                id: 'not-a-uuid',
                teamId: 'team-1',
                content: 'bad',
                type: 'chat',
                timestamp: 1,
            },
        });

        expect(response.statusCode).toBe(400);

        await app.close();
    });

    it('requires authentication for protected message routes', async () => {
        const app = buildApp({
            authenticate: async (_request, reply) => reply.code(401).send({ error: 'Unauthorized' }),
        });

        const response = await app.inject({
            method: 'GET',
            url: '/v1/teams/team-1/messages',
        });

        expect(response.statusCode).toBe(401);
        expect(mocked.userKVStoreFindMany).not.toHaveBeenCalled();

        await app.close();
    });
});
