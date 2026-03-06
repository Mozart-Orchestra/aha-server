import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Fastify as TypedFastify } from '../types';

const testState = vi.hoisted(() => {
    const cacheEntries: Array<{ key: string; value: string }> = [];
    const metricsEntries: Array<{ key: string; value: Uint8Array }> = [];

    return {
        cacheEntries,
        metricsEntries,
        reset() {
            cacheEntries.length = 0;
            metricsEntries.length = 0;
        },
    };
});

vi.mock('@/storage/db', () => ({
    db: {
        userKVStore: {
            upsert: vi.fn(async ({ create, update, where }: any) => {
                const next = {
                    key: create?.key || where?.accountId_key?.key,
                    value: (update?.value || create?.value) as Uint8Array,
                };
                testState.metricsEntries.push(next);
                return next;
            }),
        },
        simpleCache: {
            create: vi.fn(async ({ data }: any) => {
                testState.cacheEntries.push(data);
                return data;
            }),
            findMany: vi.fn(async () => []),
        },
        artifact: {
            findFirst: vi.fn(async () => ({ id: 'team-1' })),
        },
        role: {
            findMany: vi.fn(async () => []),
        },
        team: {
            findMany: vi.fn(async () => []),
        },
    },
}));

vi.mock('@/services/autoRatingService', () => ({
    runAutoRatingForTeam: vi.fn(async () => ({ ratings: [], triggerType: 'manual', timestamp: new Date() })),
    getAutoRatingConfig: vi.fn(() => ({ enabled: false, frequency: 'daily', minRoundsBeforeRate: 3, lastRun: null })),
    setAutoRatingConfig: vi.fn((config) => config),
    calculateConfidenceScore: vi.fn(() => ({
        score: 0,
        sampleSize: 0,
        ratingCount: 0,
        period: { start: new Date().toISOString(), end: new Date().toISOString() },
        breakdown: { dataQuality: 0, sampleAdequacy: 0, recency: 0, consistency: 0 },
    })),
}));

vi.mock('@/utils/log', () => ({
    log: vi.fn(),
}));

import { autoRatingRoutes } from './autoRatingRoutes';

function buildApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as TypedFastify;
    typed.decorate('authenticate', async (req: any, _reply: any) => {
        req.userId = 'user-1';
    });

    autoRatingRoutes(typed);
    return app;
}

describe('autoRatingRoutes metrics persistence', () => {
    let app: ReturnType<typeof buildApp>;

    beforeEach(() => {
        testState.reset();
        app = buildApp();
    });

    afterEach(async () => {
        await app.close();
    });

    it('stores code metrics and evolution evidence for submitted agent metrics', async () => {
        const response = await app.inject({
            method: 'POST',
            url: '/v1/teams/team-1/agents/session-1/metrics',
            payload: {
                codeLines: 120,
                commits: 5,
                filesChanged: 3,
                insertions: 90,
                deletions: 30,
                bugsFixed: 1,
                reviewComments: 2,
                testCoverage: 88,
            },
        });

        expect(response.statusCode).toBe(200);
        expect(testState.metricsEntries).toHaveLength(1);
        expect(testState.cacheEntries.some((entry) => entry.key.startsWith('code-metrics:team-1:session-1:'))).toBe(true);
        expect(testState.cacheEntries.some((entry) => entry.key.startsWith('evidence:team:team-1:'))).toBe(true);
    });
});
