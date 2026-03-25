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

function buildPayload(overrides?: Partial<{
    specName: string;
    displayName: string;
    namespace: string;
}>) {
    const specName = overrides?.specName ?? 'backend-builder';
    const displayName = overrides?.displayName ?? 'Backend Builder';
    const namespace = overrides?.namespace ?? '@official';

    return {
        spec: {
            kind: 'aha.agent.v1' as const,
            name: specName,
            runtime: 'codex' as const,
            baseRoleId: 'builder',
        },
        visibility: {
            isPublic: true,
            accessControl: 'public' as const,
        },
        display: {
            displayName,
            shortDescription: 'Backend helper',
        },
        market: {
            namespace,
            category: 'development' as const,
            tags: ['backend', 'testing'],
        },
    };
}

describe('marketListingRoutes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(db.marketListing.create).mockImplementation(async ({ data }: any) => ({
            id: 'listing-1',
            ref: data.ref,
            digest: data.digest,
            publishedAt: new Date('2026-03-25T08:00:00.000Z'),
        }) as never);
    });

    it('starts new listings at version 1', async () => {
        vi.mocked(db.marketListing.findMany).mockResolvedValue([] as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/market/listings',
            payload: buildPayload(),
        });

        expect(response.statusCode).toBe(201);
        expect(vi.mocked(db.marketListing.create)).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                ref: '@official/backend-builder:1',
            }),
        }));

        await app.close();
    });

    it('increments version from the highest existing listing ref', async () => {
        vi.mocked(db.marketListing.findMany).mockResolvedValue([
            { ref: '@official/backend-builder:2' },
            { ref: '@official/backend-builder:7' },
            { ref: '@official/backend-builder:3' },
        ] as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/market/listings',
            payload: buildPayload(),
        });

        expect(response.statusCode).toBe(201);
        expect(vi.mocked(db.marketListing.create)).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                ref: '@official/backend-builder:8',
            }),
        }));

        await app.close();
    });

    it('queries existing listings by display.displayName instead of display.name', async () => {
        vi.mocked(db.marketListing.findMany).mockResolvedValue([] as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/market/listings',
            payload: buildPayload({
                specName: 'backend-builder-core',
                displayName: 'Backend Builder Core',
            }),
        });

        expect(response.statusCode).toBe(201);
        expect(vi.mocked(db.marketListing.findMany)).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                display: {
                    path: ['displayName'],
                    equals: 'Backend Builder Core',
                },
            }),
        }));

        await app.close();
    });
});
