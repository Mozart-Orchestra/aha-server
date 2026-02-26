import { z } from "zod";
import { Fastify } from "../types";
import { kvGet } from "@/app/kv/kvGet";
import { kvList } from "@/app/kv/kvList";
import { kvMutate } from "@/app/kv/kvMutate";
import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { randomUUID } from "node:crypto";
import * as privacyKit from "privacy-kit";

/**
 * Custom Role Routes - User-defined Role Management API
 *
 * This route now supports:
 * - Server-provided default role templates
 * - Public role pool (new custom roles are public by default)
 * - Role and team public reviews ("大众点评")
 * - Persistent cumulative scorecards (rating/code/quality/user/master/system)
 */

const RoleVisibilitySchema = z.enum(["public", "private"]);
const ReviewSourceSchema = z.enum(["user", "master", "system"]);

const SourceScoreInputSchema = z.object({
    user: z.number().min(0).max(100).optional(),
    master: z.number().min(0).max(100).optional(),
    system: z.number().min(0).max(100).optional(),
});

const SourceScoreTotalsSchema = z.object({
    user: z.number().nonnegative(),
    master: z.number().nonnegative(),
    system: z.number().nonnegative(),
});

const ModelConfigSchema = z.object({
    model: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().min(1).max(1000000).optional(),
});

const ToolPermissionsSchema = z.object({
    allowRead: z.boolean().optional().default(true),
    allowWrite: z.boolean().optional().default(true),
    allowEdit: z.boolean().optional().default(true),
    allowBash: z.boolean().optional().default(false),
    allowedTools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
});

const RolePolicySchema = z.object({
    permissionMode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan"]).optional(),
    accessLevel: z.enum(["read-only", "full-access"]).optional(),
    disallowedTools: z.array(z.string()).optional(),
    coordinationMode: z.enum(["strong", "weak"]).optional(),
});

const RoleStatsSchema = z.object({
    reviewCount: z.number().int().nonnegative().default(0),
    completionCount: z.number().int().nonnegative().default(0),
    totalRating: z.number().nonnegative().default(0),
    averageRating: z.number().min(0).max(5).default(0),
    cumulativeCode: z.number().nonnegative().default(0),
    cumulativeQuality: z.number().nonnegative().default(0),
    sourceScoreTotals: SourceScoreTotalsSchema.default({ user: 0, master: 0, system: 0 }),
    lastReviewedAt: z.number().optional(),
});

const CustomRoleSchema = z.object({
    id: z.string().optional(),
    title: z.string().min(1).max(100),
    // Role summary can include long guidance blocks (prompt/MCP notes),
    // so keep this comfortably above short-description limits.
    summary: z.string().max(5000).optional(),
    icon: z.string().max(10).optional(),

    modelConfig: ModelConfigSchema.optional(),
    toolPermissions: ToolPermissionsSchema.optional(),
    assignedSkills: z.array(z.string()).optional(),
    policy: RolePolicySchema.optional(),

    responsibilities: z.array(z.string()).optional(),
    abilityBoundaries: z.array(z.string()).optional(),
    handoffProtocol: z.array(z.string()).optional(),
    protocol: z.array(z.string()).optional(),

    isTemplate: z.boolean().optional().default(false),
    templateSource: z.string().optional(),

    visibility: RoleVisibilitySchema.optional().default("public"),
    ownerId: z.string().optional(),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
    publishedAt: z.number().optional(),
    stats: RoleStatsSchema.optional(),
});

const PublicRoleSchema = CustomRoleSchema.extend({
    id: z.string(),
    ownerId: z.string(),
    visibility: z.literal("public"),
    stats: RoleStatsSchema,
    publishedAt: z.number(),
});

const RoleExportSchema = z.object({
    version: z.literal("1.0"),
    exportedAt: z.number(),
    role: CustomRoleSchema,
});

const RoleReviewInputSchema = z.object({
    rating: z.number().min(1).max(5),
    codeScore: z.number().min(0).max(100).optional().default(0),
    qualityScore: z.number().min(0).max(100).optional().default(0),
    source: ReviewSourceSchema.optional().default("user"),
    sourceScores: SourceScoreInputSchema.optional(),
    teamId: z.string().optional(),
    comment: z.string().max(1000).optional(),
});

const RoleReviewSchema = RoleReviewInputSchema.extend({
    id: z.string(),
    roleId: z.string(),
    reviewerId: z.string(),
    createdAt: z.number(),
});

const TeamReviewInputSchema = z.object({
    rating: z.number().min(1).max(5),
    codeScore: z.number().min(0).max(100).optional().default(0),
    qualityScore: z.number().min(0).max(100).optional().default(0),
    source: ReviewSourceSchema.optional().default("user"),
    sourceScores: SourceScoreInputSchema.optional(),
    roleIds: z.array(z.string()).optional(),
    comment: z.string().max(1000).optional(),
});

const TeamReviewSchema = TeamReviewInputSchema.extend({
    id: z.string(),
    teamId: z.string(),
    reviewerId: z.string(),
    createdAt: z.number(),
});

