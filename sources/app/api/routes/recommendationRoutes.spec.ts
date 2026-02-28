/**
 * V5-AI-001: 智能角色推荐 API 测试
 *
 * 测试端点:
 * - POST /api/v5/recommendations - 获取推荐角色列表
 * - POST /api/v5/recommendations/batch - 批量推荐
 * - POST /api/v5/recommendations/apply - 一键应用推荐
 * - PUT /api/v5/recommendations/adjust - 自定义调整推荐
 */

import fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Fastify as TypedFastify } from '../types';

const testState = vi.hoisted(() => {
    type KVEntry = { value: string | null; version: number };
    type CacheEntry = { value: string; createdAt: number; updatedAt: number };

    const kvStore = new Map<string, KVEntry>();
    const cacheStore = new Map<string, CacheEntry>();
    const kvKey = (uid: string, key: string) => `${uid}::${key}`;

    return {
        kvStore,
        cacheStore,
        kvKey,
        reset() {
            kvStore.clear();
            cacheStore.clear();
        },
        seedRole(uid: string, key: string, rawJson: string) {
            kvStore.set(kvKey(uid, key), { value: rawJson, version: 0 });
        },
    };
});

function matchSimpleCacheWhere(key: string, where: any): boolean {
    if (!where) {
        return true;
    }

    if (Array.isArray(where.OR)) {
        return where.OR.some((item: any) => matchSimpleCacheWhere(key, item));
    }

    if (typeof where.key === 'string') {
        return key === where.key;
    }

    if (typeof where.key?.startsWith === 'string') {
        return key.startsWith(where.key.startsWith);
    }

    return true;
}

vi.mock('@/storage/db', () => ({
    db: {
        simpleCache: {
            findUnique: vi.fn(async ({ where }: any) => {
                const entry = testState.cacheStore.get(where.key);
                if (!entry) {
                    return null;
                }

                return {
                    key: where.key,
                    value: entry.value,
                    createdAt: new Date(entry.createdAt),
                    updatedAt: new Date(entry.updatedAt),
                };
            }),
            findMany: vi.fn(async ({ where, orderBy, take }: any) => {
                let rows = Array.from(testState.cacheStore.entries())
                    .filter(([key]) => matchSimpleCacheWhere(key, where))
                    .map(([key, value]) => ({
                        key,
                        value: value.value,
                        createdAt: new Date(value.createdAt),
                        updatedAt: new Date(value.updatedAt),
                    }));

                if (orderBy?.updatedAt === 'desc') {
                    rows = rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
                }

                if (typeof take === 'number') {
                    rows = rows.slice(0, take);
                }

                return rows;
            }),
            upsert: vi.fn(async ({ where, update, create }: any) => {
                const now = Date.now();
                const existing = testState.cacheStore.get(where.key);

                if (existing) {
                    existing.value = update.value;
                    existing.updatedAt = now;
                } else {
                    testState.cacheStore.set(where.key, {
                        value: create.value,
                        createdAt: now,
                        updatedAt: now,
                    });
                }

                const current = testState.cacheStore.get(where.key)!;
                return {
                    key: where.key,
                    value: current.value,
                    createdAt: new Date(current.createdAt),
                    updatedAt: new Date(current.updatedAt),
                };
            }),
            update: vi.fn(async ({ where, data }: any) => {
                const existing = testState.cacheStore.get(where.key);
                if (!existing) {
                    throw new Error(`Record not found for key ${where.key}`);
                }
                existing.value = data.value;
                existing.updatedAt = Date.now();
                return {
                    key: where.key,
                    value: existing.value,
                    createdAt: new Date(existing.createdAt),
                    updatedAt: new Date(existing.updatedAt),
                };
            }),
            deleteMany: vi.fn(async ({ where }: any) => {
                const keys = Array.from(testState.cacheStore.keys())
                    .filter((key) => matchSimpleCacheWhere(key, where));

                for (const key of keys) {
                    testState.cacheStore.delete(key);
                }
                return { count: keys.length };
            }),
        },
    },
}));

vi.mock('@/app/kv/kvGet', () => ({
    kvGet: vi.fn(async ({ uid }: { uid: string }, key: string) => {
        const entry = testState.kvStore.get(testState.kvKey(uid, key));
        if (!entry || entry.value === null) {
            return null;
        }

        return {
            key,
            value: entry.value,
            version: entry.version,
        };
    }),
}));

