/**
 * Evolution Routes for R10 Feature
 *
 * Provides endpoints for:
 * - GET /v1/teams/:teamId/evolution/suggestions - Get evolution suggestions
 * - POST /v1/teams/:teamId/evolution/apply - Apply an evolution suggestion
 */

import { Fastify } from '../types';
import { z } from 'zod';
import { db } from '@/storage/db';
import { log } from '@/utils/log';
import {
    generateEvolutionSuggestions,
    applyEvolutionSuggestion,
} from '@/services/evolutionService';
import {
    buildEvolutionSummary,
    calculateEvolutionSignalsForUser,
} from '@/services/evolutionEvidenceService';

// Response schemas
const EvolutionSignalsSchema = z.object({
    ratingTrend: z.enum(['improving', 'stable', 'declining']),
    blockingRate: z.number(),
    avgCompletionTime: z.number(),
    idleRate: z.number(),
    coordinatorMessageRatio: z.number().optional(),
    readyPingRatio: z.number().optional()
});

const SuggestionSchema = z.object({
    type: z.enum(['add-role', 'remove-role', 'adjust-count', 'change-model', 'recompose']),
    description: z.string(),
    confidence: z.number(),
    basedOn: z.array(z.string()),
    currentState: z.record(z.unknown()),
    suggestedState: z.record(z.unknown())
});

const EvolutionSuggestionsResponseSchema = z.object({
    suggestions: z.array(SuggestionSchema),
    signals: EvolutionSignalsSchema
});

const EvolutionEvidenceSchema = z.object({
    id: z.string(),
    teamId: z.string(),
    category: z.enum(['runtime', 'code', 'rating', 'review', 'collaboration']),
    source: z.string(),
    title: z.string(),
    summary: z.string(),
    timestamp: z.string(),
    actor: z.string().optional(),
    refs: z.array(z.object({
        type: z.enum(['session', 'task', 'machine', 'rating', 'message']),
        id: z.string(),
    })).optional(),
    metadata: z.record(z.unknown()).optional(),
});

const EvolutionRecommendationSchema = z.object({
    id: z.string(),
    type: z.string(),
    title: z.string(),
    summary: z.string(),
    priority: z.enum(['high', 'medium', 'low']),
    confidence: z.number(),
    scoreDelta: z.number(),
    why: z.array(z.string()),
    nextAction: z.string(),
    evidence: z.array(EvolutionEvidenceSchema),
});

const EvolutionSummaryResponseSchema = z.object({
    teamId: z.string(),
    generatedAt: z.string(),
    period: z.object({
        start: z.string(),
        end: z.string(),
        days: z.number(),
    }),
    score: z.object({
        current: z.number(),
        previous: z.number(),
        delta: z.number(),
        trend: z.enum(['up', 'down', 'flat']),
    }),
    signals: EvolutionSignalsSchema,
    evidenceCounts: z.object({
        runtime: z.number(),
        code: z.number(),
        rating: z.number(),
        review: z.number(),
        collaboration: z.number(),
    }),
    recommendations: z.array(EvolutionRecommendationSchema),
    memory: z.object({
        summary: z.string(),
        highlights: z.array(z.string()),
        nextActions: z.array(z.string()),
    }),
});

const ApplySuggestionRequestSchema = z.object({
    suggestionIndex: z.number().min(0)
});

const ApplySuggestionResponseSchema = z.object({
    result: z.literal('applied'),
    changes: z.record(z.unknown())
});

const ErrorResponse = z.object({ error: z.string() });

