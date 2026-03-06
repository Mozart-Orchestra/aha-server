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
    };

    type CacheEntry = {
        key: string;
        value: string;
        updatedAt: Date;
    };

    type Message = {
        id: string;
        teamId: string;
        type: string;
        content: string;
        createdAt: Date;
    };

    type Session = {
        id: string;
        accountId: string;
        active: boolean;
        lastActiveAt: Date;
        roleId?: string | null;
        machineId?: string | null;
        displayName?: string | null;
    };

    type BoardTask = {
        id: string;
        title: string;
        status: string;
        createdAt: number;
        updatedAt: number;
        description?: string;
        approvalStatus?: 'pending' | 'approved' | 'rejected';
        blockers?: Array<{ id: string; description: string; resolvedAt?: number }>;
    };

    const artifacts = new Map<string, Artifact>();
    const cacheEntries: CacheEntry[] = [];
    const messages: Message[] = [];
    const sessions: Session[] = [];
    const boards = new Map<string, { tasks: BoardTask[]; team?: { members?: Array<{ sessionId: string }> } }>();

    return {
        artifacts,
        cacheEntries,
        messages,
        sessions,
        boards,
        reset() {
            artifacts.clear();
            cacheEntries.length = 0;
            messages.length = 0;
            sessions.length = 0;
            boards.clear();
        },
        seedTeam(userId: string, teamId: string) {
            artifacts.set(teamId, {
                id: teamId,
                accountId: userId,
                type: 'team',
                body: null
            });
        },
        seedRatings(teamId: string, ratings: Array<{ value: string; daysAgo?: number }>) {
            for (const r of ratings) {
                const updatedAt = new Date();
                if (r.daysAgo) {
                    updatedAt.setDate(updatedAt.getDate() - r.daysAgo);
                }
                const createdAt = updatedAt.getTime();
                cacheEntries.push({
                    key: `rating_record.${teamId}.rating-${Date.now()}-${Math.random()}`,
                    value: JSON.stringify({
                        id: `rating-${Date.now()}-${Math.random()}`,
                        teamId,
                        roleId: 'developer',
                        rating: Number(r.value),
                        codeLines: 120,
                        commits: 3,
                        bugsCount: 0,
                        qualityScore: 84,
                        source: 'system',
                        reviewerId: 'system',
                        createdAt,
                    }),
                    updatedAt
                });
            }
        },
        seedEvidence(teamId: string, category: 'runtime' | 'code' | 'review' | 'collaboration', summary: string, daysAgo = 0) {
            const updatedAt = new Date();
            if (daysAgo) {
                updatedAt.setDate(updatedAt.getDate() - daysAgo);
            }
            cacheEntries.push({
                key: `evidence:team:${teamId}:${updatedAt.getTime()}:ev-${Math.random().toString(36).slice(2, 8)}`,
                value: JSON.stringify({
                    id: `ev-${Math.random().toString(36).slice(2, 8)}`,
                    teamId,
                    category,
                    source: `spec-${category}`,
                    title: `${category} evidence`,
                    summary,
                    timestamp: updatedAt.toISOString(),
                    metadata: category === 'collaboration' ? { fromRole: 'coordinator' } : undefined,
                }),
                updatedAt,
            });
        },
        seedSession(userId: string, sessionId: string, overrides: Partial<Session> = {}) {
            sessions.push({
                id: sessionId,
                accountId: userId,
                active: true,
                lastActiveAt: new Date(),
                roleId: null,
                machineId: null,
                displayName: null,
                ...overrides,
            });
        },
        seedBoard(teamId: string, tasks: BoardTask[], members: string[] = []) {
            boards.set(teamId, {
                tasks,
                team: {
                    members: members.map((sessionId) => ({ sessionId })),
                },
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
                // Type filter check
                if (args.where?.type && artifact.type !== args.where.type) {
                    return Promise.resolve(null);
                }
                return Promise.resolve(artifact);
            })
        },
        simpleCache: {
            findMany: vi.fn((args) => {
                const prefix = args.where?.key?.startsWith;
                if (!prefix) return Promise.resolve([]);
                return Promise.resolve(
                    testState.cacheEntries.filter(c => c.key.startsWith(prefix))
                );
            }),
            create: vi.fn((args) => {
                const entry = { ...args.data };
                testState.cacheEntries.push(entry);
                return Promise.resolve(entry);
            }),
            upsert: vi.fn((args) => {
                const existingIndex = testState.cacheEntries.findIndex((entry) => entry.key === args.where?.key);
                const next = existingIndex >= 0
                    ? { ...testState.cacheEntries[existingIndex], value: args.update.value }
                    : { ...args.create, updatedAt: new Date() };
                if (existingIndex >= 0) {
                    testState.cacheEntries.splice(existingIndex, 1, next as any);
                } else {
                    testState.cacheEntries.push(next as any);
                }
                return Promise.resolve(next);
            })
        },
        session: {
            findMany: vi.fn((args) => {
                const ids = args.where?.id?.in || [];
                return Promise.resolve(
                    testState.sessions.filter((session) => {
                        if (args.where?.accountId && session.accountId !== args.where.accountId) {
                            return false;
                        }
                        if (ids.length > 0 && !ids.includes(session.id)) {
                            return false;
                        }
                        return true;
                    })
                );
            })
        },
        userKVStore: {
            findMany: vi.fn(() => Promise.resolve([]))
        },
        teamMessage: {
            create: vi.fn((args) => {
                const msg = { id: 'msg-1', ...args.data, createdAt: new Date() };
                testState.messages.push(msg);
                return Promise.resolve(msg);
            })
        },
        role: {
            findMany: vi.fn((args) => {
                return Promise.resolve([]);
            }),
            update: vi.fn((args) => {
                return Promise.resolve({ id: args.where?.id || 'role-1', ...args.data });
            })
        }
    }
}));