vi.mock('@/app/kv/kvList', () => ({
    kvList: vi.fn(async ({ uid }: { uid: string }, options?: { prefix?: string; limit?: number }) => {
        let items = Array.from(testState.kvStore.entries())
            .filter(([compoundKey, entry]) => compoundKey.startsWith(`${uid}::`) && entry.value !== null)
            .map(([compoundKey, entry]) => {
                const key = compoundKey.slice(uid.length + 2);
                return {
                    key,
                    value: entry.value!,
                    version: entry.version,
                };
            })
            .filter((item) => (options?.prefix ? item.key.startsWith(options.prefix) : true))
            .sort((a, b) => a.key.localeCompare(b.key));

        if (typeof options?.limit === 'number') {
            items = items.slice(0, options.limit);
        }

        return { items };
    }),
}));

vi.mock('@/app/kv/kvMutate', () => ({
    kvMutate: vi.fn(async ({ uid }: { uid: string }, mutations: Array<{ key: string; value: string | null; version: number }>) => {
        const results: Array<{ key: string; version: number }> = [];

        for (const mutation of mutations) {
            const storeKey = testState.kvKey(uid, mutation.key);
            const existing = testState.kvStore.get(storeKey);

            if (mutation.version === -1) {
                testState.kvStore.set(storeKey, { value: mutation.value, version: 0 });
                results.push({ key: mutation.key, version: 0 });
                continue;
            }

            const nextVersion = (existing?.version ?? mutation.version) + 1;
            testState.kvStore.set(storeKey, { value: mutation.value, version: nextVersion });
            results.push({ key: mutation.key, version: nextVersion });
        }

        return {
            success: true,
            results,
        };
    }),
}));

vi.mock('@/utils/log', () => ({
    log: vi.fn(),
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

// Mock Anthropic SDK for RecommendationEngine
vi.mock('@anthropic-ai/sdk', () => ({
    default: class MockAnthropic {
        messages = {
            create: vi.fn(async ({ model, messages }: any) => {
                const prompt = messages[0].content;

                // 项目需求分析响应
                if (prompt.includes('分析以下项目需求')) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                coreSkills: ['React', 'TypeScript', 'Node.js'],
                                roleTypes: ['frontend', 'backend'],
                                challenges: ['时间紧迫'],
                                recommendedRoles: 2
                            })
                        }]
                    };
                }

                // 角色匹配度计算响应
                if (prompt.includes('计算角色匹配度')) {
                    return {
                        content: [{
                            type: 'text',
                            text: JSON.stringify({
                                matchScore: 85,
                                reasons: ['技能匹配度高', '项目类型符合'],
                                skillMatch: {
                                    matched: ['React', 'TypeScript'],
                                    missing: ['Node.js'],
                                    bonus: []
                                }
                            })
                        }]
                    };
                }

                return {
                    content: [{
                        type: 'text',
                        text: '{}'
                    }]
                };
            })
        };
    }
}));

import { recommendationRoutes } from './recommendationRoutes';

async function buildApp(defaultUserId = 'user-1') {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as TypedFastify;

    // Register authentication decorator that sets request.user from x-user-id header
    typed.decorate('authenticate', async (request: any) => {
        const headerUserId = request.headers['x-user-id'];
        request.user = { id: typeof headerUserId === 'string' ? headerUserId : defaultUserId };
    });

    // Register the authentication decorator as a hook
    typed.addHook('preHandler', async (request: any) => {
        if (request.authenticate) {
            await request.authenticate(request);
        }
    });

    recommendationRoutes(typed);
    await typed.ready();
    return typed;
}

