/**
 * V5-AI-002: Personalized Improvement Suggestions API
 *
 * Endpoints:
 * - POST /api/v5/suggestions - Generate improvement suggestions for a role
 * - POST /api/v5/suggestions/batch - Batch suggestions for multiple roles
 * - GET /api/v5/suggestions/resources - Get learning resources database
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import {
  ImprovementSuggestionEngine,
  RatingData,
  UserProfile,
} from '../../../services/ai/ImprovementSuggestionEngine';
import { log } from '@/utils/log';
import { kv } from '@/storage/kv';

// KV prefix for suggestion tracking
const SUGGESTION_TRACKING_PREFIX = 'suggestion_tracking.';
const SUGGESTION_PROGRESS_PREFIX = 'suggestion_progress.';

// Request schemas
const RatingDataSchema = z.object({
  overall: z.number().min(0).max(5),
  dimensions: z.object({
    codeQuality: z.number().min(0).max(5),
    collaboration: z.number().min(0).max(5),
    efficiency: z.number().min(0).max(5),
    innovation: z.number().min(0).max(5),
    problemSolving: z.number().min(0).max(5),
  }),
  trends: z.object({
    direction: z.enum(['improving', 'stable', 'declining']),
    changeRate: z.number(),
  }),
  historicalData: z.array(
    z.object({
      date: z.string(),
      score: z.number(),
      taskId: z.string(),
    })
  ),
});

const UserProfileSchema = z.object({
  roleId: z.string(),
  roleName: z.string(),
  totalTasks: z.number(),
  averageRating: z.number().min(0).max(5),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
});

const BatchSuggestionRequestSchema = z.object({
  users: z.array(
    z.object({
      profile: UserProfileSchema,
      ratingData: RatingDataSchema,
    })
  ),
  options: z
    .object({
      maxSuggestions: z.number().min(1).max(10).default(3),
      focusAreas: z.array(z.string()).optional(),
    })
    .optional(),
});

const SuggestionRequestSchema = z.object({
  profile: UserProfileSchema,
  ratingData: RatingDataSchema,
  options: z
    .object({
      maxSuggestions: z.number().min(1).max(10).default(5),
      focusAreas: z.array(z.string()).optional(),
    })
    .optional(),
});

export async function suggestionRoutes(fastify: FastifyInstance) {
  const suggestionEngine = new ImprovementSuggestionEngine();

  /**
   * POST /api/v5/suggestions
   *
   * Generate personalized improvement suggestions for a role
   */
  fastify.post('/api/v5/suggestions', {
    schema: {
      body: SuggestionRequestSchema,
      response: {
        200: z.object({
          success: z.boolean(),
          suggestions: z.array(
            z.object({
              category: z.string(),
              priority: z.enum(['high', 'medium', 'low']),
              title: z.string(),
              description: z.string(),
              actionableSteps: z.array(z.string()),
              resources: z.array(
                z.object({
                  type: z.enum(['article', 'video', 'course', 'book', 'tool']),
                  title: z.string(),
                  url: z.string(),
                  description: z.string(),
                  estimatedTime: z.string(),
                })
              ),
              expectedImpact: z.string(),
              timeline: z.string(),
            })
          ),
        }),
      },
    },
  }, async (request, reply) => {
    try {
      const body = request.body as z.infer<typeof SuggestionRequestSchema>;
      const userId = (request as any).user?.id;

      if (!userId) {
        return reply.status(401).send({
          success: false,
          suggestions: [],
          error: 'Unauthorized',
        });
      }

      // Generate suggestions
      const suggestions = await suggestionEngine.generateSuggestions(
        body.profile as UserProfile,
        body.ratingData as RatingData,
        body.options
      );

      return {
        success: true,
        suggestions,
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        suggestions: [],
        error: 'Failed to generate suggestions',
      });
    }
  });

  /**
   * POST /api/v5/suggestions/batch
   *
   * Batch generate suggestions for multiple roles
   */
  fastify.post('/api/v5/suggestions/batch', {
    schema: {
      body: BatchSuggestionRequestSchema,
      response: {
        200: z.object({
          success: z.boolean(),
          results: z.record(
            z.string(),
            z.array(
              z.object({
                category: z.string(),
                priority: z.enum(['high', 'medium', 'low']),
                title: z.string(),
                description: z.string(),
                actionableSteps: z.array(z.string()),
                resources: z.array(z.any()),
                expectedImpact: z.string(),
                timeline: z.string(),
              })
            )
          ),
        }),
      },
    },
  }, async (request, reply) => {
    try {
      const body = request.body as z.infer<typeof BatchSuggestionRequestSchema>;
      const userId = (request as any).user?.id;

      if (!userId) {
        return reply.status(401).send({
          success: false,
          results: {},
          error: 'Unauthorized',
        });
      }

      // Generate batch suggestions
      const suggestionsMap = await suggestionEngine.batchGenerateSuggestions(
        body.users,
        body.options
      );

      // Convert Map to Record for JSON response
      const results: Record<string, any[]> = {};
      suggestionsMap.forEach((suggestions, roleId) => {
        results[roleId] = suggestions;
      });

      return {
        success: true,
        results,
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        results: {},
        error: 'Failed to generate batch suggestions',
      });
    }
  });

  /**
   * GET /api/v5/suggestions/resources
   *
   * Get default learning resources database
   */
  fastify.get('/api/v5/suggestions/resources', {
    schema: {
      response: {
        200: z.object({
          success: z.boolean(),
          resources: z.array(
            z.object({
              type: z.enum(['article', 'video', 'course', 'book', 'tool']),
              title: z.string(),
              url: z.string(),
              description: z.string(),
              estimatedTime: z.string(),
            })
          ),
        }),
      },
    },
  }, async (request, reply) => {
    try {
      const resources = suggestionEngine.getDefaultResources();

      return {
        success: true,
        resources,
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        resources: [],
        error: 'Failed to get resources',
      });
    }
  });

  /**
   * POST /api/v5/suggestions/analyze
   *
   * Analyze rating data to identify weaknesses
   */
  fastify.post('/api/v5/suggestions/analyze', {
    schema: {
      body: z.object({
        ratingData: RatingDataSchema,
      }),
      response: {
        200: z.object({
          success: z.boolean(),
          weaknesses: z.array(z.string()),
          summary: z.string(),
        }),
      },
    },
  }, async (request, reply) => {
    try {
      const body = request.body as RatingData;

      const weaknesses = suggestionEngine.analyzeWeaknesses(body);

      const summary = weaknesses.length > 0
        ? `Found ${weaknesses.length} area(s) for improvement`
        : 'Performance is good across all dimensions';

      return {
        success: true,
        weaknesses,
        summary,
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        weaknesses: [],
        summary: 'Failed to analyze rating data',
      });
    }
  });
}
