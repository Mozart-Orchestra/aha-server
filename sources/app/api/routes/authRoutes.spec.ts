import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

vi.mock('@/storage/db', () => ({
    db: {
        account: {
            upsert: vi.fn(),
            findFirst: vi.fn(),
            findUnique: vi.fn(),
            update: vi.fn(),
            create: vi.fn(),
        },
        accountRecoveryMaterial: {
            findUnique: vi.fn(),
            upsert: vi.fn(),
            update: vi.fn(),
        },
        accountJoinTicket: {
            create: vi.fn(),
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

vi.mock('@/app/auth/supabaseVerify', () => ({
    supabaseVerifyToken: vi.fn(),
}));

vi.mock('@/app/auth/accountRecoveryMaterial', () => ({
    markAccountRecoveryUsed: vi.fn(),
    publicKeyHexFromContentSecretKey: vi.fn(() => 'hex-public-key'),
    readAccountRecoverySecret: vi.fn(),
    upsertAccountRecoveryMaterial: vi.fn(),
}));

vi.mock('privacy-kit', () => ({
    decodeBase64: vi.fn((value: string) => {
        switch (value) {
            case 'valid-public-key':
                return new Uint8Array(32).fill(1);
            case 'recovery-public-key':
                return new Uint8Array(32).fill(7);
            case 'content-secret':
                return new Uint8Array(32).fill(9);
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
    encodeBase64: vi.fn(() => 'encoded-recovery-secret'),
}));

vi.mock('tweetnacl', () => {
    const box = Object.assign(
        vi.fn((_data: Uint8Array) => new Uint8Array([8, 8, 8])),
        {
            publicKeyLength: 32,
            nonceLength: 24,
            keyPair: vi.fn(() => ({
                publicKey: new Uint8Array(32).fill(5),
                secretKey: new Uint8Array(32).fill(6),
            })),
        },
    );

    return {
        default: {
            sign: {
                keyPair: {
                    fromSeed: vi.fn(() => ({
                        publicKey: new Uint8Array(32).fill(1),
                        secretKey: new Uint8Array(64).fill(2),
                    })),
                },
                detached: {
                    verify: vi.fn(),
                },
            },
            box,
        },
    };
});

import tweetnacl from 'tweetnacl';

import { db } from '@/storage/db';
import { auth } from '@/app/auth/auth';
import {
    markAccountRecoveryUsed,
    readAccountRecoverySecret,
    upsertAccountRecoveryMaterial,
} from '@/app/auth/accountRecoveryMaterial';
import { supabaseVerifyToken } from '@/app/auth/supabaseVerify';
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
        vi.mocked(db.accountRecoveryMaterial.findUnique).mockResolvedValue(null as never);
        vi.mocked(db.accountJoinTicket.findUnique).mockResolvedValue(null as never);
        vi.mocked(readAccountRecoverySecret).mockResolvedValue(null as never);
        vi.mocked(supabaseVerifyToken).mockResolvedValue({
            supabaseUserId: 'supabase-user-1',
            email: 'user@example.com',
            name: 'Test User',
            avatarUrl: null,
        } as never);
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

    it('rejects Supabase exchange when the Google account is linked to a different secret', async () => {
        vi.mocked(db.account.findFirst).mockResolvedValue({
            id: 'user-1',
            publicKey: 'different-public-key',
            supabaseUserId: 'supabase-user-1',
        } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/auth/supabase/exchange',
            payload: {
                accessToken: 'supabase-token',
                publicKey: 'valid-public-key',
                challenge: 'challenge',
                signature: 'signature',
            },
        });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({
            error: 'This sign-in account is already linked to a different device secret',
            code: 'secret-proof-mismatch',
        });

        await app.close();
    });

    it('bootstraps recovery material during successful Supabase exchange', async () => {
        vi.mocked(db.account.findFirst).mockResolvedValue(null as never);
        vi.mocked(db.account.findUnique).mockResolvedValue(null as never);
        vi.mocked(db.account.create).mockResolvedValue({
            id: 'user-1',
            publicKey: 'hex-public-key',
        } as never);
        vi.mocked(upsertAccountRecoveryMaterial).mockResolvedValue({
            accountId: 'user-1',
        } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/auth/supabase/exchange',
            payload: {
                accessToken: 'supabase-token',
                publicKey: 'valid-public-key',
                challenge: 'challenge',
                signature: 'signature',
                contentSecretKey: 'content-secret',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            success: true,
            token: 'token-123',
            userId: 'user-1',
            recoveryReady: true,
        });
        expect(vi.mocked(upsertAccountRecoveryMaterial)).toHaveBeenCalled();

        await app.close();
    });

    it('returns recovery material for Supabase recover when available', async () => {
        vi.mocked(db.account.findFirst).mockResolvedValue({
            id: 'user-1',
            publicKey: 'hex-public-key',
            supabaseUserId: 'supabase-user-1',
        } as never);
        vi.mocked(readAccountRecoverySecret).mockResolvedValue(new Uint8Array([1, 2, 3]) as never);
        vi.mocked(markAccountRecoveryUsed).mockResolvedValue(undefined as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/auth/supabase/recover',
            payload: {
                accessToken: 'supabase-token',
                recoveryPublicKey: 'recovery-public-key',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            success: true,
            token: 'token-123',
            userId: 'user-1',
            encryptedContentSecretKey: 'encoded-recovery-secret',
        });

        await app.close();
    });

    it('creates an account join ticket when recovery material is ready', async () => {
        vi.mocked(db.account.findUnique).mockResolvedValue({
            id: 'user-1',
            publicKey: 'hex-public-key',
        } as never);
        vi.mocked(db.accountRecoveryMaterial.findUnique).mockResolvedValue({
            publicKey: 'hex-public-key',
        } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/account/join-ticket',
            headers: {
                authorization: 'Bearer token-123',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            success: true,
            ticket: expect.stringMatching(/^aha_join_/),
        });
        expect(vi.mocked(db.accountJoinTicket.create)).toHaveBeenCalledWith({
            data: expect.objectContaining({
                accountId: 'user-1',
                tokenHash: expect.any(String),
                expiresAt: expect.any(Date),
            }),
        });

        await app.close();
    });

    it('redeems an account join ticket into encrypted credentials', async () => {
        vi.mocked(db.accountJoinTicket.findUnique).mockResolvedValue({
            id: 'join-1',
            accountId: 'user-1',
            usedAt: null,
            expiresAt: new Date(Date.now() + 60_000),
        } as never);
        vi.mocked(db.account.findUnique).mockResolvedValue({
            id: 'user-1',
            publicKey: 'hex-public-key',
        } as never);
        vi.mocked(readAccountRecoverySecret).mockResolvedValue(new Uint8Array([1, 2, 3]) as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/auth/account/join',
            payload: {
                ticket: 'aha_join_ExampleTicket123',
                publicKey: 'valid-public-key',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            success: true,
            token: 'token-123',
            userId: 'user-1',
            encryptedContentSecretKey: 'encoded-recovery-secret',
        });
        expect(vi.mocked(db.accountJoinTicket.update)).toHaveBeenCalledWith({
            where: { id: 'join-1' },
            data: { usedAt: expect.any(Date) },
        });

        await app.close();
    });
});
