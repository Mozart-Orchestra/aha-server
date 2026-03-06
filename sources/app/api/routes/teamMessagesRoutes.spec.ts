import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Fastify as TypedFastify } from '../types';

const testState = vi.hoisted(() => {
    type Artifact = {
        id: string;
        accountId: string;
    };

    type Team = {
        id: string;
        accountId: string;
        name: string;
    };

    type Session = {
        id: string;
        accountId: string;
        metadata: string;
    };

    type KvEntry = {
        accountId: string;
        key: string;
        value: Uint8Array;
    };

    type EvidenceEntry = {
        key: string;
        value: string;
    };

    const artifacts = new Map<string, Artifact>();
    const teams = new Map<string, Team>();
    const sessions = new Map<string, Session>();
    const kvEntries: KvEntry[] = [];
    const evidenceEntries: EvidenceEntry[] = [];

    return {
        artifacts,
        teams,
        sessions,
        kvEntries,
        evidenceEntries,
        reset() {
            artifacts.clear();
            teams.clear();
            sessions.clear();
            kvEntries.length = 0;
            evidenceEntries.length = 0;
        },
        seedArtifact(userId: string, teamId: string) {
            artifacts.set(teamId, { id: teamId, accountId: userId });
        },
        seedCanonicalTeam(userId: string, teamId: string, name = 'Team') {
            teams.set(teamId, { id: teamId, accountId: userId, name });
        },
        seedSession(userId: string, sessionId: string, metadata: Record<string, unknown>) {
            sessions.set(sessionId, {
                id: sessionId,
                accountId: userId,
                metadata: JSON.stringify(metadata),
            });
        },
        writeKv(accountId: string, key: string, value: Uint8Array) {
            const existingIndex = kvEntries.findIndex((entry) => entry.accountId === accountId && entry.key === key);
            if (existingIndex >= 0) {
                kvEntries.splice(existingIndex, 1, { accountId, key, value });
                return;
            }
            kvEntries.push({ accountId, key, value });
        },
    };
});

vi.mock('@/storage/db', () => ({
    db: {
        artifact: {
            findFirst: vi.fn(async (args) => {
                const artifact = testState.artifacts.get(args.where?.id);
                if (!artifact) return null;
                if (args.where?.accountId && artifact.accountId !== args.where.accountId) {
                    return null;
                }
                return artifact;
            }),
        },
        team: {
            findFirst: vi.fn(async (args) => {
                const team = testState.teams.get(args.where?.id);
                if (!team) return null;
                if (args.where?.accountId && team.accountId !== args.where.accountId) {
                    return null;
                }
                return team;
            }),
        },
        session: {
            findFirst: vi.fn(async (args) => {
                const session = testState.sessions.get(args.where?.id);
                if (!session) return null;
                if (args.where?.accountId && session.accountId !== args.where.accountId) {
                    return null;
                }
                return session;
            }),
            findMany: vi.fn(async (args) => {
                return Array.from(testState.sessions.values()).filter((session) => {
                    if (args.where?.accountId && session.accountId !== args.where.accountId) {
                        return false;
                    }
                    return true;
                });
            }),
        },
        userKVStore: {
            findMany: vi.fn(async (args) => {
                const prefix = args.where?.key?.startsWith ?? '';
                const accountId = args.where?.accountId;
                const take = args.take ?? 100;
                return testState.kvEntries
                    .filter((entry) => entry.accountId === accountId && entry.key.startsWith(prefix))
                    .sort((a, b) => b.key.localeCompare(a.key))
                    .slice(0, take);
            }),
        },
        simpleCache: {
            create: vi.fn(async ({ data }) => {
                testState.evidenceEntries.push({ key: data.key, value: data.value });
                return data;
            }),
        },
    },
}));

vi.mock('@/app/kv/kvList', () => ({
    kvList: vi.fn(),
}));

vi.mock('@/app/kv/kvMutate', () => ({
    kvMutate: vi.fn(async (ctx, mutations) => {
        for (const mutation of mutations) {
            if (mutation.value === null) continue;
            testState.writeKv(ctx.uid, mutation.key, new Uint8Array(Buffer.from(mutation.value, 'utf8')));
        }
        return { success: true };
    }),
}));

vi.mock('@/modules/encrypt', () => ({
    encryptString: vi.fn((_path, value) => value),
    decryptString: vi.fn((_path, value) => {
        const encoded = Buffer.from(value).toString('utf8');
        return Buffer.from(encoded, 'base64').toString('utf8');
    }),
}));

vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: {
        emitUpdate: vi.fn(),
    },
}));

vi.mock('@/storage/seq', () => ({
    allocateUserSeq: vi.fn(async () => 1),
}));

vi.mock('@/utils/log', () => ({
    log: vi.fn(),
}));

vi.mock('@/app/monitoring/metrics2', () => ({
    teamMessagesCounter: { inc: vi.fn() },
    teamTaskOperationsCounter: { inc: vi.fn() },
    teamBroadcastEfficiencyGauge: { set: vi.fn() },
}));

vi.mock('@/utils/teamArtifacts', () => ({
    ensureSessionLinkedToTeam: vi.fn(async () => ({ success: true, alreadyLinked: false })),
}));

import { teamMessagesRoutes } from './teamMessagesRoutes';

function buildApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as TypedFastify;
    typed.decorate('authenticate', async (req: any, _reply: any) => {
        req.userId = 'user-1';
    });

    teamMessagesRoutes(typed);
    return app;
}

describe('team messages routes', () => {
    let app: ReturnType<typeof buildApp>;

    beforeEach(() => {
        testState.reset();
        app = buildApp();
    });

    afterEach(async () => {
        await app.close();
    });

    it('returns an empty message list for canonical-only teams', async () => {
        testState.seedCanonicalTeam('user-1', 'team-1');

        const res = await app.inject({
            method: 'GET',
            url: '/v1/teams/team-1/messages',
        });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.payload)).toEqual({
            messages: [],
            hasMore: false,
        });
    });

    it('accepts extended collaboration message types for canonical-only teams', async () => {
        testState.seedCanonicalTeam('user-1', 'team-2');

        const createRes = await app.inject({
            method: 'POST',
            url: '/v1/teams/team-2/messages',
            payload: {
                id: '11111111-1111-4111-8111-111111111111',
                teamId: 'team-2',
                content: 'Please approve task-1 before merge.',
                type: 'approval-request',
                timestamp: 1,
                metadata: {
                    taskId: 'task-1',
                    priority: 'high',
                    requestType: 'approval-request',
                },
            },
        });

        expect(createRes.statusCode).toBe(200);
        expect(JSON.parse(createRes.payload)).toEqual({
            success: true,
            messageId: '11111111-1111-4111-8111-111111111111',
        });

        const listRes = await app.inject({
            method: 'GET',
            url: '/v1/teams/team-2/messages',
        });

        expect(listRes.statusCode).toBe(200);
        const payload = JSON.parse(listRes.payload);
        expect(payload.messages).toHaveLength(1);
        expect(payload.messages[0]).toMatchObject({
            id: '11111111-1111-4111-8111-111111111111',
            teamId: 'team-2',
            type: 'approval-request',
            content: 'Please approve task-1 before merge.',
            fromRole: 'user',
            fromDisplayName: 'User',
            metadata: {
                taskId: 'task-1',
                priority: 'high',
                requestType: 'approval-request',
            },
        });
        expect(typeof payload.messages[0].timestamp).toBe('number');
        expect(testState.evidenceEntries).toHaveLength(1);
        expect(testState.evidenceEntries[0].key).toContain('evidence:team:team-2:');
    });
});
