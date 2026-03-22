import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

vi.mock('@/storage/db', () => ({
    db: {
        simpleCache: {
            findUnique: vi.fn(),
            findMany: vi.fn(),
            upsert: vi.fn(),
        },
    },
}));

vi.mock('@/app/team/teamArtifacts', () => ({
    getAccessibleTeamArtifact: vi.fn(),
}));

import { db } from '@/storage/db';
import { getAccessibleTeamArtifact } from '@/app/team/teamArtifacts';
import { teamReviewRoutes } from './teamReviewRoutes';

function buildApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    typed.decorate('authenticate', async (request: any) => {
        request.userId = 'user-1';
    });
    teamReviewRoutes(typed);
    return typed;
}

describe('teamReviewRoutes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getAccessibleTeamArtifact).mockResolvedValue({
            id: 'team-1',
            accountId: 'user-1',
            body: Buffer.from('{}'),
            createdAt: new Date('2026-03-20T00:00:00Z'),
            updatedAt: new Date('2026-03-20T00:00:00Z'),
        } as never);
    });

    it('writes a team review and returns an aggregate scorecard', async () => {
        vi.mocked(db.simpleCache.findUnique).mockResolvedValue(null as never);
        vi.mocked(db.simpleCache.upsert).mockResolvedValue({ key: 'team-review:team-1:user-1' } as never);
        vi.mocked(db.simpleCache.findMany).mockResolvedValue([
            {
                key: 'team-review:team-1:user-1',
                value: JSON.stringify({
                    id: 'team-review:team-1:user-1',
                    teamId: 'team-1',
                    reviewerId: 'user-1',
                    rating: 4.5,
                    codeScore: 88,
                    qualityScore: 91,
                    source: 'system',
                    createdAt: '2026-03-20T00:00:00.000Z',
                    updatedAt: '2026-03-20T00:00:00.000Z',
                }),
            },
        ] as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/teams/team-1/reviews',
            payload: {
                rating: 4.5,
                codeScore: 88,
                qualityScore: 91,
                source: 'system',
                comment: 'Strong collaboration.',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            success: true,
            review: expect.objectContaining({
                teamId: 'team-1',
                reviewerId: 'user-1',
                rating: 4.5,
                codeScore: 88,
                qualityScore: 91,
                source: 'system',
                comment: 'Strong collaboration.',
            }),
            scorecard: expect.objectContaining({
                averageRating: 4.5,
                reviewCount: 1,
                cumulativeCode: 88,
                cumulativeQuality: 91,
                sourceScoreTotals: expect.objectContaining({
                    system: 4.5,
                }),
            }),
        });

        await app.close();
    });

    it('lists stored team reviews', async () => {
        vi.mocked(db.simpleCache.findMany).mockResolvedValue([
            {
                key: 'team-review:team-1:user-1',
                value: JSON.stringify({
                    id: 'team-review:team-1:user-1',
                    teamId: 'team-1',
                    reviewerId: 'user-1',
                    rating: 4,
                    source: 'user',
                    createdAt: '2026-03-20T00:00:00.000Z',
                    updatedAt: '2026-03-20T00:00:00.000Z',
                }),
            },
            {
                key: 'team-review:team-1:user-2',
                value: JSON.stringify({
                    id: 'team-review:team-1:user-2',
                    teamId: 'team-1',
                    reviewerId: 'user-2',
                    rating: 5,
                    source: 'master',
                    createdAt: '2026-03-20T01:00:00.000Z',
                    updatedAt: '2026-03-20T01:00:00.000Z',
                }),
            },
        ] as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/teams/team-1/reviews?limit=10',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            reviews: expect.arrayContaining([
                expect.objectContaining({ reviewerId: 'user-1', rating: 4 }),
                expect.objectContaining({ reviewerId: 'user-2', rating: 5 }),
            ]),
            total: 2,
        });

        await app.close();
    });

    it('builds a cumulative team score from reviews', async () => {
        vi.mocked(db.simpleCache.findMany).mockResolvedValue([
            {
                key: 'team-review:team-1:user-1',
                value: JSON.stringify({
                    id: 'team-review:team-1:user-1',
                    teamId: 'team-1',
                    reviewerId: 'user-1',
                    rating: 4,
                    codeScore: 80,
                    qualityScore: 85,
                    sourceScores: { user: 4 },
                    createdAt: '2026-03-20T00:00:00.000Z',
                    updatedAt: '2026-03-20T00:00:00.000Z',
                }),
            },
            {
                key: 'team-review:team-1:user-2',
                value: JSON.stringify({
                    id: 'team-review:team-1:user-2',
                    teamId: 'team-1',
                    reviewerId: 'user-2',
                    rating: 5,
                    codeScore: 90,
                    qualityScore: 92,
                    sourceScores: { system: 5 },
                    createdAt: '2026-03-20T02:00:00.000Z',
                    updatedAt: '2026-03-20T02:00:00.000Z',
                }),
            },
        ] as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/teams/team-1/score',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            averageRating: 4.5,
            reviewCount: 2,
            cumulativeCode: 170,
            cumulativeQuality: 177,
            sourceScoreTotals: {
                user: 4,
                master: 0,
                system: 5,
            },
            lastReviewedAt: '2026-03-20T02:00:00.000Z',
        });

        await app.close();
    });
});
