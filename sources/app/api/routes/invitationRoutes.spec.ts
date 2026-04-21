import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

vi.mock('@/storage/db', () => ({
    db: {
        account: {
            findUnique: vi.fn(),
            update: vi.fn(),
        },
        invitationCode: {
            findUnique: vi.fn(),
            updateMany: vi.fn(),
            create: vi.fn(),
            findMany: vi.fn(),
        },
        invitationRedemption: {
            create: vi.fn(),
        },
        $transaction: vi.fn(),
    },
}));

import { db } from '@/storage/db';
import { invitationRoutes } from './invitationRoutes';

function buildApp(options?: {
    userId?: string;
    authenticate?: (request: any, reply: any) => unknown | Promise<unknown>;
}) {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    typed.decorate('authenticate', options?.authenticate ?? (async (request: any) => {
        request.userId = options?.userId ?? 'user-1';
    }));
    invitationRoutes(typed);
    return typed;
}

// Helper for /redeem: backs the $transaction mock with a callback that uses
// the same mocked collections as the outer db, matching the production code.
function mockRedeemTransaction() {
    vi.mocked(db.$transaction).mockImplementation(async (callback: any) => {
        const txDb = {
            account: db.account,
            invitationCode: db.invitationCode,
            invitationRedemption: db.invitationRedemption,
        };
        return callback(txDb);
    });
}

