import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

const tx = {
    genome: {
        findFirst: vi.fn(),
        update: vi.fn(),
    },
    session: {
        create: vi.fn(),
    },
    artifact: {
        create: vi.fn(),
    },
};

vi.mock('@/storage/db', () => ({
    db: {
        $transaction: vi.fn(async (callback: (innerTx: typeof tx) => unknown) => callback(tx)),
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
        vi.mocked(db.$transaction).mockImplementation(async (callback: (innerTx: typeof tx) => unknown) => callback(tx));
        tx.genome.findFirst.mockResolvedValue({ id: 'genome-1' });
        tx.genome.update.mockResolvedValue({ id: 'genome-1' });
        tx.session.create.mockResolvedValue({ id: 'session-1' });
        tx.artifact.create.mockResolvedValue({
            id: 'agent-123',
            createdAt: new Date('2026-03-18T00:00:00Z'),
            updatedAt: new Date('2026-03-18T00:00:00Z'),
        });
    });

    it('creates a standalone agent inside a single transaction', async () => {
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
        expect(tx.session.create).toHaveBeenCalledTimes(1);
        expect(tx.artifact.create).toHaveBeenCalledTimes(1);
        expect(tx.genome.update).toHaveBeenCalledTimes(1);

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
});
