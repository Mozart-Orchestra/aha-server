import { z } from "zod";
import { Fastify } from "../types";
import { kvGet } from "@/app/kv/kvGet";
import { kvList } from "@/app/kv/kvList";
import { kvMutate } from "@/app/kv/kvMutate";
import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { randomUUID } from "node:crypto";
import * as privacyKit from "privacy-kit";
import { calculateSystemRating, submitSystemRating, getRoleSystemRating } from "@/services/systemRatingService";
import { ApiErrors, sendErrorResponse } from "@/errors/errorHandler";
import { ErrorCode } from "@/errors/errorCodes";

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
    // Backward compatibility alias used by PRD clients.
    isPublic: z.boolean().optional(),
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

const RatingRecordSchema = z.object({
    id: z.string(),
    teamId: z.string(),
    roleId: z.string(),
    taskId: z.string().optional(),
    rating: z.number().min(1).max(5),
    userRating: z.number().min(1).max(5).optional(),
    masterRating: z.number().min(1).max(5).optional(),
    systemRating: z.number().min(1).max(5).optional(),
    codeLines: z.number().int().nonnegative().default(0),
    commits: z.number().int().nonnegative().default(0),
    bugsCount: z.number().int().nonnegative().default(0),
    qualityScore: z.number().min(0).max(100).default(0),
    source: ReviewSourceSchema.default("system"),
    reviewerId: z.string(),
    comment: z.string().max(1000).optional(),
    createdAt: z.number(),
});

const CreateRatingInputSchema = z.object({
    teamId: z.string(),
    roleId: z.string(),
    taskId: z.string().optional(),
    userRating: z.number().min(1).max(5).optional(),
    masterRating: z.number().min(1).max(5).optional(),
    systemRating: z.number().min(1).max(5).optional(),
    rating: z.number().min(1).max(5).optional(),
    codeLines: z.number().int().nonnegative().optional().default(0),
    commits: z.number().int().nonnegative().optional().default(0),
    bugsCount: z.number().int().nonnegative().optional().default(0),
    qualityScore: z.number().min(0).max(100).optional().default(0),
    source: ReviewSourceSchema.optional().default("system"),
    comment: z.string().max(1000).optional(),
});

const TeamRatingAnalyticsSchema = z.object({
    teamId: z.string(),
    totalRatings: z.number().int().nonnegative(),
    averageRating: z.number().min(0).max(5),
    totalCodeLines: z.number().int().nonnegative(),
    totalCommits: z.number().int().nonnegative(),
    totalBugs: z.number().int().nonnegative(),
    averageQualityScore: z.number().min(0).max(100),
    roleBreakdown: z.array(z.object({
        roleId: z.string(),
        totalRatings: z.number().int().nonnegative(),
        averageRating: z.number().min(0).max(5),
        totalCodeLines: z.number().int().nonnegative(),
        totalCommits: z.number().int().nonnegative(),
        totalBugs: z.number().int().nonnegative(),
        averageQualityScore: z.number().min(0).max(100),
    })),
});

const SystemRatingMetricsSchema = z.object({
    roleId: z.string(),
    teamId: z.string().optional(),
    taskId: z.string().optional(),
    codeLines: z.number().int().nonnegative().default(0),
    commits: z.number().int().nonnegative().default(0),
    bugsCount: z.number().int().nonnegative().default(0),
    filesChanged: z.number().int().nonnegative().default(0),
    reviewComments: z.number().int().nonnegative().default(0),
    testCoverage: z.number().min(0).max(100).optional(),
    persist: z.boolean().optional().default(false),
});

const RoleTemplateSchema = z.object({
    id: z.string(),
    title: z.string(),
    summary: z.string(),
    icon: z.string().optional(),
    category: z.string().optional(),
    responsibilities: z.array(z.string()).default([]),
    abilityBoundaries: z.array(z.string()).default([]),
    handoffProtocol: z.array(z.string()).default([]),
    protocol: z.array(z.string()).default([]),
});

