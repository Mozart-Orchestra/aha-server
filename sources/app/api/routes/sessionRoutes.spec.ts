import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

vi.mock('@/storage/db', () => ({
    db: {
        session: {
            findMany: vi.fn(),
            findFirst: vi.fn(),
        },
        sessionMessage: {
            findMany: vi.fn(),
            count: vi.fn(),
        },
    },
}));

import { db } from '@/storage/db';
import { sessionRoutes } from './sessionRoutes';

function buildApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    typed.decorate('authenticate', async (request: any) => {
        request.userId = 'user-1';
    });
    sessionRoutes(typed);
    return typed;
}

describe('sessionRoutes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('gets a single session by id', async () => {
        vi.mocked(db.session.findFirst).mockResolvedValue({
            id: 'session-1',
            seq: 12,
            createdAt: new Date('2026-03-17T00:00:00Z'),
            updatedAt: new Date('2026-03-17T00:05:00Z'),
            metadata: JSON.stringify({ name: 'Builder', path: '/repo' }),
            metadataVersion: 3,
            agentState: JSON.stringify({ status: 'idle' }),
            agentStateVersion: 2,
            dataEncryptionKey: Buffer.from('secret'),
            active: true,
            lastActiveAt: new Date('2026-03-17T00:04:00Z'),
            _count: {
                messages: 7,
            },
        } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/sessions/session-1',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            session: expect.objectContaining({
                id: 'session-1',
                seq: 12,
                metadataVersion: 3,
                agentStateVersion: 2,
                persistedMessageCount: 7,
                dataEncryptionKey: Buffer.from('secret').toString('base64'),
            }),
        });

        await app.close();
    });
});
