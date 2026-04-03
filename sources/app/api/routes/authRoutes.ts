import { z } from "zod";
import { type Fastify } from "../types";
import * as privacyKit from "privacy-kit";
import { randomBytes, randomInt } from "crypto";
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
import { decryptBoxedContentSecretKey, getWrappingPublicKey } from "@/app/auth/contentWrappingKey";

export function authRoutes(app: Fastify) {
    const JOIN_CODE_TTL_MS = 15 * 60 * 1000;
    const JOIN_CODE_LENGTH = 6;
    const JOIN_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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
        if (!publicKeysMatch(derivedPublicKeyHex, accountPublicKey)) {
            throw new Error('content-secret-mismatch');
        }

        await upsertAccountRecoveryMaterial(accountId, contentSecretKey);
        return true;
    }

    function normalizePublicKeyHex(publicKey: string | null | undefined): string | null {
        const normalized = publicKey?.trim().toLowerCase() ?? '';
        return normalized || null;
    }

    function publicKeysMatch(left: string | null | undefined, right: string | null | undefined): boolean {
        const normalizedLeft = normalizePublicKeyHex(left);
        const normalizedRight = normalizePublicKeyHex(right);
        return !!normalizedLeft && normalizedLeft === normalizedRight;
    }

    function generateJoinCodeValue(): string {
        return Array.from({ length: JOIN_CODE_LENGTH }, () => {
            const index = randomInt(0, JOIN_CODE_ALPHABET.length);
            return JOIN_CODE_ALPHABET[index];
        }).join('');
    }

    async function createJoinCode(accountId: string): Promise<{ code: string; expiresAt: Date }> {
        await db.joinCode.deleteMany({
            where: {
                accountId,
                usedAt: null,
            },
        });

        const expiresAt = new Date(Date.now() + JOIN_CODE_TTL_MS);

        for (let attempt = 0; attempt < 5; attempt++) {
            const code = generateJoinCodeValue();

            try {
                await db.joinCode.create({
                    data: {
                        accountId,
                        code,
                        expiresAt,
                    },
                });

                return { code, expiresAt };
            } catch (error: any) {
                if (error?.code !== 'P2002') {
                    throw error;
                }
            }
        }

        throw new Error('join-code-generation-failed');
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

    async function decodeValidBoxPublicKey(publicKeyBase64: string): Promise<Uint8Array | null> {
        const tweetnacl = (await import("tweetnacl")).default;
        let publicKey: Uint8Array;
        try {
            publicKey = privacyKit.decodeBase64(publicKeyBase64);
        } catch {
            return null;
        }

        if (publicKey.length !== tweetnacl.box.publicKeyLength) {
            return null;
        }

        return publicKey;
    }

    /**
     * Resolves a plaintext contentSecretKey (as base64) from the request body.
     * Accepts either the NaCl box-encrypted form or the legacy plaintext fallback.
     * Returns null if an encrypted payload is incomplete/invalid or when no secret is present.
     */
    function resolveContentSecretKeyBase64(body: {
        encryptedContentSecretKey?: string | null;
        nonce?: string | null;
        ephemeralPublicKey?: string | null;
        contentSecretKey?: string | null;
    }): string | null {
        if (body.encryptedContentSecretKey || body.nonce || body.ephemeralPublicKey) {
            if (!(body.encryptedContentSecretKey && body.nonce && body.ephemeralPublicKey)) {
                return null;
            }
            const decrypted = decryptBoxedContentSecretKey({
                ciphertext: body.encryptedContentSecretKey,
                nonce: body.nonce,
                ephemeralPublicKey: body.ephemeralPublicKey,
            });
            if (!decrypted) {
                return null;
            }
            return privacyKit.encodeBase64(decrypted);
        }
        return body.contentSecretKey?.trim() || null;
    }

    app.get('/v1/auth/wrapping-key', {
        schema: {
            response: {
                200: z.object({
                    wrappingPublicKey: z.string(),
                }),
            },
        },
    }, async (_request, reply) => {
        return reply.send({
            wrappingPublicKey: privacyKit.encodeBase64(getWrappingPublicKey()),
        });
    });

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
                // NaCl box-encrypted form: client encrypts contentSecretKey to server wrapping key
                encryptedContentSecretKey: z.string().optional(),
                nonce: z.string().optional(),
                ephemeralPublicKey: z.string().optional(),
                // Legacy plaintext fallback kept during rollout.
                contentSecretKey: z.string().optional(),
            }),
            response: {
                200: z.object({
                    success: z.literal(true),
                    publicKey: z.string(),
                }),
                400: z.object({
                    error: z.string(),
                    code: z.enum(['decryption-failed', 'content-secret-required']),
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

        const hasLegacyContentSecretKey = !!request.body.contentSecretKey?.trim();
        const hasEncryptedContentSecretKeyPayload = !!(
            request.body.encryptedContentSecretKey ||
            request.body.nonce ||
            request.body.ephemeralPublicKey
        );

        if (!hasLegacyContentSecretKey && !hasEncryptedContentSecretKeyPayload) {
            return reply.code(400).send({
                error: 'Missing content secret key',
                code: 'content-secret-required',
            });
        }

        const contentSecretKeyBase64 = resolveContentSecretKeyBase64(request.body);
        if (request.body.encryptedContentSecretKey && !contentSecretKeyBase64) {
            return reply.code(400).send({
                error: 'Failed to decrypt content secret key',
                code: 'decryption-failed',
            });
        }

        try {
            await persistRecoveryMaterialForAccount(account.id, account.publicKey, contentSecretKeyBase64);
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

    // Legacy path kept for older clients — internally creates a JoinCode and aliases code as ticket.
    for (const path of ['/v1/account/join-ticket', '/v1/auth/joincode/create'] as const) {
        app.post(path, {
            preHandler: app.authenticate,
            schema: {
                response: {
                    200: z.object({
                        success: z.literal(true),
                        ticket: z.string(),
                        code: z.string(),
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

            const contentSecretKey = await readAccountRecoverySecret(account.id);
            if (!contentSecretKey || !publicKeysMatch(publicKeyHexFromContentSecretKey(contentSecretKey), account.publicKey)) {
                return reply.code(409).send({
                    error: 'Automatic recovery is not ready for this account yet',
                    code: 'RECOVERY_NOT_READY',
                });
            }

            const { code, expiresAt } = await createJoinCode(account.id);

            return reply.send({
                success: true,
                ticket: code,
                code,
                expiresAt: expiresAt.toISOString(),
            });
        });
    }


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

        const joinCode = await db.joinCode.findUnique({
            where: { code: request.body.ticket.trim().toUpperCase() },
        });

        if (!joinCode || joinCode.usedAt || joinCode.expiresAt.getTime() <= Date.now()) {
            return reply.code(404).send({
                error: 'Join code is invalid or expired',
                code: 'JOIN_TICKET_INVALID',
            });
        }

        const account = await db.account.findUnique({
            where: { id: joinCode.accountId },
        });

        if (!account) {
            return reply.code(404).send({
                error: 'Join code is invalid or expired',
                code: 'JOIN_TICKET_INVALID',
            });
        }

        const contentSecretKey = await readAccountRecoverySecret(account.id);
        if (!contentSecretKey || !publicKeysMatch(publicKeyHexFromContentSecretKey(contentSecretKey), account.publicKey)) {
            return reply.code(409).send({
                error: 'Automatic recovery is not ready for this account yet',
                code: 'RECOVERY_NOT_READY',
            });
        }

        const token = await auth.createToken(account.id);
        const encryptedContentSecretKey = await encryptForBoxPublicKey(contentSecretKey, publicKey);

        await db.joinCode.update({
            where: { id: joinCode.id },
            data: { usedAt: new Date() },
        });

        return reply.send({
            success: true,
            token,
            userId: account.id,
            encryptedContentSecretKey: privacyKit.encodeBase64(encryptedContentSecretKey),
        });
    });

    app.post('/v1/auth/joincode/redeem', {
        schema: {
            body: z.object({
                code: z.string(),
                machinePublicKey: z.string(),
            }),
            response: {
                200: z.object({
                    jwt: z.string(),
                    encryptedContentSecretKey: z.string(),
                }),
                401: z.object({
                    error: z.string(),
                }),
                404: z.object({
                    error: z.string(),
                    code: z.literal('JOIN_CODE_INVALID'),
                }),
                409: z.object({
                    error: z.string(),
                    code: z.literal('RECOVERY_NOT_READY'),
                }),
            },
        },
    }, async (request, reply) => {
        const machinePublicKey = await decodeValidBoxPublicKey(request.body.machinePublicKey);
        if (!machinePublicKey) {
            return reply.code(401).send({ error: 'Invalid machine public key' });
        }

        const joinCode = await db.joinCode.findUnique({
            where: { code: request.body.code.trim().toUpperCase() },
            include: { account: true },
        });

        if (!joinCode || joinCode.usedAt || joinCode.expiresAt.getTime() <= Date.now()) {
            return reply.code(404).send({
                error: 'Join code is invalid or expired',
                code: 'JOIN_CODE_INVALID',
            });
        }

        const contentSecretKey = await readAccountRecoverySecret(joinCode.account.id);
        if (!contentSecretKey) {
            return reply.code(409).send({
                error: 'Automatic recovery is not ready for this account yet',
                code: 'RECOVERY_NOT_READY',
            });
        }

        const derivedPublicKeyHex = publicKeyHexFromContentSecretKey(contentSecretKey);
        if (!publicKeysMatch(derivedPublicKeyHex, joinCode.account.publicKey)) {
            return reply.code(409).send({
                error: 'Automatic recovery is not ready for this account yet',
                code: 'RECOVERY_NOT_READY',
            });
        }

        const jwt = await auth.createToken(joinCode.account.id);
        const encryptedContentSecretKey = await encryptForBoxPublicKey(contentSecretKey, machinePublicKey);

        await db.joinCode.update({
            where: { id: joinCode.id },
            data: { usedAt: new Date() },
        });

        return reply.send({
            jwt,
            encryptedContentSecretKey: privacyKit.encodeBase64(encryptedContentSecretKey),
        });
    });


    app.post('/v1/auth/supabase/complete', {
        schema: {
            body: z.object({
                accessToken: z.string(),
                recoveryPublicKey: z.string(),
                // Encrypted form (required)
                newEncryptedContentSecretKey: z.string().optional(),
                newNonce: z.string().optional(),
                newEphemeralPublicKey: z.string().optional(),
                // Legacy plaintext fallback kept during rollout.
                newContentSecretKey: z.string().optional(),
                legacyPublicKey: z.string().nullable().optional(),
                legacyAuthToken: z.string().nullable().optional(),
            }),
            response: {
                200: z.object({
                    state: z.enum(['existing_recovered', 'new_account_created', 'migration_required']),
                    token: z.string().nullable(),
                    userId: z.string().nullable(),
                    encryptedContentSecretKey: z.string().nullable().optional(),
                    canonicalPublicKey: z.string().nullable().optional(),
                    reason: z.string().optional(),
                }),
                401: z.object({
                    error: z.string(),
                }),
                409: z.object({
                    error: z.string(),
                    code: z.literal('ACCOUNT_LINK_CONFLICT'),
                }),
            },
        },
    }, async (request, reply) => {
        const verified = await supabaseVerifyToken(request.body.accessToken);
        if (!verified) {
            log({ module: 'supabase-auth' }, `[SUPABASE COMPLETE] ❌ Token verification failed`);
            return reply.code(401).send({ error: 'Invalid Supabase token' });
        }

        const recoveryPublicKey = await decodeValidBoxPublicKey(request.body.recoveryPublicKey);
        if (!recoveryPublicKey) {
            return reply.code(401).send({ error: 'Invalid recovery public key' });
        }

        const firstName = verified.name?.split(' ')[0] ?? null;
        const lastName = verified.name?.split(' ').slice(1).join(' ') ?? null;

        let account = await db.account.findFirst({
            where: { supabaseUserId: verified.supabaseUserId },
        });

        const legacyPublicKey = request.body.legacyPublicKey?.trim() || null;
        const legacyAuthToken = request.body.legacyAuthToken?.trim() || null;
        if (!account && legacyAuthToken) {
            const verifiedLegacyAuth = await auth.verifyToken(legacyAuthToken);
            if (!verifiedLegacyAuth) {
                return reply.code(401).send({ error: 'Invalid legacy auth token' });
            }

            const legacyAccount = await db.account.findUnique({
                where: { id: verifiedLegacyAuth.userId },
            });

            if (!legacyAccount) {
                return reply.code(401).send({ error: 'Invalid legacy auth token' });
            }

            if (legacyPublicKey && !publicKeysMatch(legacyAccount.publicKey, legacyPublicKey)) {
                return reply.code(401).send({ error: 'Invalid legacy auth token' });
            }

            if (legacyAccount?.supabaseUserId && legacyAccount.supabaseUserId !== verified.supabaseUserId) {
                return reply.code(409).send({
                    error: 'This restore key is already linked to another sign-in account',
                    code: 'ACCOUNT_LINK_CONFLICT',
                });
            }

            if (legacyAccount && !legacyAccount.supabaseUserId) {
                account = await db.account.update({
                    where: { id: legacyAccount.id },
                    data: {
                        supabaseUserId: verified.supabaseUserId,
                        email: verified.email,
                        firstName,
                        lastName,
                        updatedAt: new Date(),
                    },
                });
                log({ module: 'supabase-auth' }, `[SUPABASE COMPLETE] Linked legacy account ${legacyAccount.id} to Supabase user ${verified.supabaseUserId}`);
            }
        }

        if (account) {
            let contentSecretKey = await readAccountRecoverySecret(account.id);

            // No recovery material yet — adopt the newContentSecretKey the client sent.
            // This handles: (a) legacy accounts that predate recovery material,
            // (b) any account where recovery material was never bootstrapped.
            // The account publicKey is also updated to match the new key.
            if (!contentSecretKey || !publicKeysMatch(publicKeyHexFromContentSecretKey(contentSecretKey), account.publicKey)) {
                const resolvedNewKey = resolveContentSecretKeyBase64({
                    encryptedContentSecretKey: request.body.newEncryptedContentSecretKey,
                    nonce: request.body.newNonce,
                    ephemeralPublicKey: request.body.newEphemeralPublicKey,
                    contentSecretKey: request.body.newContentSecretKey,
                });
                if (!resolvedNewKey) {
                    return reply.code(401).send({ error: 'Missing or invalid new content secret key' });
                }
                const adoptedKey = privacyKit.decodeBase64(resolvedNewKey);
                const adoptedPublicKeyHex = publicKeyHexFromContentSecretKey(adoptedKey);
                await upsertAccountRecoveryMaterial(account.id, adoptedKey);
                account = await db.account.update({
                    where: { id: account.id },
                    data: {
                        publicKey: adoptedPublicKeyHex,
                        email: verified.email,
                        firstName,
                        lastName,
                        updatedAt: new Date(),
                    },
                });
                contentSecretKey = adoptedKey;
                log({ module: 'supabase-auth' }, `[SUPABASE COMPLETE] Adopted new content key for account ${account.id}`);
            } else {
                await db.account.update({
                    where: { id: account.id },
                    data: { email: verified.email, firstName, lastName, updatedAt: new Date() },
                });
            }

            const token = await auth.createToken(account.id);
            const encryptedContentSecretKey = await encryptForBoxPublicKey(contentSecretKey, recoveryPublicKey);
            await markAccountRecoveryUsed(account.id);

            return reply.send({
                state: 'existing_recovered',
                token,
                userId: account.id,
                encryptedContentSecretKey: privacyKit.encodeBase64(encryptedContentSecretKey),
            });
        }

        const resolvedNewKeyBase64 = resolveContentSecretKeyBase64({
            encryptedContentSecretKey: request.body.newEncryptedContentSecretKey,
            nonce: request.body.newNonce,
            ephemeralPublicKey: request.body.newEphemeralPublicKey,
            contentSecretKey: request.body.newContentSecretKey,
        });
        if (!resolvedNewKeyBase64) {
            return reply.code(401).send({ error: 'Missing or invalid new content secret key' });
        }
        const contentSecretKey = privacyKit.decodeBase64(resolvedNewKeyBase64);
        const publicKeyHex = publicKeyHexFromContentSecretKey(contentSecretKey);
        const existingByPublicKey = await db.account.findUnique({
            where: { publicKey: publicKeyHex },
        });

        if (existingByPublicKey) {
            return reply.code(409).send({
                error: 'This restore key is already linked to another sign-in account',
                code: 'ACCOUNT_LINK_CONFLICT',
            });
        }

        const newAccount = await db.account.create({
            data: {
                publicKey: publicKeyHex,
                supabaseUserId: verified.supabaseUserId,
                email: verified.email,
                firstName,
                lastName,
            },
        });

        await upsertAccountRecoveryMaterial(newAccount.id, contentSecretKey);
        const token = await auth.createToken(newAccount.id);

        return reply.send({
            state: 'new_account_created',
            token,
            userId: newAccount.id,
            encryptedContentSecretKey: null,
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
            // Encrypted form: NaCl box-encrypted contentSecretKey
            encryptedContentSecretKey: z.string().optional(),
            nonce: z.string().optional(),
            ephemeralPublicKey: z.string().optional(),
            // Legacy plaintext fallback kept during rollout.
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

            if (existingByPublicKey) {
                log({ module: 'supabase-auth' }, `[SUPABASE AUTH] ⚠️ Refusing to reverse-link Google account through legacy publicKey path`);
                return reply.code(409).send({
                    error: 'This restore key is already linked to another sign-in account',
                    code: 'ACCOUNT_LINK_CONFLICT',
                });
            }

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

        const contentSecretKeyBase64 = resolveContentSecretKeyBase64(request.body);
        if (request.body.encryptedContentSecretKey && !contentSecretKeyBase64) {
            return reply.code(401).send({ error: 'Invalid content secret key payload' });
        }

        let recoveryReady = false;
        try {
            recoveryReady = await persistRecoveryMaterialForAccount(account.id, account.publicKey, contentSecretKeyBase64);
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
        if (!publicKeysMatch(derivedPublicKeyHex, account.publicKey)) {
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