const TeamScorecardSchema = z.object({
    teamId: z.string(),
    reviewCount: z.number().int().nonnegative(),
    totalRating: z.number().nonnegative(),
    averageRating: z.number().min(0).max(5),
    cumulativeCode: z.number().nonnegative(),
    cumulativeQuality: z.number().nonnegative(),
    sourceScoreTotals: SourceScoreTotalsSchema,
    lastReviewedAt: z.number().optional(),
});

const RoleTemplateSchema = z.object({
    id: z.string(),
    title: z.string(),
    summary: z.string(),
    icon: z.string().optional(),
    category: z.string().optional(),
});

const DEFAULT_ROLE_TEMPLATES: z.infer<typeof RoleTemplateSchema>[] = [
    { id: "master", title: "Master", summary: "Team coordinator and task distributor", icon: "🎯", category: "management" },
    { id: "orchestrator", title: "Orchestrator", summary: "Plans, delegates, and coordinates team workflows", icon: "🧭", category: "management" },
    { id: "architect", title: "Architect", summary: "System design and architecture decisions", icon: "🏗️", category: "engineering" },
    { id: "implementer", title: "Implementer", summary: "Code implementation and execution", icon: "⚙️", category: "engineering" },
    { id: "reviewer", title: "Reviewer", summary: "Code review and quality assurance", icon: "🔍", category: "quality" },
    { id: "qa", title: "QA", summary: "Testing and quality validation", icon: "✅", category: "quality" },
    { id: "observer", title: "Observer", summary: "Progress monitoring and reporting", icon: "👁️", category: "support" },
    { id: "user", title: "User", summary: "Human team member with full context", icon: "👤", category: "human" },
];

const ROLES_PREFIX = "roles.";
const ROLE_POOL_PREFIX = "role_pool.";
const ROLE_REVIEW_PREFIX = "role_review.";
const TEAM_REVIEW_PREFIX = "team_review.";
const TEAM_SCORE_PREFIX = "team_score.";

type CustomRole = z.infer<typeof CustomRoleSchema>;
type PublicRole = z.infer<typeof PublicRoleSchema>;
type RoleStats = z.infer<typeof RoleStatsSchema>;
type RoleReviewInput = z.infer<typeof RoleReviewInputSchema>;
type RoleReview = z.infer<typeof RoleReviewSchema>;
type TeamReviewInput = z.infer<typeof TeamReviewInputSchema>;
type TeamReview = z.infer<typeof TeamReviewSchema>;
type TeamScorecard = z.infer<typeof TeamScorecardSchema>;
type SourceScoreTotals = z.infer<typeof SourceScoreTotalsSchema>;
type SourceScoreInput = z.infer<typeof SourceScoreInputSchema>;

function generateRoleId(): string {
    return `custom-${randomUUID().slice(0, 8)}`;
}

function generateReviewId(prefix: string): string {
    return `${prefix}-${randomUUID().slice(0, 10)}`;
}

function encodeKVJson(value: unknown): string {
    const json = JSON.stringify(value);
    return privacyKit.encodeBase64(new TextEncoder().encode(json));
}

function decodeKVJson<T>(value: string): T | null {
    const candidates: string[] = [];

    try {
        const decoded = privacyKit.decodeBase64(value);
        candidates.push(new TextDecoder().decode(decoded));
    } catch {
        // ignore and try raw fallback
    }

    candidates.push(value);

    for (const candidate of candidates) {
        try {
            return JSON.parse(candidate) as T;
        } catch {
            // try next candidate
        }
    }

    return null;
}

function parseJson<T>(value: string): T | null {
    try {
        return JSON.parse(value) as T;
    } catch {
        return null;
    }
}

function emptySourceScoreTotals(): SourceScoreTotals {
    return { user: 0, master: 0, system: 0 };
}

function normalizeSourceTotals(input?: Partial<SourceScoreTotals>): SourceScoreTotals {
    return {
        user: input?.user ?? 0,
        master: input?.master ?? 0,
        system: input?.system ?? 0,
    };
}

function emptyRoleStats(): RoleStats {
    return {
        reviewCount: 0,
        completionCount: 0,
        totalRating: 0,
        averageRating: 0,
        cumulativeCode: 0,
        cumulativeQuality: 0,
        sourceScoreTotals: emptySourceScoreTotals(),
    };
}

function normalizeRoleStats(input?: Partial<RoleStats>): RoleStats {
    const base = emptyRoleStats();
    const merged: RoleStats = {
        reviewCount: input?.reviewCount ?? base.reviewCount,
        completionCount: input?.completionCount ?? base.completionCount,
        totalRating: input?.totalRating ?? base.totalRating,
        averageRating: input?.averageRating ?? base.averageRating,
        cumulativeCode: input?.cumulativeCode ?? base.cumulativeCode,
        cumulativeQuality: input?.cumulativeQuality ?? base.cumulativeQuality,
        sourceScoreTotals: normalizeSourceTotals(input?.sourceScoreTotals),
        lastReviewedAt: input?.lastReviewedAt,
    };

    // Keep average consistent if historical records only stored total/reviewCount.
    if (merged.reviewCount > 0 && merged.averageRating === 0 && merged.totalRating > 0) {
        merged.averageRating = Number((merged.totalRating / merged.reviewCount).toFixed(3));
    }

    return merged;
}

