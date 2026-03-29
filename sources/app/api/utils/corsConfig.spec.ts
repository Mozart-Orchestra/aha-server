import fastify from 'fastify';
import cors from '@fastify/cors';
import { afterEach, describe, expect, it } from 'vitest';
import { getCorsConfig, getSocketCorsConfig } from './corsConfig';

const ORIGINAL_ENV = {
    NODE_ENV: process.env.NODE_ENV,
    ALLOW_LOCALHOST_ORIGINS: process.env.ALLOW_LOCALHOST_ORIGINS,
    CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS,
};

function restoreEnv() {
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
        if (value === undefined) {
            delete process.env[key];
            continue;
        }
        process.env[key] = value;
    }
}

function setEnv(updates: Record<string, string | undefined>) {
    restoreEnv();
    for (const [key, value] of Object.entries(updates)) {
        if (value === undefined) {
            delete process.env[key];
            continue;
        }
        process.env[key] = value;
    }
}

async function buildApp() {
    const app = fastify();
    await app.register(cors, getCorsConfig());
    app.post('/v1/auth', async () => ({ ok: true }));
    return app;
}

describe('corsConfig', () => {
    afterEach(() => {
        restoreEnv();
    });

    it('keeps localhost origins blocked in production unless explicitly allowed', async () => {
        setEnv({
            NODE_ENV: 'production',
            ALLOW_LOCALHOST_ORIGINS: undefined,
            CORS_ALLOWED_ORIGINS: undefined,
        });

        const app = await buildApp();
        const response = await app.inject({
            method: 'OPTIONS',
            url: '/v1/auth',
            headers: {
                origin: 'http://localhost:8082',
                'access-control-request-method': 'POST',
                'access-control-request-headers': 'content-type,authorization',
            },
        });

        expect(response.headers['access-control-allow-origin']).toBeUndefined();

        await app.close();
    });

    it('allows explicitly configured production origins for preflight requests', async () => {
        setEnv({
            NODE_ENV: 'production',
            CORS_ALLOWED_ORIGINS: ' http://localhost:8082/ , http://127.0.0.1:8082 ',
        });

        const app = await buildApp();
        const response = await app.inject({
            method: 'OPTIONS',
            url: '/v1/auth',
            headers: {
                origin: 'http://localhost:8082',
                'access-control-request-method': 'POST',
                'access-control-request-headers': 'content-type,authorization',
            },
        });

        expect(response.headers['access-control-allow-origin']).toBe('http://localhost:8082');
        expect(response.headers['access-control-allow-credentials']).toBe('true');

        await app.close();
    });

    it('adds localhost and extra origins to websocket cors when enabled', () => {
        setEnv({
            NODE_ENV: 'production',
            ALLOW_LOCALHOST_ORIGINS: 'true',
            CORS_ALLOWED_ORIGINS: 'https://preview.aha.engineering/',
        });

        const socketConfig = getSocketCorsConfig();

        expect(Array.isArray(socketConfig.origin)).toBe(true);
        expect(socketConfig.origin).toEqual(expect.arrayContaining([
            'http://localhost:8082',
            'http://127.0.0.1:8082',
            'https://preview.aha.engineering',
        ]));
    });
});
