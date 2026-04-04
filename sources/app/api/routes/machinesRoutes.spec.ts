import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

vi.mock('@/storage/db', () => ({
    db: {
        $transaction: vi.fn(),
        accessKey: {
            deleteMany: vi.fn(),
        },
        machine: {
            findFirst: vi.fn(),
            findMany: vi.fn(),
            findUnique: vi.fn(),
            upsert: vi.fn(),
            updateMany: vi.fn(),
            deleteMany: vi.fn(),
        },
    },
}));

vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: {
        emitUpdate: vi.fn(),
    },
    buildNewMachineUpdate: vi.fn().mockReturnValue({ t: 'new-machine' }),
    buildUpdateMachineUpdate: vi.fn().mockReturnValue({ t: 'update-machine' }),
    buildDeleteMachineUpdate: vi.fn().mockReturnValue({ t: 'delete-machine' }),
}));

vi.mock('@/storage/seq', () => ({
    allocateUserSeq: vi.fn().mockResolvedValue(1),
}));

vi.mock('@/utils/randomKeyNaked', () => ({
    randomKeyNaked: vi.fn().mockReturnValue('update-id'),
}));

import { db } from '@/storage/db';
import { eventRouter } from '@/app/events/eventRouter';
import { machinesRoutes } from './machinesRoutes';

function buildApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    typed.decorate('authenticate', async (request: any) => {
        request.userId = 'user-1';
    });
    machinesRoutes(typed);
    return typed;
}

describe('machinesRoutes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(db.machine.findFirst).mockResolvedValue(null as never);
        vi.mocked(db.machine.findMany).mockResolvedValue([] as never);
        vi.mocked(db.machine.findUnique).mockResolvedValue(null as never);
        vi.mocked(db.machine.upsert).mockResolvedValue({
            id: 'machine-1',
            metadata: 'meta',
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
            dataEncryptionKey: null,
            active: false,
            archivedAt: null,
            lastActiveAt: new Date('2026-03-19T00:00:00Z'),
            createdAt: new Date('2026-03-19T00:00:00Z'),
            updatedAt: new Date('2026-03-19T00:00:00Z'),
        } as never);
        vi.mocked(db.machine.updateMany).mockResolvedValue({ count: 1 } as never);
        vi.mocked(db.machine.deleteMany).mockResolvedValue({ count: 1 } as never);
        vi.mocked(db.accessKey.deleteMany).mockResolvedValue({ count: 0 } as never);
        (db.$transaction as any).mockImplementation(async (operations: unknown[]) => operations);
    });

    it('rejects cross-account machine registration without proof of ownership', async () => {
        vi.mocked(db.machine.findUnique).mockResolvedValue({
            id: 'machine-1',
            accountId: 'other-user',
        } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/machines',
            payload: {
                id: 'machine-1',
                metadata: 'encrypted-meta',
            },
        });

        expect(response.statusCode).toBe(409);
        expect(response.json()).toEqual({
            error: 'Machine already belongs to another account. Clear the local machine ID or reconnect the original account.',
        });
        expect(vi.mocked(db.machine.upsert)).not.toHaveBeenCalled();

        await app.close();
    });

    it('archives an offline machine', async () => {
        vi.mocked(db.machine.findFirst).mockResolvedValue({
            id: 'machine-1',
            accountId: 'user-1',
            active: false,
            archivedAt: null,
            lastActiveAt: new Date('2026-03-19T00:00:00Z'),
        } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/machines/machine-1/archive',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            success: true,
            machineId: 'machine-1',
            archivedAt: expect.any(Number),
        });
        expect(vi.mocked(db.machine.updateMany)).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ accountId: 'user-1', id: 'machine-1', archivedAt: null }),
        }));
        expect(vi.mocked(eventRouter.emitUpdate)).toHaveBeenCalled();

        await app.close();
    });

    it('restores an archived machine', async () => {
        vi.mocked(db.machine.findFirst).mockResolvedValue({
            id: 'machine-1',
            accountId: 'user-1',
            active: false,
            archivedAt: new Date('2026-03-18T00:00:00Z'),
            lastActiveAt: new Date('2026-03-19T00:00:00Z'),
        } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/machines/machine-1/unarchive',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            success: true,
            machineId: 'machine-1',
        });
        expect(vi.mocked(db.machine.updateMany)).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({ accountId: 'user-1', id: 'machine-1' }),
            data: { archivedAt: null },
        }));

        await app.close();
    });

    it('deletes an offline machine and its access keys', async () => {
        vi.mocked(db.machine.findFirst).mockResolvedValue({
            id: 'machine-1',
            accountId: 'user-1',
            active: false,
        } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'DELETE',
            url: '/v1/machines/machine-1',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            success: true,
            machineId: 'machine-1',
        });
        expect(vi.mocked(db.accessKey.deleteMany)).toHaveBeenCalledWith({
            where: { accountId: 'user-1', machineId: 'machine-1' },
        });
        expect(vi.mocked(db.machine.deleteMany)).toHaveBeenCalledWith({
            where: { accountId: 'user-1', id: 'machine-1' },
        });
        expect(db.$transaction).toHaveBeenCalledTimes(1);

        await app.close();
    });
});
