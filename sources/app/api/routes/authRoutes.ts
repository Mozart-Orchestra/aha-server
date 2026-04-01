import { z } from "zod";
import { type Fastify } from "../types";
import * as privacyKit from "privacy-kit";
import { createHash, randomBytes } from "crypto";
import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { log } from "@/utils/log";
import { supabaseVerifyToken } from "@/app/auth/supabaseVerify";
import {
    markAccountRecoveryUsed,
    publicKeyHexFromContentSecretKey,
    readAccountRecoverySecret,
    upsertAccountRecoveryMaterial,
} from "@/app/auth/accountRecoveryMaterial";
import { randomKey } from "@/utils/randomKey";

export function authRoutes(app: Fastify) {
    const ACCOUNT_JOIN_TICKET_PREFIX = 'aha_join';
    const ACCOUNT_JOIN_TICKET_TTL_MS = 15 * 60 * 1000;

    const secretAuthSchema = {
        body: z.object({
            publicKey: z.string(),
            challenge: z.string(),
            signature: z.string()
        })
    };

    async function authenticateSecretKey(
        body: { publicKey: string; challenge: string; signature: string },
        createIfMissing: boolean
    ) {
        const tweetnacl = (await import("tweetnacl")).default;
        const publicKey = privacyKit.decodeBase64(body.publicKey);
        const challenge = privacyKit.decodeBase64(body.challenge);
        const signature = privacyKit.decodeBase64(body.signature);
        const isValid = tweetnacl.sign.detached.verify(challenge, signature, publicKey);

        if (!isValid) {
            return { ok: false as const, status: 401, body: { error: 'Invalid signature' } };
        }

        const publicKeyHex = privacyKit.encodeHex(publicKey);

        if (createIfMissing) {
            const user = await db.account.upsert({
                where: { publicKey: publicKeyHex },
                update: { updatedAt: new Date() },
                create: { publicKey: publicKeyHex }
            });

            return {
                ok: true as const,
                body: {
                    success: true,
                    token: await auth.createToken(user.id)
                }
            };
        }

        const user = await db.account.findUnique({
            where: { publicKey: publicKeyHex }
        });

        if (!user) {
            return { ok: false as const, status: 404, body: { error: 'Account not found' } };
        }

        await db.account.update({
            where: { publicKey: publicKeyHex },
            data: { updatedAt: new Date() }
        });

        return {
            ok: true as const,
            body: {
                success: true,
                token: await auth.createToken(user.id)
            }
        };
    }

    async function persistRecoveryMaterialForAccount(accountId: string, accountPublicKey: string, contentSecretKeyBase64?: string | null): Promise<boolean> {
        if (!contentSecretKeyBase64) {
            const existing = await db.accountRecoveryMaterial.findUnique({
                where: { accountId },
                select: { accountId: true },
            });
            return !!existing;
        }

        const contentSecretKey = privacyKit.decodeBase64(contentSecretKeyBase64);
        const derivedPublicKeyHex = publicKeyHexFromContentSecretKey(contentSecretKey);
        if (derivedPublicKeyHex !== accountPublicKey) {
            throw new Error('content-secret-mismatch');
        }

        await upsertAccountRecoveryMaterial(accountId, contentSecretKey);
        return true;
    }

    function hashAccountJoinTicket(ticket: string): string {
        return createHash('sha256').update(ticket).digest('hex');
    }

    async function encryptForBoxPublicKey(data: Uint8Array, recipientPublicKey: Uint8Array): Promise<Uint8Array> {
        const tweetnacl = (await import("tweetnacl")).default;
        const ephemeralKeyPair = tweetnacl.box.keyPair();
        const nonce = randomBytes(tweetnacl.box.nonceLength);
        const encrypted = tweetnacl.box(data, nonce, recipientPublicKey, ephemeralKeyPair.secretKey);

        const result = new Uint8Array(ephemeralKeyPair.publicKey.length + nonce.length + encrypted.length);
        result.set(ephemeralKeyPair.publicKey, 0);
        result.set(nonce, ephemeralKeyPair.publicKey.length);
        result.set(encrypted, ephemeralKeyPair.publicKey.length + nonce.length);
        return result;
    }

    app.post('/v1/auth', {
        schema: secretAuthSchema
    }, async (request, reply) => {
        const result = await authenticateSecretKey(request.body, true);
        if (!result.ok) {
            return reply.code(result.status).send(result.body);
        }

        return reply.send(result.body);
    });

    app.post('/v1/auth/reconnect', {
        schema: secretAuthSchema
    }, async (request, reply) => {
        const result = await authenticateSecretKey(request.body, false);
        if (!result.ok) {
            return reply.code(result.status).send(result.body);
        }

        return reply.send(result.body);
    });

    app.post('/v1/auth/request', {
        schema: {
            body: z.object({
                publicKey: z.string(),
                supportsV2: z.boolean().nullish()
            }),
            response: {
                200: z.union([z.object({
                    state: z.literal('requested'),
                }), z.object({
                    state: z.literal('authorized'),
                    token: z.string(),
                    response: z.string()
                })]),
                401: z.object({
                    error: z.literal('Invalid public key')
                })
            }
        }
    }, async (request, reply) => {
        log({ module: 'auth-request' }, `[AUTH REQUEST] Received terminal auth request`);

        const tweetnacl = (await import("tweetnacl")).default;
        const publicKey = privacyKit.decodeBase64(request.body.publicKey);
        const isValid = tweetnacl.box.publicKeyLength === publicKey.length;
        if (!isValid) {
            log({ module: 'auth-request' }, `[AUTH REQUEST] ❌ Invalid public key length: ${publicKey.length}`);
            return reply.code(401).send({ error: 'Invalid public key' });
        }

        const publicKeyHex = privacyKit.encodeHex(publicKey);
        log({ module: 'auth-request' }, `[AUTH REQUEST] PublicKey hex: ${publicKeyHex}`);

        const answer = await db.terminalAuthRequest.upsert({
            where: { publicKey: publicKeyHex },
            update: {},
            create: { publicKey: publicKeyHex, supportsV2: request.body.supportsV2 ?? false }
        });

        if (answer.response && answer.responseAccountId) {
            const token = await auth.createToken(answer.responseAccountId!, { session: answer.id });
            return reply.send({
                state: 'authorized',
                token: token,
                response: answer.response
            });
        }

        return reply.send({ state: 'requested' });
    });

    // Get auth request status
    app.get('/v1/auth/request/status', {
        schema: {
            querystring: z.object({
                publicKey: z.string(),
            }),
            response: {
                200: z.object({
                    status: z.enum(['not_found', 'pending', 'authorized']),
                    supportsV2: z.boolean()
                })
            }
        }
    }, async (request, reply) => {
        const tweetnacl = (await import("tweetnacl")).default;

        log({ module: 'auth-status' }, `[AUTH STATUS] Checking status for publicKey: ${request.query.publicKey.substring(0, 20)}...`);

        const publicKey = privacyKit.decodeBase64(request.query.publicKey);
        const isValid = tweetnacl.box.publicKeyLength === publicKey.length;
        if (!isValid) {
            log({ module: 'auth-status' }, `[AUTH STATUS] ❌ Invalid public key length: ${publicKey.length}`);
            return reply.send({ status: 'not_found', supportsV2: false });
        }

        const publicKeyHex = privacyKit.encodeHex(publicKey);
        log({ module: 'auth-status' }, `[AUTH STATUS] PublicKey hex: ${publicKeyHex}`);

        const authRequest = await db.terminalAuthRequest.findUnique({
            where: { publicKey: publicKeyHex }
        });

        if (!authRequest) {
            log({ module: 'auth-status' }, `[AUTH STATUS] ❌ Request not found`);
            return reply.send({ status: 'not_found', supportsV2: false });
        }

        log({ module: 'auth-status' }, `[AUTH STATUS] Found request: ${authRequest.id}, response: ${!!authRequest.response}`);

        if (authRequest.response && authRequest.responseAccountId) {
            return reply.send({ status: 'authorized', supportsV2: false });
        }

        return reply.send({ status: 'pending', supportsV2: authRequest.supportsV2 });
    });

    // Approve auth request
    app.post('/v1/auth/response', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                response: z.string(),
                publicKey: z.string()
            })
        }
    }, async (request, reply) => {
        log({ module: 'auth-response' }, `[TERMINAL AUTH] Processing auth response - user: ${request.userId}`);

        const tweetnacl = (await import("tweetnacl")).default;
        const publicKey = privacyKit.decodeBase64(request.body.publicKey);
        log({ module: 'auth-response' }, `[TERMINAL AUTH] Decoded publicKey length: ${publicKey.length}`);

        const isValid = tweetnacl.box.publicKeyLength === publicKey.length;
        if (!isValid) {
            log({ module: 'auth-response' }, `[TERMINAL AUTH] ❌ Invalid public key length: ${publicKey.length}`);
            return reply.code(401).send({ error: 'Invalid public key' });
        }

        const publicKeyHex = privacyKit.encodeHex(publicKey);
        log({ module: 'auth-response' }, `[TERMINAL AUTH] Looking for auth request with publicKey hex: ${publicKeyHex}`);

        const authRequest = await db.terminalAuthRequest.findUnique({
            where: { publicKey: publicKeyHex }
        });

        if (!authRequest) {
            log({ module: 'auth-response' }, `[TERMINAL AUTH] ❌ Auth request not found for publicKey: ${publicKeyHex}`);
            // Let's also check what auth requests exist
            const allRequests = await db.terminalAuthRequest.findMany({
                take: 5,
                orderBy: { createdAt: 'desc' }
            });
            log({ module: 'auth-response' }, `[TERMINAL AUTH] Recent auth requests in DB: ${JSON.stringify(allRequests.map(r => ({
                id: r.id,
                publicKey: r.publicKey.substring(0, 20) + '...',
                hasResponse: !!r.response,
                createdAt: r.createdAt
            })))}`);
            return reply.code(404).send({ error: 'Request not found' });
        }

        log({ module: 'auth-response' }, `[TERMINAL AUTH] Found auth request: ${authRequest.id}, hasResponse: ${!!authRequest.response}`);

        if (!authRequest.response) {
            await db.terminalAuthRequest.update({
                where: { id: authRequest.id },
                data: { response: request.body.response, responseAccountId: request.userId }
            });
            log({ module: 'auth-response' }, `[TERMINAL AUTH] ✅ Updated auth request with response`);
        } else {
            log({ module: 'auth-response' }, `[TERMINAL AUTH] ⚠️ Auth request already has response, skipping update`);
        }

        return reply.send({ success: true });
    });

    app.post('/v1/account/recovery-material', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                contentSecretKey: z.string(),
            }),
            response: {
                200: z.object({
                    success: z.literal(true),
                    publicKey: z.string(),
                }),
                409: z.object({
                    error: z.string(),
                    code: z.literal('secret-proof-mismatch'),
                }),
            },
        },
    }, async (request, reply) => {
        const account = await db.account.findUnique({
            where: { id: request.userId },
        });

        if (!account) {
            return reply.code(409).send({
                error: 'Account not found',
                code: 'secret-proof-mismatch',
            });
        }

        try {
            await persistRecoveryMaterialForAccount(account.id, account.publicKey, request.body.contentSecretKey);
        } catch (error) {
            return reply.code(409).send({
                error: 'This device secret does not match the current account',
                code: 'secret-proof-mismatch',
            });
        }

        return reply.send({
            success: true,
            publicKey: account.publicKey,
        });
    });

    app.post('/v1/account/join-ticket', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    success: z.literal(true),
                    ticket: z.string(),
                    expiresAt: z.string(),
                }),
                409: z.object({
                    error: z.string(),
                    code: z.literal('RECOVERY_NOT_READY'),
                }),
            },
        },
    }, async (request, reply) => {
        const account = await db.account.findUnique({
            where: { id: request.userId },
        });

        if (!account) {
            return reply.code(409).send({
                error: 'Automatic recovery is not ready for this account yet',
                code: 'RECOVERY_NOT_READY',
            });
        }

        const recovery = await db.accountRecoveryMaterial.findUnique({
            where: { accountId: account.id },
            select: { publicKey: true },
        });

        if (!recovery || recovery.publicKey !== account.publicKey) {
            return reply.code(409).send({
                error: 'Automatic recovery is not ready for this account yet',
                code: 'RECOVERY_NOT_READY',
            });
        }

        const ticket = randomKey(ACCOUNT_JOIN_TICKET_PREFIX, 32);
        const expiresAt = new Date(Date.now() + ACCOUNT_JOIN_TICKET_TTL_MS);

        await db.accountJoinTicket.create({
            data: {
                accountId: account.id,
                tokenHash: hashAccountJoinTicket(ticket),
                expiresAt,
            },
        });

        return reply.send({
            success: true,
            ticket,
            expiresAt: expiresAt.toISOString(),
        });
    });

    // Account auth request
    app.post('/v1/auth/account/request', {
        schema: {
            body: z.object({
                publicKey: z.string(),
            }),
            response: {
                200: z.union([z.object({
                    state: z.literal('requested'),
                }), z.object({
                    state: z.literal('authorized'),
                    token: z.string(),
                    response: z.string()
                })]),
                401: z.object({
                    error: z.literal('Invalid public key')
                })
            }
        }
    }, async (request, reply) => {
        log({ module: 'account-auth-request' }, `[ACCOUNT AUTH] Received account auth request`);

        const tweetnacl = (await import("tweetnacl")).default;
        const publicKey = privacyKit.decodeBase64(request.body.publicKey);
        const publicKeyHex = privacyKit.encodeHex(publicKey);

        log({ module: 'account-auth-request' }, `[ACCOUNT AUTH] PublicKey hex: ${publicKeyHex}`);
        log({ module: 'account-auth-request' }, `[ACCOUNT AUTH] PublicKey length: ${publicKey.length}`);

        const isValid = tweetnacl.box.publicKeyLength === publicKey.length;
        if (!isValid) {
            log({ module: 'account-auth-request' }, `[ACCOUNT AUTH] ❌ Invalid public key length: ${publicKey.length}, expected: ${tweetnacl.box.publicKeyLength}`);
            return reply.code(401).send({ error: 'Invalid public key' });
        }

        const answer = await db.accountAuthRequest.upsert({
            where: { publicKey: publicKeyHex },
            update: {},
            create: { publicKey: publicKeyHex }
        });

        log({ module: 'account-auth-request' }, `[ACCOUNT AUTH] Created/found auth request: ${answer.id}, hasResponse: ${!!answer.response}`);

        if (answer.response && answer.responseAccountId) {
            log({ module: 'account-auth-request' }, `[ACCOUNT AUTH] ✅ Already authorized, returning token`);
            const token = await auth.createToken(answer.responseAccountId!);
            return reply.send({
                state: 'authorized',
                token: token,
                response: answer.response
            });
        }

        log({ module: 'account-auth-request' }, `[ACCOUNT AUTH] 🕐 Waiting for approval...`);
        return reply.send({ state: 'requested' });
    });

    // Approve account auth request
    app.post('/v1/auth/account/response', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                response: z.string(),
                publicKey: z.string()
            })
        }
    }, async (request, reply) => {
        log({ module: 'account-auth-response' }, `[ACCOUNT AUTH] Processing account auth response - user: ${request.userId}`);

        const tweetnacl = (await import("tweetnacl")).default;
        const publicKey = privacyKit.decodeBase64(request.body.publicKey);
        log({ module: 'account-auth-response' }, `[ACCOUNT AUTH] Decoded publicKey length: ${publicKey.length}`);

        const isValid = tweetnacl.box.publicKeyLength === publicKey.length;
        if (!isValid) {
            log({ module: 'account-auth-response' }, `[ACCOUNT AUTH] ❌ Invalid public key length: ${publicKey.length}, expected: ${tweetnacl.box.publicKeyLength}`);
            return reply.code(401).send({ error: 'Invalid public key' });
        }

        const publicKeyHex = privacyKit.encodeHex(publicKey);
        log({ module: 'account-auth-response' }, `[ACCOUNT AUTH] Looking for auth request with publicKey hex: ${publicKeyHex}`);

        const authRequest = await db.accountAuthRequest.findUnique({
            where: { publicKey: publicKeyHex }
        });

        if (!authRequest) {
            log({ module: 'account-auth-response' }, `[ACCOUNT AUTH] ❌ Request not found for publicKey: ${publicKeyHex}`);
            // Debug: check recent auth requests
            const allRequests = await db.accountAuthRequest.findMany({
                take: 5,
                orderBy: { createdAt: 'desc' }
            });
            log({ module: 'account-auth-response' }, `[ACCOUNT AUTH] Recent auth requests in DB: ${JSON.stringify(allRequests.map(r => ({
                id: r.id,
                publicKey: r.publicKey.substring(0, 20) + '...',
                hasResponse: !!r.response,
                createdAt: r.createdAt
            })))}`);
            return reply.code(404).send({ error: 'Request not found' });
        }

        log({ module: 'account-auth-response' }, `[ACCOUNT AUTH] Found auth request: ${authRequest.id}, hasResponse: ${!!authRequest.response}`);

        if (!authRequest.response) {
            await db.accountAuthRequest.update({
                where: { id: authRequest.id },
                data: { response: request.body.response, responseAccountId: request.userId }
            });
            log({ module: 'account-auth-response' }, `[ACCOUNT AUTH] ✅ Updated auth request with response`);
        } else {
            log({ module: 'account-auth-response' }, `[ACCOUNT AUTH] ⚠️ Auth request already has response, skipping update`);
        }

        return reply.send({ success: true });
    });

    app.post('/v1/auth/account/join', {
        schema: {
            body: z.object({
                ticket: z.string(),
                publicKey: z.string(),
            }),
            response: {
                200: z.object({
                    success: z.literal(true),
                    token: z.string(),
                    userId: z.string(),
                    encryptedContentSecretKey: z.string(),
                }),
                401: z.object({
                    error: z.string(),
                }),
                404: z.object({
                    error: z.string(),
                    code: z.literal('JOIN_TICKET_INVALID'),
                }),
                409: z.object({
                    error: z.string(),
                    code: z.literal('RECOVERY_NOT_READY'),
                }),
            },
        },
    }, async (request, reply) => {
        const tweetnacl = (await import("tweetnacl")).default;
        let publicKey: Uint8Array;
        try {
            publicKey = privacyKit.decodeBase64(request.body.publicKey);
        } catch {
            return reply.code(401).send({ error: 'Invalid public key' });
        }

        if (publicKey.length !== tweetnacl.box.publicKeyLength) {
            return reply.code(401).send({ error: 'Invalid public key' });
        }

        const joinTicket = await db.accountJoinTicket.findUnique({
            where: { tokenHash: hashAccountJoinTicket(request.body.ticket) },
        });

        if (!joinTicket || joinTicket.usedAt || joinTicket.expiresAt.getTime() <= Date.now()) {
            return reply.code(404).send({
                error: 'Join ticket is invalid or expired',
                code: 'JOIN_TICKET_INVALID',
            });
        }

        const account = await db.account.findUnique({
            where: { id: joinTicket.accountId },
        });

        if (!account) {
            return reply.code(404).send({
                error: 'Join ticket is invalid or expired',
                code: 'JOIN_TICKET_INVALID',
            });
        }

        const contentSecretKey = await readAccountRecoverySecret(account.id);
        if (!contentSecretKey) {
            return reply.code(409).send({
                error: 'Automatic recovery is not ready for this account yet',
                code: 'RECOVERY_NOT_READY',
            });
        }

        const derivedPublicKeyHex = publicKeyHexFromContentSecretKey(contentSecretKey);
        if (derivedPublicKeyHex !== account.publicKey) {
            return reply.code(409).send({
                error: 'Automatic recovery is not ready for this account yet',
                code: 'RECOVERY_NOT_READY',
            });
        }

        const token = await auth.createToken(account.id);
        const encryptedContentSecretKey = await encryptForBoxPublicKey(contentSecretKey, publicKey);

        await db.accountJoinTicket.update({
            where: { id: joinTicket.id },
            data: { usedAt: new Date() },
        });

        return reply.send({
            success: true,
            token,
            userId: account.id,
            encryptedContentSecretKey: privacyKit.encodeBase64(encryptedContentSecretKey),
        });
    });

    /**
     * Supabase Google OAuth authentication.
     * Receives a Supabase access token, verifies it, and creates/links an Account.
     * Client proves possession of secret via challenge-response.
     * Server never sees the secret.
     */
    const supabaseExchangeSchema = {
        body: z.object({
            accessToken: z.string(),
            publicKey: z.string(),
            challenge: z.string(),
            signature: z.string(),
            contentSecretKey: z.string().optional(),
        }),
        response: {
            200: z.object({
                success: z.literal(true),
                token: z.string(),
                userId: z.string(),
                recoveryReady: z.boolean(),
            }),
            401: z.object({
                error: z.string(),
            }),
            409: z.object({
                error: z.string(),
                code: z.enum(['RESTORE_REQUIRED', 'ACCOUNT_LINK_CONFLICT', 'secret-proof-mismatch']),
            }),
        }
    };

    // Register both /v1/auth/supabase (legacy) and /v1/auth/supabase/exchange (v3)
    for (const path of ['/v1/auth/supabase', '/v1/auth/supabase/exchange'] as const) {
        app.post(path, {
            schema: supabaseExchangeSchema
        }, async (request, reply) => {
        log({ module: 'supabase-auth' }, `[SUPABASE AUTH] Received Supabase auth request`);

        const verified = await supabaseVerifyToken(request.body.accessToken);
        if (!verified) {
            log({ module: 'supabase-auth' }, `[SUPABASE AUTH] ❌ Token verification failed`);
            return reply.code(401).send({ error: 'Invalid Supabase token' });
        }

        log({ module: 'supabase-auth' }, `[SUPABASE AUTH] ✅ Verified user: ${verified.supabaseUserId}, email: ${verified.email}`);

        const tweetnacl = (await import("tweetnacl")).default;
        const publicKey = privacyKit.decodeBase64(request.body.publicKey);
        const challenge = privacyKit.decodeBase64(request.body.challenge);
        const signature = privacyKit.decodeBase64(request.body.signature);

        const isValid = tweetnacl.sign.detached.verify(challenge, signature, publicKey);
        if (!isValid) {
            log({ module: 'supabase-auth' }, `[SUPABASE AUTH] ❌ Invalid secret proof`);
            return reply.code(401).send({ error: 'Invalid signature' });
        }

        const publicKeyHex = privacyKit.encodeHex(publicKey);
        const firstName = verified.name?.split(' ')[0] ?? null;
        const lastName = verified.name?.split(' ').slice(1).join(' ') ?? null;

        let account = await db.account.findFirst({
            where: { supabaseUserId: verified.supabaseUserId }
        });

        if (account && account.publicKey !== publicKeyHex) {
            log({ module: 'supabase-auth' }, `[SUPABASE AUTH] Account found via Google, but secret proof does not match the canonical publicKey for: ${account.id}`);
            return reply.code(409).send({
                error: 'This sign-in account is already linked to a different device secret',
                code: 'secret-proof-mismatch',
            });
        }

        if (!account) {
            const existingByPublicKey = await db.account.findUnique({
                where: { publicKey: publicKeyHex }
            });

            if (existingByPublicKey?.supabaseUserId && existingByPublicKey.supabaseUserId !== verified.supabaseUserId) {
                log({ module: 'supabase-auth' }, `[SUPABASE AUTH] ⚠️ Public key already linked to another Supabase account`);
                return reply.code(409).send({
                    error: 'This restore key is already linked to another sign-in account',
                    code: 'ACCOUNT_LINK_CONFLICT',
                });
            }

            if (existingByPublicKey) {
                account = await db.account.update({
                    where: { id: existingByPublicKey.id },
                    data: {
                        supabaseUserId: verified.supabaseUserId,
                        email: verified.email,
                        firstName,
                        lastName,
                        updatedAt: new Date(),
                    }
                });
                log({ module: 'supabase-auth' }, `[SUPABASE AUTH] Linked existing key-based account: ${account.id}`);
            } else {
                account = await db.account.create({
                    data: {
                        publicKey: publicKeyHex,
                        supabaseUserId: verified.supabaseUserId,
                        email: verified.email,
                        firstName,
                        lastName,
                    }
                });
                log({ module: 'supabase-auth' }, `[SUPABASE AUTH] Created new account: ${account.id}`);
            }
        } else {
            account = await db.account.update({
                where: { id: account.id },
                data: {
                    email: verified.email,
                    firstName,
                    lastName,
                    updatedAt: new Date(),
                }
            });
            log({ module: 'supabase-auth' }, `[SUPABASE AUTH] Found existing account: ${account.id}`);
        }

        let recoveryReady = false;
        try {
            recoveryReady = await persistRecoveryMaterialForAccount(account.id, account.publicKey, request.body.contentSecretKey);
        } catch (error) {
            return reply.code(409).send({
                error: 'This device secret does not match the current account',
                code: 'secret-proof-mismatch',
            });
        }

        const token = await auth.createToken(account.id);

        return reply.send({
            success: true,
            token,
            userId: account.id,
            recoveryReady,
        });
    });
    } // end for-loop over supabase paths

    app.post('/v1/auth/supabase/recover', {
        schema: {
            body: z.object({
                accessToken: z.string(),
                recoveryPublicKey: z.string(),
            }),
            response: {
                200: z.object({
                    success: z.literal(true),
                    token: z.string(),
                    userId: z.string(),
                    encryptedContentSecretKey: z.string(),
                }),
                401: z.object({
                    error: z.string(),
                }),
                404: z.object({
                    error: z.string(),
                    code: z.literal('ACCOUNT_NOT_FOUND'),
                }),
                409: z.object({
                    error: z.string(),
                    code: z.literal('RECOVERY_NOT_READY'),
                }),
            },
        },
    }, async (request, reply) => {
        const verified = await supabaseVerifyToken(request.body.accessToken);
        if (!verified) {
            log({ module: 'supabase-auth' }, `[SUPABASE RECOVER] ❌ Token verification failed`);
            return reply.code(401).send({ error: 'Invalid Supabase token' });
        }

        const account = await db.account.findFirst({
            where: { supabaseUserId: verified.supabaseUserId },
        });

        if (!account) {
            return reply.code(404).send({
                error: 'No existing account is linked to this sign-in identity',
                code: 'ACCOUNT_NOT_FOUND',
            });
        }

        const contentSecretKey = await readAccountRecoverySecret(account.id);
        if (!contentSecretKey) {
            return reply.code(409).send({
                error: 'Automatic recovery is not ready for this account yet',
                code: 'RECOVERY_NOT_READY',
            });
        }

        const derivedPublicKeyHex = publicKeyHexFromContentSecretKey(contentSecretKey);
        if (derivedPublicKeyHex !== account.publicKey) {
            log({ module: 'supabase-auth', level: 'warn' }, `[SUPABASE RECOVER] Recovery material does not match account publicKey for: ${account.id}`);
            return reply.code(409).send({
                error: 'Automatic recovery is not ready for this account yet',
                code: 'RECOVERY_NOT_READY',
            });
        }

        const tweetnacl = (await import("tweetnacl")).default;
        const recoveryPublicKey = privacyKit.decodeBase64(request.body.recoveryPublicKey);
        if (recoveryPublicKey.length !== tweetnacl.box.publicKeyLength) {
            return reply.code(401).send({ error: 'Invalid recovery public key' });
        }

        const token = await auth.createToken(account.id);
        const encryptedContentSecretKey = await encryptForBoxPublicKey(contentSecretKey, recoveryPublicKey);
        await markAccountRecoveryUsed(account.id);

        return reply.send({
            success: true,
            token,
            userId: account.id,
            encryptedContentSecretKey: privacyKit.encodeBase64(encryptedContentSecretKey),
        });
    });

}