function normalizeRole(role: Partial<CustomRole>, roleId: string, ownerId: string): CustomRole {
    const now = Date.now();

    return {
        id: roleId,
        title: role.title || "Untitled Role",
        summary: role.summary || `Custom role: ${role.title || roleId}`,
        icon: role.icon,
        modelConfig: role.modelConfig,
        toolPermissions: role.toolPermissions,
        assignedSkills: role.assignedSkills || [],
        policy: role.policy,
        responsibilities: role.responsibilities || [],
        abilityBoundaries: role.abilityBoundaries || [],
        handoffProtocol: role.handoffProtocol || [],
        protocol: role.protocol || [],
        isTemplate: role.isTemplate ?? false,
        templateSource: role.templateSource,
        visibility: role.visibility ?? "public",
        ownerId,
        createdAt: role.createdAt ?? now,
        updatedAt: role.updatedAt ?? now,
        publishedAt: role.publishedAt,
        stats: normalizeRoleStats(role.stats),
    };
}

function parseRole(value: string): CustomRole | null {
    const parsed = decodeKVJson<unknown>(value);
    if (!parsed) {
        return null;
    }

    const candidate = CustomRoleSchema.safeParse(parsed);
    if (!candidate.success) {
        return null;
    }

    const role = candidate.data;
    if (!role.id) {
        return null;
    }

    return normalizeRole(role, role.id, role.ownerId || "");
}

function serializeRole(role: CustomRole): string {
    return encodeKVJson(role);
}

function parsePublicRole(value: string): PublicRole | null {
    const parsed = parseJson<unknown>(value);
    if (!parsed) {
        return null;
    }

    const candidate = PublicRoleSchema.safeParse(parsed);
    if (!candidate.success) {
        return null;
    }

    return {
        ...candidate.data,
        stats: normalizeRoleStats(candidate.data.stats),
    };
}

function parseRoleReview(value: string): RoleReview | null {
    const parsed = parseJson<unknown>(value);
    if (!parsed) {
        return null;
    }

    const candidate = RoleReviewSchema.safeParse(parsed);
    return candidate.success ? candidate.data : null;
}

function parseTeamReview(value: string): TeamReview | null {
    const parsed = parseJson<unknown>(value);
    if (!parsed) {
        return null;
    }

    const candidate = TeamReviewSchema.safeParse(parsed);
    return candidate.success ? candidate.data : null;
}

function parseTeamScorecard(value: string): TeamScorecard | null {
    const parsed = parseJson<unknown>(value);
    if (!parsed) {
        return null;
    }

    const candidate = TeamScorecardSchema.safeParse(parsed);
    return candidate.success ? candidate.data : null;
}

function toSourceScoreDelta(source: z.infer<typeof ReviewSourceSchema>, rating: number, scores?: SourceScoreInput): SourceScoreTotals {
    const hasExplicitScores = Boolean(
        scores && (scores.user !== undefined || scores.master !== undefined || scores.system !== undefined)
    );

    if (hasExplicitScores) {
        return {
            user: scores?.user ?? 0,
            master: scores?.master ?? 0,
            system: scores?.system ?? 0,
        };
    }

    const fallback = emptySourceScoreTotals();
    fallback[source] = rating * 20;
    return fallback;
}

function applyRoleReview(stats: RoleStats, review: RoleReviewInput): RoleStats {
    const nextReviewCount = stats.reviewCount + 1;
    const nextTotalRating = stats.totalRating + review.rating;
    const sourceDelta = toSourceScoreDelta(review.source || "user", review.rating, review.sourceScores);

    return {
        reviewCount: nextReviewCount,
        completionCount: stats.completionCount + 1,
        totalRating: nextTotalRating,
        averageRating: Number((nextTotalRating / nextReviewCount).toFixed(3)),
        cumulativeCode: stats.cumulativeCode + (review.codeScore ?? 0),
        cumulativeQuality: stats.cumulativeQuality + (review.qualityScore ?? 0),
        sourceScoreTotals: {
            user: stats.sourceScoreTotals.user + sourceDelta.user,
            master: stats.sourceScoreTotals.master + sourceDelta.master,
            system: stats.sourceScoreTotals.system + sourceDelta.system,
        },
        lastReviewedAt: Date.now(),
    };
}

function emptyTeamScorecard(teamId: string): TeamScorecard {
    return {
        teamId,
        reviewCount: 0,
        totalRating: 0,
        averageRating: 0,
        cumulativeCode: 0,
        cumulativeQuality: 0,
        sourceScoreTotals: emptySourceScoreTotals(),
    };
}

