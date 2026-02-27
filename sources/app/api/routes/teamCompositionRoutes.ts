import { z } from 'zod';
import { Fastify } from '../types';
import { generateTeamCompositionPlan } from '@/modules/teamComposition';
import { log } from '@/utils/log';

const EvolutionSignalsSchema = z.object({
    readyPingRatio: z.number().min(0).max(1).optional(),
    coordinatorMessageRatio: z.number().min(0).max(1).optional(),
    deploymentIncidentRatio: z.number().min(0).max(1).optional(),
    historySampleSize: z.number().int().nonnegative().optional(),
});

const TeamCompositionRequestSchema = z.object({
    goal: z.string().min(1),
    context: z.string().optional(),
    versionTrack: z.enum(['v1', 'v2', 'dual']).optional(),
    mode: z.enum(['single', 'multi']).optional(),
    maxTeams: z.number().int().min(1).max(5).optional(),
    deploymentTarget: z.enum(['wow', 'local', 'generic']).optional(),
    evolutionSignals: EvolutionSignalsSchema.optional(),
});

const TeamPlanSliceSchema = z.object({
    key: z.string(),
    name: z.string(),
    objective: z.string(),
    versionTrack: z.enum(['v1', 'v2', 'shared']),
    branchSuggestion: z.string(),
    roleCounts: z.record(z.number().int().nonnegative()),
    rationale: z.array(z.string()),
    risks: z.array(z.string()),
});

const TeamCompositionResponseSchema = z.object({
    mode: z.enum(['single', 'multi']),
    versionTrack: z.enum(['v1', 'v2', 'dual']),
    deploymentTarget: z.enum(['wow', 'local', 'generic']),
    inferredFocus: z.array(z.string()),
    constraints: z.array(z.string()),
    recommendations: z.array(z.string()),
    signalsUsed: z.object({
        readyPingRatio: z.number().min(0).max(1),
        coordinatorMessageRatio: z.number().min(0).max(1),
        deploymentIncidentRatio: z.number().min(0).max(1),
        historySampleSize: z.number().int().nonnegative(),
    }),
    teams: z.array(TeamPlanSliceSchema),
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

        return reply.send(plan);
    });
}
