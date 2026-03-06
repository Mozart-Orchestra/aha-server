import { z } from 'zod';
import { Fastify } from '../types';
import { buildRoleMarketSnapshot } from '@/modules/roleMarket';
import { detectFocus, generateTeamCompositionPlan } from '@/modules/teamComposition';
import { log } from '@/utils/log';
import { META_CONTRACT_VERSION, TeamBlueprintSchema } from './metaContractSchemas';
import { DEFAULT_ROLE_TEMPLATES, listPublicRoles, listUserRoles } from './roleRoutes';

const EvolutionSignalsSchema = z.object({
    readyPingRatio: z.number().min(0).max(1).optional(),
    coordinatorMessageRatio: z.number().min(0).max(1).optional(),
    deploymentIncidentRatio: z.number().min(0).max(1).optional(),
    idleStatusRatio: z.number().min(0).max(1).optional(),
    cliFocusRatio: z.number().min(0).max(1).optional(),
    serverFocusRatio: z.number().min(0).max(1).optional(),
    kanbanFocusRatio: z.number().min(0).max(1).optional(),
    historySampleSize: z.number().int().nonnegative().optional(),
});

const TeamCompositionRequestSchema = z.object({
    goal: z.string().min(1),
    context: z.string().optional(),
    versionTrack: z.enum(['v1', 'v2', 'dual']).optional(),
    mode: z.enum(['single', 'multi']).optional(),
    maxTeams: z.number().int().min(1).max(5).optional(),
    deploymentTarget: z.enum(['wow', 'uv1', 'uv2', 'local', 'generic']).optional(),
    evolutionSignals: EvolutionSignalsSchema.optional(),
});

const TeamEvoMapSchema = z.object({
    score: z.number().min(1).max(5),
    tier: z.enum(['S', 'A', 'B', 'C']),
    trend: z.enum(['up', 'flat', 'down']),
    highlights: z.array(z.string()),
});

const TeamPlanSliceSchema = z.object({
    key: z.string(),
    name: z.string(),
    objective: z.string(),
    versionTrack: z.enum(['v1', 'v2', 'shared']),
    branchSuggestion: z.string(),
    roleCounts: z.record(z.number().int().nonnegative()),
    evoMap: TeamEvoMapSchema,
    rationale: z.array(z.string()),
    risks: z.array(z.string()),
});

const TeamReleaseGateSchema = z.object({
    versionTrack: z.enum(['v1', 'v2', 'shared']),
    branch: z.string(),
    completionRule: z.string(),
    requiredChecks: z.array(z.object({
        component: z.enum(['aha-cli', 'happy-server', 'kanban']),
        environments: z.array(z.enum(['uv1', 'uv2', 'wow', 'local'])),
        status: z.enum(['pending', 'passed', 'failed']),
    })),
});

const MarketRecommendationSchema = z.object({
    id: z.string(),
    title: z.string(),
    summary: z.string(),
    source: z.enum(['default', 'custom', 'public']),
    assignedSkills: z.array(z.string()),
    score: z.number().min(0).max(100),
    why: z.array(z.string()),
    goalMatches: z.array(z.string()),
    variant: z.object({
        id: z.string(),
        label: z.string(),
        source: z.enum(['server-template', 'workspace-custom', 'public-market']),
        detail: z.string(),
    }),
    access: z.object({
        key: z.enum(['defaults', 'workspace-private', 'workspace-shared', 'market-public']),
        label: z.string(),
    }),
    stats: z.object({
        reviewCount: z.number().int().nonnegative(),
        completionCount: z.number().int().nonnegative(),
        totalRating: z.number().nonnegative(),
        averageRating: z.number().min(0).max(5),
        cumulativeCode: z.number().nonnegative(),
        cumulativeQuality: z.number().nonnegative(),
        sourceScoreTotals: z.object({
            user: z.number().nonnegative(),
            master: z.number().nonnegative(),
            system: z.number().nonnegative(),
        }),
        lastReviewedAt: z.number().optional(),
    }).optional(),
});

