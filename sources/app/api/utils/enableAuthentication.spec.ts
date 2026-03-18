import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAuthentication } from './enableAuthentication';

vi.mock('@/app/auth/auth', () => ({
    auth: {
        verifyToken: vi.fn(),
    },
}));

vi.mock('@/storage/db', () => ({
    db: {
        account: {
            findUnique: vi.fn(),
        },
    },
}));

import { auth } from '@/app/auth/auth';
import { db } from '@/storage/db';

function buildApp() {
    const app = fastify();
    enableAuthentication(app as any);
    app.get('/protected', {
        preHandler: (app as any).authenticate,
    }, async (request: any) => ({ userId: request.userId }));
    return app;
}

describe('enableAuthentication', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns 401 when token points to a missing account', async () => {
        vi.mocked(auth.verifyToken).mockResolvedValue({ userId: 'user-1' });
        vi.mocked(db.account.findUnique).mockResolvedValue(null as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/protected',
            headers: {
                authorization: 'Bearer test-token',
            },
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: 'Account not found for token' });

        await app.close();
    });

    it('attaches userId when token and account are valid', async () => {
        vi.mocked(auth.verifyToken).mockResolvedValue({ userId: 'user-1' });
        vi.mocked(db.account.findUnique).mockResolvedValue({ id: 'user-1' } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/protected',
            headers: {
                authorization: 'Bearer test-token',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ userId: 'user-1' });

        await app.close();
    });
});