const DEFAULT_ROLE_TEMPLATES: z.infer<typeof RoleTemplateSchema>[] = [
    {
        id: "master",
        title: "Master",
        summary: "Team coordinator and task distributor",
        icon: "🎯",
        category: "management",
        responsibilities: ["Break requirements into scoped tasks", "Assign work based on role expertise"],
        abilityBoundaries: ["Do not bypass validation gates when closing tasks"],
        handoffProtocol: ["Confirm acceptance criteria before marking done"],
        protocol: ["Keep board state and team status aligned"],
    },
    {
        id: "orchestrator",
        title: "Orchestrator",
        summary: "Plans, delegates, and coordinates team workflows",
        icon: "🧭",
        category: "management",
        responsibilities: ["Sequence parallel workstreams", "Resolve dependency and ordering conflicts"],
        abilityBoundaries: ["Escalate scope changes to master/user before re-planning"],
        handoffProtocol: ["Publish execution plan before implementation starts"],
        protocol: ["Prefer smallest viable plan that unblocks delivery"],
    },
    {
        id: "project-manager",
        title: "Project Manager",
        summary: "Tracks milestones, risks, and delivery commitments",
        icon: "📋",
        category: "management",
        responsibilities: ["Track milestone burndown", "Maintain risk/mitigation log"],
        abilityBoundaries: ["Do not rewrite technical implementation details"],
        handoffProtocol: ["Escalate schedule risk with impact and options"],
        protocol: ["Review timeline assumptions on every major update"],
    },
    {
        id: "product-owner",
        title: "Product Owner",
        summary: "Owns requirements clarity and acceptance outcomes",
        icon: "🧩",
        category: "management",
        responsibilities: ["Clarify user value and acceptance criteria", "Prioritize scope with business impact"],
        abilityBoundaries: ["Do not directly merge code or bypass QA"],
        handoffProtocol: ["Provide acceptance decision with rationale"],
        protocol: ["Default to user-facing value over internal complexity"],
    },
    {
        id: "business-analyst",
        title: "Business Analyst",
        summary: "Translates goals into measurable requirements",
        icon: "📈",
        category: "management",
        responsibilities: ["Map user stories to metrics", "Capture assumptions and constraints"],
        abilityBoundaries: ["Do not alter implementation branches directly"],
        handoffProtocol: ["Share requirement deltas before implementation"],
        protocol: ["Keep traceability from story to validation evidence"],
    },
    {
        id: "architect",
        title: "Architect",
        summary: "System design and architecture decisions",
        icon: "🏗️",
        category: "engineering",
        responsibilities: ["Define module boundaries and contracts", "Review technical tradeoffs"],
        abilityBoundaries: ["Avoid shipping unreviewed large refactors alone"],
        handoffProtocol: ["Document architecture decisions and constraints"],
        protocol: ["Prefer backward-compatible interfaces for shared services"],
    },
    {
        id: "solution-architect",
        title: "Solution Architect",
        summary: "Designs end-to-end technical solutions",
        icon: "🧱",
        category: "engineering",
        responsibilities: ["Produce implementation-ready technical specs", "Ensure deployability across environments"],
        abilityBoundaries: ["Do not skip validation for cross-service changes"],
        handoffProtocol: ["Provide rollout/rollback notes with design"],
        protocol: ["Design for observability and failure isolation first"],
    },
    {
        id: "builder",
        title: "Builder",
        summary: "Builds and integrates scoped features",
        icon: "🛠️",
        category: "engineering",
        responsibilities: ["Implement scoped tasks with small diffs", "Keep task status updated during execution"],
        abilityBoundaries: ["Do not re-prioritize tasks without coordinator approval"],
        handoffProtocol: ["Attach validation steps before review handoff"],
        protocol: ["Escalate blockers quickly with actionable context"],
    },
    {
        id: "implementer",
        title: "Implementer",
        summary: "Code implementation and execution",
        icon: "⚙️",
        category: "engineering",
        responsibilities: ["Deliver code changes with focused scope", "Drive assigned tasks to completion"],
        abilityBoundaries: ["Avoid broad rewrites without architecture sign-off"],
        handoffProtocol: ["Signal ready-for-review with test evidence"],
        protocol: ["Keep diffs readable and reversible"],
    },
    {
        id: "framer",
        title: "Framer",
        summary: "Turns goals into implementation-ready technical slices",
        icon: "🧠",
        category: "engineering",
        responsibilities: ["Frame work into actionable slices", "Prepare scaffolding for builders"],
        abilityBoundaries: ["Do not self-approve major architecture changes"],
        handoffProtocol: ["Align assumptions with architect before coding"],
        protocol: ["Favor iterative delivery over big-bang design"],
    },
    {
        id: "qa-engineer",
        title: "QA Engineer",
        summary: "Writes and executes verification suites",
        icon: "✅",
        category: "quality",
        responsibilities: ["Validate acceptance criteria", "Stress edge cases and regressions"],
        abilityBoundaries: ["Do not merge production changes directly"],
        handoffProtocol: ["Provide reproducible bug reports and evidence"],
        protocol: ["Treat missing tests as release risk"],
    },
    {
        id: "qa",
        title: "QA",
        summary: "Quality validation support role",
        icon: "🧪",
        category: "quality",
        responsibilities: ["Run smoke/regression checks", "Track defect lifecycle"],
        abilityBoundaries: ["Do not redefine product scope"],
        handoffProtocol: ["Route defects to owner with impact notes"],
        protocol: ["Keep pass/fail evidence auditable"],
    },
    {
        id: "reviewer",
        title: "Reviewer",
        summary: "Code review and quality assurance",
        icon: "🔍",
        category: "quality",
        responsibilities: ["Review implementation correctness", "Flag risks and regressions early"],
        abilityBoundaries: ["Do not silently change scope during review"],
        handoffProtocol: ["Leave clear must-fix vs follow-up feedback"],
        protocol: ["Prioritize correctness, safety, and test coverage"],
    },
    {
        id: "researcher",
        title: "Researcher",
        summary: "Investigates technical options and references",
        icon: "🔬",
        category: "research",
        responsibilities: ["Collect primary-source references", "Compare options with tradeoff matrix"],
        abilityBoundaries: ["Do not make production code edits unless assigned"],
        handoffProtocol: ["Deliver concise findings with source links"],
        protocol: ["Call out confidence and unknowns explicitly"],
    },
    {
        id: "scout",
        title: "Scout",
        summary: "Fast codebase reconnaissance and context gathering",
        icon: "🛰️",
        category: "research",
        responsibilities: ["Locate relevant files and ownership", "Map current behavior quickly"],
        abilityBoundaries: ["Read-only unless explicit implementation task"],
        handoffProtocol: ["Return file/line references for follow-up"],
        protocol: ["Optimize for speed and signal density"],
    },
    {
        id: "observer",
        title: "Observer",
        summary: "Progress monitoring and reporting",
        icon: "👁️",
        category: "support",
        responsibilities: ["Maintain execution timeline and status notes", "Surface drift between board and code"],
        abilityBoundaries: ["Do not alter implementation behavior directly"],
        handoffProtocol: ["Publish concise status snapshots to stakeholders"],
        protocol: ["Report facts first, interpretation second"],
    },
    {
        id: "scribe",
        title: "Scribe",
        summary: "Maintains project documentation and changelogs",
        icon: "📝",
        category: "support",
        responsibilities: ["Update docs/readmes/changelogs", "Capture architecture and workflow decisions"],
        abilityBoundaries: ["Avoid code changes outside documentation scope"],
        handoffProtocol: ["Request technical context before finalizing docs"],
        protocol: ["Keep docs aligned with shipped behavior"],
    },
    {
        id: "technical-writer",
        title: "Technical Writer",
        summary: "Produces user-facing and API documentation",
        icon: "📚",
        category: "support",
        responsibilities: ["Document API contracts and usage", "Create onboarding/how-to content"],
        abilityBoundaries: ["Do not approve technical architecture changes"],
        handoffProtocol: ["Tag code owners for doc accuracy review"],
        protocol: ["Prefer examples that mirror real workflows"],
    },
    {
        id: "spec-writer",
        title: "Spec Writer",
        summary: "Writes precise implementation specifications",
        icon: "📐",
        category: "support",
        responsibilities: ["Draft technical specs and acceptance criteria", "Maintain requirement traceability"],
        abilityBoundaries: ["Do not merge code while acting as spec role"],
        handoffProtocol: ["Publish spec revisions with explicit delta notes"],
        protocol: ["Keep specs testable and unambiguous"],
    },
    {
        id: "product-designer",
        title: "Product Designer",
        summary: "Designs product interaction and visual systems",
        icon: "🎨",
        category: "design",
        responsibilities: ["Define interaction patterns and states", "Ensure UX consistency across flows"],
        abilityBoundaries: ["Do not ship final frontend behavior without review"],
        handoffProtocol: ["Provide annotated design intent for implementers"],
        protocol: ["Balance usability, clarity, and implementation effort"],
    },
    {
        id: "ux-designer",
        title: "UX Designer",
        summary: "Focuses on usability and user journey quality",
        icon: "🧭",
        category: "design",
        responsibilities: ["Validate information architecture", "Improve workflow friction points"],
        abilityBoundaries: ["Do not bypass accessibility review"],
        handoffProtocol: ["Share rationale for UX decisions with acceptance checks"],
        protocol: ["Prioritize clarity and accessibility in interaction flows"],
    },
    {
        id: "ux-researcher",
        title: "UX Researcher",
        summary: "Conducts discovery and usability research",
        icon: "🧪",
        category: "design",
        responsibilities: ["Run qualitative/quantitative UX research", "Translate findings into product insights"],
        abilityBoundaries: ["Do not overfit decisions to limited samples"],
        handoffProtocol: ["Deliver findings with evidence level and confidence"],
        protocol: ["Keep recommendations tied to observed behavior"],
    },
];