const TeamCompositionResponseSchema = z.object({
    metaContractVersion: z.string(),
    mode: z.enum(['single', 'multi']),
    versionTrack: z.enum(['v1', 'v2', 'dual']),
    deploymentTarget: z.enum(['wow', 'uv1', 'uv2', 'local', 'generic']),
    inferredFocus: z.array(z.string()),
    constraints: z.array(z.string()),
    recommendations: z.array(z.string()),
    signalsUsed: z.object({
        readyPingRatio: z.number().min(0).max(1),
        coordinatorMessageRatio: z.number().min(0).max(1),
        deploymentIncidentRatio: z.number().min(0).max(1),
        idleStatusRatio: z.number().min(0).max(1),
        cliFocusRatio: z.number().min(0).max(1),
        serverFocusRatio: z.number().min(0).max(1),
        kanbanFocusRatio: z.number().min(0).max(1),
        historySampleSize: z.number().int().nonnegative(),
    }),
    releaseGates: z.array(TeamReleaseGateSchema),
    teams: z.array(TeamPlanSliceSchema),
    blueprintSeeds: z.array(TeamBlueprintSchema),
    marketRecommendations: z.array(MarketRecommendationSchema),
});

export function teamCompositionRoutes(app: Fastify): void {
    app.post('/v1/teams/compose', {
        preHandler: app.authenticate,
        schema: {
            description: 'Generate adaptive single-team/multi-team composition plan for V1/V2 delivery.',
            tags: ['Team Planning'],
            body: TeamCompositionRequestSchema,
            response: {
                200: TeamCompositionResponseSchema,
            },
        },
    }, async (request, reply) => {
        const payload = TeamCompositionRequestSchema.parse(request.body);
        const plan = generateTeamCompositionPlan(payload);
        const inferredFocus = detectFocus(payload.goal, payload.context);
        const [customRoles, publicRoles] = await Promise.all([
            listUserRoles(request.userId, { includeTemplates: false, includePrivate: true, limit: 200 }),
            listPublicRoles(),
        ]);
        const market = buildRoleMarketSnapshot({
            goal: payload.goal,
            context: payload.context,
            inferredFocus,
            limit: 4,
            candidates: [
                ...DEFAULT_ROLE_TEMPLATES.map((role) => ({
                    id: role.id,
                    title: role.title,
                    summary: role.summary,
                    icon: role.icon,
                    source: 'default' as const,
                    assignedSkills: role.responsibilities,
                    templateSource: role.category,
                })),
                ...customRoles.map((role) => ({
                    id: role.id || '',
                    title: role.title,
                    summary: role.summary,
                    icon: role.icon,
                    ownerId: role.ownerId,
                    source: 'custom' as const,
                    visibility: role.visibility,
                    assignedSkills: role.assignedSkills,
                    stats: role.stats,
                })),
                ...publicRoles.map((role) => ({
                    id: role.id,
                    title: role.title,
                    summary: role.summary,
                    icon: role.icon,
                    ownerId: role.ownerId,
                    source: 'public' as const,
                    visibility: role.visibility,
                    assignedSkills: role.assignedSkills,
                    stats: role.stats,
                })),
            ],
        });
        const marketHeadline = market.recommendations.length > 0
            ? [`角色市场优先建议：${market.recommendations.slice(0, 3).map((role) => `${role.title} (${role.score})`).join(' / ')}`]
            : [];

        log(
            {
                module: 'team-composition',
                userId: request.userId,
                mode: plan.mode,
                versionTrack: plan.versionTrack,
                teamCount: plan.teams.length,
            },
            'Generated team composition plan'
        );

        const blueprintSeeds = plan.teams.map((slice) => TeamBlueprintSchema.parse({
            schemaVersion: META_CONTRACT_VERSION,
            id: `team-blueprint:${slice.key}`,
            title: slice.name,
            summary: slice.objective,
            coordinationMode: plan.mode === 'multi' ? 'weak' : 'strong',
            members: Object.entries(slice.roleCounts)
                .filter(([, count]) => count > 0)
                .map(([roleId, count], index) => ({
                    id: `member:${slice.key}:${index}:${roleId}`,
                    roleId,
                    title: roleId,
                    count,
                })),
        }));

        return reply.send({
            ...plan,
            recommendations: [...marketHeadline, ...plan.recommendations],
            metaContractVersion: META_CONTRACT_VERSION,
            blueprintSeeds,
            marketRecommendations: market.recommendations,
        });
    });
}
