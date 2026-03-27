import { beforeEach, describe, expect, it, vi } from 'vitest';

const persistentTokenNew = vi.fn(async (payload: any) => `token-for-${payload.user}`);
const persistentVerify = vi.fn(async (token: string) => {
    if (token === 'unknown-token') {
        throw new Error('bad token');
    }

    return {
        user: 'user-verified',
        extras: { session: 'session-1' },
    };
});
const githubTokenNew = vi.fn(async () => 'github-token');
const githubVerify = vi.fn(async () => ({ user: 'user-verified' }));

vi.mock('privacy-kit', () => ({
    createPersistentTokenGenerator: vi.fn(async () => ({
        publicKey: 'public-key',
        new: persistentTokenNew,
    })),
    createPersistentTokenVerifier: vi.fn(async () => ({
        verify: persistentVerify,
    })),
    createEphemeralTokenGenerator: vi.fn(async () => ({
        publicKey: 'github-public-key',
        new: githubTokenNew,
    })),
    createEphemeralTokenVerifier: vi.fn(async () => ({
        verify: githubVerify,
    })),
}));

import { auth } from './auth';

describe('auth module', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        auth.shutdown();
        (auth as any).tokens = null;
        (auth as any).tokenCache.clear();
        delete process.env.HANDY_MASTER_SECRET;
    });

    it('requires HANDY_MASTER_SECRET during init', async () => {
        await expect(auth.init()).rejects.toThrow('HANDY_MASTER_SECRET environment variable is required');
    });

    it('serves freshly created tokens from cache without hitting the verifier', async () => {
        process.env.HANDY_MASTER_SECRET = 'test-secret';
        await auth.init();

        const token = await auth.createToken('user-1', { session: 'session-1' });
        const result = await auth.verifyToken(token);

        expect(token).toBe('token-for-user-1');
        expect(result).toEqual({
            userId: 'user-1',
            extras: { session: 'session-1' },
        });
        expect(persistentVerify).not.toHaveBeenCalled();
    });

    it('returns null when verifier throws on an uncached token', async () => {
        process.env.HANDY_MASTER_SECRET = 'test-secret';
        await auth.init();

        const result = await auth.verifyToken('unknown-token');

        expect(result).toBeNull();
        expect(persistentVerify).toHaveBeenCalledWith('unknown-token');
    });
});
