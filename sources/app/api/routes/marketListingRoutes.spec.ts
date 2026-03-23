import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

vi.mock('@/storage/db', () => ({
    db: {
        marketListing: {
            findMany: vi.fn(),
            create: vi.fn(),
            count: vi.fn(),
            findUnique: vi.fn(),
            update: vi.fn(),
        },
        marketReview: {
            findUnique: vi.fn(),
            create: vi.fn(),
            findMany: vi.fn(),
        },
    },
}));

import { db } from '@/storage/db';
import { marketListingRoutes } from './marketListingRoutes';

function buildApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    typed.decorate('authenticate', async (request: any) => {
        request.userId = 'user-1';
    });
    marketListingRoutes(typed);
    return typed;
}

function buildPayload() {
    return {
        spec: {
            kind: 'aha.agent.v1',
            name: 'builder',
            runtime: 'codex',
            baseRoleId: 'builder',
        },
        visibility: {
            isPublic: true,
            accessControl: 'public',
        },
        display: {
            displayName: 'Builder',
            shortDescription: 'Builds things',
        },
        market: {
            namespace: '@acme',
            category: 'development',
            tags: ['builder', 'typescript'],
        },
    };
}

describe('marketListingRoutes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('increments version from the latest existing ref', async () => {
        vi.mocked(db.marketListing.findMany).mockResolvedValue([
            { ref: '@acme/builder:1' },
            { ref: '@acme/builder:3' },
            { ref: '@acme/builder:2' },
        ] as never);
        vi.mocked(db.marketListing.create).mockResolvedValue({
            id: 'listing-1',
            ref: '@acme/builder:4',
            digest: 'sha256:test',
            publishedAt: new Date('2026-03-24T00:00:00.000Z'),
        } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/market/listings',
            payload: buildPayload(),
        });

        expect(response.statusCode).toBe(201);
        expect(db.marketListing.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                ref: '@acme/builder:4',
            }),
        }));

        await app.close();
    });

    it('retries with a new version when ref uniqueness collides', async () => {
        vi.mocked(db.marketListing.findMany)
            .mockResolvedValueOnce([{ ref: '@acme/builder:1' }] as never)
            .mockResolvedValueOnce([{ ref: '@acme/builder:1' }, { ref: '@acme/builder:2' }] as never);
        vi.mocked(db.marketListing.create)
            .mockRejectedValueOnce({ code: 'P2002', meta: { target: ['ref'] } } as never)
            .mockResolvedValueOnce({
                id: 'listing-2',
                ref: '@acme/builder:3',
                digest: 'sha256:test',
                publishedAt: new Date('2026-03-24T00:00:00.000Z'),
            } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/market/listings',
            payload: buildPayload(),
        });

        expect(response.statusCode).toBe(201);
        expect(db.marketListing.create).toHaveBeenNthCalledWith(1, expect.objectContaining({
            data: expect.objectContaining({
                ref: '@acme/builder:2',
            }),
        }));
        expect(db.marketListing.create).toHaveBeenNthCalledWith(2, expect.objectContaining({
            data: expect.objectContaining({
                ref: '@acme/builder:3',
            }),
        }));

        await app.close();
    });
});
