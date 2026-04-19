import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

const tx = {
    genome: {
        findFirst: vi.fn(),
        update: vi.fn(),
    },
    session: {
        findFirst: vi.fn(),
        create: vi.fn(),
    },
    artifact: {
        create: vi.fn(),
    },
};

vi.mock('@/storage/db', () => ({
    db: {
        session: {
            findFirst: vi.fn(),
        },
        genome: {
            findFirst: vi.fn(),
            update: vi.fn(),
        },
        artifact: {
            findFirst: vi.fn(),
            update: vi.fn(),
        },
        $transaction: vi.fn(),
    },
}));

vi.mock('@/utils/randomKeyNaked', () => ({
    randomKeyNaked: vi.fn().mockReturnValue('agent-123'),
}));

import { db } from '@/storage/db';
import { agentRoutes } from './agentRoutes';

function buildApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    typed.decorate('authenticate', async (request: any) => {
        request.userId = 'user-1';
    });
    agentRoutes(typed);
    return typed;
}

describe('agentRoutes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (db.$transaction as any).mockImplementation(async (callback: (innerTx: typeof tx) => unknown) => callback(tx));
        vi.mocked(db.session.findFirst).mockResolvedValue(null as never);
        tx.genome.findFirst.mockResolvedValue({ id: 'genome-1' });
        tx.genome.update.mockResolvedValue({ id: 'genome-1' });
        tx.session.findFirst.mockResolvedValue(null as never);
        tx.session.create.mockResolvedValue({ id: 'session-1' });
        tx.artifact.create.mockResolvedValue({
            id: 'agent-123',
            createdAt: new Date('2026-03-18T00:00:00Z'),
            updatedAt: new Date('2026-03-18T00:00:00Z'),
        });
        vi.mocked(db.artifact.findFirst).mockResolvedValue({
            id: 'agent-123',
            accountId: 'user-1',
            body: Buffer.from(JSON.stringify({
                type: 'standalone',
                name: 'Reviewer',
                status: 'pending',
                sourceImageId: 'genome-1',
                genomeId: 'genome-1',
                metadata: {},
                team: {
                    members: [{
                        memberId: 'member-1',
                        sessionTag: 'standalone:agent-123',
                        roleId: 'standalone',
                        displayName: 'Reviewer',
                        sourceImageId: 'genome-1',
                        specId: 'genome-1',
                        runtimeType: 'claude',
                        lifecycle: {
                            spawnRequestedAt: 123,
                            runStatus: 'pending',
                        },
                    }],
                },
            })),
            createdAt: new Date('2026-03-18T00:00:00Z'),
            updatedAt: new Date('2026-03-18T00:00:00Z'),
        } as never);
        vi.mocked(db.artifact.update).mockResolvedValue({
            id: 'agent-123',
            createdAt: new Date('2026-03-18T00:00:00Z'),
            updatedAt: new Date('2026-03-18T00:01:00Z'),
        } as never);
        vi.mocked(db.genome.findFirst).mockResolvedValue({ id: 'genome-1' } as never);
        vi.mocked(db.genome.update).mockResolvedValue({ id: 'genome-1' } as never);
    });

    it('creates a standalone agent artifact without a session (artifact-first)', async () => {
        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/agents',
            payload: {
                displayName: 'Reviewer',
                genomeId: 'genome-1',
                runtimeType: 'claude',
            },
        });

        expect(response.statusCode).toBe(201);
        expect(db.$transaction).toHaveBeenCalledTimes(1);
        expect(tx.session.create).not.toHaveBeenCalled();
        expect(tx.artifact.create).toHaveBeenCalledTimes(1);
        expect(tx.genome.update).not.toHaveBeenCalled();

        const body = JSON.parse(response.body);
        expect(body.agent.sessionId).toBeNull();
        expect(body.agent.lifecycle).toEqual({
            spawnRequestedAt: expect.any(Number),
            runStatus: 'pending',
        });

        await app.close();
    });

    it('does not advance genome counters when the artifact write fails', async () => {
        tx.artifact.create.mockRejectedValueOnce(new Error('artifact write failed'));

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/agents',
            payload: {
                displayName: 'Reviewer',
                genomeId: 'genome-1',
                runtimeType: 'claude',
            },
        });

        expect(response.statusCode).toBe(500);
        expect(db.$transaction).toHaveBeenCalledTimes(1);
        expect(tx.genome.update).not.toHaveBeenCalled();

        await app.close();
    });

    it('reuses a freshly spawned persisted session by tag before falling back to session.create', async () => {
        vi.mocked(db.session.findFirst).mockResolvedValue({
            id: 'session-live',
            tag: 'standalone:abc',
        } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/agents',
            payload: {
                displayName: 'Reviewer',
                genomeId: 'genome-1',
                runtimeType: 'claude',
                sessionId: 'session-live',
                sessionTag: 'standalone:abc',
            },
        });

        expect(response.statusCode).toBe(201);
        expect(db.session.findFirst).toHaveBeenCalled();
        expect(tx.session.create).not.toHaveBeenCalled();
        expect(tx.artifact.create).toHaveBeenCalledTimes(1);
        expect(tx.genome.update).not.toHaveBeenCalled();

        const body = JSON.parse(response.body);
        expect(body.agent.sessionId).toBe('session-live');

        await app.close();
    });

    it('returns 404 when caller provides sessionId that does not exist', async () => {
        vi.mocked(db.session.findFirst).mockResolvedValue(null as never);
        tx.session.findFirst.mockResolvedValue(null as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/agents',
            payload: {
                displayName: 'Reviewer',
                genomeId: 'genome-1',
                runtimeType: 'claude',
                sessionId: 'session-nonexistent',
            },
        });

        expect(response.statusCode).toBe(404);
        const body = JSON.parse(response.body);
        expect(body.error).toBe('Session not found');

        await app.close();
    });

    it('patches standalone lifecycle as an object and increments counters only on active transition', async () => {
        vi.mocked(db.session.findFirst).mockResolvedValue({
            id: 'session-123',
            tag: 'standalone:agent-123',
        } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/agents/agent-123',
            payload: {
                sessionId: 'session-123',
                lifecycle: {
                    runStatus: 'active',
                    spawnedAt: 456,
                },
            },
        });

        expect(response.statusCode).toBe(200);
        expect(db.session.findFirst).toHaveBeenCalledWith({
            where: {
                id: 'session-123',
                accountId: 'user-1',
            },
            select: {
                id: true,
                tag: true,
            },
        });
        expect(db.genome.update).toHaveBeenCalledTimes(1);
        expect(db.artifact.update).toHaveBeenCalledTimes(1);

        const body = JSON.parse(response.body);
        expect(body.agent.sessionId).toBe('session-123');
        expect(body.agent.lifecycle).toEqual({
            spawnRequestedAt: 123,
            runStatus: 'active',
            spawnedAt: 456,
        });

        await app.close();
    });

    it('clears stale genome attribution when runtime changes without a new image ref', async () => {
        const app = buildApp();
        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/agents/agent-123',
            payload: {
                runtimeType: 'codex',
            },
        });

        expect(response.statusCode).toBe(200);
        const updateCall = vi.mocked(db.artifact.update).mock.calls[0]?.[0];
        const rawBody = updateCall?.data?.body as Buffer;
        const parsed = JSON.parse(rawBody.toString());
        const boardBody = JSON.parse(parsed.body);
        const member = boardBody.team.members[0];

        expect(boardBody.sourceImageId).toBeNull();
        expect(boardBody.genomeId).toBeNull();
        expect(member.runtimeType).toBe('codex');
        expect(member.sourceImageId).toBeNull();
        expect(member.specId).toBeNull();

        await app.close();
    });

    it('rejects patch when the provided session does not belong to the user', async () => {
        vi.mocked(db.session.findFirst).mockResolvedValue(null as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/agents/agent-123',
            payload: {
                sessionId: 'session-404',
                lifecycle: {
                    runStatus: 'active',
                },
            },
        });

        expect(response.statusCode).toBe(404);
        expect(JSON.parse(response.body).error).toBe('Session not found');
        expect(db.artifact.update).not.toHaveBeenCalled();
        expect(db.genome.update).not.toHaveBeenCalled();

        await app.close();
    });
});
