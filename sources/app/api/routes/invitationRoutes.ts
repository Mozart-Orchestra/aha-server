import { z } from "zod";
import * as crypto from "crypto";
import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { Fastify } from "../types";
import { requireInvitationVerified } from "../utils/requireInvitationVerified";

const MAX_CODE_LENGTH = 64;

function generateInvitationCode(prefix: string = 'aha'): string {
    // Unambiguous base32 alphabet (no 0/O, 1/I/L)
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(10);
    let body = '';
    for (let i = 0; i < bytes.length; i++) {
        body += alphabet[bytes[i] % alphabet.length];
    }
    return `${prefix}-${body.slice(0, 4)}-${body.slice(4, 8)}`;
}

export function invitationRoutes(app: Fastify) {
    // GET /v1/invitation/status — whether the authenticated account has redeemed a code
    app.get('/v1/invitation/status', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        const account = await db.account.findUnique({
            where: { id: userId },
            select: { invitationVerifiedAt: true, invitationCodeUsed: true },
        });
        return reply.send({
            verified: Boolean(account?.invitationVerifiedAt),
            verifiedAt: account?.invitationVerifiedAt ?? null,
            codeUsed: account?.invitationCodeUsed ?? null,
        });
    });

    // POST /v1/invitation/redeem — consume an invitation code to unlock the account
    app.post('/v1/invitation/redeem', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                code: z.string().min(1).max(MAX_CODE_LENGTH),
            }),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const rawCode = request.body.code.trim();
        if (!rawCode) {
            return reply.code(400).send({ error: 'code_invalid' });
        }

        try {
            const result = await db.$transaction(async (tx) => {
                const account = await tx.account.findUnique({
                    where: { id: userId },
                    select: { invitationVerifiedAt: true, invitationCodeUsed: true },
                });
                if (!account) {
                    return { status: 'account_not_found' as const };
                }

                // Idempotent: already verified — return success with existing code
                if (account.invitationVerifiedAt) {
                    return {
                        status: 'ok' as const,
                        alreadyVerified: true,
                        codeUsed: account.invitationCodeUsed,
                    };
                }

                const code = await tx.invitationCode.findUnique({
                    where: { code: rawCode },
                });
                if (!code || !code.active) {
                    return { status: 'code_invalid' as const };
                }
                if (code.expiresAt && code.expiresAt.getTime() <= Date.now()) {
                    return { status: 'code_expired' as const };
                }
                if (code.usedCount >= code.maxUses) {
                    return { status: 'code_exhausted' as const };
                }

                // Atomic update: increment usedCount only if still under limit
                const updated = await tx.invitationCode.updateMany({
                    where: {
                        id: code.id,
                        active: true,
                        usedCount: { lt: code.maxUses },
                    },
                    data: { usedCount: { increment: 1 } },
                });
                if (updated.count === 0) {
                    return { status: 'code_exhausted' as const };
                }

                await tx.invitationRedemption.create({
                    data: {
                        codeId: code.id,
                        accountId: userId,
                        ip: (request.ip ?? null) as string | null,
                        userAgent: (request.headers['user-agent'] ?? null) as string | null,
                    },
                });

                await tx.account.update({
                    where: { id: userId },
                    data: {
                        invitationVerifiedAt: new Date(),
                        invitationCodeUsed: code.code,
                    },
                });

                return { status: 'ok' as const, alreadyVerified: false, codeUsed: code.code };
            });

            if (result.status === 'ok') {
                return reply.send({
                    success: true,
                    alreadyVerified: result.alreadyVerified,
                    codeUsed: result.codeUsed,
                });
            }
            if (result.status === 'account_not_found') {
                return reply.code(401).send({ error: 'account_not_found' });
            }
            return reply.code(400).send({ error: result.status });
        } catch (error) {
            log({ module: 'invitation' }, `Redeem failed: ${error instanceof Error ? error.message : String(error)}`);
            return reply.code(500).send({ error: 'redeem_failed' });
        }
    });

    // POST /v1/invitation/generate — verified accounts can mint new codes to share
    app.post('/v1/invitation/generate', {
        preHandler: [app.authenticate, requireInvitationVerified],
        schema: {
            body: z.object({
                maxUses: z.number().int().min(1).max(50).optional(),
                expiresInDays: z.number().int().min(1).max(365).optional(),
                note: z.string().max(200).optional(),
            }).optional(),
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const body = (request.body ?? {}) as {
            maxUses?: number;
            expiresInDays?: number;
            note?: string;
        };
        const maxUses = body.maxUses ?? 1;
        const expiresInDays = body.expiresInDays ?? 30;
        const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

        // Retry on rare collision of randomly-generated codes
        for (let attempt = 0; attempt < 5; attempt++) {
            const code = generateInvitationCode('aha');
            try {
                const created = await db.invitationCode.create({
                    data: {
                        code,
                        issuedByAccountId: userId,
                        maxUses,
                        expiresAt,
                        note: body.note ?? null,
                    },
                    select: {
                        id: true,
                        code: true,
                        maxUses: true,
                        usedCount: true,
                        expiresAt: true,
                        note: true,
                        createdAt: true,
                    },
                });
                return reply.send({ success: true, invitation: created });
            } catch (error: any) {
                if (error?.code === 'P2002') continue; // unique-constraint collision, retry
                log({ module: 'invitation' }, `Generate failed: ${error instanceof Error ? error.message : String(error)}`);
                return reply.code(500).send({ error: 'generate_failed' });
            }
        }
        return reply.code(500).send({ error: 'generate_failed_collision' });
    });

    // GET /v1/invitation/mine — list codes issued by the authenticated account
    app.get('/v1/invitation/mine', {
        preHandler: [app.authenticate, requireInvitationVerified],
    }, async (request, reply) => {
        const userId = request.userId;
        const codes = await db.invitationCode.findMany({
            where: { issuedByAccountId: userId },
            orderBy: { createdAt: 'desc' },
            select: {
                id: true,
                code: true,
                maxUses: true,
                usedCount: true,
                expiresAt: true,
                active: true,
                note: true,
                createdAt: true,
                redemptions: {
                    select: {
                        accountId: true,
                        redeemedAt: true,
                    },
                    orderBy: { redeemedAt: 'desc' },
                },
            },
        });
        return reply.send({ invitations: codes });
    });
}
