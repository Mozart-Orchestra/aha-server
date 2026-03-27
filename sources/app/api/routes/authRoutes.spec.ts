import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

vi.mock('@/storage/db', () => ({
    db: {
        account: {
            upsert: vi.fn(),
            findUnique: vi.fn(),
            update: vi.fn(),
        },
        terminalAuthRequest: {
            upsert: vi.fn(),
            findUnique: vi.fn(),
            findMany: vi.fn(),
            update: vi.fn(),
        },
        accountAuthRequest: {
            upsert: vi.fn(),
            findUnique: vi.fn(),
            findMany: vi.fn(),
            update: vi.fn(),
        },
    },
}));

vi.mock('@/app/auth/auth', () => ({
    auth: {
        createToken: vi.fn(),
    },
}));

vi.mock('privacy-kit', () => ({
    decodeBase64: vi.fn((value: string) => {
        switch (value) {
            case 'valid-public-key':
                return new Uint8Array(32).fill(1);
            case 'invalid-public-key':
                return new Uint8Array(12).fill(2);
            case 'challenge':
                return new Uint8Array([1, 2, 3]);
            case 'signature':
                return new Uint8Array([4, 5, 6]);
            default:
                return new Uint8Array();
        }
    }),
    encodeHex: vi.fn(() => 'hex-public-key'),
}));

vi.mock('tweetnacl', () => ({
    default: {
        sign: {
            detached: {
                verify: vi.fn(),
            },
        },
        box: {
            publicKeyLength: 32,
        },
    },
}));

import tweetnacl from 'tweetnacl';

import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import { authRoutes } from './authRoutes';

function buildApp(options?: {
    authenticate?: (request: any, reply: any) => unknown | Promise<unknown>;
}) {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    typed.decorate('authenticate', options?.authenticate || (async (request: any) => {
        request.userId = 'user-1';
    }));
    authRoutes(typed);
    return typed;
}

describe('authRoutes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(auth.createToken).mockResolvedValue('token-123');
        vi.mocked(tweetnacl.sign.detached.verify).mockReturnValue(true as never);
    });

    it('rejects /v1/auth when the signature is invalid', async () => {
        vi.mocked(tweetnacl.sign.detached.verify).mockReturnValue(false as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/auth',
            payload: {
                publicKey: 'valid-public-key',
                challenge: 'challenge',
                signature: 'signature',
            },
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: 'Invalid signature' });
        expect(vi.mocked(db.account.upsert)).not.toHaveBeenCalled();

        await app.close();
    });

    it('creates an auth token for /v1/auth when the signature is valid', async () => {
        vi.mocked(db.account.upsert).mockResolvedValue({ id: 'user-1' } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/auth',
            payload: {
                publicKey: 'valid-public-key',
                challenge: 'challenge',
                signature: 'signature',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            success: true,
            token: 'token-123',
        });
        expect(vi.mocked(db.account.upsert)).toHaveBeenCalledWith({
            where: { publicKey: 'hex-public-key' },
            update: { updatedAt: expect.any(Date) },
            create: { publicKey: 'hex-public-key' },
        });

        await app.close();
    });

    it('returns 404 from /v1/auth/reconnect when the account does not exist', async () => {
        vi.mocked(db.account.findUnique).mockResolvedValue(null as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/auth/reconnect',
            payload: {
                publicKey: 'valid-public-key',
                challenge: 'challenge',
                signature: 'signature',
            },
        });

        expect(response.statusCode).toBe(404);
        expect(response.json()).toEqual({ error: 'Account not found' });
        expect(vi.mocked(db.account.update)).not.toHaveBeenCalled();

        await app.close();
    });

    it('returns requested from /v1/auth/request when approval is still pending', async () => {
        vi.mocked(db.terminalAuthRequest.upsert).mockResolvedValue({
            id: 'request-1',
            response: null,
            responseAccountId: null,
        } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/auth/request',
            payload: {
                publicKey: 'valid-public-key',
                supportsV2: true,
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ state: 'requested' });
        expect(vi.mocked(db.terminalAuthRequest.upsert)).toHaveBeenCalledWith({
            where: { publicKey: 'hex-public-key' },
            update: {},
            create: { publicKey: 'hex-public-key', supportsV2: true },
        });

        await app.close();
    });

    it('rejects /v1/auth/request when the public key length is invalid', async () => {
        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/auth/request',
            payload: {
                publicKey: 'invalid-public-key',
            },
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({ error: 'Invalid public key' });
        expect(vi.mocked(db.terminalAuthRequest.upsert)).not.toHaveBeenCalled();

        await app.close();
    });

    it('returns authorized status for /v1/auth/request/status when a response exists', async () => {
        vi.mocked(db.terminalAuthRequest.findUnique).mockResolvedValue({
            id: 'request-1',
            supportsV2: true,
            response: 'approved',
            responseAccountId: 'user-1',
        } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/auth/request/status',
            query: {
                publicKey: 'valid-public-key',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            status: 'authorized',
            supportsV2: false,
        });

        await app.close();
    });
});
