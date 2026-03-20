import { eventRouter } from "@/app/events/eventRouter";
import { Fastify } from "../types";
import { z } from "zod";
import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { allocateUserSeq } from "@/storage/seq";
import { buildNewMachineUpdate, buildUpdateMachineUpdate } from "@/app/events/eventRouter";

export function machinesRoutes(app: Fastify) {
    app.post('/v1/machines', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                id: z.string(),
                metadata: z.string(), // Encrypted metadata
                daemonState: z.string().optional(), // Encrypted daemon state
                dataEncryptionKey: z.string().nullish()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id, metadata, daemonState, dataEncryptionKey } = request.body;

        // Check if machine ID exists for a different account
        const existingById = await db.machine.findUnique({ where: { id } });
        if (existingById && existingById.accountId !== userId) {
            log(
                { module: 'machines', level: 'warn', machineId: id, userId, previousAccountId: existingById.accountId },
                'Rejected machine registration attempt for machine owned by another account',
            );
            return reply.code(409).send({
                error: 'Machine already belongs to another account. Clear the local machine ID or reconnect the original account.',
            });
        }

        try {
            // ✅ Race condition fix: Use upsert instead of check-then-create
            // This handles concurrent machine registration gracefully
            const machine = await db.machine.upsert({
                where: {
                    accountId_id: { accountId: userId, id: id }
                },
                create: {
                    id,
                    accountId: userId,
                    metadata,
                    metadataVersion: 1,
                    daemonState: daemonState || null,
                    daemonStateVersion: daemonState ? 1 : 0,
                    dataEncryptionKey: dataEncryptionKey ? new Uint8Array(Buffer.from(dataEncryptionKey, 'base64')) : undefined,
                    active: false,
                },
                update: {
                    metadata,
                    metadataVersion: { increment: 1 },
                    lastActiveAt: new Date(),
                }
            });

            // Check if this was a newly created machine (version 1 = new)
            const isNewMachine = machine.metadataVersion === 1;

            if (isNewMachine) {
                // Emit new-machine events for newly created machines
                const updSeq1 = await allocateUserSeq(userId);
                const updSeq2 = await allocateUserSeq(userId);

                // Emit new-machine event with all data including dataEncryptionKey
                const newMachinePayload = buildNewMachineUpdate(machine, updSeq1, randomKeyNaked(12));
                eventRouter.emitUpdate({
                    userId,
                    payload: newMachinePayload,
                    recipientFilter: { type: 'user-scoped-only' }
                });

                // Emit update-machine event for backward compatibility
                const machineMetadata = {
                    version: 1,
                    value: metadata
                };
                const updatePayload = buildUpdateMachineUpdate(machine.id, updSeq2, randomKeyNaked(12), machineMetadata);
                eventRouter.emitUpdate({
                    userId,
                    payload: updatePayload,
                    recipientFilter: { type: 'machine-scoped-only', machineId: machine.id }
                });
            }

            return reply.send({
                machine: {
                    id: machine.id,
                    metadata: machine.metadata,
                    metadataVersion: machine.metadataVersion,
                    daemonState: machine.daemonState,
                    daemonStateVersion: machine.daemonStateVersion,
                    dataEncryptionKey: machine.dataEncryptionKey ? Buffer.from(machine.dataEncryptionKey).toString('base64') : null,
                    active: machine.active,
                    activeAt: machine.lastActiveAt.getTime(),
                    createdAt: machine.createdAt.getTime(),
                    updatedAt: machine.updatedAt.getTime()
                }
            });
        } catch (error: any) {
            // ✅ Handle concurrent registration with unique constraint violation
            if (error.code === 'P2002' && error.meta?.target?.includes('accountId') && error.meta?.target?.includes('id')) {
                log({ module: 'machines', level: 'warn', machineId: id, userId }, 'Concurrent machine registration detected, retrying');

                // Retry: fetch the machine that was created by the concurrent request
                const existingMachine = await db.machine.findFirst({
                    where: { accountId: userId, id: id }
                });

                if (existingMachine) {
                    return reply.send({
                        machine: {
                            id: existingMachine.id,
                            metadata: existingMachine.metadata,
                            metadataVersion: existingMachine.metadataVersion,
                            daemonState: existingMachine.daemonState,
                            daemonStateVersion: existingMachine.daemonStateVersion,
                            dataEncryptionKey: existingMachine.dataEncryptionKey ? Buffer.from(existingMachine.dataEncryptionKey).toString('base64') : null,
                            active: existingMachine.active,
                            activeAt: existingMachine.lastActiveAt.getTime(),
                            createdAt: existingMachine.createdAt.getTime(),
                            updatedAt: existingMachine.updatedAt.getTime()
                        }
                    });
                }
            }

            // Re-throw other errors
            throw error;
        }
    });


    // Machines API
    app.get('/v1/machines', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;

        const machines = await db.machine.findMany({
            where: { accountId: userId },
            orderBy: { lastActiveAt: 'desc' }
        });

        return machines.map(m => ({
            id: m.id,
            metadata: m.metadata,
            metadataVersion: m.metadataVersion,
            daemonState: m.daemonState,
            daemonStateVersion: m.daemonStateVersion,
            dataEncryptionKey: m.dataEncryptionKey ? Buffer.from(m.dataEncryptionKey).toString('base64') : null,
            seq: m.seq,
            active: m.active,
            activeAt: m.lastActiveAt.getTime(),
            createdAt: m.createdAt.getTime(),
            updatedAt: m.updatedAt.getTime()
        }));
    });

    // GET /v1/machines/:id - Get single machine by ID
    app.get('/v1/machines/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            })
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params;

        const machine = await db.machine.findFirst({
            where: {
                accountId: userId,
                id: id
            }
        });

        if (!machine) {
            return reply.code(404).send({ error: 'Machine not found' });
        }

        return {
            machine: {
                id: machine.id,
                metadata: machine.metadata,
                metadataVersion: machine.metadataVersion,
                daemonState: machine.daemonState,
                daemonStateVersion: machine.daemonStateVersion,
                dataEncryptionKey: machine.dataEncryptionKey ? Buffer.from(machine.dataEncryptionKey).toString('base64') : null,
                seq: machine.seq,
                active: machine.active,
                activeAt: machine.lastActiveAt.getTime(),
                createdAt: machine.createdAt.getTime(),
                updatedAt: machine.updatedAt.getTime()
            }
        };
    });

}
