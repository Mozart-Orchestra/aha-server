import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

vi.mock('node:fs', () => ({
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
}));

vi.mock('@/storage/db', () => ({
    db: {
        artifact: {
            findUnique: vi.fn(),
            update: vi.fn(),
        },
        session: {
            findFirst: vi.fn(),
            updateMany: vi.fn(),
        },
        genome: {
            findFirst: vi.fn(),
            findUnique: vi.fn(),
            findMany: vi.fn(),
            count: vi.fn(),
            upsert: vi.fn(),
            create: vi.fn(),
            update: vi.fn(),
        },
    },
}));

vi.mock('axios', () => ({
    default: {
        post: vi.fn(),
        patch: vi.fn(),
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

import { db } from '@/storage/db';
import axios from 'axios';
import { existsSync, readFileSync } from 'node:fs';
import { evolutionRoutes } from './evolutionRoutes';

function buildTeamArtifact(board: Record<string, unknown>) {
    return {
        id: 'team-1',
        accountId: 'user-1',
        body: Buffer.from(JSON.stringify({ body: JSON.stringify(board) })),
        createdAt: new Date('2026-03-17T00:00:00Z'),
        updatedAt: new Date('2026-03-17T00:05:00Z'),
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
    evolutionRoutes(typed);
    return typed;
}

describe('evolutionRoutes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(existsSync).mockReturnValue(false);
        vi.mocked(readFileSync).mockReset();
    });

    it('retires a bypass agent by removing it from the team roster', async () => {
        vi.mocked(db.artifact.findUnique).mockResolvedValue(buildTeamArtifact({
            team: {
                members: [
                    { sessionId: 'bypass-1', roleId: 'supervisor', executionPlane: 'bypass' },
                    { sessionId: 'mainline-1', roleId: 'builder', executionPlane: 'mainline' },
                ],
            },
            tasks: [],
        }) as never);
        vi.mocked(db.artifact.update).mockResolvedValue({ id: 'team-1' } as never);
        vi.mocked(db.session.updateMany).mockResolvedValue({ count: 1 } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'DELETE',
            url: '/v1/teams/team-1/bypass-agents/bypass-1',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            success: true,
            retiredAgentId: 'bypass-1',
        });
        expect(db.artifact.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'team-1' },
            data: expect.objectContaining({
                body: expect.any(Buffer),
            }),
        }));
        expect(db.session.updateMany).toHaveBeenCalledWith({
            where: {
                id: 'bypass-1',
                accountId: 'user-1',
                active: true,
            },
            data: expect.objectContaining({
                active: false,
                updatedAt: expect.any(Date),
            }),
        });

        await app.close();
    });

    it('deduplicates bypass agents by role/profile and keeps the latest member', async () => {
        vi.mocked(db.artifact.findUnique).mockResolvedValue(buildTeamArtifact({
            team: {
                members: [
                    { sessionId: 'help-old', roleId: 'help-agent', executionPlane: 'bypass', profile: 'event', joinedAt: 1000 },
                    { sessionId: 'help-new', roleId: 'help-agent', executionPlane: 'bypass', profile: 'event', joinedAt: 2000 },
                    { sessionId: 'supervisor-1', roleId: 'supervisor', executionPlane: 'bypass', profile: 'periodic', joinedAt: 1500 },
                ],
            },
            tasks: [],
        }) as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/teams/team-1/bypass-agents',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            agents: [
                {
                    agentId: 'help-new',
                    teamId: 'team-1',
                    roleId: 'help-agent',
                    profile: 'event',
                    spawnedAt: 2,
                    expiresAt: 0,
                    permissions: {
                        canSpawnAgents: false,
                        canCreateTeams: false,
                        canDeployToProduction: false,
                    },
                },
                {
                    agentId: 'supervisor-1',
                    teamId: 'team-1',
                    roleId: 'supervisor',
                    profile: 'periodic',
                    spawnedAt: 1,
                    expiresAt: 0,
                    permissions: {
                        canSpawnAgents: false,
                        canCreateTeams: false,
                        canDeployToProduction: false,
                    },
                },
            ],
        });

        await app.close();
    });

    it('creates a genome with namespace/tags/category metadata', async () => {
        vi.mocked(db.genome.create).mockResolvedValue({
            id: 'genome-1',
            namespace: '@public',
            tags: '["builder","typescript"]',
            category: 'development',
        } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/genomes',
            payload: {
                name: 'builder',
                spec: '{"role":"builder"}',
                namespace: '@public',
                tags: '["builder","typescript"]',
                category: 'development',
            },
        });

        expect(response.statusCode).toBe(201);
        expect(db.genome.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                namespace: '@public',
                tags: '["builder","typescript"]',
                category: 'development',
            }),
        }));

        await app.close();
    });

    it('aliases local genome scorecards as feedbackData in genome listings', async () => {
        const scorecard = JSON.stringify({
            evaluationCount: 3,
            avgScore: 88,
            latestAction: 'keep',
        });

        vi.mocked(db.genome.findMany).mockResolvedValue([
            {
                id: 'genome-1',
                accountId: 'user-1',
                name: 'builder',
                description: 'Builder genome',
                spec: '{"role":"builder"}',
                parentSessionId: 'session-1',
                teamId: 'team-1',
                namespace: '@public',
                version: 1,
                tags: '["builder"]',
                category: 'development',
                status: 'verified',
                spawnCount: 2,
                isPublic: false,
                scorecard,
                createdAt: '2026-03-20T00:00:00.000Z',
                updatedAt: '2026-03-20T00:00:00.000Z',
            },
        ] as never);
        vi.mocked(db.genome.count).mockResolvedValue(1 as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/genomes?ownedOnly=true&limit=200',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            genomes: [
                expect.objectContaining({
                    id: 'genome-1',
                    scorecard,
                    feedbackData: scorecard,
                }),
            ],
            total: 1,
        });

        await app.close();
    });

    it('returns persisted supervisor facts when a state file exists', async () => {
        vi.mocked(db.artifact.findUnique).mockResolvedValue(buildTeamArtifact({
            team: { members: [] },
            tasks: [],
        }) as never);
        vi.mocked(existsSync).mockReturnValue(true);
        vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
            teamId: 'team-1',
            lastRunAt: 1773800000000,
            lastConclusion: 'Supervisor reviewed new evidence and found one pending follow-up.',
            lastSessionId: 'supervisor-session-1',
            terminated: false,
            idleRuns: 2,
            pendingAction: {
                type: 'notify_help',
                message: 'Ask help-agent to re-check the blocked builder.',
            },
            calibration: {
                calibrationScore: 84,
            },
        }) as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/teams/team-1/supervisor-state',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            state: {
                teamId: 'team-1',
                lastRunAt: 1773800000000,
                lastConclusion: 'Supervisor reviewed new evidence and found one pending follow-up.',
                lastSessionId: 'supervisor-session-1',
                terminated: false,
                idleRuns: 2,
                pendingAction: {
                    type: 'notify_help',
                    message: 'Ask help-agent to re-check the blocked builder.',
                },
                calibrationScore: 84,
            },
        });

        await app.close();
    });

    it('patches genome metadata in place when spec is unchanged', async () => {
        vi.mocked(db.genome.findFirst).mockResolvedValueOnce({
            id: 'genome-1',
            accountId: 'user-1',
            name: 'builder',
            description: 'old',
            spec: '{"role":"builder"}',
            namespace: '@public',
            tags: '["builder"]',
            category: 'development',
            isPublic: false,
            deletedAt: null,
        } as never);
        vi.mocked(db.genome.update).mockResolvedValue({
            id: 'genome-1',
            name: 'builder-v2',
            description: 'new',
        } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/genomes/genome-1',
            payload: {
                name: 'builder-v2',
                description: 'new',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            genome: expect.objectContaining({ id: 'genome-1', name: 'builder-v2' }),
            createdNewVersion: false,
        });
        expect(db.genome.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'genome-1' },
            data: expect.objectContaining({
                name: 'builder-v2',
                description: 'new',
            }),
        }));

        await app.close();
    });

    it('creates a new genome version when spec changes', async () => {
        vi.mocked(db.genome.findFirst)
            .mockResolvedValueOnce({
                id: 'genome-1',
                accountId: 'user-1',
                name: 'builder',
                description: 'old',
                spec: '{"role":"builder"}',
                parentSessionId: 'session-1',
                teamId: 'team-1',
                namespace: '@public',
                tags: '["builder"]',
                category: 'development',
                isPublic: true,
                deletedAt: null,
            } as never)
            .mockResolvedValueOnce({ version: 2 } as never);
        vi.mocked(db.genome.create).mockResolvedValue({
            id: 'genome-3',
            version: 3,
            isPublic: false,
        } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/genomes/genome-1',
            payload: {
                spec: '{"role":"builder","mode":"v2"}',
                description: 'new version',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            genome: expect.objectContaining({ id: 'genome-3', version: 3, isPublic: false }),
            createdNewVersion: true,
        });
        expect(db.genome.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                version: 3,
                isPublic: false,
                hubGenomeId: null,
            }),
        }));

        await app.close();
    });

    it('soft deletes a genome', async () => {
        vi.mocked(db.genome.findFirst).mockResolvedValue({
            id: 'genome-1',
        } as never);
        vi.mocked(db.genome.update).mockResolvedValue({
            id: 'genome-1',
            deletedAt: new Date('2026-03-17T01:00:00Z'),
        } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'DELETE',
            url: '/v1/genomes/genome-1',
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ success: true });
        expect(db.genome.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'genome-1' },
            data: expect.objectContaining({
                deletedAt: expect.any(Date),
                isPublic: false,
            }),
        }));

        await app.close();
    });

    it('proxies genome feedback updates to genome-hub', async () => {
        vi.mocked(axios.patch).mockResolvedValue({
            status: 200,
            data: {
                genome: {
                    id: 'hub-genome-1',
                    feedbackData: '{"avgScore":91}',
                },
            },
        } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/genomes/%40official/implementer/feedback',
            payload: {
                evaluationCount: 3,
                avgScore: 91,
                sessionScore: {
                    taskCompletion: 90,
                    codeQuality: 92,
                    collaboration: 91,
                    overall: 91,
                },
                dimensions: {
                    delivery: 90,
                    integrity: 91,
                    efficiency: 89,
                    collaboration: 92,
                    reliability: 91,
                },
                distribution: {
                    excellent: 2,
                    good: 1,
                    fair: 0,
                    poor: 0,
                },
                latestAction: 'keep',
                suggestions: ['Keeps work well-scoped.'],
            },
        });

        expect(response.statusCode).toBe(200);
        expect(axios.patch).toHaveBeenCalledWith(
            expect.stringContaining('/genomes/%40official/implementer/feedback'),
            expect.objectContaining({
                evaluationCount: 3,
                avgScore: 91,
                latestAction: 'keep',
            }),
            expect.any(Object),
        );
        expect(response.json()).toEqual({
            genome: {
                id: 'hub-genome-1',
                feedbackData: '{"avgScore":91}',
            },
        });

        await app.close();
    });

    it('marks the local genome public after successful publish and stores hubGenomeId', async () => {
        const scorecard = JSON.stringify({
            evaluationCount: 4,
            avgScore: 91,
            latestAction: 'keep',
        });
        vi.mocked(db.genome.findFirst).mockResolvedValue({
            id: 'genome-1',
            accountId: 'user-1',
            name: 'builder',
            namespace: '@public',
            version: 2,
            description: 'Builder genome',
            spec: '{"role":"builder"}',
            tags: '["builder"]',
            category: 'development',
            scorecard,
            deletedAt: null,
        } as never);
        vi.mocked(axios.post).mockResolvedValue({
            data: {
                genome: {
                    id: 'hub-genome-1',
                },
            },
        } as never);
        vi.mocked(axios.patch).mockResolvedValue({
            data: { success: true },
        } as never);
        vi.mocked(db.genome.update).mockResolvedValue({
            id: 'genome-1',
            isPublic: true,
            hubGenomeId: 'hub-genome-1',
            scorecard,
        } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/genomes/genome-1/publish',
            payload: {},
        });

        expect(response.statusCode).toBe(201);
        expect(axios.post).toHaveBeenCalledWith(
            expect.stringContaining('/genomes'),
            expect.objectContaining({
                namespace: '@public',
                version: 2,
                tags: '["builder"]',
            }),
            expect.any(Object),
        );
        expect(axios.patch).toHaveBeenCalledWith(
            expect.stringContaining('/genomes/%40public/builder/feedback'),
            JSON.parse(scorecard),
            expect.any(Object),
        );
        expect(db.genome.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'genome-1' },
            data: {
                isPublic: true,
                hubGenomeId: 'hub-genome-1',
            },
        }));
        expect(response.json()).toEqual(expect.objectContaining({
            genome: expect.objectContaining({
                id: 'genome-1',
                feedbackData: scorecard,
            }),
            feedbackSync: {
                attempted: true,
                synced: true,
            },
        }));

        await app.close();
    });
});
