import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

vi.mock('@/app/auth/auth', () => ({
    auth: {
        createGithubToken: vi.fn(),
        verifyGithubToken: vi.fn(),
    },
}));

vi.mock('@/app/github/githubConnect', () => ({
    githubConnect: vi.fn(),
}));

vi.mock('@/app/github/githubDisconnect', () => ({
    githubDisconnect: vi.fn(),
}));

vi.mock('@/context', () => ({
    Context: {
        create: vi.fn(() => ({ userId: 'user-1' })),
    },
}));

vi.mock('@/storage/db', () => ({
    db: {},
}));

import { auth } from '@/app/auth/auth';
import { connectRoutes } from './connectRoutes';

function buildApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    typed.decorate('authenticate', async (request: any) => {
        request.userId = 'user-1';
    });
    connectRoutes(typed);
    return typed;
}

describe('connectRoutes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.AHA_WEBAPP_URL;
        delete process.env.GITHUB_CLIENT_ID;
        delete process.env.GITHUB_CLIENT_SECRET;
    });

    it('redirects invalid GitHub state back to the current public webapp host', async () => {
        vi.mocked(auth.verifyGithubToken).mockResolvedValue(null as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/connect/github/callback?code=test-code&state=bad-state',
            headers: {
                host: 'internal:3005',
                'x-forwarded-host': 'ahaagi.com',
                'x-forwarded-proto': 'https',
            },
        });

        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe('https://ahaagi.com/webappv3?error=invalid_state');

        await app.close();
    });

    it('prefers AHA_WEBAPP_URL for GitHub callback errors', async () => {
        process.env.AHA_WEBAPP_URL = 'https://custom.example.com/app';
        vi.mocked(auth.verifyGithubToken).mockResolvedValue({ userId: 'user-1' } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/connect/github/callback?code=test-code&state=ok-state',
        });

        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe('https://custom.example.com/app?error=server_config');

        await app.close();
    });
});
