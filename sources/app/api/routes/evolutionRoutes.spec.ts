import fastify from 'fastify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';

vi.mock('node:fs', () => ({
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
}));

vi.mock('@/storage/db', () => ({
    db: {
        $transaction: vi.fn(),
        $executeRaw: vi.fn(),
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
        trial: {
            create: vi.fn(),
            findMany: vi.fn(),
            update: vi.fn(),
            updateMany: vi.fn(),
        },
        verdict: {
            create: vi.fn(),
            findMany: vi.fn(),
        },
    },
}));

vi.mock('axios', () => ({
    default: {
        get: vi.fn(),
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
        vi.mocked(db.$transaction).mockImplementation(async (callback: any) => callback(db));
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
            version: 1,
            spec: '{"role":"builder","version":1}',
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
                spec: '{"role":"builder","version":1}',
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
                spec: '{"role":"builder","version":2}',
                parentSessionId: 'session-1',
                teamId: 'team-1',
                namespace: '@public',
                version: 4,
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
                    version: 4,
                }),
            ],
            total: 1,
        });
        expect(JSON.parse(response.json().genomes[0].spec)).toMatchObject({
            role: 'builder',
            version: 4,
        });

        await app.close();
    });

    it('hard-fails genome projection when stored spec is malformed', async () => {
        vi.mocked(db.genome.findFirst).mockResolvedValue({
            id: 'genome-bad',
            accountId: 'user-1',
            name: 'builder',
            namespace: '@public',
            version: 4,
            spec: '{bad-json',
            deletedAt: null,
        } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'GET',
            url: '/v1/genomes/genome-bad',
        });

        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({
            error: expect.stringContaining('Genome spec version sync failed'),
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
            spec: '{"role":"builder","mode":"v2"}',
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
        expect(JSON.parse(response.json().genome.spec)).toMatchObject({
            role: 'builder',
            mode: 'v2',
            version: 3,
        });
        expect(db.genome.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                spec: '{"role":"builder","mode":"v2","version":3}',
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

    it('proxies specimen-bound genome feedback updates to genome-hub by immutable id', async () => {
        vi.mocked(axios.patch).mockResolvedValue({
            status: 200,
            data: {
                genome: {
                    id: 'hub-genome-1',
                    feedbackData: '{"avgScore":93}',
                },
            },
        } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'PATCH',
            url: '/v1/genomes/id/hub-genome-1/feedback',
            payload: {
                evaluationCount: 2,
                avgScore: 93,
                sessionScore: {
                    taskCompletion: 94,
                    codeQuality: 92,
                    collaboration: 93,
                    overall: 93,
                },
                dimensions: {
                    delivery: 94,
                    integrity: 92,
                    efficiency: 91,
                    collaboration: 93,
                    reliability: 94,
                },
                distribution: {
                    excellent: 2,
                    good: 0,
                    fair: 0,
                    poor: 0,
                },
                latestAction: 'keep',
                suggestions: ['Binds feedback to the exact scored genome row.'],
            },
        });

        expect(response.statusCode).toBe(200);
        expect(axios.patch).toHaveBeenCalledWith(
            expect.stringContaining('/genomes/id/hub-genome-1/feedback'),
            expect.objectContaining({
                evaluationCount: 2,
                avgScore: 93,
                latestAction: 'keep',
            }),
            expect.any(Object),
        );

        await app.close();
    });

    it('proxies heterogeneous genome diffs to genome-hub using the shared publish key fallback', async () => {
        const previousHubPublishKey = process.env.HUB_PUBLISH_KEY;
        const previousGenomeHubPublishKey = process.env.GENOME_HUB_PUBLISH_KEY;
        delete process.env.GENOME_HUB_PUBLISH_KEY;
        process.env.HUB_PUBLISH_KEY = 'shared-hub-key';

        vi.mocked(axios.post).mockResolvedValue({
            status: 201,
            data: {
                genome: {
                    id: 'hub-genome-3',
                    version: 3,
                },
                diff: {
                    id: 'diff-1',
                },
            },
        } as never);

        try {
            const app = buildApp();
            const response = await app.inject({
                method: 'POST',
                url: '/v1/genomes/%40official/implementer/diff',
                payload: {
                    description: 'Refine task routing',
                    changes: [
                        { type: 'kv', path: 'behavior.onIdle', from: 'wait', to: 'ask' },
                        {
                            type: 'string',
                            path: 'protocol',
                            op: 'replace',
                            from: 'Use todo list',
                            content: 'Use Kanban board first',
                        },
                        {
                            type: 'narrative',
                            content: 'Supervisor observed better task hygiene.',
                        },
                    ],
                    verdictRefs: ['verdict-1'],
                    authorRole: 'supervisor',
                },
            });

            expect(response.statusCode).toBe(201);
            expect(axios.post).toHaveBeenCalledWith(
                expect.stringContaining('/genomes/%40official/implementer/diff'),
                expect.objectContaining({
                    description: 'Refine task routing',
                    verdictRefs: ['verdict-1'],
                    changes: expect.arrayContaining([
                        expect.objectContaining({
                            type: 'kv',
                            path: 'behavior.onIdle',
                            from: 'wait',
                            to: 'ask',
                        }),
                        expect.objectContaining({
                            type: 'string',
                            path: 'protocol',
                            op: 'replace',
                            from: 'Use todo list',
                            content: 'Use Kanban board first',
                        }),
                        expect.objectContaining({
                            type: 'narrative',
                            content: 'Supervisor observed better task hygiene.',
                        }),
                    ]),
                }),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer shared-hub-key',
                    }),
                }),
            );
            expect(response.json()).toEqual({
                genome: {
                    id: 'hub-genome-3',
                    version: 3,
                },
                diff: {
                    id: 'diff-1',
                },
            });

            await app.close();
        } finally {
            if (previousHubPublishKey === undefined) {
                delete process.env.HUB_PUBLISH_KEY;
            } else {
                process.env.HUB_PUBLISH_KEY = previousHubPublishKey;
            }
            if (previousGenomeHubPublishKey === undefined) {
                delete process.env.GENOME_HUB_PUBLISH_KEY;
            } else {
                process.env.GENOME_HUB_PUBLISH_KEY = previousGenomeHubPublishKey;
            }
        }
    });

    it('proxies genome ledger queries to genome-hub with optional version filters', async () => {
        const previousHubPublishKey = process.env.HUB_PUBLISH_KEY;
        const previousGenomeHubPublishKey = process.env.GENOME_HUB_PUBLISH_KEY;
        delete process.env.GENOME_HUB_PUBLISH_KEY;
        process.env.HUB_PUBLISH_KEY = 'shared-hub-key';

        vi.mocked(axios.get).mockResolvedValue({
            status: 200,
            data: {
                ledger: [
                    {
                        id: 'ledger-1',
                        version: 2,
                        seqNo: 1,
                        diffType: 'kv',
                    },
                ],
                replayedSpec: '{"version":2}',
            },
        } as never);

        try {
            const app = buildApp();
            const response = await app.inject({
                method: 'GET',
                url: '/v1/genomes/%40official/implementer/ledger?version=2',
            });

            expect(response.statusCode).toBe(200);
            expect(axios.get).toHaveBeenCalledWith(
                expect.stringContaining('/genomes/%40official/implementer/ledger'),
                expect.objectContaining({
                    params: { version: '2' },
                    headers: expect.objectContaining({
                        Authorization: 'Bearer shared-hub-key',
                    }),
                }),
            );
            expect(response.json()).toEqual({
                ledger: [
                    {
                        id: 'ledger-1',
                        version: 2,
                        seqNo: 1,
                        diffType: 'kv',
                    },
                ],
                replayedSpec: '{"version":2}',
            });

            await app.close();
        } finally {
            if (previousHubPublishKey === undefined) {
                delete process.env.HUB_PUBLISH_KEY;
            } else {
                process.env.HUB_PUBLISH_KEY = previousHubPublishKey;
            }
            if (previousGenomeHubPublishKey === undefined) {
                delete process.env.GENOME_HUB_PUBLISH_KEY;
            } else {
                process.env.GENOME_HUB_PUBLISH_KEY = previousGenomeHubPublishKey;
            }
        }
    });

    it('proxies genome seed queries to genome-hub', async () => {
        const previousHubPublishKey = process.env.HUB_PUBLISH_KEY;
        const previousGenomeHubPublishKey = process.env.GENOME_HUB_PUBLISH_KEY;
        delete process.env.GENOME_HUB_PUBLISH_KEY;
        process.env.HUB_PUBLISH_KEY = 'shared-hub-key';

        vi.mocked(axios.get).mockResolvedValue({
            status: 200,
            data: {
                seed: '{"displayName":"Implementer","version":1}',
            },
        } as never);

        try {
            const app = buildApp();
            const response = await app.inject({
                method: 'GET',
                url: '/v1/genomes/%40official/implementer/seed',
            });

            expect(response.statusCode).toBe(200);
            expect(axios.get).toHaveBeenCalledWith(
                expect.stringContaining('/genomes/%40official/implementer/seed'),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer shared-hub-key',
                    }),
                }),
            );
            expect(response.json()).toEqual({
                seed: '{"displayName":"Implementer","version":1}',
            });

            await app.close();
        } finally {
            if (previousHubPublishKey === undefined) {
                delete process.env.HUB_PUBLISH_KEY;
            } else {
                process.env.HUB_PUBLISH_KEY = previousHubPublishKey;
            }
            if (previousGenomeHubPublishKey === undefined) {
                delete process.env.GENOME_HUB_PUBLISH_KEY;
            } else {
                process.env.GENOME_HUB_PUBLISH_KEY = previousGenomeHubPublishKey;
            }
        }
    });

    it('proxies entity latest and diff routes to genome-hub', async () => {
        const previousHubPublishKey = process.env.HUB_PUBLISH_KEY;
        const previousGenomeHubPublishKey = process.env.GENOME_HUB_PUBLISH_KEY;
        delete process.env.GENOME_HUB_PUBLISH_KEY;
        process.env.HUB_PUBLISH_KEY = 'shared-hub-key';

        vi.mocked(axios.get)
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    entity: {
                        id: 'entity-1',
                        version: 7,
                        name: 'implementer',
                    },
                },
            } as never)
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    diffs: [
                        { id: 'entity-diff-1', version: 7 },
                    ],
                },
            } as never);
        vi.mocked(axios.post).mockResolvedValueOnce({
            status: 201,
            data: {
                diff: {
                    id: 'entity-diff-2',
                    version: 8,
                },
            },
        } as never);

        try {
            const app = buildApp();
            const entityResponse = await app.inject({
                method: 'GET',
                url: '/v1/entities/%40official/implementer',
            });
            const diffsResponse = await app.inject({
                method: 'GET',
                url: '/v1/entities/%40official/implementer/diffs',
            });
            const createDiffResponse = await app.inject({
                method: 'POST',
                url: '/v1/entities/%40official/implementer/diffs',
                payload: {
                    description: 'Apply structured entity diff',
                    changes: [{ type: 'narrative', content: 'Carry forward the diff ledger evidence.' }],
                    strategy: 'conservative',
                },
            });

            expect(entityResponse.statusCode).toBe(200);
            expect(diffsResponse.statusCode).toBe(200);
            expect(createDiffResponse.statusCode).toBe(201);
            expect(axios.get).toHaveBeenNthCalledWith(
                1,
                expect.stringContaining('/entities/%40official/implementer'),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer shared-hub-key',
                    }),
                }),
            );
            expect(axios.get).toHaveBeenNthCalledWith(
                2,
                expect.stringContaining('/entities/%40official/implementer/diffs'),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer shared-hub-key',
                    }),
                }),
            );
            expect(axios.post).toHaveBeenCalledWith(
                expect.stringContaining('/entities/%40official/implementer/diffs'),
                expect.objectContaining({
                    description: 'Apply structured entity diff',
                }),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer shared-hub-key',
                    }),
                }),
            );

            await app.close();
        } finally {
            if (previousHubPublishKey === undefined) {
                delete process.env.HUB_PUBLISH_KEY;
            } else {
                process.env.HUB_PUBLISH_KEY = previousHubPublishKey;
            }
            if (previousGenomeHubPublishKey === undefined) {
                delete process.env.GENOME_HUB_PUBLISH_KEY;
            } else {
                process.env.GENOME_HUB_PUBLISH_KEY = previousGenomeHubPublishKey;
            }
        }
    });

    it('proxies entity trial, verdict, and materialization routes to genome-hub', async () => {
        const previousHubPublishKey = process.env.HUB_PUBLISH_KEY;
        const previousGenomeHubPublishKey = process.env.GENOME_HUB_PUBLISH_KEY;
        delete process.env.GENOME_HUB_PUBLISH_KEY;
        process.env.HUB_PUBLISH_KEY = 'shared-hub-key';

        vi.mocked(axios.post)
            .mockResolvedValueOnce({
                status: 201,
                data: { trial: { id: 'trial-1', entityVersion: 7 } },
            } as never)
            .mockResolvedValueOnce({
                status: 200,
                data: { trial: { id: 'trial-1', logRefs: '[{"kind":"team","path":"logs/team.log"}]' } },
            } as never)
            .mockResolvedValueOnce({
                status: 201,
                data: { verdict: { id: 'verdict-1', trialId: 'trial-1' } },
            } as never)
            .mockResolvedValueOnce({
                status: 200,
                data: { entityId: 'entity-1', feedback: { avgScore: 95 } },
            } as never);
        vi.mocked(axios.get)
            .mockResolvedValueOnce({
                status: 200,
                data: { trials: [{ id: 'trial-1' }] },
            } as never)
            .mockResolvedValueOnce({
                status: 200,
                data: { verdicts: [{ id: 'verdict-1' }] },
            } as never);

        try {
            const app = buildApp();
            const createTrialResponse = await app.inject({
                method: 'POST',
                url: '/v1/entities/%40official/implementer/trials',
                payload: {
                    teamId: 'team-1',
                    contextNarrative: 'Validate the updated implementer on the next task.',
                },
            });
            const listTrialsResponse = await app.inject({
                method: 'GET',
                url: '/v1/entities/id/entity-1/trials',
            });
            const appendLogRefsResponse = await app.inject({
                method: 'POST',
                url: '/v1/trials/trial-1/log-refs',
                payload: {
                    logRefs: [{ kind: 'team', path: 'logs/team.log' }],
                },
            });
            const createVerdictResponse = await app.inject({
                method: 'POST',
                url: '/v1/trials/trial-1/verdicts',
                payload: {
                    readerRole: 'supervisor',
                    content: 'The new entity is an improvement.',
                    score: 95,
                    action: 'keep',
                },
            });
            const listVerdictsResponse = await app.inject({
                method: 'GET',
                url: '/v1/trials/trial-1/verdicts',
            });
            const materializeResponse = await app.inject({
                method: 'POST',
                url: '/v1/entities/id/entity-1/feedback/materialize',
            });

            expect(createTrialResponse.statusCode).toBe(201);
            expect(listTrialsResponse.statusCode).toBe(200);
            expect(appendLogRefsResponse.statusCode).toBe(200);
            expect(createVerdictResponse.statusCode).toBe(201);
            expect(listVerdictsResponse.statusCode).toBe(200);
            expect(materializeResponse.statusCode).toBe(200);
            expect(axios.post).toHaveBeenNthCalledWith(
                1,
                expect.stringContaining('/entities/%40official/implementer/trials'),
                expect.objectContaining({
                    teamId: 'team-1',
                }),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer shared-hub-key',
                    }),
                }),
            );
            expect(axios.get).toHaveBeenNthCalledWith(
                1,
                expect.stringContaining('/entities/id/entity-1/trials'),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer shared-hub-key',
                    }),
                }),
            );
            expect(axios.post).toHaveBeenNthCalledWith(
                2,
                expect.stringContaining('/trials/trial-1/log-refs'),
                expect.objectContaining({
                    logRefs: [{ kind: 'team', path: 'logs/team.log' }],
                }),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer shared-hub-key',
                    }),
                }),
            );
            expect(axios.post).toHaveBeenNthCalledWith(
                3,
                expect.stringContaining('/trials/trial-1/verdicts'),
                expect.objectContaining({
                    readerRole: 'supervisor',
                    action: 'keep',
                }),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer shared-hub-key',
                    }),
                }),
            );
            expect(axios.get).toHaveBeenNthCalledWith(
                2,
                expect.stringContaining('/trials/trial-1/verdicts'),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer shared-hub-key',
                    }),
                }),
            );
            expect(axios.post).toHaveBeenNthCalledWith(
                4,
                expect.stringContaining('/entities/id/entity-1/feedback/materialize'),
                undefined,
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer shared-hub-key',
                    }),
                }),
            );

            await app.close();
        } finally {
            if (previousHubPublishKey === undefined) {
                delete process.env.HUB_PUBLISH_KEY;
            } else {
                process.env.HUB_PUBLISH_KEY = previousHubPublishKey;
            }
            if (previousGenomeHubPublishKey === undefined) {
                delete process.env.GENOME_HUB_PUBLISH_KEY;
            } else {
                process.env.GENOME_HUB_PUBLISH_KEY = previousGenomeHubPublishKey;
            }
        }
    });

    it('proxies entity lookup routes to genome-hub', async () => {
        const previousHubPublishKey = process.env.HUB_PUBLISH_KEY;
        const previousGenomeHubPublishKey = process.env.GENOME_HUB_PUBLISH_KEY;
        delete process.env.GENOME_HUB_PUBLISH_KEY;
        process.env.HUB_PUBLISH_KEY = 'shared-hub-key';

        vi.mocked(axios.get)
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    entity: {
                        id: 'entity-1',
                        namespace: '@official',
                        name: 'implementer',
                        version: 3,
                    },
                },
            } as never)
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    entity: {
                        id: 'entity-1',
                        namespace: '@official',
                        name: 'implementer',
                        version: 2,
                    },
                },
            } as never);

        try {
            const app = buildApp();

            const byIdResponse = await app.inject({
                method: 'GET',
                url: '/v1/entities/id/entity-1',
            });
            const byVersionResponse = await app.inject({
                method: 'GET',
                url: '/v1/entities/%40official/implementer/2',
            });

            expect(byIdResponse.statusCode).toBe(200);
            expect(byVersionResponse.statusCode).toBe(200);
            expect(axios.get).toHaveBeenNthCalledWith(
                1,
                expect.stringContaining('/entities/id/entity-1'),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer shared-hub-key',
                    }),
                }),
            );
            expect(axios.get).toHaveBeenNthCalledWith(
                2,
                expect.stringContaining('/entities/%40official/implementer/2'),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer shared-hub-key',
                    }),
                }),
            );

            await app.close();
        } finally {
            if (previousHubPublishKey === undefined) {
                delete process.env.HUB_PUBLISH_KEY;
            } else {
                process.env.HUB_PUBLISH_KEY = previousHubPublishKey;
            }
            if (previousGenomeHubPublishKey === undefined) {
                delete process.env.GENOME_HUB_PUBLISH_KEY;
            } else {
                process.env.GENOME_HUB_PUBLISH_KEY = previousGenomeHubPublishKey;
            }
        }
    });

    it('proxies entity diff, trial, verdict, and materialization routes to genome-hub', async () => {
        const previousHubPublishKey = process.env.HUB_PUBLISH_KEY;
        const previousGenomeHubPublishKey = process.env.GENOME_HUB_PUBLISH_KEY;
        delete process.env.GENOME_HUB_PUBLISH_KEY;
        process.env.HUB_PUBLISH_KEY = 'shared-hub-key';

        vi.mocked(axios.post)
            .mockResolvedValueOnce({
                status: 201,
                data: {
                    diff: {
                        id: 'entity-diff-1',
                    },
                },
            } as never)
            .mockResolvedValueOnce({
                status: 201,
                data: {
                    trial: {
                        id: 'trial-1',
                    },
                },
            } as never)
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    trial: {
                        id: 'trial-1',
                        logRefs: [{ kind: 'codex', path: '/tmp/log.jsonl' }],
                    },
                },
            } as never)
            .mockResolvedValueOnce({
                status: 201,
                data: {
                    verdict: {
                        id: 'verdict-1',
                    },
                },
            } as never)
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    entityId: 'entity-1',
                    feedback: {
                        avgScore: 91,
                    },
                },
            } as never);
        vi.mocked(axios.get)
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    trials: [{ id: 'trial-1' }],
                },
            } as never)
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    verdicts: [{ id: 'verdict-1' }],
                },
            } as never);

        try {
            const app = buildApp();

            const diffResponse = await app.inject({
                method: 'POST',
                url: '/v1/entities/%40official/implementer/diffs',
                payload: {
                    description: 'Add stricter completion audit',
                    changes: [{ type: 'kv', path: 'policy.audit', to: true }],
                    strategy: 'moderate',
                },
            });
            const trialCreateResponse = await app.inject({
                method: 'POST',
                url: '/v1/entities/%40official/implementer/trials',
                payload: {
                    teamId: 'team-1',
                    contextNarrative: 'Run a focused repair loop',
                    logRefs: [{ kind: 'codex', path: '/tmp/log.jsonl' }],
                },
            });
            const entityTrialsResponse = await app.inject({
                method: 'GET',
                url: '/v1/entities/id/entity-1/trials',
            });
            const logRefsResponse = await app.inject({
                method: 'POST',
                url: '/v1/trials/trial-1/log-refs',
                payload: {
                    logRefs: [{ kind: 'codex', path: '/tmp/log.jsonl' }],
                },
            });
            const verdictCreateResponse = await app.inject({
                method: 'POST',
                url: '/v1/trials/trial-1/verdicts',
                payload: {
                    readerRole: 'reviewer',
                    content: 'Looks good',
                    score: 91,
                    action: 'keep',
                },
            });
            const verdictListResponse = await app.inject({
                method: 'GET',
                url: '/v1/trials/trial-1/verdicts',
            });
            const materializeResponse = await app.inject({
                method: 'POST',
                url: '/v1/entities/id/entity-1/feedback/materialize',
            });

            expect(diffResponse.statusCode).toBe(201);
            expect(trialCreateResponse.statusCode).toBe(201);
            expect(entityTrialsResponse.statusCode).toBe(200);
            expect(logRefsResponse.statusCode).toBe(200);
            expect(verdictCreateResponse.statusCode).toBe(201);
            expect(verdictListResponse.statusCode).toBe(200);
            expect(materializeResponse.statusCode).toBe(200);

            expect(axios.post).toHaveBeenNthCalledWith(
                1,
                expect.stringContaining('/entities/%40official/implementer/diffs'),
                expect.objectContaining({
                    description: 'Add stricter completion audit',
                    strategy: 'moderate',
                }),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer shared-hub-key',
                    }),
                }),
            );
            expect(axios.post).toHaveBeenNthCalledWith(
                2,
                expect.stringContaining('/entities/%40official/implementer/trials'),
                expect.objectContaining({
                    teamId: 'team-1',
                }),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer shared-hub-key',
                    }),
                }),
            );
            expect(axios.get).toHaveBeenNthCalledWith(
                1,
                expect.stringContaining('/entities/id/entity-1/trials'),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer shared-hub-key',
                    }),
                }),
            );
            expect(axios.post).toHaveBeenNthCalledWith(
                3,
                expect.stringContaining('/trials/trial-1/log-refs'),
                expect.objectContaining({
                    logRefs: [{ kind: 'codex', path: '/tmp/log.jsonl' }],
                }),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer shared-hub-key',
                    }),
                }),
            );
            expect(axios.post).toHaveBeenNthCalledWith(
                4,
                expect.stringContaining('/trials/trial-1/verdicts'),
                expect.objectContaining({
                    readerRole: 'reviewer',
                    action: 'keep',
                }),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer shared-hub-key',
                    }),
                }),
            );
            expect(axios.get).toHaveBeenNthCalledWith(
                2,
                expect.stringContaining('/trials/trial-1/verdicts'),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer shared-hub-key',
                    }),
                }),
            );
            expect(axios.post).toHaveBeenNthCalledWith(
                5,
                expect.stringContaining('/entities/id/entity-1/feedback/materialize'),
                undefined,
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer shared-hub-key',
                    }),
                }),
            );

            await app.close();
        } finally {
            if (previousHubPublishKey === undefined) {
                delete process.env.HUB_PUBLISH_KEY;
            } else {
                process.env.HUB_PUBLISH_KEY = previousHubPublishKey;
            }
            if (previousGenomeHubPublishKey === undefined) {
                delete process.env.GENOME_HUB_PUBLISH_KEY;
            } else {
                process.env.GENOME_HUB_PUBLISH_KEY = previousGenomeHubPublishKey;
            }
        }
    });

    it('proxies genome promotion updates to genome-hub using the shared publish key fallback', async () => {
        const previousHubPublishKey = process.env.HUB_PUBLISH_KEY;
        const previousGenomeHubPublishKey = process.env.GENOME_HUB_PUBLISH_KEY;
        delete process.env.GENOME_HUB_PUBLISH_KEY;
        process.env.HUB_PUBLISH_KEY = 'shared-hub-key';

        vi.mocked(axios.post).mockResolvedValue({
            status: 201,
            data: {
                genome: {
                    id: 'hub-genome-2',
                    version: 2,
                },
            },
        } as never);

        try {
            const app = buildApp();
            const response = await app.inject({
                method: 'POST',
                url: '/v1/genomes/%40official/supervisor/promote',
                payload: {
                    spec: '{"displayName":"Supervisor"}',
                    minAvgScore: 60,
                    isPublic: true,
                },
            });

            expect(response.statusCode).toBe(201);
            expect(axios.post).toHaveBeenCalledWith(
                expect.stringContaining('/genomes/%40official/supervisor/promote'),
                expect.objectContaining({
                    spec: '{"displayName":"Supervisor"}',
                    minAvgScore: 60,
                    isPublic: true,
                }),
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: 'Bearer shared-hub-key',
                    }),
                }),
            );
            expect(response.json()).toEqual({
                genome: {
                    id: 'hub-genome-2',
                    version: 2,
                },
            });

            await app.close();
        } finally {
            if (previousHubPublishKey === undefined) {
                delete process.env.HUB_PUBLISH_KEY;
            } else {
                process.env.HUB_PUBLISH_KEY = previousHubPublishKey;
            }
            if (previousGenomeHubPublishKey === undefined) {
                delete process.env.GENOME_HUB_PUBLISH_KEY;
            } else {
                process.env.GENOME_HUB_PUBLISH_KEY = previousGenomeHubPublishKey;
            }
        }
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
            spec: '{"role":"builder","version":1}',
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
            version: 2,
            spec: '{"role":"builder","version":1}',
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
                spec: '{"role":"builder","version":2}',
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
        expect(JSON.parse(response.json().genome.spec)).toMatchObject({
            role: 'builder',
            version: 2,
        });

        await app.close();
    });

    it('creates a new session trial, prefers open trials when listing, and closes sibling open rows on patch', async () => {
        vi.mocked(db.trial.findMany)
            .mockResolvedValueOnce([] as never)
            .mockResolvedValueOnce([
                {
                    id: 'trial-closed',
                    hubEntityId: 'spec-1',
                    entityVersion: 7,
                    teamId: 'team-1',
                    sessionId: 'session-1',
                    contextNarrative: null,
                    logRefs: '[]',
                    startedAt: new Date('2026-03-29T00:01:00.000Z'),
                    endedAt: new Date('2026-03-29T00:03:00.000Z'),
                },
                {
                    id: 'trial-open',
                    hubEntityId: 'spec-1',
                    entityVersion: 7,
                    teamId: 'team-1',
                    sessionId: 'session-1',
                    contextNarrative: null,
                    logRefs: '[]',
                    startedAt: new Date('2026-03-29T00:00:00.000Z'),
                    endedAt: null,
                },
            ] as never);
        vi.mocked(db.trial.create).mockResolvedValue({
            id: 'trial-open',
            hubEntityId: 'spec-1',
            entityVersion: 7,
            teamId: 'team-1',
            sessionId: 'session-1',
            contextNarrative: null,
            logRefs: '[]',
            startedAt: new Date('2026-03-29T00:00:00.000Z'),
            endedAt: null,
        } as never);
        vi.mocked(db.trial.update).mockResolvedValue({
            id: 'trial-open',
            hubEntityId: 'spec-1',
            entityVersion: 7,
            teamId: 'team-1',
            sessionId: 'session-1',
            contextNarrative: null,
            logRefs: '[{\"kind\":\"aha-session\",\"sessionId\":\"session-1\"}]',
            startedAt: new Date('2026-03-29T00:00:00.000Z'),
            endedAt: new Date('2026-03-29T00:05:00.000Z'),
        } as never);
        vi.mocked(db.trial.updateMany).mockResolvedValue({ count: 1 } as never);

        const app = buildApp();

        const createResponse = await app.inject({
            method: 'POST',
            url: '/v1/trials',
            payload: {
                hubEntityId: 'spec-1',
                entityVersion: 7,
                teamId: 'team-1',
                sessionId: 'session-1',
                logRefs: '[]',
            },
        });
        expect(createResponse.statusCode).toBe(201);
        expect(db.trial.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                hubEntityId: 'spec-1',
                entityVersion: 7,
                teamId: 'team-1',
                sessionId: 'session-1',
            }),
        });

        const listResponse = await app.inject({
            method: 'GET',
            url: '/v1/trials?sessionId=session-1&limit=1',
        });
        expect(listResponse.statusCode).toBe(200);
        expect(db.trial.findMany).toHaveBeenLastCalledWith({
            where: { sessionId: 'session-1' },
            orderBy: [
                { startedAt: 'desc' },
                { id: 'desc' },
            ],
        });
        expect(listResponse.json()).toEqual({
            trials: [
                expect.objectContaining({
                    id: 'trial-open',
                    endedAt: null,
                }),
            ],
        });

        const patchResponse = await app.inject({
            method: 'PATCH',
            url: '/v1/trials/trial-open',
            payload: {
                endedAt: '2026-03-29T00:05:00.000Z',
                logRefs: '[{\"kind\":\"aha-session\",\"sessionId\":\"session-1\"}]',
            },
        });
        expect(patchResponse.statusCode).toBe(200);
        expect(db.trial.update).toHaveBeenCalledWith({
            where: { id: 'trial-open' },
            data: {
                endedAt: new Date('2026-03-29T00:05:00.000Z'),
                logRefs: '[{\"kind\":\"aha-session\",\"sessionId\":\"session-1\"}]',
            },
        });
        expect(db.trial.updateMany).toHaveBeenCalledWith({
            where: {
                sessionId: 'session-1',
                endedAt: null,
                id: { not: 'trial-open' },
            },
            data: {
                endedAt: new Date('2026-03-29T00:05:00.000Z'),
            },
        });

        await app.close();
    });

    it('reuses an existing open session trial and closes duplicate open rows', async () => {
        vi.mocked(db.trial.findMany).mockResolvedValue([
            {
                id: 'trial-primary',
                hubEntityId: 'spec-1',
                entityVersion: 7,
                teamId: 'team-1',
                sessionId: 'session-1',
                contextNarrative: null,
                logRefs: '[]',
                startedAt: new Date('2026-03-29T00:02:00.000Z'),
                endedAt: null,
            },
            {
                id: 'trial-duplicate',
                hubEntityId: 'spec-1',
                entityVersion: 7,
                teamId: 'team-1',
                sessionId: 'session-1',
                contextNarrative: null,
                logRefs: '[]',
                startedAt: new Date('2026-03-29T00:01:00.000Z'),
                endedAt: null,
            },
        ] as never);
        vi.mocked(db.trial.updateMany).mockResolvedValue({ count: 1 } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/trials',
            payload: {
                hubEntityId: 'spec-1',
                entityVersion: 7,
                teamId: 'team-1',
                sessionId: 'session-1',
            },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
            trial: expect.objectContaining({
                id: 'trial-primary',
            }),
        });
        expect(db.trial.create).not.toHaveBeenCalled();
        expect(db.trial.updateMany).toHaveBeenCalledWith({
            where: {
                id: { in: ['trial-duplicate'] },
            },
            data: {
                endedAt: expect.any(Date),
            },
        });

        await app.close();
    });

    it('closes a stale open trial before creating a new one for the same session', async () => {
        vi.mocked(db.trial.findMany).mockResolvedValue([
            {
                id: 'trial-old',
                hubEntityId: 'spec-1',
                entityVersion: 6,
                teamId: 'team-1',
                sessionId: 'session-1',
                contextNarrative: null,
                logRefs: '[]',
                startedAt: new Date('2026-03-29T00:00:00.000Z'),
                endedAt: null,
            },
        ] as never);
        vi.mocked(db.trial.updateMany).mockResolvedValue({ count: 1 } as never);
        vi.mocked(db.trial.create).mockResolvedValue({
            id: 'trial-new',
            hubEntityId: 'spec-1',
            entityVersion: 7,
            teamId: 'team-1',
            sessionId: 'session-1',
            contextNarrative: null,
            logRefs: '[]',
            startedAt: new Date('2026-03-29T00:05:00.000Z'),
            endedAt: null,
        } as never);

        const app = buildApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/trials',
            payload: {
                hubEntityId: 'spec-1',
                entityVersion: 7,
                teamId: 'team-1',
                sessionId: 'session-1',
            },
        });

        expect(response.statusCode).toBe(201);
        expect(db.trial.updateMany).toHaveBeenCalledWith({
            where: {
                id: { in: ['trial-old'] },
            },
            data: {
                endedAt: expect.any(Date),
            },
        });
        expect(db.trial.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                hubEntityId: 'spec-1',
                entityVersion: 7,
                sessionId: 'session-1',
            }),
        });

        await app.close();
    });

    it('creates and lists verdicts', async () => {
        vi.mocked(db.verdict.create).mockResolvedValue({
            id: 'verdict-1',
            trialId: 'trial-1',
            readerRole: 'supervisor',
            readerSessionId: 'reviewer-1',
            content: 'overall 85',
            score: 85,
            action: 'keep',
            dimensions: '{"delivery":85}',
            createdAt: new Date('2026-03-29T00:06:00.000Z'),
        } as never);
        vi.mocked(db.verdict.findMany).mockResolvedValue([
            {
                id: 'verdict-1',
                trialId: 'trial-1',
                readerRole: 'supervisor',
                readerSessionId: 'reviewer-1',
                content: 'overall 85',
                score: 85,
                action: 'keep',
                dimensions: '{"delivery":85}',
                createdAt: new Date('2026-03-29T00:06:00.000Z'),
            },
        ] as never);

        const app = buildApp();

        const createResponse = await app.inject({
            method: 'POST',
            url: '/v1/verdicts',
            payload: {
                trialId: 'trial-1',
                readerRole: 'supervisor',
                readerSessionId: 'reviewer-1',
                content: 'overall 85',
                score: 85,
                action: 'keep',
                dimensions: '{"delivery":85}',
            },
        });
        expect(createResponse.statusCode).toBe(201);
        expect(db.verdict.create).toHaveBeenCalledWith({
            data: {
                trialId: 'trial-1',
                readerRole: 'supervisor',
                readerSessionId: 'reviewer-1',
                content: 'overall 85',
                score: 85,
                action: 'keep',
                dimensions: '{"delivery":85}',
            },
        });

        const listResponse = await app.inject({
            method: 'GET',
            url: '/v1/verdicts?trialId=trial-1&readerRole=supervisor&limit=5',
        });
        expect(listResponse.statusCode).toBe(200);
        expect(db.verdict.findMany).toHaveBeenCalledWith({
            where: {
                trialId: 'trial-1',
                readerRole: 'supervisor',
            },
            orderBy: { createdAt: 'desc' },
            take: 5,
        });

        await app.close();
    });
});