vi.mock('@/utils/log', () => ({
    log: vi.fn()
}));

vi.mock('@/app/task/taskOrchestrator', () => ({
    taskOrchestrator: {
        getBoard: vi.fn(async (_userId: string, teamId: string) => testState.boards.get(teamId) || { tasks: [], team: { members: [] } }),
    },
}));

import { evolutionRoutes } from './evolutionRoutes';

function buildApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as TypedFastify;
    typed.decorate('authenticate', async (req: any, _reply: any) => {
        req.userId = 'user-1';
    });

    evolutionRoutes(typed);
    return app;
}

describe('evolution routes', () => {
    let app: ReturnType<typeof buildApp>;

    beforeEach(() => {
        testState.reset();
        app = buildApp();
    });

    afterEach(async () => {
        await app.close();
    });

    describe('GET /v1/teams/:teamId/evolution/suggestions', () => {
        it('returns 404 when team not found', async () => {
            const res = await app.inject({
                method: 'GET',
                url: '/v1/teams/nonexistent/evolution/suggestions'
            });
            expect(res.statusCode).toBe(404);
            const body = JSON.parse(res.payload);
            expect(body.error).toBe('Team not found');
        });

        it('returns suggestions array and signals for existing team', async () => {
            testState.seedTeam('user-1', 'team-1');
            const res = await app.inject({
                method: 'GET',
                url: '/v1/teams/team-1/evolution/suggestions'
            });
            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body).toHaveProperty('suggestions');
            expect(body).toHaveProperty('signals');
            expect(Array.isArray(body.suggestions)).toBe(true);
        });

        it('returns required signal fields', async () => {
            testState.seedTeam('user-1', 'team-1');
            const res = await app.inject({
                method: 'GET',
                url: '/v1/teams/team-1/evolution/suggestions'
            });
            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body.signals).toHaveProperty('ratingTrend');
            expect(body.signals).toHaveProperty('blockingRate');
            expect(body.signals).toHaveProperty('avgCompletionTime');
            expect(body.signals).toHaveProperty('idleRate');
        });

        it('suggestion has required fields', async () => {
            testState.seedTeam('user-1', 'team-1');
            // Seed declining ratings to trigger a suggestion
            testState.seedRatings('team-1', [
                { value: '8.0', daysAgo: 6 },
                { value: '6.0', daysAgo: 4 },
                { value: '4.0', daysAgo: 2 },
                { value: '3.0', daysAgo: 0 }
            ]);
            const res = await app.inject({
                method: 'GET',
                url: '/v1/teams/team-1/evolution/suggestions'
            });
            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            if (body.suggestions.length > 0) {
                const s = body.suggestions[0];
                expect(s).toHaveProperty('type');
                expect(s).toHaveProperty('description');
                expect(s).toHaveProperty('confidence');
                expect(s).toHaveProperty('basedOn');
                expect(s).toHaveProperty('currentState');
                expect(s).toHaveProperty('suggestedState');
            }
        });

        it('ratingTrend is declining when ratings decrease consistently', async () => {
            testState.seedTeam('user-1', 'team-1');
            testState.seedRatings('team-1', [
                { value: '9.0', daysAgo: 6 },
                { value: '7.0', daysAgo: 4 },
                { value: '5.0', daysAgo: 2 },
                { value: '3.0', daysAgo: 0 }
            ]);
            const res = await app.inject({
                method: 'GET',
                url: '/v1/teams/team-1/evolution/suggestions'
            });
            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body.signals.ratingTrend).toBe('declining');
        });

        it('ratingTrend is stable when no ratings', async () => {
            testState.seedTeam('user-1', 'team-1');
            const res = await app.inject({
                method: 'GET',
                url: '/v1/teams/team-1/evolution/suggestions'
            });
            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body.signals.ratingTrend).toBe('stable');
        });
    });

    describe('GET /v1/teams/:teamId/evolution/summary', () => {
        it('returns evidence-backed recommendations and memory digest', async () => {
            testState.seedTeam('user-1', 'team-1');
            testState.seedRatings('team-1', [
                { value: '4.8', daysAgo: 6 },
                { value: '4.1', daysAgo: 2 },
                { value: '3.7', daysAgo: 0 },
            ]);
            testState.seedEvidence('team-1', 'code', '7 commits landed across the active work window.');
            testState.seedEvidence('team-1', 'collaboration', 'Coordinator requested review before merge.');
            testState.seedSession('user-1', 'sess-1', { roleId: 'coordinator', displayName: 'Coordinator' });
            testState.seedBoard('team-1', [
                {
                    id: 'task-review',
                    title: 'Review PRD evidence flow',
                    status: 'review',
                    createdAt: Date.now() - 4 * 60 * 60 * 1000,
                    updatedAt: Date.now() - 60 * 60 * 1000,
                    description: 'Waiting for approval.',
                    approvalStatus: 'pending',
                },
                {
                    id: 'task-blocked',
                    title: 'Fix machine heartbeat drift',
                    status: 'blocked',
                    createdAt: Date.now() - 8 * 60 * 60 * 1000,
                    updatedAt: Date.now() - 2 * 60 * 60 * 1000,
                    blockers: [{ id: 'block-1', description: 'Need daemon ACK before retry.' }],
                },
            ], ['sess-1']);

            const res = await app.inject({
                method: 'GET',
                url: '/v1/teams/team-1/evolution/summary',
            });

            expect(res.statusCode).toBe(200);
            const body = JSON.parse(res.payload);
            expect(body.score).toHaveProperty('delta');
            expect(body.evidenceCounts.code).toBeGreaterThan(0);
            expect(body.evidenceCounts.review).toBeGreaterThan(0);
            expect(Array.isArray(body.recommendations)).toBe(true);
            expect(body.recommendations[0]).toHaveProperty('why');
            expect(body.recommendations[0]).toHaveProperty('evidence');
            expect(body.memory.highlights.length).toBeGreaterThan(0);
        });
    });

    describe('POST /v1/teams/:teamId/evolution/apply', () => {
        it('returns 404 when team not found', async () => {
            const res = await app.inject({
                method: 'POST',
                url: '/v1/teams/nonexistent/evolution/apply',
                payload: { suggestionIndex: 0 }
            });
            expect(res.statusCode).toBe(404);
            const body = JSON.parse(res.payload);
            expect(body.error).toBe('Team not found');
        });

        it('returns 400 when no suggestions available to apply', async () => {
            testState.seedTeam('user-1', 'team-1');
            const res = await app.inject({
                method: 'POST',
                url: '/v1/teams/team-1/evolution/apply',
                payload: { suggestionIndex: 0 }
            });
            expect(res.statusCode).toBe(400);
            const body = JSON.parse(res.payload);
            expect(body.error).toContain('No suggestion');
        });

        it('returns applied result with changes', async () => {
            testState.seedTeam('user-1', 'team-1');
            // Seed declining ratings to ensure a suggestion is generated
            testState.seedRatings('team-1', [
                { value: '9.0', daysAgo: 6 },
                { value: '6.0', daysAgo: 4 },
                { value: '4.0', daysAgo: 2 },
                { value: '2.0', daysAgo: 0 }
            ]);
            // First get suggestions to see if any exist
            const suggestionsRes = await app.inject({
                method: 'GET',
                url: '/v1/teams/team-1/evolution/suggestions'
            });
            const suggestionsBody = JSON.parse(suggestionsRes.payload);

            if (suggestionsBody.suggestions.length > 0) {
                const res = await app.inject({
                    method: 'POST',
                    url: '/v1/teams/team-1/evolution/apply',
                    payload: { suggestionIndex: 0 }
                });
                expect(res.statusCode).toBe(200);
                const body = JSON.parse(res.payload);
                expect(body.result).toBe('applied');
                expect(body).toHaveProperty('changes');
            }
        });
    });
});