function applyTeamReview(scorecard: TeamScorecard, review: TeamReviewInput): TeamScorecard {
    const nextReviewCount = scorecard.reviewCount + 1;
    const nextTotalRating = scorecard.totalRating + review.rating;
    const sourceDelta = toSourceScoreDelta(review.source || "user", review.rating, review.sourceScores);

    return {
        teamId: scorecard.teamId,
        reviewCount: nextReviewCount,
        totalRating: nextTotalRating,
        averageRating: Number((nextTotalRating / nextReviewCount).toFixed(3)),
        cumulativeCode: scorecard.cumulativeCode + (review.codeScore ?? 0),
        cumulativeQuality: scorecard.cumulativeQuality + (review.qualityScore ?? 0),
        sourceScoreTotals: {
            user: scorecard.sourceScoreTotals.user + sourceDelta.user,
            master: scorecard.sourceScoreTotals.master + sourceDelta.master,
            system: scorecard.sourceScoreTotals.system + sourceDelta.system,
        },
        lastReviewedAt: Date.now(),
    };
}

async function loadUserRole(userId: string, roleId: string): Promise<{ role: CustomRole; version: number } | null> {
    const result = await kvGet({ uid: userId }, `${ROLES_PREFIX}${roleId}`);
    if (!result) {
        return null;
    }

    const role = parseRole(result.value);
    if (!role || !role.id) {
        return null;
    }

    return {
        role: normalizeRole(role, role.id, role.ownerId || userId),
        version: result.version,
    };
}

async function loadPublicRole(roleId: string): Promise<PublicRole | null> {
    const cache = await db.simpleCache.findUnique({
        where: { key: `${ROLE_POOL_PREFIX}${roleId}` }
    });

    if (!cache) {
        return null;
    }

    return parsePublicRole(cache.value);
}

async function syncRoleToPublicPool(role: CustomRole, ownerId: string): Promise<void> {
    if (!role.id) {
        return;
    }

    const poolKey = `${ROLE_POOL_PREFIX}${role.id}`;

    if (role.visibility === "private") {
        await db.simpleCache.deleteMany({ where: { key: poolKey } });
        return;
    }

    const existing = await loadPublicRole(role.id);
    const normalizedStats = normalizeRoleStats(existing?.stats || role.stats);

    const publishedRole: PublicRole = {
        ...role,
        id: role.id,
        ownerId,
        visibility: "public",
        stats: normalizedStats,
        publishedAt: existing?.publishedAt || role.publishedAt || Date.now(),
        updatedAt: Date.now(),
    };

    await db.simpleCache.upsert({
        where: { key: poolKey },
        update: {
            value: JSON.stringify(publishedRole)
        },
        create: {
            key: poolKey,
            value: JSON.stringify(publishedRole)
        }
    });
}

async function mergeWithPublicStats(role: CustomRole): Promise<CustomRole> {
    if (!role.id || role.visibility !== "public") {
        return role;
    }

    const publicRole = await loadPublicRole(role.id);
    if (!publicRole) {
        return role;
    }

    return {
        ...role,
        stats: normalizeRoleStats(publicRole.stats),
        publishedAt: publicRole.publishedAt,
        updatedAt: Math.max(role.updatedAt || 0, publicRole.updatedAt || 0),
    };
}

