import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

vi.mock('@/storage/db', () => ({
    db: {
        artifact: {
            create: vi.fn(),
            findMany: vi.fn(),
            findUnique: vi.fn(),
            update: vi.fn(),
            delete: vi.fn(),
        },
        session: {
            findFirst: vi.fn(),
            findMany: vi.fn(),
            update: vi.fn(),
            updateMany: vi.fn(),
            deleteMany: vi.fn(),
        },
        sessionMessage: {
            deleteMany: vi.fn(),
        },
        usageReport: {
            deleteMany: vi.fn(),
        },
        accessKey: {
            deleteMany: vi.fn(),
        },
    },
}));

vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: {
        emitUpdate: vi.fn(),
    },
}));

vi.mock('@/storage/seq', () => ({
    allocateUserSeq: vi.fn().mockResolvedValue(1),
}));

vi.mock('@/utils/randomKeyNaked', () => ({
    randomKeyNaked: vi.fn().mockReturnValue('update-id'),
}));

vi.mock('@/app/team/teamOverview', () => ({
    getTeamOverviewSnapshot: vi.fn(),
    invalidateTeamOverviewSnapshot: vi.fn(),
}));

import { db } from '@/storage/db';
import { getTeamOverviewSnapshot } from '@/app/team/teamOverview';
import { teamManagementRoutes } from './teamManagementRoutes';

function buildTeamArtifact(board: Record<string, unknown>, overrides?: Partial<{ id: string; accountId: string; createdAt: Date; updatedAt: Date }>) {
    return {
        id: overrides?.id ?? 'team-1',
        accountId: overrides?.accountId ?? 'user-1',
        body: Buffer.from(JSON.stringify({ body: JSON.stringify(board) })),
        createdAt: overrides?.createdAt ?? new Date('2026-03-17T00:00:00Z'),
        updatedAt: overrides?.updatedAt ?? new Date('2026-03-17T00:05:00Z'),
    };
}

function buildApp(options?: {
    authenticate?: (request: any, reply: any) => unknown | Promise<unknown>;
}) {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    typed.decorate('authenticate', options?.authenticate || (async (request: any) => {
        request.userId = 'user-1';
    }));
    teamManagementRoutes(typed);
    return typed;
}

