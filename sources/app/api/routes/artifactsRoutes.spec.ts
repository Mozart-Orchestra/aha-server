import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

vi.mock('@/storage/db', () => ({
    db: {
        artifact: {
            findMany: vi.fn(),
            findFirst: vi.fn(),
            findUnique: vi.fn(),
            create: vi.fn(),
            update: vi.fn(),
            delete: vi.fn(),
        },
        session: {
            findFirst: vi.fn(),
            findMany: vi.fn(),
        },
    },
}));

vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: {
        emitUpdate: vi.fn(),
    },
    buildNewArtifactUpdate: vi.fn(),
    buildUpdateArtifactUpdate: vi.fn(),
    buildDeleteArtifactUpdate: vi.fn(),
}));

vi.mock('@/storage/seq', () => ({
    allocateUserSeq: vi.fn().mockResolvedValue(1),
}));

vi.mock('@/utils/randomKeyNaked', () => ({
    randomKeyNaked: vi.fn().mockReturnValue('update-id'),
}));

import { db } from '@/storage/db';
import { artifactsRoutes } from './artifactsRoutes';

function buildTeamBody(board: Record<string, unknown>) {
    return Buffer.from(JSON.stringify({ body: JSON.stringify(board) }));
}

function buildArtifact(overrides?: Partial<{
    id: string;
    accountId: string;
    header: Uint8Array;
    headerVersion: number;
    body: Uint8Array;
    bodyVersion: number;
    dataEncryptionKey: Uint8Array;
    seq: number;
    createdAt: Date;
    updatedAt: Date;
}>) {
    return {
        id: overrides?.id ?? 'artifact-1',
        accountId: overrides?.accountId ?? 'user-1',
        header: overrides?.header ?? Buffer.from('encrypted-header'),
        headerVersion: overrides?.headerVersion ?? 2,
        body: overrides?.body ?? buildTeamBody({
            team: {
                name: 'Recovered Team',
                members: [{ sessionId: 'session-1', roleId: 'builder' }],
            },
            tasks: [],
        }),
        bodyVersion: overrides?.bodyVersion ?? 5,
        dataEncryptionKey: overrides?.dataEncryptionKey ?? Buffer.from('encrypted-key'),
        seq: overrides?.seq ?? 9,
        createdAt: overrides?.createdAt ?? new Date('2026-03-18T00:00:00Z'),
        updatedAt: overrides?.updatedAt ?? new Date('2026-03-18T00:05:00Z'),
    };
}

function buildApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    typed.decorate('authenticate', async (request: any) => {
        request.userId = 'user-1';
    });
    artifactsRoutes(typed);
    return typed;
}