const ROLES_PREFIX = "roles.";
const ROLE_POOL_PREFIX = "role_pool.";
const ROLE_REVIEW_PREFIX = "role_review.";
const TEAM_REVIEW_PREFIX = "team_review.";
const TEAM_SCORE_PREFIX = "team_score.";
const TEAM_RATING_PREFIX = "rating_record.";
const TEAM_RATING_ANALYTICS_PREFIX = "rating_analytics.";

const ROLE_POOL_LIST_CACHE_TTL_MS = 30_000;
const TEAM_RATING_ANALYTICS_CACHE_TTL_MS = 60_000;

type RolePoolListCacheEntry = {
    expiresAt: number;
    roles: PublicRole[];
};

const rolePoolListCache = new Map<string, RolePoolListCacheEntry>();

type CustomRole = z.infer<typeof CustomRoleSchema>;
type PublicRole = z.infer<typeof PublicRoleSchema>;
type RoleStats = z.infer<typeof RoleStatsSchema>;
type RoleReviewInput = z.infer<typeof RoleReviewInputSchema>;
type RoleReview = z.infer<typeof RoleReviewSchema>;
type TeamReviewInput = z.infer<typeof TeamReviewInputSchema>;
type TeamReview = z.infer<typeof TeamReviewSchema>;
type TeamScorecard = z.infer<typeof TeamScorecardSchema>;
type RatingRecord = z.infer<typeof RatingRecordSchema>;
type TeamRatingAnalytics = z.infer<typeof TeamRatingAnalyticsSchema>;
type CreateRatingInput = z.infer<typeof CreateRatingInputSchema>;
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

function normalizeSearchTerm(search?: string): string {
    return search?.toLowerCase().trim() || "";
}

function rolePoolListCacheKey(search?: string): string {
    return normalizeSearchTerm(search);
}

function readRolePoolListCache(search?: string): PublicRole[] | null {
    const key = rolePoolListCacheKey(search);
    const existing = rolePoolListCache.get(key);
    if (!existing) {
        return null;
    }

    if (existing.expiresAt <= Date.now()) {
        rolePoolListCache.delete(key);
        return null;
    }

    return existing.roles;
}

function writeRolePoolListCache(search: string | undefined, roles: PublicRole[]): void {
    const key = rolePoolListCacheKey(search);
    rolePoolListCache.set(key, {
        expiresAt: Date.now() + ROLE_POOL_LIST_CACHE_TTL_MS,
        roles,
    });
}

