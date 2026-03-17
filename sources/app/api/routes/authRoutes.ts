import { z } from "zod";
import { type Fastify } from "../types";
import * as privacyKit from "privacy-kit";
import { db } from "@/storage/db";
import { auth } from "@/app/auth/auth";
import { log } from "@/utils/log";

export function authRoutes(app: Fastify) {
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

}