describe('artifactsRoutes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('lists owned artifacts and accessible shared teams in one feed', async () => {
        const ownedArtifact = buildArtifact({
            id: 'owned-note',
            accountId: 'user-1',
            body: Buffer.from(JSON.stringify({ body: 'secret note body' })),
            updatedAt: new Date('2026-03-18T00:01:00Z'),
        });
        const sharedTeamArtifact = buildArtifact({
            id: 'shared-team',
            accountId: 'user-2',
            body: buildTeamBody({
                team: {
                    name: 'Recovered Team',
                    members: [
                        { sessionId: 'session-1', roleId: 'builder' },
                        { sessionId: 'session-2', roleId: 'reviewer' },
                    ],
                },
                tasks: [{ id: 'task-1' }],
            }),
            updatedAt: new Date('2026-03-18T00:10:00Z'),
        });

        vi.mocked(db.artifact.findMany)
            .mockResolvedValueOnce([ownedArtifact] as never)
            .mockResolvedValueOnce([sharedTeamArtifact] as never);
        vi.mocked(db.session.findMany).mockResolvedValue([{ id: 'session-1' }] as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/artifacts',
        });

        expect(response.statusCode).toBe(200);
        const payload = response.json() as Array<any>;
        expect(payload).toHaveLength(2);
        expect(payload[0].id).toBe('shared-team');

        const sharedHeader = JSON.parse(
            Buffer.from(privacyKit.decodeBase64(payload[0].header)).toString('utf-8')
        );
        expect(sharedHeader).toEqual(expect.objectContaining({
            title: 'Recovered Team',
            type: 'team',
            sessions: ['session-1', 'session-2'],
        }));
        expect(Buffer.from(privacyKit.decodeBase64(payload[0].dataEncryptionKey)).toString('utf-8')).toBe('team');

        expect(payload[1]).toEqual(expect.objectContaining({
            id: 'owned-note',
            header: privacyKit.encodeBase64(ownedArtifact.header),
            dataEncryptionKey: privacyKit.encodeBase64(ownedArtifact.dataEncryptionKey),
        }));

        await app.close();
    });

    it('returns a plaintext-compatible envelope for accessible shared team fetches', async () => {
        const sharedTeamArtifact = buildArtifact({
            id: 'shared-team',
            accountId: 'user-2',
            body: buildTeamBody({
                name: 'Recovered Team',
                team: {
                    name: 'Recovered Team',
                    members: [{ sessionId: 'session-1', roleId: 'builder' }],
                },
                tasks: [{ id: 'task-1', status: 'todo' }],
            }),
        });

        vi.mocked(db.artifact.findFirst).mockResolvedValue(null as never);
        vi.mocked(db.artifact.findUnique).mockResolvedValue(sharedTeamArtifact as never);
        vi.mocked(db.session.findFirst).mockResolvedValue({ id: 'session-1' } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/artifacts/shared-team',
        });

        expect(response.statusCode).toBe(200);
        const payload = response.json() as any;
        const header = JSON.parse(Buffer.from(privacyKit.decodeBase64(payload.header)).toString('utf-8'));
        const body = JSON.parse(Buffer.from(privacyKit.decodeBase64(payload.body)).toString('utf-8'));

        expect(payload.type).toBe('team');
        expect(header).toEqual(expect.objectContaining({
            title: 'Recovered Team',
            type: 'team',
            sessions: ['session-1'],
        }));
        expect(body).toEqual(JSON.parse(Buffer.from(sharedTeamArtifact.body).toString('utf-8')));
        expect(Buffer.from(privacyKit.decodeBase64(payload.dataEncryptionKey)).toString('utf-8')).toBe('team');

        await app.close();
    });

    it('accepts non-uuid artifact ids for team recovery flows', async () => {
        vi.mocked(db.artifact.findUnique).mockResolvedValue(null as never);
        vi.mocked(db.artifact.create).mockResolvedValue(buildArtifact({
            id: 'team_legacy_id',
            body: Buffer.from('encrypted-body'),
            dataEncryptionKey: Buffer.from('encrypted-key'),
        }) as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/artifacts',
            payload: {
                id: 'team_legacy_id',
                header: privacyKit.encodeBase64(Buffer.from('encrypted-header')),
                body: privacyKit.encodeBase64(Buffer.from('encrypted-body')),
                dataEncryptionKey: privacyKit.encodeBase64(Buffer.from('encrypted-key')),
            },
        });

        expect(response.statusCode).toBe(200);
        expect(vi.mocked(db.artifact.create)).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                id: 'team_legacy_id',
            }),
        }));

        await app.close();
    });

    it('rejects artifact ids with unsafe characters', async () => {
        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/artifacts',
            payload: {
                id: 'bad/id with spaces',
                header: privacyKit.encodeBase64(Buffer.from('encrypted-header')),
                body: privacyKit.encodeBase64(Buffer.from('encrypted-body')),
                dataEncryptionKey: privacyKit.encodeBase64(Buffer.from('encrypted-key')),
            },
        });

        expect(response.statusCode).toBe(400);
        expect(vi.mocked(db.artifact.create)).not.toHaveBeenCalled();

        await app.close();
    });
});