export function roleRoutes(app: Fastify) {
    log({ module: "api" }, "Registering roleRoutes...");

    // GET /v1/roles/defaults - Server-provided default role templates
    app.get("/v1/roles/defaults", {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    roles: z.array(RoleTemplateSchema)
                })
            }
        }
    }, async (request, reply) => {
        return reply.send({ roles: DEFAULT_ROLE_TEMPLATES });
    });

    // GET /v1/roles/pool - Public role pool ("角色池")
    app.get("/v1/roles/pool", {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(200).default(100),
                search: z.string().optional(),
            }),
            response: {
                200: z.object({
                    roles: z.array(PublicRoleSchema),
                    total: z.number(),
                }),
                500: z.object({
                    error: z.literal("Failed to list public roles")
                })
            }
        }
    }, async (request, reply) => {
        const { limit, search } = request.query as { limit: number; search?: string };

        try {
            const caches = await db.simpleCache.findMany({
                where: {
                    key: { startsWith: ROLE_POOL_PREFIX }
                },
                orderBy: {
                    updatedAt: "desc"
                },
                take: 1000
            });

            const normalizedSearch = search?.toLowerCase().trim();
            const parsedRoles = caches
                .map((entry) => parsePublicRole(entry.value))
                .filter((role): role is PublicRole => Boolean(role))
                .filter((role) => {
                    if (!normalizedSearch) return true;
                    const haystack = `${role.title} ${role.summary || ""} ${role.id}`.toLowerCase();
                    return haystack.includes(normalizedSearch);
                })
                .sort((a, b) => {
                    const ratingDiff = b.stats.averageRating - a.stats.averageRating;
                    if (ratingDiff !== 0) return ratingDiff;
                    const reviewDiff = b.stats.reviewCount - a.stats.reviewCount;
                    if (reviewDiff !== 0) return reviewDiff;
                    return (b.updatedAt || 0) - (a.updatedAt || 0);
                });

            return reply.send({
                roles: parsedRoles.slice(0, limit),
                total: parsedRoles.length,
            });
        } catch (error) {
            log({ module: "role-routes", level: "error" }, `Failed to list public roles: ${error}`);
            return reply.code(500).send({ error: "Failed to list public roles" });
        }
    });

    // GET /v1/roles/library - Defaults + my roles + public pool
    app.get("/v1/roles/library", {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                includePrivate: z.coerce.boolean().optional().default(false),
                limit: z.coerce.number().int().min(1).max(200).default(100)
            }),
            response: {
                200: z.object({
                    defaults: z.array(RoleTemplateSchema),
                    custom: z.array(CustomRoleSchema),
                    pool: z.array(PublicRoleSchema),
                }),
                500: z.object({
                    error: z.literal("Failed to load role library")
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { includePrivate, limit } = request.query as { includePrivate: boolean; limit: number };

        try {
            const [mine, poolCache] = await Promise.all([
                kvList({ uid: userId }, { prefix: ROLES_PREFIX, limit: 1000 }),
                db.simpleCache.findMany({
                    where: { key: { startsWith: ROLE_POOL_PREFIX } },
                    orderBy: { updatedAt: "desc" },
                    take: 1000,
                })
            ]);

            const customRoles: CustomRole[] = [];
            for (const item of mine.items) {
                const role = parseRole(item.value);
                if (!role || !role.id) {
                    continue;
                }

                const hydrated = await mergeWithPublicStats(normalizeRole(role, role.id, role.ownerId || userId));
                if (!includePrivate && hydrated.visibility === "private") {
                    continue;
                }
                customRoles.push(hydrated);
            }

            const pool = poolCache
                .map((entry) => parsePublicRole(entry.value))
                .filter((role): role is PublicRole => Boolean(role))
                .slice(0, limit);

            return reply.send({
                defaults: DEFAULT_ROLE_TEMPLATES,
                custom: customRoles.slice(0, limit),
                pool,
            });
        } catch (error) {
            log({ module: "role-routes", level: "error" }, `Failed to load role library: ${error}`);
            return reply.code(500).send({ error: "Failed to load role library" });
        }
    });

    // GET /v1/roles - List user's custom roles
    app.get("/v1/roles", {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                includeTemplates: z.coerce.boolean().optional().default(false),
                includePrivate: z.coerce.boolean().optional().default(true),
                limit: z.coerce.number().int().min(1).max(200).default(50)
            }),
            response: {
                200: z.object({
                    roles: z.array(CustomRoleSchema),
                    total: z.number()
                }),
                500: z.object({
                    error: z.literal("Failed to list roles")
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { includeTemplates, includePrivate, limit } = request.query as {
            includeTemplates: boolean;
            includePrivate: boolean;
            limit: number;
        };

        try {
            const result = await kvList({ uid: userId }, { prefix: ROLES_PREFIX, limit: 1000 });
            const roles: CustomRole[] = [];

            for (const item of result.items) {
                const parsed = parseRole(item.value);
                if (!parsed || !parsed.id) {
                    continue;
                }

                const role = await mergeWithPublicStats(normalizeRole(parsed, parsed.id, parsed.ownerId || userId));

                if (!includeTemplates && role.isTemplate) {
                    continue;
                }
                if (!includePrivate && role.visibility === "private") {
                    continue;
                }

                roles.push(role);
            }

            return reply.send({
                roles: roles.slice(0, limit),
                total: roles.length,
            });
        } catch (error) {
            log({ module: "role-routes", level: "error" }, `Failed to list roles: ${error}`);
            return reply.code(500).send({ error: "Failed to list roles" });
        }
    });

    // GET /v1/roles/:id - Get single role
    app.get("/v1/roles/:id", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            response: {
                200: CustomRoleSchema,
                404: z.object({
                    error: z.literal("Role not found")
                }),
                500: z.object({
                    error: z.literal("Failed to get role")
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params as { id: string };

        try {
            const own = await loadUserRole(userId, id);
            if (own) {
                const hydrated = await mergeWithPublicStats(own.role);
                return reply.send(hydrated);
            }

            const publicRole = await loadPublicRole(id);
            if (publicRole) {
                return reply.send(publicRole);
            }

            return reply.code(404).send({ error: "Role not found" });
        } catch (error) {
            log({ module: "role-routes", level: "error" }, `Failed to get role: ${error}`);
            return reply.code(500).send({ error: "Failed to get role" });
        }
    });

    // POST /v1/roles - Create custom role (default public + sync to role pool)
    app.post("/v1/roles", {
        preHandler: app.authenticate,
        schema: {
            body: CustomRoleSchema,
            response: {
                200: z.object({
                    success: z.literal(true),
                    role: CustomRoleSchema
                }),
                400: z.object({
                    error: z.string()
                }),
                409: z.object({
                    error: z.literal("Role with this ID already exists")
                }),
                500: z.object({
                    error: z.literal("Failed to create role")
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const roleData = request.body as CustomRole;

        try {
            const roleId = roleData.id || generateRoleId();
            const existing = await kvGet({ uid: userId }, `${ROLES_PREFIX}${roleId}`);
            if (existing) {
                return reply.code(409).send({ error: "Role with this ID already exists" });
            }

            const role = normalizeRole({
                ...roleData,
                id: roleId,
                visibility: roleData.visibility ?? "public",
            }, roleId, userId);

            await kvMutate({ uid: userId }, [{
                key: `${ROLES_PREFIX}${roleId}`,
                value: serializeRole(role),
                version: -1
            }]);

            // New role auto-syncs to public pool by default.
            await syncRoleToPublicPool(role, userId);

            log({ module: "role-routes", roleId }, "Custom role created");
            return reply.send({ success: true, role });
        } catch (error) {
            log({ module: "role-routes", level: "error" }, `Failed to create role: ${error}`);
            return reply.code(500).send({ error: "Failed to create role" });
        }
    });

    // PUT /v1/roles/:id - Update custom role
    app.put("/v1/roles/:id", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            body: CustomRoleSchema.partial(),
            response: {
                200: z.object({
                    success: z.literal(true),
                    role: CustomRoleSchema
                }),
                404: z.object({
                    error: z.literal("Role not found")
                }),
                409: z.object({
                    error: z.literal("Version mismatch")
                }),
                500: z.object({
                    error: z.literal("Failed to update role")
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params as { id: string };
        const updates = request.body as Partial<CustomRole>;

        try {
            const existing = await loadUserRole(userId, id);
            if (!existing) {
                return reply.code(404).send({ error: "Role not found" });
            }

            const existingRole = existing.role;

            const merged: CustomRole = normalizeRole({
                ...existingRole,
                ...updates,
                id,
                ownerId: userId,
                createdAt: existingRole.createdAt,
                updatedAt: Date.now(),
                modelConfig: updates.modelConfig
                    ? { ...existingRole.modelConfig, ...updates.modelConfig }
                    : existingRole.modelConfig,
                toolPermissions: updates.toolPermissions
                    ? { ...existingRole.toolPermissions, ...updates.toolPermissions }
                    : existingRole.toolPermissions,
                policy: updates.policy
                    ? { ...existingRole.policy, ...updates.policy }
                    : existingRole.policy,
                stats: updates.stats
                    ? normalizeRoleStats({ ...existingRole.stats, ...updates.stats })
                    : normalizeRoleStats(existingRole.stats),
            }, id, userId);

            await kvMutate({ uid: userId }, [{
                key: `${ROLES_PREFIX}${id}`,
                value: serializeRole(merged),
                version: existing.version,
            }]);

            await syncRoleToPublicPool(merged, userId);

            log({ module: "role-routes", roleId: id }, "Custom role updated");
            return reply.send({ success: true, role: merged });
        } catch (error: any) {
            if (error.message?.includes("version")) {
                return reply.code(409).send({ error: "Version mismatch" });
            }
            log({ module: "role-routes", level: "error" }, `Failed to update role: ${error}`);
            return reply.code(500).send({ error: "Failed to update role" });
        }
    });

    // DELETE /v1/roles/:id - Delete custom role
    app.delete("/v1/roles/:id", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                404: z.object({
                    error: z.literal("Role not found")
                }),
                500: z.object({
                    error: z.literal("Failed to delete role")
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params as { id: string };

        try {
            const existing = await loadUserRole(userId, id);
            if (!existing) {
                return reply.code(404).send({ error: "Role not found" });
            }

            await kvMutate({ uid: userId }, [{
                key: `${ROLES_PREFIX}${id}`,
                value: null,
                version: existing.version
            }]);

            await db.simpleCache.deleteMany({
                where: {
                    OR: [
                        { key: `${ROLE_POOL_PREFIX}${id}` },
                        { key: { startsWith: `${ROLE_REVIEW_PREFIX}${id}.` } },
                    ]
                }
            });

            log({ module: "role-routes", roleId: id }, "Custom role deleted");
            return reply.send({ success: true });
        } catch (error) {
            log({ module: "role-routes", level: "error" }, `Failed to delete role: ${error}`);
            return reply.code(500).send({ error: "Failed to delete role" });
        }
    });

    // POST /v1/roles/:id/export - Export role template
    app.post("/v1/roles/:id/export", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            response: {
                200: RoleExportSchema,
                404: z.object({
                    error: z.literal("Role not found")
                }),
                500: z.object({
                    error: z.literal("Failed to export role")
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params as { id: string };

        try {
            const existing = await loadUserRole(userId, id);
            if (!existing) {
                return reply.code(404).send({ error: "Role not found" });
            }

            const exportData: z.infer<typeof RoleExportSchema> = {
                version: "1.0",
                exportedAt: Date.now(),
                role: {
                    ...existing.role,
                    id: undefined,
                    ownerId: undefined,
                    templateSource: id,
                }
            };

            log({ module: "role-routes", roleId: id }, "Role exported");
            return reply.send(exportData);
        } catch (error) {
            log({ module: "role-routes", level: "error" }, `Failed to export role: ${error}`);
            return reply.code(500).send({ error: "Failed to export role" });
        }
    });

    // POST /v1/roles/import - Import role template
    app.post("/v1/roles/import", {
        preHandler: app.authenticate,
        schema: {
            body: RoleExportSchema,
            response: {
                200: z.object({
                    success: z.literal(true),
                    role: CustomRoleSchema
                }),
                400: z.object({
                    error: z.string()
                }),
                500: z.object({
                    error: z.literal("Failed to import role")
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const importData = request.body as z.infer<typeof RoleExportSchema>;

        try {
            if (importData.version !== "1.0") {
                return reply.code(400).send({ error: "Unsupported export version" });
            }

            const roleId = generateRoleId();
            const role = normalizeRole({
                ...importData.role,
                id: roleId,
                isTemplate: false,
            }, roleId, userId);

            await kvMutate({ uid: userId }, [{
                key: `${ROLES_PREFIX}${roleId}`,
                value: serializeRole(role),
                version: -1
            }]);

            await syncRoleToPublicPool(role, userId);

            log({ module: "role-routes", roleId, sourceId: importData.role.templateSource }, "Role imported");
            return reply.send({ success: true, role });
        } catch (error) {
            log({ module: "role-routes", level: "error" }, `Failed to import role: ${error}`);
            return reply.code(500).send({ error: "Failed to import role" });
        }
    });

    // POST /v1/roles/:id/reviews - Public role review/score input
    app.post("/v1/roles/:id/reviews", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            body: RoleReviewInputSchema,
            response: {
                200: z.object({
                    success: z.literal(true),
                    review: RoleReviewSchema,
                    stats: RoleStatsSchema,
                }),
                404: z.object({
                    error: z.literal("Role not found")
                }),
                500: z.object({
                    error: z.literal("Failed to review role")
                })
            }
        }
    }, async (request, reply) => {
        const reviewerId = request.userId;
        const { id: roleId } = request.params as { id: string };
        const payload = request.body as RoleReviewInput;

        try {
            const [own, publicRole] = await Promise.all([
                loadUserRole(reviewerId, roleId),
                loadPublicRole(roleId),
            ]);

            if (!own && !publicRole) {
                return reply.code(404).send({ error: "Role not found" });
            }

            const baseStats = normalizeRoleStats(publicRole?.stats || own?.role.stats);
            const nextStats = applyRoleReview(baseStats, payload);

            const review: RoleReview = {
                ...payload,
                id: generateReviewId("rr"),
                roleId,
                reviewerId,
                createdAt: Date.now(),
            };

            await db.simpleCache.upsert({
                where: { key: `${ROLE_REVIEW_PREFIX}${roleId}.${review.id}` },
                update: {
                    value: JSON.stringify(review)
                },
                create: {
                    key: `${ROLE_REVIEW_PREFIX}${roleId}.${review.id}`,
                    value: JSON.stringify(review)
                }
            });

            if (publicRole) {
                await db.simpleCache.upsert({
                    where: { key: `${ROLE_POOL_PREFIX}${roleId}` },
                    update: {
                        value: JSON.stringify({
                            ...publicRole,
                            stats: nextStats,
                            updatedAt: Date.now(),
                        })
                    },
                    create: {
                        key: `${ROLE_POOL_PREFIX}${roleId}`,
                        value: JSON.stringify({
                            ...publicRole,
                            stats: nextStats,
                            updatedAt: Date.now(),
                        })
                    }
                });
            }

            // If reviewer is owner and has local role copy, keep it in sync too.
            if (own) {
                const updatedLocal = normalizeRole({
                    ...own.role,
                    stats: nextStats,
                    updatedAt: Date.now(),
                }, roleId, own.role.ownerId || reviewerId);

                await kvMutate({ uid: reviewerId }, [{
                    key: `${ROLES_PREFIX}${roleId}`,
                    value: serializeRole(updatedLocal),
                    version: own.version,
                }]);

                await syncRoleToPublicPool(updatedLocal, reviewerId);
            }

            return reply.send({
                success: true,
                review,
                stats: nextStats,
            });
        } catch (error) {
            log({ module: "role-routes", level: "error" }, `Failed to review role: ${error}`);
            return reply.code(500).send({ error: "Failed to review role" });
        }
    });

    // GET /v1/roles/:id/reviews - Read role public reviews
    app.get("/v1/roles/:id/reviews", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(200).default(50)
            }),
            response: {
                200: z.object({
                    reviews: z.array(RoleReviewSchema),
                    total: z.number(),
                }),
                500: z.object({
                    error: z.literal("Failed to list role reviews")
                })
            }
        }
    }, async (request, reply) => {
        const { id } = request.params as { id: string };
        const { limit } = request.query as { limit: number };

        try {
            const rows = await db.simpleCache.findMany({
                where: { key: { startsWith: `${ROLE_REVIEW_PREFIX}${id}.` } },
                orderBy: { updatedAt: "desc" },
                take: 1000,
            });

            const reviews = rows
                .map((row) => parseRoleReview(row.value))
                .filter((review): review is RoleReview => Boolean(review));

            return reply.send({
                reviews: reviews.slice(0, limit),
                total: reviews.length,
            });
        } catch (error) {
            log({ module: "role-routes", level: "error" }, `Failed to list role reviews: ${error}`);
            return reply.code(500).send({ error: "Failed to list role reviews" });
        }
    });

    // POST /v1/teams/:teamId/reviews - Team public review/score input
    app.post("/v1/teams/:teamId/reviews", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string()
            }),
            body: TeamReviewInputSchema,
            response: {
                200: z.object({
                    success: z.literal(true),
                    review: TeamReviewSchema,
                    scorecard: TeamScorecardSchema,
                }),
                500: z.object({
                    error: z.literal("Failed to review team")
                })
            }
        }
    }, async (request, reply) => {
        const reviewerId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const payload = request.body as TeamReviewInput;

        try {
            const review: TeamReview = {
                ...payload,
                id: generateReviewId("tr"),
                teamId,
                reviewerId,
                createdAt: Date.now(),
            };

            await db.simpleCache.upsert({
                where: { key: `${TEAM_REVIEW_PREFIX}${teamId}.${review.id}` },
                update: {
                    value: JSON.stringify(review)
                },
                create: {
                    key: `${TEAM_REVIEW_PREFIX}${teamId}.${review.id}`,
                    value: JSON.stringify(review)
                }
            });

            const scoreKey = `${TEAM_SCORE_PREFIX}${teamId}`;
            const existing = await db.simpleCache.findUnique({ where: { key: scoreKey } });
            const base = existing ? parseTeamScorecard(existing.value) : null;
            const next = applyTeamReview(base || emptyTeamScorecard(teamId), payload);

            await db.simpleCache.upsert({
                where: { key: scoreKey },
                update: {
                    value: JSON.stringify(next)
                },
                create: {
                    key: scoreKey,
                    value: JSON.stringify(next)
                }
            });

            return reply.send({
                success: true,
                review,
                scorecard: next,
            });
        } catch (error) {
            log({ module: "role-routes", level: "error" }, `Failed to review team: ${error}`);
            return reply.code(500).send({ error: "Failed to review team" });
        }
    });

    // GET /v1/teams/:teamId/reviews - Team review feed
    app.get("/v1/teams/:teamId/reviews", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string()
            }),
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(200).default(50)
            }),
            response: {
                200: z.object({
                    reviews: z.array(TeamReviewSchema),
                    total: z.number(),
                }),
                500: z.object({
                    error: z.literal("Failed to list team reviews")
                })
            }
        }
    }, async (request, reply) => {
        const { teamId } = request.params as { teamId: string };
        const { limit } = request.query as { limit: number };

        try {
            const rows = await db.simpleCache.findMany({
                where: { key: { startsWith: `${TEAM_REVIEW_PREFIX}${teamId}.` } },
                orderBy: { updatedAt: "desc" },
                take: 1000,
            });

            const reviews = rows
                .map((row) => parseTeamReview(row.value))
                .filter((review): review is TeamReview => Boolean(review));

            return reply.send({
                reviews: reviews.slice(0, limit),
                total: reviews.length,
            });
        } catch (error) {
            log({ module: "role-routes", level: "error" }, `Failed to list team reviews: ${error}`);
            return reply.code(500).send({ error: "Failed to list team reviews" });
        }
    });

    // GET /v1/teams/:teamId/score - Team cumulative scorecard
    app.get("/v1/teams/:teamId/score", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string()
            }),
            response: {
                200: TeamScorecardSchema,
                500: z.object({
                    error: z.literal("Failed to get team score")
                })
            }
        }
    }, async (request, reply) => {
        const { teamId } = request.params as { teamId: string };

        try {
            const existing = await db.simpleCache.findUnique({ where: { key: `${TEAM_SCORE_PREFIX}${teamId}` } });
            if (!existing) {
                return reply.send(emptyTeamScorecard(teamId));
            }

            const parsed = parseTeamScorecard(existing.value);
            return reply.send(parsed || emptyTeamScorecard(teamId));
        } catch (error) {
            log({ module: "role-routes", level: "error" }, `Failed to get team score: ${error}`);
            return reply.code(500).send({ error: "Failed to get team score" });
        }
    });

    // Backward-compatible endpoint alias for default templates
    app.get("/v1/roles/templates/list", {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    templates: z.array(RoleTemplateSchema)
                })
            }
        }
    }, async (request, reply) => {
        return reply.send({ templates: DEFAULT_ROLE_TEMPLATES });
    });
}
