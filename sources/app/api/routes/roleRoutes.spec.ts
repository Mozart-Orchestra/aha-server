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
        seedLegacyRole(uid: string, key: string, rawJson: string) {
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
        for (const mutation of mutations) {
            const storeKey = testState.kvKey(uid, mutation.key);
            const existing = testState.kvStore.get(storeKey);
            const currentVersion = existing?.version ?? -1;

            if (currentVersion !== mutation.version) {
                return {
                    success: false,
                    errors: [{
                        key: mutation.key,
                        error: 'version-mismatch',
                        version: currentVersion,
                        value: existing?.value ?? null,
                    }],
                };
            }
        }

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

import { roleRoutes } from './roleRoutes';

async function buildApp(defaultUserId = 'user-1') {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as TypedFastify;
    typed.decorate('authenticate', async (request: any) => {
        const headerUserId = request.headers['x-user-id'];
        request.userId = typeof headerUserId === 'string' ? headerUserId : defaultUserId;
    });

    roleRoutes(typed);
    await typed.ready();
    return typed;
}

describe('roleRoutes', () => {
    let app: Awaited<ReturnType<typeof buildApp>>;

    beforeEach(async () => {
        testState.reset();
        app = await buildApp();
    });

    afterEach(async () => {
        await app.close();
    });

    it('creates new roles as public by default and syncs them to the public pool', async () => {
        const createResponse = await app.inject({
            method: 'POST',
            url: '/v1/roles',
            headers: { 'content-type': 'application/json', 'x-user-id': 'owner-1' },
            payload: { title: 'Backend Operator', summary: 'Runs backend operations' },
        });

        expect(createResponse.statusCode).toBe(200);
        const createPayload = createResponse.json();

        expect(createPayload.success).toBe(true);
        expect(createPayload.role.visibility).toBe('public');
        expect(createPayload.role.ownerId).toBe('owner-1');

        const poolResponse = await app.inject({
            method: 'GET',
            url: '/v1/roles/pool?limit=10',
            headers: { 'x-user-id': 'owner-1' },
        });

        expect(poolResponse.statusCode).toBe(200);
        const poolPayload = poolResponse.json();
        expect(poolPayload.total).toBe(1);
        expect(poolPayload.roles[0].id).toBe(createPayload.role.id);
        expect(poolPayload.roles[0].visibility).toBe('public');
        expect(poolPayload.roles[0].ownerId).toBe('owner-1');
    });

    it('removes roles from the public pool when visibility becomes private', async () => {
        const createResponse = await app.inject({
            method: 'POST',
            url: '/v1/roles',
            headers: { 'content-type': 'application/json', 'x-user-id': 'owner-2' },
            payload: { title: 'Private Candidate' },
        });

        const roleId = createResponse.json().role.id as string;

        const updateResponse = await app.inject({
            method: 'PUT',
            url: `/v1/roles/${roleId}`,
            headers: { 'content-type': 'application/json', 'x-user-id': 'owner-2' },
            payload: { visibility: 'private' },
        });

        expect(updateResponse.statusCode).toBe(200);

        const poolResponse = await app.inject({
            method: 'GET',
            url: '/v1/roles/pool?limit=10',
            headers: { 'x-user-id': 'owner-2' },
        });

        expect(poolResponse.statusCode).toBe(200);
        const poolPayload = poolResponse.json();
        const roleIds = poolPayload.roles.map((role: { id: string }) => role.id);
        expect(roleIds).not.toContain(roleId);
    });

    it('sorts public role pool by average rating first and review count second', async () => {
        const makeRole = async (title: string) => {
            const response = await app.inject({
                method: 'POST',
                url: '/v1/roles',
                headers: { 'content-type': 'application/json', 'x-user-id': 'owner-3' },
                payload: { title },
            });
            return response.json().role.id as string;
        };

        const topRatedId = await makeRole('Top Rated');
        const tieHigherCountId = await makeRole('Tie Higher Count');
        const tieLowerCountId = await makeRole('Tie Lower Count');

        await app.inject({
            method: 'POST',
            url: `/v1/roles/${topRatedId}/reviews`,
            headers: { 'content-type': 'application/json', 'x-user-id': 'owner-3' },
            payload: { rating: 5, source: 'user' },
        });

        await app.inject({
            method: 'POST',
            url: `/v1/roles/${tieHigherCountId}/reviews`,
            headers: { 'content-type': 'application/json', 'x-user-id': 'owner-3' },
            payload: { rating: 4, source: 'user' },
        });
        await app.inject({
            method: 'POST',
            url: `/v1/roles/${tieHigherCountId}/reviews`,
            headers: { 'content-type': 'application/json', 'x-user-id': 'owner-3' },
            payload: { rating: 4, source: 'user' },
        });

        await app.inject({
            method: 'POST',
            url: `/v1/roles/${tieLowerCountId}/reviews`,
            headers: { 'content-type': 'application/json', 'x-user-id': 'owner-3' },
            payload: { rating: 4, source: 'user' },
        });

        const poolResponse = await app.inject({
            method: 'GET',
            url: '/v1/roles/pool?limit=10',
            headers: { 'x-user-id': 'owner-3' },
        });

        expect(poolResponse.statusCode).toBe(200);
        const roleIds = poolResponse.json().roles.map((role: { id: string }) => role.id);

        expect(roleIds.indexOf(topRatedId)).toBeLessThan(roleIds.indexOf(tieHigherCountId));
        expect(roleIds.indexOf(tieHigherCountId)).toBeLessThan(roleIds.indexOf(tieLowerCountId));
    });

    it('accumulates role ratings, code/quality totals, and source totals on review', async () => {
        const createResponse = await app.inject({
            method: 'POST',
            url: '/v1/roles',
            headers: { 'content-type': 'application/json', 'x-user-id': 'owner-4' },
            payload: { title: 'Quality Role' },
        });

        const roleId = createResponse.json().role.id as string;

        const reviewResponse = await app.inject({
            method: 'POST',
            url: `/v1/roles/${roleId}/reviews`,
            headers: { 'content-type': 'application/json', 'x-user-id': 'owner-4' },
            payload: {
                rating: 4,
                codeScore: 90,
                qualityScore: 80,
                source: 'master',
            },
        });

        expect(reviewResponse.statusCode).toBe(200);
        const reviewPayload = reviewResponse.json();

        expect(reviewPayload.stats.reviewCount).toBe(1);
        expect(reviewPayload.stats.averageRating).toBe(4);
        expect(reviewPayload.stats.cumulativeCode).toBe(90);
        expect(reviewPayload.stats.cumulativeQuality).toBe(80);
        expect(reviewPayload.stats.sourceScoreTotals.master).toBe(80);

        const roleResponse = await app.inject({
            method: 'GET',
            url: `/v1/roles/${roleId}`,
            headers: { 'x-user-id': 'owner-4' },
        });

        expect(roleResponse.statusCode).toBe(200);
        const rolePayload = roleResponse.json();
        expect(rolePayload.stats.reviewCount).toBe(1);
        expect(rolePayload.stats.sourceScoreTotals.master).toBe(80);

        const reviewsResponse = await app.inject({
            method: 'GET',
            url: `/v1/roles/${roleId}/reviews?limit=10`,
            headers: { 'x-user-id': 'owner-4' },
        });

        expect(reviewsResponse.statusCode).toBe(200);
        const reviewsPayload = reviewsResponse.json();
        expect(reviewsPayload.total).toBe(1);
        expect(reviewsPayload.reviews[0].source).toBe('master');
    });

    it('accumulates team reviews into the team scorecard', async () => {
        const teamId = 'team-abc';

        const review1 = await app.inject({
            method: 'POST',
            url: `/v1/teams/${teamId}/reviews`,
            headers: { 'content-type': 'application/json', 'x-user-id': 'reviewer-1' },
            payload: {
                rating: 3,
                codeScore: 40,
                qualityScore: 50,
                sourceScores: { user: 5, master: 10, system: 15 },
                source: 'system',
            },
        });

        expect(review1.statusCode).toBe(200);

        const review2 = await app.inject({
            method: 'POST',
            url: `/v1/teams/${teamId}/reviews`,
            headers: { 'content-type': 'application/json', 'x-user-id': 'reviewer-2' },
            payload: {
                rating: 5,
                codeScore: 20,
                qualityScore: 30,
                source: 'user',
            },
        });

        expect(review2.statusCode).toBe(200);

        const scoreResponse = await app.inject({
            method: 'GET',
            url: `/v1/teams/${teamId}/score`,
            headers: { 'x-user-id': 'reviewer-2' },
        });

        expect(scoreResponse.statusCode).toBe(200);
        const scorePayload = scoreResponse.json();

        expect(scorePayload.reviewCount).toBe(2);
        expect(scorePayload.totalRating).toBe(8);
        expect(scorePayload.averageRating).toBe(4);
        expect(scorePayload.cumulativeCode).toBe(60);
        expect(scorePayload.cumulativeQuality).toBe(80);
        expect(scorePayload.sourceScoreTotals).toEqual({ user: 105, master: 10, system: 15 });

        const teamReviewsResponse = await app.inject({
            method: 'GET',
            url: `/v1/teams/${teamId}/reviews?limit=10`,
            headers: { 'x-user-id': 'reviewer-2' },
        });

        expect(teamReviewsResponse.statusCode).toBe(200);
        expect(teamReviewsResponse.json().total).toBe(2);
    });

    it('serves 22 default role templates with responsibilities via templates alias', async () => {
        const response = await app.inject({
            method: 'GET',
            url: '/v1/roles/templates/list',
            headers: { 'x-user-id': 'template-user' },
        });

        expect(response.statusCode).toBe(200);
        const payload = response.json() as { templates: Array<{ id: string; responsibilities: string[] }> };

        expect(payload.templates).toHaveLength(22);
        expect(payload.templates.every((template) => Array.isArray(template.responsibilities))).toBe(true);
        expect(payload.templates.some((template) => template.id === 'implementer')).toBe(true);
    });

    it('supports /v1/roles/public alias and isPublic compatibility field', async () => {
        const created = await app.inject({
            method: 'POST',
            url: '/v1/roles',
            headers: { 'content-type': 'application/json', 'x-user-id': 'public-alias-owner' },
            payload: {
                title: 'Public Alias Role',
                summary: 'Should appear in /v1/roles/public',
                isPublic: true,
            },
        });

        expect(created.statusCode).toBe(200);
        expect(created.json().role.isPublic).toBe(true);
        expect(created.json().role.visibility).toBe('public');

        const listPublic = await app.inject({
            method: 'GET',
            url: '/v1/roles/public?limit=20',
            headers: { 'x-user-id': 'public-alias-owner' },
        });

        expect(listPublic.statusCode).toBe(200);
        expect(listPublic.json().roles.some((role: { title: string }) => role.title === 'Public Alias Role')).toBe(true);
    });

    it('creates and queries rating records through /v1/ratings endpoints', async () => {
        const teamId = 'team-rating';

        const create1 = await app.inject({
            method: 'POST',
            url: '/v1/ratings',
            headers: { 'content-type': 'application/json', 'x-user-id': 'rater-1' },
            payload: {
                teamId,
                roleId: 'implementer',
                taskId: 'task-1',
                userRating: 4,
                systemRating: 5,
                codeLines: 120,
                commits: 3,
                bugsCount: 1,
                qualityScore: 88,
                source: 'system',
            },
        });

        expect(create1.statusCode).toBe(200);
        expect(create1.json().rating.rating).toBe(4.5);

        const create2 = await app.inject({
            method: 'POST',
            url: '/v1/ratings',
            headers: { 'content-type': 'application/json', 'x-user-id': 'rater-2' },
            payload: {
                teamId,
                roleId: 'qa-engineer',
                rating: 3,
                codeLines: 20,
                commits: 2,
                bugsCount: 0,
                qualityScore: 76,
                source: 'user',
            },
        });

        expect(create2.statusCode).toBe(200);

        const listTeam = await app.inject({
            method: 'GET',
            url: `/v1/ratings/${teamId}`,
            headers: { 'x-user-id': 'rater-1' },
        });
        expect(listTeam.statusCode).toBe(200);
        expect(listTeam.json().total).toBe(2);

        const listRole = await app.inject({
            method: 'GET',
            url: `/v1/ratings/${teamId}/role/implementer`,
            headers: { 'x-user-id': 'rater-1' },
        });
        expect(listRole.statusCode).toBe(200);
        expect(listRole.json().total).toBe(1);
        expect(listRole.json().ratings[0].roleId).toBe('implementer');

        const analytics = await app.inject({
            method: 'GET',
            url: `/v1/ratings/${teamId}/analytics`,
            headers: { 'x-user-id': 'rater-1' },
        });

        expect(analytics.statusCode).toBe(200);
        const analyticsPayload = analytics.json();
        expect(analyticsPayload.totalRatings).toBe(2);
        expect(analyticsPayload.totalCodeLines).toBe(140);
        expect(analyticsPayload.totalCommits).toBe(5);
        expect(analyticsPayload.totalBugs).toBe(1);
        expect(analyticsPayload.roleBreakdown).toHaveLength(2);
    });

    it('calculates system rating and can persist it to role pool stats', async () => {
        const createRole = await app.inject({
            method: 'POST',
            url: '/v1/roles',
            headers: { 'content-type': 'application/json', 'x-user-id': 'system-rater' },
            payload: {
                id: 'custom-system-role',
                title: 'System Rated Role',
                summary: 'Role for system rating test',
            },
        });
        expect(createRole.statusCode).toBe(200);

        const calc = await app.inject({
            method: 'POST',
            url: '/v1/ratings/system/calculate',
            headers: { 'content-type': 'application/json', 'x-user-id': 'system-rater' },
            payload: {
                roleId: 'custom-system-role',
                codeLines: 300,
                commits: 4,
                bugsCount: 1,
                filesChanged: 5,
                reviewComments: 2,
                persist: true,
            },
        });

        expect(calc.statusCode).toBe(200);
        expect(calc.json().success).toBe(true);
        expect(calc.json().result.rating).toBeGreaterThanOrEqual(1);
        expect(calc.json().result.rating).toBeLessThanOrEqual(5);
        expect(calc.json().persisted).toBe(true);

        const scoreSnapshot = await app.inject({
            method: 'GET',
            url: '/v1/ratings/system/role/custom-system-role',
            headers: { 'x-user-id': 'system-rater' },
        });

        expect(scoreSnapshot.statusCode).toBe(200);
        expect(scoreSnapshot.json().success).toBe(true);
        expect(scoreSnapshot.json().result).toBeTruthy();
    });

    it('reads legacy plain JSON role values while supporting encoded values', async () => {
        const userId = 'legacy-user';
        const legacyRole = {
            id: 'legacy-role',
            title: 'Legacy Role',
            summary: 'Stored before base64 encoding rollout',
            visibility: 'public',
        };

        testState.seedLegacyRole(userId, 'roles.legacy-role', JSON.stringify(legacyRole));

        const listResponse = await app.inject({
            method: 'GET',
            url: '/v1/roles?limit=20',
            headers: { 'x-user-id': userId },
        });

        expect(listResponse.statusCode).toBe(200);
        const listPayload = listResponse.json();
        const parsedRole = listPayload.roles.find((role: { id: string }) => role.id === 'legacy-role');

        expect(parsedRole).toBeDefined();
        expect(parsedRole.title).toBe('Legacy Role');
        expect(parsedRole.stats.reviewCount).toBe(0);
    });
});