describe('invitationRoutes', () => {
    const originalInvitationGateEnabled = process.env.INVITATION_GATE_ENABLED;

    beforeEach(() => {
        vi.clearAllMocks();
        process.env.INVITATION_GATE_ENABLED = 'true';
    });

    afterEach(() => {
        if (originalInvitationGateEnabled === undefined) {
            delete process.env.INVITATION_GATE_ENABLED;
        } else {
            process.env.INVITATION_GATE_ENABLED = originalInvitationGateEnabled;
        }
    });

    describe('GET /v1/invitation/status', () => {
        it('returns verified=false for fresh account', async () => {
            vi.mocked(db.account.findUnique).mockResolvedValue({
                invitationVerifiedAt: null,
                invitationCodeUsed: null,
            } as never);
            const app = buildApp();
            const response = await app.inject({
                method: 'GET',
                url: '/v1/invitation/status',
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({
                verified: false,
                verifiedAt: null,
                codeUsed: null,
                gateEnabled: true,
            });
        });

        it('returns verified=true when the invitation gate is disabled', async () => {
            process.env.INVITATION_GATE_ENABLED = 'false';
            vi.mocked(db.account.findUnique).mockResolvedValue({
                invitationVerifiedAt: null,
                invitationCodeUsed: null,
            } as never);
            const app = buildApp();
            const response = await app.inject({
                method: 'GET',
                url: '/v1/invitation/status',
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({
                verified: true,
                verifiedAt: null,
                codeUsed: null,
                gateEnabled: false,
            });
        });

        it('returns verified=true once redeemed', async () => {
            const verifiedAt = new Date('2026-04-16T10:00:00Z');
            vi.mocked(db.account.findUnique).mockResolvedValue({
                invitationVerifiedAt: verifiedAt,
                invitationCodeUsed: 'aha-ABCD-EFGH',
            } as never);
            const app = buildApp();
            const response = await app.inject({
                method: 'GET',
                url: '/v1/invitation/status',
            });
            expect(response.statusCode).toBe(200);
            expect(response.json().verified).toBe(true);
            expect(response.json().codeUsed).toBe('aha-ABCD-EFGH');
        });
    });

    describe('POST /v1/invitation/redeem', () => {
        it('unlocks the account with a valid code', async () => {
            mockRedeemTransaction();
            vi.mocked(db.account.findUnique).mockResolvedValue({
                invitationVerifiedAt: null,
                invitationCodeUsed: null,
            } as never);
            vi.mocked(db.invitationCode.findUnique).mockResolvedValue({
                id: 'code-1',
                code: 'aha-AAAA-BBBB',
                active: true,
                expiresAt: null,
                maxUses: 1,
                usedCount: 0,
            } as never);
            vi.mocked(db.invitationCode.updateMany).mockResolvedValue({ count: 1 } as never);
            vi.mocked(db.invitationRedemption.create).mockResolvedValue({} as never);
            vi.mocked(db.account.update).mockResolvedValue({} as never);

            const app = buildApp();
            const response = await app.inject({
                method: 'POST',
                url: '/v1/invitation/redeem',
                payload: { code: 'aha-AAAA-BBBB' },
            });

            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({
                success: true,
                alreadyVerified: false,
                codeUsed: 'aha-AAAA-BBBB',
            });
            expect(db.account.update).toHaveBeenCalledWith(expect.objectContaining({
                data: expect.objectContaining({
                    invitationCodeUsed: 'aha-AAAA-BBBB',
                }),
            }));
        });

        it('is idempotent when already verified', async () => {
            mockRedeemTransaction();
            vi.mocked(db.account.findUnique).mockResolvedValue({
                invitationVerifiedAt: new Date(),
                invitationCodeUsed: 'aha-OLD-OLD',
            } as never);

            const app = buildApp();
            const response = await app.inject({
                method: 'POST',
                url: '/v1/invitation/redeem',
                payload: { code: 'aha-anything' },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({
                success: true,
                alreadyVerified: true,
                codeUsed: 'aha-OLD-OLD',
            });
            expect(db.invitationCode.findUnique).not.toHaveBeenCalled();
            expect(db.account.update).not.toHaveBeenCalled();
        });

        it('rejects invalid code', async () => {
            mockRedeemTransaction();
            vi.mocked(db.account.findUnique).mockResolvedValue({
                invitationVerifiedAt: null,
                invitationCodeUsed: null,
            } as never);
            vi.mocked(db.invitationCode.findUnique).mockResolvedValue(null as never);

            const app = buildApp();
            const response = await app.inject({
                method: 'POST',
                url: '/v1/invitation/redeem',
                payload: { code: 'bogus' },
            });
            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ error: 'code_invalid' });
        });

        it('rejects exhausted code', async () => {
            mockRedeemTransaction();
            vi.mocked(db.account.findUnique).mockResolvedValue({
                invitationVerifiedAt: null,
                invitationCodeUsed: null,
            } as never);
            vi.mocked(db.invitationCode.findUnique).mockResolvedValue({
                id: 'code-full',
                code: 'aha-FULL',
                active: true,
                expiresAt: null,
                maxUses: 1,
                usedCount: 1,
            } as never);

            const app = buildApp();
            const response = await app.inject({
                method: 'POST',
                url: '/v1/invitation/redeem',
                payload: { code: 'aha-FULL' },
            });
            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ error: 'code_exhausted' });
        });

        it('rejects expired code', async () => {
            mockRedeemTransaction();
            vi.mocked(db.account.findUnique).mockResolvedValue({
                invitationVerifiedAt: null,
                invitationCodeUsed: null,
            } as never);
            vi.mocked(db.invitationCode.findUnique).mockResolvedValue({
                id: 'code-exp',
                code: 'aha-EXPIRED',
                active: true,
                expiresAt: new Date(Date.now() - 1000),
                maxUses: 1,
                usedCount: 0,
            } as never);

            const app = buildApp();
            const response = await app.inject({
                method: 'POST',
                url: '/v1/invitation/redeem',
                payload: { code: 'aha-EXPIRED' },
            });
            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ error: 'code_expired' });
        });

        it('rejects race-lost concurrent redeem', async () => {
            mockRedeemTransaction();
            vi.mocked(db.account.findUnique).mockResolvedValue({
                invitationVerifiedAt: null,
                invitationCodeUsed: null,
            } as never);
            vi.mocked(db.invitationCode.findUnique).mockResolvedValue({
                id: 'code-race',
                code: 'aha-RACE',
                active: true,
                expiresAt: null,
                maxUses: 1,
                usedCount: 0,
            } as never);
            vi.mocked(db.invitationCode.updateMany).mockResolvedValue({ count: 0 } as never);

            const app = buildApp();
            const response = await app.inject({
                method: 'POST',
                url: '/v1/invitation/redeem',
                payload: { code: 'aha-RACE' },
            });
            expect(response.statusCode).toBe(400);
            expect(response.json()).toEqual({ error: 'code_exhausted' });
        });
    });

    describe('POST /v1/invitation/generate', () => {
        it('403s when account is not yet invitation-verified', async () => {
            vi.mocked(db.account.findUnique).mockResolvedValue({
                invitationVerifiedAt: null,
            } as never);

            const app = buildApp();
            const response = await app.inject({
                method: 'POST',
                url: '/v1/invitation/generate',
                payload: {},
            });
            expect(response.statusCode).toBe(403);
            expect(response.json()).toEqual({ error: 'invitation_required' });
        });

        it('mints a new code for verified accounts', async () => {
            vi.mocked(db.account.findUnique).mockResolvedValue({
                invitationVerifiedAt: new Date(),
            } as never);
            vi.mocked(db.invitationCode.create).mockResolvedValue({
                id: 'new-id',
                code: 'aha-XXXX-YYYY',
                maxUses: 1,
                usedCount: 0,
                expiresAt: new Date(),
                note: null,
                createdAt: new Date(),
            } as never);

            const app = buildApp();
            const response = await app.inject({
                method: 'POST',
                url: '/v1/invitation/generate',
                payload: { maxUses: 2, expiresInDays: 7, note: 'share with alice' },
            });
            expect(response.statusCode).toBe(200);
            expect(response.json().success).toBe(true);
            expect(response.json().invitation.code).toBe('aha-XXXX-YYYY');
            expect(db.invitationCode.create).toHaveBeenCalledWith(expect.objectContaining({
                data: expect.objectContaining({
                    issuedByAccountId: 'user-1',
                    maxUses: 2,
                    note: 'share with alice',
                }),
            }));
        });
    });

    describe('GET /v1/invitation/mine', () => {
        it('lists codes issued by the authenticated account', async () => {
            vi.mocked(db.account.findUnique).mockResolvedValue({
                invitationVerifiedAt: new Date(),
            } as never);
            vi.mocked(db.invitationCode.findMany).mockResolvedValue([
                {
                    id: 'c1',
                    code: 'aha-1',
                    maxUses: 1,
                    usedCount: 0,
                    expiresAt: null,
                    active: true,
                    note: null,
                    createdAt: new Date(),
                    redemptions: [],
                },
            ] as never);

            const app = buildApp();
            const response = await app.inject({
                method: 'GET',
                url: '/v1/invitation/mine',
            });
            expect(response.statusCode).toBe(200);
            expect(response.json().invitations).toHaveLength(1);
            expect(response.json().invitations[0].code).toBe('aha-1');
        });
    });
});