export function evolutionRoutes(app: Fastify) {
    log({ module: 'api' }, 'Registering evolutionRoutes...');

    app.get('/v1/teams/:teamId/evolution/summary', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            querystring: z.object({
                period: z.number().min(1).max(90).optional().default(7),
            }),
            response: {
                200: EvolutionSummaryResponseSchema,
                404: ErrorResponse,
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const { period } = request.query as { period?: number };

        try {
            const team = await db.artifact.findFirst({
                where: {
                    id: teamId,
                    accountId: userId,
                },
                select: { id: true },
            });

            if (!team) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            const summary = await buildEvolutionSummary(userId, teamId, period || 7);
            return reply.send(summary);
        } catch (error) {
            log({ module: 'evolution', level: 'error', teamId }, `Failed to build evolution summary: ${error}`);
            return reply.send({
                teamId,
                generatedAt: new Date().toISOString(),
                period: {
                    start: new Date().toISOString(),
                    end: new Date().toISOString(),
                    days: period || 7,
                },
                score: {
                    current: 0,
                    previous: 0,
                    delta: 0,
                    trend: 'flat' as const,
                },
                signals: {
                    ratingTrend: 'stable' as const,
                    blockingRate: 0,
                    avgCompletionTime: 0,
                    idleRate: 0,
                    coordinatorMessageRatio: 0,
                    readyPingRatio: 0,
                },
                evidenceCounts: {
                    runtime: 0,
                    code: 0,
                    rating: 0,
                    review: 0,
                    collaboration: 0,
                },
                recommendations: [],
                memory: {
                    summary: 'Evolution evidence is still warming up for this team.',
                    highlights: [],
                    nextActions: ['Run a few more sessions, reviews, and code updates to build evidence.'],
                },
            });
        }
    });

    /**
     * GET /v1/teams/:teamId/evolution/suggestions
     * Get evolution suggestions for a team based on collected signals
     */
    app.get('/v1/teams/:teamId/evolution/suggestions', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            querystring: z.object({
                period: z.number().min(1).max(90).optional().default(7)
            }),
            response: {
                200: EvolutionSuggestionsResponseSchema,
                404: ErrorResponse
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const { period } = request.query as { period?: number };

        try {
            // Verify team exists and user has access
            const team = await db.artifact.findFirst({
                where: {
                    id: teamId,
                    accountId: userId
                },
                select: { id: true }
            });

            if (!team) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            // Calculate evolution signals
            const signals = await calculateEvolutionSignalsForUser(userId, teamId, period || 7);

            // Generate suggestions based on signals
            const suggestions = await generateEvolutionSuggestions(teamId, signals);

            log({ module: 'evolution', teamId, userId },
                `Returning ${suggestions.length} suggestions, rating trend: ${signals.ratingTrend}`);

            return reply.send({
                suggestions,
                signals
            });

        } catch (error) {
            log({ module: 'evolution', level: 'error', teamId },
                `Failed to get evolution suggestions: ${error}`);

            // Return safe defaults on error
            return reply.send({
                suggestions: [],
                signals: {
                    ratingTrend: 'stable' as const,
                    blockingRate: 0,
                    avgCompletionTime: 0,
                    idleRate: 0
                }
            });
        }
    });

    /**
     * POST /v1/teams/:teamId/evolution/apply
     * Apply an evolution suggestion to modify team composition
     */
    app.post('/v1/teams/:teamId/evolution/apply', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            body: ApplySuggestionRequestSchema,
            response: {
                200: ApplySuggestionResponseSchema,
                400: ErrorResponse,
                404: ErrorResponse
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const { suggestionIndex } = request.body as { suggestionIndex: number };

        try {
            // Verify team exists and user has access
            const team = await db.artifact.findFirst({
                where: {
                    id: teamId,
                    accountId: userId
                },
                select: { id: true }
            });

            if (!team) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            // Get current signals and suggestions
            const signals = await calculateEvolutionSignalsForUser(userId, teamId, 7);
            const suggestions = await generateEvolutionSuggestions(teamId, signals);

            if (suggestions.length === 0 || suggestionIndex >= suggestions.length) {
                return reply.code(400).send({
                    error: `No suggestion available at index ${suggestionIndex}`
                });
            }

            // Apply the suggestion
            const suggestion = suggestions[suggestionIndex];
            const result = await applyEvolutionSuggestion(teamId, suggestion);

            log({ module: 'evolution', teamId, userId },
                `Applied suggestion: ${suggestion.type}, index: ${suggestionIndex}`);

            return reply.send(result);

        } catch (error) {
            log({ module: 'evolution', level: 'error', teamId },
                `Failed to apply evolution suggestion: ${error}`);

            return reply.code(500).send({
                error: 'Failed to apply suggestion'
            });
        }
    });

    /**
     * GET /v1/teams/:teamId/evolution/signals
     * Get raw evolution signals without suggestions (for debugging/dashboard)
     */
    app.get('/v1/teams/:teamId/evolution/signals', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            querystring: z.object({
                period: z.number().min(1).max(90).optional().default(7)
            }),
            response: {
                200: EvolutionSignalsSchema,
                404: ErrorResponse
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const { period } = request.query as { period?: number };

        try {
            // Verify team exists and user has access
            const team = await db.artifact.findFirst({
                where: {
                    id: teamId,
                    accountId: userId
                },
                select: { id: true }
            });

            if (!team) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            const signals = await calculateEvolutionSignalsForUser(userId, teamId, period || 7);

            return reply.send(signals);

        } catch (error) {
            log({ module: 'evolution', level: 'error', teamId },
                `Failed to get evolution signals: ${error}`);

            return reply.send({
                ratingTrend: 'stable' as const,
                blockingRate: 0,
                avgCompletionTime: 0,
                idleRate: 0
            });
        }
    });
}