describe('teamManagementRoutes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('creates a canonical team artifact with the provided id and initial board', async () => {
        vi.mocked(db.artifact.create).mockResolvedValue(buildTeamArtifact({
            name: 'Canonical Team',
            description: 'Ship it',
            team: {
                name: 'Canonical Team',
                members: [{ sessionId: 'session-1', roleId: 'builder' }],
            },
            tasks: [{ id: 'task-1', status: 'todo' }],
        }, { id: 'team-canonical' }) as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/teams',
            payload: {
                id: 'team-canonical',
                name: 'Canonical Team',
                description: 'Ship it',
                board: {
                    team: {
                        members: [{ sessionId: 'session-1', roleId: 'builder' }],
                    },
                    tasks: [{ id: 'task-1', status: 'todo' }],
                },
            },
        });

        expect(response.statusCode).toBe(201);
        expect(vi.mocked(db.artifact.create)).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                id: 'team-canonical',
                body: expect.any(Buffer),
            }),
        }));

        await app.close();
    });

    it('rejects invalid team creation payloads via zod validation', async () => {
        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/teams',
            payload: {
                name: '',
            },
        });

        expect(response.statusCode).toBe(400);
        expect(vi.mocked(db.artifact.create)).not.toHaveBeenCalled();

        await app.close();
    });

    it('treats repeated canonical team creation with the same id as idempotent', async () => {
        vi.mocked(db.artifact.findUnique).mockResolvedValue(
            buildTeamArtifact({
                name: 'Canonical Team',
                team: {
                    name: 'Canonical Team',
                    members: [],
                },
                tasks: [],
            }, { id: 'team-canonical' }) as never
        );
        vi.mocked(db.artifact.update).mockResolvedValue(
            buildTeamArtifact({
                name: 'Canonical Team',
                description: 'Retry create',
                team: {
                    name: 'Canonical Team',
                    members: [{ sessionId: 'session-1', roleId: 'builder' }],
                },
                tasks: [{ id: 'task-1', status: 'todo' }],
            }, { id: 'team-canonical' }) as never
        );

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/teams',
            payload: {
                id: 'team-canonical',
                name: 'Canonical Team',
                description: 'Retry create',
                board: {
                    team: {
                        members: [{ sessionId: 'session-1', roleId: 'builder' }],
                    },
                    tasks: [{ id: 'task-1', status: 'todo' }],
                },
            },
        });

        expect(response.statusCode).toBe(200);
        expect(vi.mocked(db.artifact.update)).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'team-canonical' },
            data: expect.objectContaining({
                body: expect.any(Buffer),
            }),
        }));

        await app.close();
    });

    it('falls back to a fresh team id when the requested canonical id belongs to another account', async () => {
        vi.mocked(db.artifact.findUnique).mockResolvedValue(
            buildTeamArtifact({
                name: 'Foreign Team',
                team: {
                    name: 'Foreign Team',
                    members: [],
                },
                tasks: [],
            }, { id: 'foreign-team', accountId: 'other-user' }) as never
        );
        vi.mocked(db.artifact.create).mockResolvedValue(
            buildTeamArtifact({
                name: 'Canonical Team',
                team: {
                    name: 'Canonical Team',
                    members: [],
                },
                tasks: [],
            }, { id: 'update-id' }) as never
        );

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/teams',
            payload: {
                id: 'foreign-team',
                name: 'Canonical Team',
            },
        });

        expect(response.statusCode).toBe(201);
        expect(vi.mocked(db.artifact.create)).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                id: 'update-id',
                accountId: 'user-1',
            }),
        }));
        expect(response.json()).toEqual({
            team: expect.objectContaining({
                id: 'update-id',
                name: 'Canonical Team',
            }),
        });

        await app.close();
    });

    it('lists accessible teams with summary counts', async () => {
        const board = {
            team: {
                name: 'Backend Team',
                members: [{ sessionId: 'session-1', roleId: 'builder' }],
            },
            tasks: [{ id: 'task-1' }, { id: 'task-2' }],
        };
        const standaloneBoard = {
            type: 'standalone',
            name: 'Solo Agent',
            team: {
                members: [{ sessionId: 'session-2', roleId: 'standalone' }],
            },
        };

        vi.mocked(db.artifact.findMany).mockResolvedValue([
            buildTeamArtifact(board),
            buildTeamArtifact(standaloneBoard, { id: 'agent-1' }),
        ] as never);
        vi.mocked(db.session.findMany).mockResolvedValue([{ id: 'session-1' }, { id: 'session-2' }] as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/teams',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            teams: [
                expect.objectContaining({
                    id: 'team-1',
                    name: 'Backend Team',
                    memberCount: 1,
                    taskCount: 2,
                }),
            ],
        });

        await app.close();
    });

    it('hides archived teams from the workspace list', async () => {
        const activeBoard = {
            team: {
                name: 'Active Team',
                members: [{ sessionId: 'session-1', roleId: 'builder' }],
            },
            tasks: [],
        };
        const archivedBoard = {
            archivedAt: 1710800000000,
            team: {
                name: 'Archived Team',
                archivedAt: 1710800000000,
                members: [],
            },
            tasks: [],
        };

        vi.mocked(db.artifact.findMany).mockResolvedValue([
            buildTeamArtifact(activeBoard, { id: 'team-active' }),
            buildTeamArtifact(archivedBoard, { id: 'team-archived' }),
        ] as never);
        vi.mocked(db.session.findMany).mockResolvedValue([{ id: 'session-1' }] as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/teams',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            teams: [
                expect.objectContaining({
                    id: 'team-active',
                    name: 'Active Team',
                }),
            ],
        });

        await app.close();
    });

    it('serves the persisted team overview snapshot from the static overview route', async () => {
        vi.mocked(getTeamOverviewSnapshot).mockResolvedValue({
            generatedAt: 1710800000000,
            teamCount: 2,
            teamTotalTokens: 4200,
            agentTotalTokens: 2100,
            completedTasksTotal: 5,
            teamUsageItems: [{ id: 'team-1', label: 'Backend Team', tokens: 4200 }],
            agentUsageItems: [{ id: 'session-1', label: 'Builder · builder', tokens: 2100 }],
            completedTaskItems: [{ id: 'team-1', label: 'Backend Team', completedTasks: 5 }],
        } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/teams/overview',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            overview: expect.objectContaining({
                teamCount: 2,
                teamTotalTokens: 4200,
                completedTasksTotal: 5,
            }),
        });
        expect(getTeamOverviewSnapshot).toHaveBeenCalledWith('user-1');

        await app.close();
    });

    it('requires authentication before listing teams', async () => {
        const app = buildApp({
            authenticate: async (_request, reply) => {
                return reply.code(401).send({ error: 'Unauthorized' });
            },
        });

        const response = await app.inject({
            method: 'GET',
            url: '/v1/teams',
        });

        expect(response.statusCode).toBe(401);
        expect(vi.mocked(db.artifact.findMany)).not.toHaveBeenCalled();

        await app.close();
    });

    it('archives member sessions discovered from the stored team board', async () => {
        const board = {
            team: {
                name: 'Ops Team',
                members: [
                    { sessionId: 'session-1', roleId: 'builder' },
                    { sessionId: 'session-2', roleId: 'reviewer' },
                ],
            },
            tasks: [],
        };

        vi.mocked(db.artifact.findUnique).mockResolvedValue(buildTeamArtifact(board) as never);
        vi.mocked(db.session.updateMany).mockResolvedValue({ count: 2 } as never);
        vi.mocked(db.artifact.update).mockResolvedValue({ id: 'team-1' } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/teams/team-1/archive',
            payload: {},
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            success: true,
            archivedSessions: 2,
        });
        expect(db.session.updateMany).toHaveBeenCalledWith({
            where: {
                id: { in: ['session-1', 'session-2'] },
                accountId: 'user-1',
            },
            data: expect.objectContaining({
                active: false,
                updatedAt: expect.any(Date),
            }),
        });
        expect(db.artifact.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'team-1' },
            data: expect.objectContaining({
                body: expect.any(Buffer),
                bodyVersion: expect.anything(),
                updatedAt: expect.any(Date),
            }),
        }));

        await app.close();
    });

    it('returns team detail with members', async () => {
        const board = {
            team: {
                name: 'API Squad',
                members: [
                    { sessionId: 'session-1', roleId: 'builder', displayName: 'Server Builder' },
                    { sessionId: 'session-2', roleId: 'master', displayName: 'Master' },
                ],
            },
            tasks: [{ id: 'task-1' }],
        };

        vi.mocked(db.artifact.findUnique).mockResolvedValue(buildTeamArtifact(board) as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/teams/team-1',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            team: expect.objectContaining({
                id: 'team-1',
                name: 'API Squad',
                memberCount: 2,
                taskCount: 1,
                members: [
                    expect.objectContaining({ sessionId: 'session-1', roleId: 'builder' }),
                    expect.objectContaining({ sessionId: 'session-2', roleId: 'master' }),
                ],
            }),
        });

        await app.close();
    });

    it('persists member authorities and team overlay on add-member', async () => {
        const board = {
            team: {
                name: 'Overlay Team',
                members: [],
            },
            tasks: [],
        };

        vi.mocked(db.artifact.findUnique).mockResolvedValue(buildTeamArtifact(board) as never);
        vi.mocked(db.artifact.update).mockResolvedValue({ id: 'team-1' } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/teams/team-1/members',
            payload: {
                sessionId: 'session-3',
                candidateId: 'spec:builder-3',
                roleId: 'builder',
                displayName: 'Builder 3',
                authorities: ['task.start.self', 'task.complete.self'],
                teamOverlay: {
                    promptSuffix: 'Work only from task cards.',
                },
            },
        });

        expect(response.statusCode).toBe(200);
        expect(db.artifact.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                body: expect.any(Buffer),
            }),
        }));

        const updateCall = vi.mocked(db.artifact.update).mock.calls[0]?.[0];
        const rawBody = updateCall?.data?.body as Buffer;
        const parsed = JSON.parse(rawBody.toString());
        const boardBody = JSON.parse(parsed.body);
        expect(boardBody.team.members).toEqual([
            expect.objectContaining({
                sessionId: 'session-3',
                candidateId: 'spec:builder-3',
                roleId: 'builder',
                authorities: ['task.start.self', 'task.complete.self'],
                teamOverlay: {
                    promptSuffix: 'Work only from task cards.',
                },
            }),
        ]);

        await app.close();
    });

    it('lists members from the stored board', async () => {
        const board = {
            team: {
                name: 'Member Team',
                members: [
                    { sessionId: 'session-1', roleId: 'builder', displayName: 'Builder' },
                    { sessionId: 'session-2', roleId: 'reviewer', displayName: 'Reviewer' },
                ],
            },
            tasks: [],
        };

        vi.mocked(db.artifact.findUnique).mockResolvedValue(buildTeamArtifact(board) as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/teams/team-1/members',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            members: [
                expect.objectContaining({ sessionId: 'session-1', roleId: 'builder' }),
                expect.objectContaining({ sessionId: 'session-2', roleId: 'reviewer' }),
            ],
        });

        await app.close();
    });

    it('removes a member and persists the updated team board', async () => {
        const board = {
            team: {
                name: 'Member Team',
                members: [
                    { sessionId: 'session-1', roleId: 'builder', displayName: 'Builder' },
                    { sessionId: 'session-2', roleId: 'reviewer', displayName: 'Reviewer' },
                ],
            },
            tasks: [],
        };

        vi.mocked(db.artifact.findUnique).mockResolvedValue(buildTeamArtifact(board) as never);
        vi.mocked(db.artifact.update).mockResolvedValue({ id: 'team-1' } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'DELETE',
            url: '/v1/teams/team-1/members/session-2',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ success: true });

        const updateCall = vi.mocked(db.artifact.update).mock.calls[0]?.[0];
        const rawBody = updateCall?.data?.body as Buffer;
        const parsed = JSON.parse(rawBody.toString());
        const boardBody = JSON.parse(parsed.body);
        expect(boardBody.team.members).toEqual([
            expect.objectContaining({ sessionId: 'session-1', roleId: 'builder' }),
        ]);

        await app.close();
    });

    it('renames a team and returns the updated team envelope', async () => {
        const board = {
            name: 'Old Team Name',
            team: {
                name: 'Old Team Name',
                members: [],
            },
            tasks: [],
        };

        vi.mocked(db.artifact.findUnique).mockResolvedValue(buildTeamArtifact(board) as never);
        vi.mocked(db.artifact.update).mockResolvedValue({ id: 'team-1' } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'PUT',
            url: '/v1/teams/team-1/rename',
            payload: { name: 'New Team Name' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            success: true,
            team: {
                id: 'team-1',
                name: 'New Team Name',
            },
        });
        expect(db.artifact.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'team-1' },
            data: expect.objectContaining({
                body: expect.any(Buffer),
            }),
        }));

        await app.close();
    });

    it('batch archives only owned sessions and reports per-session results', async () => {
        vi.mocked(db.session.findMany).mockResolvedValue([{ id: 'session-1' }] as never);
        vi.mocked(db.session.updateMany).mockResolvedValue({ count: 1 } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/sessions/batch/archive',
            payload: { sessionIds: ['session-1', 'session-2'] },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            success: true,
            archived: 1,
            results: [
                { sessionId: 'session-1', success: true },
                { sessionId: 'session-2', success: false, error: 'Session not found or not owned by user' },
            ],
        });

        await app.close();
    });

    it('restores only owned sessions during batch unarchive and reports per-session results', async () => {
        vi.mocked(db.session.findMany).mockResolvedValue([{ id: 'session-1' }] as never);
        vi.mocked(db.session.updateMany).mockResolvedValue({ count: 1 } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/sessions/batch/unarchive',
            payload: { sessionIds: ['session-1', 'session-2'] },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            success: true,
            restored: 1,
            results: [
                { sessionId: 'session-1', success: true },
                { sessionId: 'session-2', success: false, error: 'Session not found or not owned by user' },
            ],
        });

        await app.close();
    });

    it('unarchives a team and all discovered member sessions', async () => {
        const board = {
            archivedAt: 1710800000000,
            team: {
                name: 'Ops Team',
                archivedAt: 1710800000000,
                members: [
                    { sessionId: 'session-1', roleId: 'builder' },
                    { sessionId: 'session-2', roleId: 'reviewer' },
                ],
            },
            tasks: [],
        };

        vi.mocked(db.artifact.findUnique).mockResolvedValue(buildTeamArtifact(board) as never);
        vi.mocked(db.session.updateMany).mockResolvedValue({ count: 2 } as never);
        vi.mocked(db.artifact.update).mockResolvedValue({ id: 'team-1' } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/teams/team-1/unarchive',
            payload: {},
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            success: true,
            restoredSessions: 2,
        });

        const updateCall = vi.mocked(db.artifact.update).mock.calls[0]?.[0];
        const rawBody = updateCall?.data?.body as Buffer;
        const parsed = JSON.parse(rawBody.toString());
        const boardBody = JSON.parse(parsed.body);
        expect(boardBody.archivedAt).toBeUndefined();
        expect(boardBody.team.archivedAt).toBeUndefined();

        await app.close();
    });

    it('deletes a team plus all owned member session records', async () => {
        const board = {
            team: {
                name: 'Delete Team',
                members: [
                    { sessionId: 'session-1', roleId: 'builder' },
                    { sessionId: 'session-2', roleId: 'reviewer' },
                ],
            },
            tasks: [],
        };

        vi.mocked(db.artifact.findUnique).mockResolvedValue(buildTeamArtifact(board) as never);
        vi.mocked(db.sessionMessage.deleteMany).mockResolvedValue({ count: 2 } as never);
        vi.mocked(db.usageReport.deleteMany).mockResolvedValue({ count: 2 } as never);
        vi.mocked(db.accessKey.deleteMany).mockResolvedValue({ count: 2 } as never);
        vi.mocked(db.session.deleteMany).mockResolvedValue({ count: 2 } as never);
        vi.mocked(db.artifact.delete).mockResolvedValue({ id: 'team-1' } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'DELETE',
            url: '/v1/teams/team-1',
            payload: {},
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            success: true,
            deletedSessions: 2,
        });
        expect(db.sessionMessage.deleteMany).toHaveBeenCalledWith({
            where: { sessionId: { in: ['session-1', 'session-2'] } },
        });
        expect(db.usageReport.deleteMany).toHaveBeenCalledWith({
            where: { sessionId: { in: ['session-1', 'session-2'] } },
        });
        expect(db.accessKey.deleteMany).toHaveBeenCalledWith({
            where: { sessionId: { in: ['session-1', 'session-2'] } },
        });
        expect(db.session.deleteMany).toHaveBeenCalledWith({
            where: {
                id: { in: ['session-1', 'session-2'] },
                accountId: 'user-1',
            },
        });
        expect(db.artifact.delete).toHaveBeenCalledWith({
            where: { id: 'team-1' },
        });

        await app.close();
    });

    it('renames a session by patching metadata when metadata is JSON', async () => {
        vi.mocked(db.session.findFirst).mockResolvedValue({
            id: 'session-1',
            accountId: 'user-1',
            metadata: JSON.stringify({ name: 'Old Session', teamId: 'team-1' }),
        } as never);
        vi.mocked(db.session.update).mockResolvedValue({ id: 'session-1' } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'PUT',
            url: '/v1/sessions/session-1/rename',
            payload: { name: 'New Session' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            success: true,
            session: {
                id: 'session-1',
                name: 'New Session',
            },
        });
        expect(db.session.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'session-1' },
            data: expect.objectContaining({
                metadata: expect.stringContaining('New Session'),
            }),
        }));

        await app.close();
    });
});