function invalidateRolePoolListCache(): void {
    rolePoolListCache.clear();
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
    const visibility = role.visibility ?? (role.isPublic === false ? "private" : "public");

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
        visibility,
        isPublic: visibility === "public",
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

function parseRatingRecord(value: string): RatingRecord | null {
    const parsed = parseJson<unknown>(value);
    if (!parsed) {
        return null;
    }

    const candidate = RatingRecordSchema.safeParse(parsed);
    return candidate.success ? candidate.data : null;
}

function resolveInputRating(input: CreateRatingInput): number {
    if (input.rating) {
        return input.rating;
    }

    const values = [input.userRating, input.masterRating, input.systemRating]
        .filter((value): value is number => typeof value === "number");

    if (values.length === 0) {
        return 0;
    }

    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
    return Number(avg.toFixed(3));
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

async function loadPublicRoleMap(roleIds: string[]): Promise<Map<string, PublicRole>> {
    const uniqueRoleIds = Array.from(new Set(roleIds.filter(Boolean)));
    if (uniqueRoleIds.length === 0) {
        return new Map();
    }

    const rows = await db.simpleCache.findMany({
        where: {
            OR: uniqueRoleIds.map((roleId) => ({ key: `${ROLE_POOL_PREFIX}${roleId}` })),
        },
        take: uniqueRoleIds.length,
    });

    const roleMap = new Map<string, PublicRole>();
    for (const row of rows) {
        const parsed = parsePublicRole(row.value);
        if (parsed?.id) {
            roleMap.set(parsed.id, parsed);
        }
    }

    return roleMap;
}

async function listPublicRoles(search?: string): Promise<PublicRole[]> {
    const cached = readRolePoolListCache(search);
    if (cached) {
        return cached;
    }

    const caches = await db.simpleCache.findMany({
        where: {
            key: { startsWith: ROLE_POOL_PREFIX },
        },
        orderBy: {
            updatedAt: "desc",
        },
        take: 1000,
    });

    const normalizedSearch = normalizeSearchTerm(search);
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

    writeRolePoolListCache(search, parsedRoles);
    return parsedRoles;
}

async function syncRoleToPublicPool(role: CustomRole, ownerId: string): Promise<void> {
    if (!role.id) {
        return;
    }

    const poolKey = `${ROLE_POOL_PREFIX}${role.id}`;

    if (role.visibility === "private") {
        await db.simpleCache.deleteMany({ where: { key: poolKey } });
        invalidateRolePoolListCache();
        return;
    }

    const existing = await loadPublicRole(role.id);
    const normalizedStats = normalizeRoleStats(existing?.stats || role.stats);

    const publishedRole: PublicRole = {
        ...role,
        id: role.id,
        ownerId,
        visibility: "public",
        isPublic: true,
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
    invalidateRolePoolListCache();
}

async function mergeWithPublicStats(
    role: CustomRole,
    publicRoleMap?: Map<string, PublicRole>,
): Promise<CustomRole> {
    if (!role.id || role.visibility !== "public") {
        return role;
    }

    const publicRole = publicRoleMap?.get(role.id) ?? await loadPublicRole(role.id);
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

    // GET /v1/roles/public - Alias for /v1/roles/pool (PRD backward compatibility)
    app.get("/v1/roles/public", {
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
        // Delegate to /v1/roles/pool handler logic
        const { limit, search } = request.query as { limit: number; search?: string };
        try {
            const parsedRoles = await listPublicRoles(search);
            return reply.send({ roles: parsedRoles.slice(0, limit), total: parsedRoles.length });
        } catch (error) {
            log({ module: "role-routes", level: "error" }, `Failed to list public roles: ${error}`);
            return reply.code(500).send({ error: "Failed to list public roles" });
        }
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
            const parsedRoles = await listPublicRoles(search);

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

            const normalizedRoles: CustomRole[] = [];
            for (const item of mine.items) {
                const role = parseRole(item.value);
                if (!role || !role.id) {
                    continue;
                }
                normalizedRoles.push(normalizeRole(role, role.id, role.ownerId || userId));
            }

            const publicRoleMap = await loadPublicRoleMap(
                normalizedRoles
                    .filter((role) => role.visibility === "public" && Boolean(role.id))
                    .map((role) => role.id as string),
            );

            const customRoles: CustomRole[] = [];
            for (const normalizedRole of normalizedRoles) {
                const hydrated = await mergeWithPublicStats(normalizedRole, publicRoleMap);
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
            const normalizedRoles: CustomRole[] = [];

            for (const item of result.items) {
                const parsed = parseRole(item.value);
                if (!parsed || !parsed.id) {
                    continue;
                }
                normalizedRoles.push(normalizeRole(parsed, parsed.id, parsed.ownerId || userId));
            }

            const publicRoleMap = await loadPublicRoleMap(
                normalizedRoles
                    .filter((role) => role.visibility === "public" && Boolean(role.id))
                    .map((role) => role.id as string),
            );

            const roles: CustomRole[] = [];

            for (const normalizedRole of normalizedRoles) {
                const role = await mergeWithPublicStats(normalizedRole, publicRoleMap);

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

            return sendErrorResponse(reply, ApiErrors.roleNotFound(id));
        } catch (error: any) {
            log({ module: "role-routes", level: "error" }, `Failed to get role: ${error}`);
            return sendErrorResponse(reply, error);
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
                return sendErrorResponse(reply, ApiErrors.duplicateEntry("id", roleId));
            }

            const role = normalizeRole({
                ...roleData,
                id: roleId,
                visibility: roleData.visibility ?? (roleData.isPublic === false ? "private" : "public"),
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
        } catch (error: any) {
            log({ module: "role-routes", level: "error" }, `Failed to create role: ${error}`);
            return sendErrorResponse(reply, error);
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
                return sendErrorResponse(reply, ApiErrors.roleNotFound(id));
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
            invalidateRolePoolListCache();

            log({ module: "role-routes", roleId: id }, "Custom role deleted");
            return reply.send({ success: true });
        } catch (error: any) {
            log({ module: "role-routes", level: "error" }, `Failed to delete role: ${error}`);
            return sendErrorResponse(reply, error);
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
                invalidateRolePoolListCache();
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

    // POST /v1/ratings - Create a unified rating record (PRD compatibility)
    app.post("/v1/ratings", {
        preHandler: app.authenticate,
        schema: {
            body: CreateRatingInputSchema,
            response: {
                200: z.object({
                    success: z.literal(true),
                    rating: RatingRecordSchema,
                }),
                400: z.object({
                    error: z.string(),
                }),
                500: z.object({
                    error: z.literal("Failed to create rating"),
                }),
            },
        },
    }, async (request, reply) => {
        const reviewerId = request.userId;
        const payload = request.body as CreateRatingInput;

        try {
            const ratingValue = resolveInputRating(payload);
            if (!(ratingValue >= 1 && ratingValue <= 5)) {
                return reply.code(400).send({
                    error: "Provide rating or at least one of userRating/masterRating/systemRating",
                });
            }

            const now = Date.now();
            const record: RatingRecord = {
                id: `rating-${randomUUID().slice(0, 10)}`,
                teamId: payload.teamId,
                roleId: payload.roleId,
                taskId: payload.taskId,
                rating: ratingValue,
                userRating: payload.userRating,
                masterRating: payload.masterRating,
                systemRating: payload.systemRating,
                codeLines: payload.codeLines ?? 0,
                commits: payload.commits ?? 0,
                bugsCount: payload.bugsCount ?? 0,
                qualityScore: payload.qualityScore ?? 0,
                source: payload.source ?? "system",
                reviewerId,
                comment: payload.comment,
                createdAt: now,
            };

            await db.simpleCache.upsert({
                where: { key: `${TEAM_RATING_PREFIX}${record.teamId}.${record.id}` },
                update: {
                    value: JSON.stringify(record),
                },
                create: {
                    key: `${TEAM_RATING_PREFIX}${record.teamId}.${record.id}`,
                    value: JSON.stringify(record),
                },
            });
            await db.simpleCache.deleteMany({
                where: { key: `${TEAM_RATING_ANALYTICS_PREFIX}${record.teamId}` },
            });

            return reply.send({
                success: true,
                rating: record,
            });
        } catch (error) {
            log({ module: "role-routes", level: "error" }, `Failed to create rating: ${error}`);
            return reply.code(500).send({ error: "Failed to create rating" });
        }
    });

    // POST /v1/ratings/system/calculate - System auto-rating algorithm
    app.post("/v1/ratings/system/calculate", {
        preHandler: app.authenticate,
        schema: {
            body: SystemRatingMetricsSchema,
            response: {
                200: z.object({
                    success: z.literal(true),
                    result: z.object({
                        rating: z.number().min(1).max(5),
                        codeScore: z.number(),
                        qualityScore: z.number(),
                        systemScore: z.number(),
                        breakdown: z.object({
                            codeLinesScore: z.number(),
                            commitsScore: z.number(),
                            bugsScore: z.number(),
                            qualityBonus: z.number(),
                        }),
                    }),
                    persisted: z.boolean(),
                }),
                500: z.object({
                    error: z.literal("Failed to calculate system rating"),
                }),
            },
        },
    }, async (request, reply) => {
        const payload = request.body as z.infer<typeof SystemRatingMetricsSchema>;

        try {
            const result = calculateSystemRating({
                codeLines: payload.codeLines,
                commits: payload.commits,
                bugsCount: payload.bugsCount,
                filesChanged: payload.filesChanged,
                reviewComments: payload.reviewComments,
                testCoverage: payload.testCoverage,
            });

            let persisted = false;
            if (payload.persist) {
                const persistResult = await submitSystemRating(payload.roleId, {
                    codeLines: payload.codeLines,
                    commits: payload.commits,
                    bugsCount: payload.bugsCount,
                    filesChanged: payload.filesChanged,
                    reviewComments: payload.reviewComments,
                    testCoverage: payload.testCoverage,
                }, payload.teamId);
                persisted = persistResult.success;
            }

            return reply.send({
                success: true,
                result,
                persisted,
            });
        } catch (error) {
            log({ module: "role-routes", level: "error" }, `Failed to calculate system rating: ${error}`);
            return reply.code(500).send({ error: "Failed to calculate system rating" });
        }
    });

    // GET /v1/ratings/system/role/:roleId - Snapshot system rating derived from role stats
    app.get("/v1/ratings/system/role/:roleId", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                roleId: z.string(),
            }),
            response: {
                200: z.object({
                    success: z.literal(true),
                    result: z.object({
                        rating: z.number().min(1).max(5),
                        codeScore: z.number(),
                        qualityScore: z.number(),
                        systemScore: z.number(),
                        breakdown: z.object({
                            codeLinesScore: z.number(),
                            commitsScore: z.number(),
                            bugsScore: z.number(),
                            qualityBonus: z.number(),
                        }),
                    }).nullable(),
                }),
                500: z.object({
                    error: z.literal("Failed to get role system rating"),
                }),
            },
        },
    }, async (request, reply) => {
        const { roleId } = request.params as { roleId: string };

        try {
            const result = await getRoleSystemRating(roleId);
            return reply.send({
                success: true,
                result,
            });
        } catch (error) {
            log({ module: "role-routes", level: "error" }, `Failed to get role system rating: ${error}`);
            return reply.code(500).send({ error: "Failed to get role system rating" });
        }
    });

    // GET /v1/ratings/:teamId - Team rating history
    app.get("/v1/ratings/:teamId", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string(),
            }),
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(500).default(200),
            }).optional(),
            response: {
                200: z.object({
                    ratings: z.array(RatingRecordSchema),
                    total: z.number(),
                }),
                500: z.object({
                    error: z.literal("Failed to list ratings"),
                }),
            },
        },
    }, async (request, reply) => {
        const { teamId } = request.params as { teamId: string };
        const { limit = 200 } = (request.query || {}) as { limit?: number };

        try {
            const rows = await db.simpleCache.findMany({
                where: { key: { startsWith: `${TEAM_RATING_PREFIX}${teamId}.` } },
                orderBy: { updatedAt: "desc" },
                take: 2000,
            });

            const ratings = rows
                .map((row) => parseRatingRecord(row.value))
                .filter((record): record is RatingRecord => Boolean(record))
                .sort((a, b) => b.createdAt - a.createdAt);

            return reply.send({
                ratings: ratings.slice(0, limit),
                total: ratings.length,
            });
        } catch (error) {
            log({ module: "role-routes", level: "error" }, `Failed to list ratings: ${error}`);
            return reply.code(500).send({ error: "Failed to list ratings" });
        }
    });

    // GET /v1/ratings/:teamId/role/:roleId - Role rating history within a team
    app.get("/v1/ratings/:teamId/role/:roleId", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string(),
                roleId: z.string(),
            }),
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(500).default(200),
            }).optional(),
            response: {
                200: z.object({
                    ratings: z.array(RatingRecordSchema),
                    total: z.number(),
                }),
                500: z.object({
                    error: z.literal("Failed to list role ratings"),
                }),
            },
        },
    }, async (request, reply) => {
        const { teamId, roleId } = request.params as { teamId: string; roleId: string };
        const { limit = 200 } = (request.query || {}) as { limit?: number };

        try {
            const rows = await db.simpleCache.findMany({
                where: { key: { startsWith: `${TEAM_RATING_PREFIX}${teamId}.` } },
                orderBy: { updatedAt: "desc" },
                take: 2000,
            });

            const ratings = rows
                .map((row) => parseRatingRecord(row.value))
                .filter((record): record is RatingRecord => Boolean(record))
                .filter((record) => record.roleId === roleId)
                .sort((a, b) => b.createdAt - a.createdAt);

            return reply.send({
                ratings: ratings.slice(0, limit),
                total: ratings.length,
            });
        } catch (error) {
            log({ module: "role-routes", level: "error" }, `Failed to list role ratings: ${error}`);
            return reply.code(500).send({ error: "Failed to list role ratings" });
        }
    });

    // GET /v1/ratings/:teamId/analytics - Team rating analytics snapshot
    app.get("/v1/ratings/:teamId/analytics", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string(),
            }),
            response: {
                200: TeamRatingAnalyticsSchema,
                500: z.object({
                    error: z.literal("Failed to get rating analytics"),
                }),
            },
        },
    }, async (request, reply) => {
        const { teamId } = request.params as { teamId: string };
        const analyticsCacheKey = `${TEAM_RATING_ANALYTICS_PREFIX}${teamId}`;

        try {
            const cachedAnalytics = await db.simpleCache.findUnique({
                where: { key: analyticsCacheKey },
            });
            if (cachedAnalytics) {
                const parsed = parseJson<{ computedAt: number; data: TeamRatingAnalytics }>(cachedAnalytics.value);
                if (
                    parsed &&
                    typeof parsed.computedAt === "number" &&
                    parsed.data &&
                    Date.now() - parsed.computedAt < TEAM_RATING_ANALYTICS_CACHE_TTL_MS
                ) {
                    return reply.send(parsed.data);
                }
            }

            const rows = await db.simpleCache.findMany({
                where: { key: { startsWith: `${TEAM_RATING_PREFIX}${teamId}.` } },
                orderBy: { updatedAt: "desc" },
                take: 5000,
            });

            const ratings = rows
                .map((row) => parseRatingRecord(row.value))
                .filter((record): record is RatingRecord => Boolean(record));

            if (ratings.length === 0) {
                const emptyPayload: TeamRatingAnalytics = {
                    teamId,
                    totalRatings: 0,
                    averageRating: 0,
                    totalCodeLines: 0,
                    totalCommits: 0,
                    totalBugs: 0,
                    averageQualityScore: 0,
                    roleBreakdown: [],
                };
                await db.simpleCache.upsert({
                    where: { key: analyticsCacheKey },
                    update: {
                        value: JSON.stringify({
                            computedAt: Date.now(),
                            data: emptyPayload,
                        }),
                    },
                    create: {
                        key: analyticsCacheKey,
                        value: JSON.stringify({
                            computedAt: Date.now(),
                            data: emptyPayload,
                        }),
                    },
                });
                return reply.send(emptyPayload);
            }

            const totalRatings = ratings.length;
            const totalRatingScore = ratings.reduce((sum, rating) => sum + rating.rating, 0);
            const totalCodeLines = ratings.reduce((sum, rating) => sum + rating.codeLines, 0);
            const totalCommits = ratings.reduce((sum, rating) => sum + rating.commits, 0);
            const totalBugs = ratings.reduce((sum, rating) => sum + rating.bugsCount, 0);
            const totalQuality = ratings.reduce((sum, rating) => sum + rating.qualityScore, 0);

            const byRole = new Map<string, RatingRecord[]>();
            for (const rating of ratings) {
                const bucket = byRole.get(rating.roleId) || [];
                bucket.push(rating);
                byRole.set(rating.roleId, bucket);
            }

            const roleBreakdown = Array.from(byRole.entries())
                .map(([roleId, roleRatings]) => {
                    const count = roleRatings.length;
                    const roleTotalRating = roleRatings.reduce((sum, rating) => sum + rating.rating, 0);
                    const roleTotalCodeLines = roleRatings.reduce((sum, rating) => sum + rating.codeLines, 0);
                    const roleTotalCommits = roleRatings.reduce((sum, rating) => sum + rating.commits, 0);
                    const roleTotalBugs = roleRatings.reduce((sum, rating) => sum + rating.bugsCount, 0);
                    const roleTotalQuality = roleRatings.reduce((sum, rating) => sum + rating.qualityScore, 0);

                    return {
                        roleId,
                        totalRatings: count,
                        averageRating: Number((roleTotalRating / count).toFixed(3)),
                        totalCodeLines: roleTotalCodeLines,
                        totalCommits: roleTotalCommits,
                        totalBugs: roleTotalBugs,
                        averageQualityScore: Number((roleTotalQuality / count).toFixed(3)),
                    };
                })
                .sort((a, b) => b.averageRating - a.averageRating || b.totalRatings - a.totalRatings);

            const analyticsPayload: TeamRatingAnalytics = {
                teamId,
                totalRatings,
                averageRating: Number((totalRatingScore / totalRatings).toFixed(3)),
                totalCodeLines,
                totalCommits,
                totalBugs,
                averageQualityScore: Number((totalQuality / totalRatings).toFixed(3)),
                roleBreakdown,
            };

            await db.simpleCache.upsert({
                where: { key: analyticsCacheKey },
                update: {
                    value: JSON.stringify({
                        computedAt: Date.now(),
                        data: analyticsPayload,
                    }),
                },
                create: {
                    key: analyticsCacheKey,
                    value: JSON.stringify({
                        computedAt: Date.now(),
                        data: analyticsPayload,
                    }),
                },
            });

            return reply.send(analyticsPayload);
        } catch (error) {
            log({ module: "role-routes", level: "error" }, `Failed to get rating analytics: ${error}`);
            return reply.code(500).send({ error: "Failed to get rating analytics" });
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

    // ============================================================
    // V5-COLLABORATION-001: Cross-Team Role Sharing
    // ============================================================

    const ROLE_SHARE_PREFIX = "role_share.";
    const ROLE_SHARE_COUNT_PREFIX = "role_share_count.";

    /**
     * POST /v1/roles/:roleId/share
     * Share a role with another team
     */
    app.post("/v1/roles/:roleId/share", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                roleId: z.string()
            }),
            body: z.object({
                targetTeamId: z.string(),
                permission: z.enum(["view", "use", "edit"]).default("use")
            }),
            response: {
                200: z.object({
                    success: z.boolean(),
                    share: z.object({
                        roleId: z.string(),
                        targetTeamId: z.string(),
                        permission: z.string(),
                        sharedAt: z.number(),
                        sharedBy: z.string()
                    })
                }),
                401: z.object({
                    success: z.boolean(),
                    error: z.string()
                }),
                404: z.object({
                    success: z.boolean(),
                    error: z.string()
                }),
                500: z.object({
                    success: z.boolean(),
                    error: z.string()
                })
            }
        }
    }, async (request, reply) => {
        try {
            const { roleId } = request.params as { roleId: string };
            const { targetTeamId, permission } = request.body as { targetTeamId: string; permission: string };
            const userId = (request as any).user?.id;

            if (!userId) {
                return reply.status(401).send({ success: false, error: "Unauthorized" });
            }

            // Verify the role exists and user has access
            const roleKey = `${ROLES_PREFIX}${roleId}`;
            const role = await kvGet({ uid: userId }, roleKey);

            if (!role) {
                return reply.status(404).send({ success: false, error: "Role not found" });
            }

            const shareKey = `${ROLE_SHARE_PREFIX}${roleId}.${targetTeamId}`;
            const sharedAt = Date.now();

            await kvMutate({
                uid: userId
            }, [{
                key: shareKey,
                value: JSON.stringify({
                    roleId,
                    targetTeamId,
                    permission,
                    sharedAt,
                    sharedBy: userId
                }),
                version: -1
            }]);

            // Increment share count
            const countKey = `${ROLE_SHARE_COUNT_PREFIX}${roleId}`;
            const existingCount = await kvGet({ uid: userId }, countKey);
            const parsedCount = existingCount ? decodeKVJson<{ count?: number }>(existingCount.value) : null;
            const newCount = (parsedCount?.count ?? 0) + 1;
            await kvMutate({ uid: userId }, [{ key: countKey, value: JSON.stringify({ count: newCount }), version: -1 }]);

            return reply.send({
                success: true,
                share: {
                    roleId,
                    targetTeamId,
                    permission,
                    sharedAt,
                    sharedBy: userId
                }
            });
        } catch (error) {
            log({ module: "role-routes", level: "error" }, `Failed to share role: ${error}`);
            return reply.status(500).send({ success: false, error: "Failed to share role" });
        }
    });

    /**
     * GET /v1/roles/:roleId/shared-teams
     * Get teams this role is shared with
     */
    app.get("/v1/roles/:roleId/shared-teams", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                roleId: z.string()
            }),
            response: {
                200: z.object({
                    success: z.boolean(),
                    shares: z.array(z.object({
                        roleId: z.string(),
                        targetTeamId: z.string(),
                        permission: z.string(),
                        sharedAt: z.number()
                    }))
                }),
                401: z.object({
                    success: z.boolean(),
                    error: z.string()
                }),
                500: z.object({
                    success: z.boolean(),
                    error: z.string()
                })
            }
        }
    }, async (request, reply) => {
        try {
            const { roleId } = request.params as { roleId: string };
            const userId = (request as any).user?.id;

            if (!userId) {
                return reply.status(401).send({ success: false, error: "Unauthorized" });
            }

            // List all shares for this role
            const sharePrefix = `${ROLE_SHARE_PREFIX}${roleId}.`;
            const shares = await kvList({ uid: userId }, { prefix: sharePrefix, limit: 100 });

            const shareList = shares.items.map(item => {
                try {
                    return JSON.parse(item.value);
                } catch {
                    return null;
                }
            }).filter(Boolean);

            return reply.send({
                success: true,
                shares: shareList
            });
        } catch (error) {
            log({ module: "role-routes", level: "error" }, `Failed to get shared teams: ${error}`);
            return reply.status(500).send({ success: false, error: "Failed to get shared teams" });
        }
    });

    /**
     * GET /v1/roles/shared-with-me
     * Get roles shared with current user's team
     */
    app.get("/v1/roles/shared-with-me", {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    success: z.boolean(),
                    roles: z.array(z.any())
                }),
                401: z.object({
                    success: z.boolean(),
                    error: z.string()
                }),
                500: z.object({
                    success: z.boolean(),
                    error: z.string()
                })
            }
        }
    }, async (request, reply) => {
        try {
            const userId = (request as any).user?.id;

            if (!userId) {
                return reply.status(401).send({ success: false, error: "Unauthorized" });
            }

            // Get user's team ID from session or settings
            const userSettingsKey = "settings";
            const userSettings = await kvGet({ uid: userId }, userSettingsKey);
            const parsedSettings = userSettings ? decodeKVJson<{ teamId?: string }>(userSettings.value) : null;
            const userTeamId = parsedSettings?.teamId ?? null;

            if (!userTeamId) {
                return reply.send({ success: true, roles: [] });
            }

            // Find all roles shared with this team
            const allShares = await kvList({ uid: userId }, { prefix: ROLE_SHARE_PREFIX, limit: 1000 });
            const sharedRoles = allShares.items
                .map(item => {
                    try {
                        return JSON.parse(item.value);
                    } catch {
                        return null;
                    }
                })
                .filter(share => share && share.targetTeamId === userTeamId)
                .map(share => ({
                    roleId: share.roleId,
                    permission: share.permission,
                    sharedAt: share.sharedAt,
                    sharedBy: share.sharedBy
                }));

            // Fetch role details
            const roles = [];
            for (const share of sharedRoles) {
                const roleKey = `${ROLES_PREFIX}${share.roleId}`;
                const roleData = await kvGet({ uid: userId }, roleKey);
                if (roleData) {
                    const parsedRoleData = parseRole(roleData.value);
                    if (!parsedRoleData) {
                        continue;
                    }
                    roles.push({
                        ...parsedRoleData,
                        shareInfo: {
                            permission: share.permission,
                            sharedAt: share.sharedAt
                        }
                    });
                }
            }

            return reply.send({
                success: true,
                roles
            });
        } catch (error) {
            log({ module: "role-routes", level: "error" }, `Failed to get shared roles: ${error}`);
            return reply.status(500).send({ success: false, error: "Failed to get shared roles" });
        }
    });

    /**
     * GET /v1/roles/:roleId/usage-stats
     * Get role usage statistics (reuse count)
     */
    app.get("/v1/roles/:roleId/usage-stats", {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                roleId: z.string()
            }),
            response: {
                200: z.object({
                    success: z.boolean(),
                    stats: z.object({
                        roleId: z.string(),
                        shareCount: z.number(),
                        viewCount: z.number().optional(),
                        useCount: z.number().optional()
                    })
                }),
                401: z.object({
                    success: z.boolean(),
                    error: z.string()
                }),
                500: z.object({
                    success: z.boolean(),
                    error: z.string()
                })
            }
        }
    }, async (request, reply) => {
        try {
            const { roleId } = request.params as { roleId: string };
            const userId = (request as any).user?.id;

            if (!userId) {
                return reply.status(401).send({ success: false, error: "Unauthorized" });
            }

            const countKey = `${ROLE_SHARE_COUNT_PREFIX}${roleId}`;
            const countData = await kvGet({ uid: userId }, countKey);
            const parsedCount = countData ? decodeKVJson<{ count?: number }>(countData.value) : null;
            const shareCount = parsedCount?.count ?? 0;

            return reply.send({
                success: true,
                stats: {
                    roleId,
                    shareCount
                }
            });
        } catch (error) {
            log({ module: "role-routes", level: "error" }, `Failed to get usage stats: ${error}`);
            return reply.status(500).send({ success: false, error: "Failed to get usage stats" });
        }
    });
}