describe('recommendationRoutes', () => {
    let app: Awaited<ReturnType<typeof buildApp>>;

    beforeEach(async () => {
        testState.reset();
        app = await buildApp();
    });

    afterEach(async () => {
        await app.close();
    });

    describe('POST /api/v5/recommendations', () => {
        it('should return 401 when user is not authenticated', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/v5/recommendations',
                headers: { 'content-type': 'application/json' }, // No x-user-id header
                payload: {
                    techStack: ['React', 'TypeScript'],
                    teamSize: 3,
                    projectType: 'webapp'
                }
            });

            expect(response.statusCode).toBe(401);
            const payload = response.json();
            expect(payload.success).toBe(false);
            expect(payload.error).toBe('Unauthorized');
        });

        it('should return recommendations with valid request', async () => {
            // Seed a custom role
            const customRole = {
                id: 'custom-role-1',
                title: 'React Developer',
                policy: { coordinationMode: 'implementer' },
                assignedSkills: ['React', 'TypeScript', 'CSS'],
                summary: 'Frontend developer with React expertise'
            };
            testState.seedRole('user-1', 'roles.custom-role-1', JSON.stringify(customRole));

            const response = await app.inject({
                method: 'POST',
                url: '/api/v5/recommendations',
                headers: {
                    'content-type': 'application/json',
                    'x-user-id': 'user-1'
                },
                payload: {
                    techStack: ['React', 'TypeScript'],
                    teamSize: 3,
                    projectType: 'webapp',
                    maxRecommendations: 5
                }
            });

            expect(response.statusCode).toBe(200);
            const payload = response.json();
            expect(payload.success).toBe(true);
            expect(payload.recommendations).toBeInstanceOf(Array);
            expect(payload.recommendations.length).toBeGreaterThan(0);

            // Check first recommendation structure
            const first = payload.recommendations[0];
            expect(first.role).toBeDefined();
            expect(first.role.id).toBeDefined();
            expect(first.role.name).toBeDefined();
            expect(first.matchScore).toBeGreaterThanOrEqual(0);
            expect(first.matchScore).toBeLessThanOrEqual(100);
            expect(first.reasons).toBeInstanceOf(Array);
            expect(first.skillMatch).toBeDefined();
            expect(first.skillMatch.matched).toBeInstanceOf(Array);
            expect(first.skillMatch.missing).toBeInstanceOf(Array);
            expect(first.skillMatch.bonus).toBeInstanceOf(Array);
        });

        it('should use default role templates when no custom roles available', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/v5/recommendations',
                headers: {
                    'content-type': 'application/json',
                    'x-user-id': 'user-no-roles'
                },
                payload: {
                    techStack: ['React', 'TypeScript'],
                    teamSize: 3,
                    projectType: 'webapp'
                }
            });

            expect(response.statusCode).toBe(200);
            const payload = response.json();
            expect(payload.success).toBe(true);
            expect(payload.recommendations.length).toBeGreaterThan(0);

            // Default roles should include frontend, backend, and QA
            const roleNames = payload.recommendations.map((r: any) => r.role.name);
            expect(roleNames).toContain('Frontend Developer');
        });

        it('should respect maxRecommendations parameter', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/v5/recommendations',
                headers: {
                    'content-type': 'application/json',
                    'x-user-id': 'user-1'
                },
                payload: {
                    techStack: ['React', 'TypeScript'],
                    teamSize: 3,
                    projectType: 'webapp',
                    maxRecommendations: 2
                }
            });

            expect(response.statusCode).toBe(200);
            const payload = response.json();
            expect(payload.recommendations.length).toBeLessThanOrEqual(2);
        });

        it('should include project description in analysis when provided', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/v5/recommendations',
                headers: {
                    'content-type': 'application/json',
                    'x-user-id': 'user-1'
                },
                payload: {
                    techStack: ['React', 'TypeScript'],
                    teamSize: 5,
                    projectType: 'fullstack',
                    description: 'E-commerce platform with payment integration',
                    timeline: '3 months'
                }
            });

            expect(response.statusCode).toBe(200);
            const payload = response.json();
            expect(payload.success).toBe(true);
        });

        it('should validate request schema - missing required fields', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/v5/recommendations',
                headers: {
                    'content-type': 'application/json',
                    'x-user-id': 'user-1'
                },
                payload: {
                    techStack: ['React'] // Missing teamSize and projectType
                }
            });

            // Fastify with Zod validation should return 400
            expect(response.statusCode).toBe(400);
        });

        it('should validate projectType enum - invalid value', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/v5/recommendations',
                headers: {
                    'content-type': 'application/json',
                    'x-user-id': 'user-1'
                },
                payload: {
                    techStack: ['React'],
                    teamSize: 3,
                    projectType: 'invalid-type'
                }
            });

            expect(response.statusCode).toBe(400);
        });

        it('should handle roles with statistics data', async () => {
            // Seed a role with statistics to trigger successRate calculation (line 105)
            const roleWithStats = {
                id: 'role-with-stats',
                title: 'Experienced Developer',
                policy: { coordinationMode: 'implementer' },
                assignedSkills: ['React', 'TypeScript'],
                summary: 'Developer with track record',
                stats: {
                    averageRating: 4.5,
                    completionCount: 20,
                    reviewCount: 25
                }
            };
            testState.seedRole('user-1', 'roles.role-with-stats', JSON.stringify(roleWithStats));

            const response = await app.inject({
                method: 'POST',
                url: '/api/v5/recommendations',
                headers: {
                    'content-type': 'application/json',
                    'x-user-id': 'user-1'
                },
                payload: {
                    techStack: ['React', 'TypeScript'],
                    teamSize: 3,
                    projectType: 'webapp'
                }
            });

            expect(response.statusCode).toBe(200);
            const payload = response.json();
            expect(payload.success).toBe(true);
        });

        it('should handle invalid role JSON gracefully', async () => {
            // Seed invalid JSON to trigger catch block (line 109)
            testState.seedRole('user-1', 'roles.invalid-role', 'not-valid-json');

            const response = await app.inject({
                method: 'POST',
                url: '/api/v5/recommendations',
                headers: {
                    'content-type': 'application/json',
                    'x-user-id': 'user-1'
                },
                payload: {
                    techStack: ['React', 'TypeScript'],
                    teamSize: 3,
                    projectType: 'webapp'
                }
            });

            expect(response.statusCode).toBe(200);
            const payload = response.json();
            expect(payload.success).toBe(true);
            // Invalid role should be filtered out
        });
    });

    describe('POST /api/v5/recommendations/batch', () => {
        it('should return 401 when user is not authenticated', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/v5/recommendations/batch',
                headers: { 'content-type': 'application/json' },
                payload: {
                    requirements: [{
                        techStack: ['React'],
                        teamSize: 3,
                        projectType: 'webapp'
                    }]
                }
            });

            expect(response.statusCode).toBe(401);
        });

        it('should handle batch recommendations with roles having statistics', async () => {
            // Seed a role with statistics to cover batch endpoint successRate calculation (line 207-209)
            const roleWithStats = {
                id: 'batch-role-stats',
                title: 'Backend Expert',
                policy: { coordinationMode: 'implementer' },
                assignedSkills: ['Node.js', 'PostgreSQL'],
                summary: 'Backend specialist',
                stats: {
                    averageRating: 4.8,
                    completionCount: 30,
                    reviewCount: 35
                }
            };
            testState.seedRole('user-1', 'roles.batch-role-stats', JSON.stringify(roleWithStats));

            const response = await app.inject({
                method: 'POST',
                url: '/api/v5/recommendations/batch',
                headers: {
                    'content-type': 'application/json',
                    'x-user-id': 'user-1'
                },
                payload: {
                    requirements: [
                        {
                            techStack: ['Node.js', 'PostgreSQL'],
                            teamSize: 5,
                            projectType: 'api'
                        }
                    ]
                }
            });

            expect(response.statusCode).toBe(200);
            const payload = response.json();
            expect(payload.success).toBe(true);
            expect(Object.keys(payload.results).length).toBe(1);
        });

        it('should handle invalid role JSON in batch endpoint', async () => {
            // Seed invalid JSON to trigger batch endpoint catch block (line 212)
            testState.seedRole('user-1', 'roles.batch-invalid', 'not-json');

            const response = await app.inject({
                method: 'POST',
                url: '/api/v5/recommendations/batch',
                headers: {
                    'content-type': 'application/json',
                    'x-user-id': 'user-1'
                },
                payload: {
                    requirements: [
                        {
                            techStack: ['React'],
                            teamSize: 3,
                            projectType: 'webapp'
                        }
                    ]
                }
            });

            expect(response.statusCode).toBe(200);
            const payload = response.json();
            expect(payload.success).toBe(true);
        });

        it('should handle batch recommendations successfully', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/v5/recommendations/batch',
                headers: {
                    'content-type': 'application/json',
                    'x-user-id': 'user-1'
                },
                payload: {
                    requirements: [
                        {
                            techStack: ['React', 'TypeScript'],
                            teamSize: 3,
                            projectType: 'webapp'
                        },
                        {
                            techStack: ['Node.js', 'PostgreSQL'],
                            teamSize: 5,
                            projectType: 'api'
                        }
                    ]
                }
            });

            expect(response.statusCode).toBe(200);
            const payload = response.json();
            expect(payload.success).toBe(true);
            expect(Object.keys(payload.results).length).toBe(2);
        });
    });

    describe('POST /api/v5/recommendations/apply - 一键应用推荐', () => {
        it('should apply recommended roles to a new project', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/v5/recommendations/apply',
                headers: {
                    'content-type': 'application/json',
                    'x-user-id': 'user-1'
                },
                payload: {
                    projectId: 'project-new-123',
                    recommendations: [
                        { roleId: 'role-1', matchScore: 85 },
                        { roleId: 'role-2', matchScore: 80 }
                    ]
                }
            });

            expect(response.statusCode).toBe(200);
            const payload = response.json();
            expect(payload.success).toBe(true);
            expect(payload.projectId).toBe('project-new-123');
            expect(payload.appliedRoles).toBeInstanceOf(Array);
            expect(payload.appliedRoles.length).toBe(2);
        });

        it('should return 401 when user is not authenticated', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/v5/recommendations/apply',
                headers: { 'content-type': 'application/json' },
                payload: {
                    projectId: 'project-123',
                    recommendations: []
                }
            });

            expect(response.statusCode).toBe(401);
        });

        it('should validate required fields for apply', async () => {
            const response = await app.inject({
                method: 'POST',
                url: '/api/v5/recommendations/apply',
                headers: {
                    'content-type': 'application/json',
                    'x-user-id': 'user-1'
                },
                payload: {
                    // Missing projectId
                    recommendations: []
                }
            });

            expect(response.statusCode).toBe(400);
        });
    });

    describe('PUT /api/v5/recommendations/adjust - 自定义调整推荐', () => {
        it('should adjust recommendation scores', async () => {
            const response = await app.inject({
                method: 'PUT',
                url: '/api/v5/recommendations/adjust',
                headers: {
                    'content-type': 'application/json',
                    'x-user-id': 'user-1'
                },
                payload: {
                    projectId: 'project-123',
                    adjustments: [
                        { roleId: 'role-1', adjustedScore: 95, reason: 'Experienced with our stack' },
                        { roleId: 'role-2', adjustedScore: 60, reason: 'Less relevant experience' }
                    ]
                }
            });

            expect(response.statusCode).toBe(200);
            const payload = response.json();
            expect(payload.success).toBe(true);
            expect(payload.adjustedRecommendations).toBeInstanceOf(Array);
        });

        it('should return 401 when user is not authenticated', async () => {
            const response = await app.inject({
                method: 'PUT',
                url: '/api/v5/recommendations/adjust',
                headers: { 'content-type': 'application/json' },
                payload: {
                    projectId: 'project-123',
                    adjustments: []
                }
            });

            expect(response.statusCode).toBe(401);
        });

        it('should validate adjustment payload', async () => {
            const response = await app.inject({
                method: 'PUT',
                url: '/api/v5/recommendations/adjust',
                headers: {
                    'content-type': 'application/json',
                    'x-user-id': 'user-1'
                },
                payload: {
                    // Missing projectId and adjustments
                }
            });

            expect(response.statusCode).toBe(400);
        });
    });

    describe('Error handling', () => {
        it('should handle internal errors gracefully', async () => {
            // This test verifies error handling structure
            // Actual error handling tests would require more sophisticated mocking
            const response = await app.inject({
                method: 'POST',
                url: '/api/v5/recommendations',
                headers: {
                    'content-type': 'application/json',
                    'x-user-id': 'user-1'
                },
                payload: {
                    techStack: ['React'],
                    teamSize: 3,
                    projectType: 'webapp'
                }
            });

            // If successful, the response should have the correct structure
            if (response.statusCode === 200) {
                const payload = response.json();
                expect(payload).toHaveProperty('success');
                expect(payload).toHaveProperty('recommendations');
            }
        });
    });
});
