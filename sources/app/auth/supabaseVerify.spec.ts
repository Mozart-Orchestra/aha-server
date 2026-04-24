import { beforeEach, describe, expect, it, vi } from 'vitest';

const getUser = vi.hoisted(() => vi.fn());
const createClient = vi.hoisted(() => vi.fn(() => ({
    auth: { getUser },
})));

vi.mock('@supabase/supabase-js', () => ({
    createClient,
}));

vi.mock('@/utils/log', () => ({
    log: vi.fn(),
}));

describe('supabaseVerifyToken', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        getUser.mockReset();
        createClient.mockClear();
        process.env.SUPABASE_URL = 'https://example.supabase.co';
        process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
    });

    it('reuses the Supabase admin client across token verifications', async () => {
        getUser.mockResolvedValue({
            data: {
                user: {
                    id: 'supabase-user-1',
                    email: 'user@example.com',
                    user_metadata: {
                        full_name: 'Test User',
                        avatar_url: 'https://example.com/avatar.png',
                    },
                },
            },
            error: null,
        });

        const { supabaseVerifyToken } = await import('./supabaseVerify');

        await expect(supabaseVerifyToken('token-1')).resolves.toEqual({
            supabaseUserId: 'supabase-user-1',
            email: 'user@example.com',
            name: 'Test User',
            avatarUrl: 'https://example.com/avatar.png',
        });
        await expect(supabaseVerifyToken('token-2')).resolves.toMatchObject({
            supabaseUserId: 'supabase-user-1',
        });

        expect(createClient).toHaveBeenCalledTimes(1);
        expect(getUser).toHaveBeenCalledTimes(2);
        expect(getUser).toHaveBeenNthCalledWith(1, 'token-1');
        expect(getUser).toHaveBeenNthCalledWith(2, 'token-2');
    });

    it('does not create a client when Supabase configuration is missing', async () => {
        delete process.env.SUPABASE_URL;

        const { supabaseVerifyToken } = await import('./supabaseVerify');

        await expect(supabaseVerifyToken('token-1')).resolves.toBeNull();
        expect(createClient).not.toHaveBeenCalled();
        expect(getUser).not.toHaveBeenCalled();
    });
});
