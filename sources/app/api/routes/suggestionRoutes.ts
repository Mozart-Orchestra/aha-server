/**
 * V5-AI-002: Personalized Improvement Suggestions API
 *
 * Endpoints:
 * - POST /api/v5/suggestions - Generate improvement suggestions for a role
 * - POST /api/v5/suggestions/batch - Batch suggestions for multiple roles
 * - GET /api/v5/suggestions/resources - Get learning resources database
 * - POST /api/v5/suggestions/analyze - Analyze rating weaknesses
 * - POST /api/v5/suggestions/track - Track adopted suggestion
 * - GET /api/v5/suggestions/track/:roleId - Get suggestion progress
 * - PUT /api/v5/suggestions/track/:trackingId - Update progress
 * - DELETE /api/v5/suggestions/track/:trackingId - Remove tracking
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
import { db } from '@/storage/db';

// KV prefix for suggestion tracking
const SUGGESTION_TRACKING_PREFIX = 'suggestion_tracking.';

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

  // ==================== Progress Tracking APIs ====================

  /**
   * POST /api/v5/suggestions/track
   *
   * Track an adopted suggestion and start progress monitoring
   */
  fastify.post('/api/v5/suggestions/track', {
    schema: {
      body: z.object({
        roleId: z.string(),
        suggestion: z.object({
          category: z.string(),
          priority: z.enum(['high', 'medium', 'low']),
          title: z.string(),
          description: z.string(),
          actionableSteps: z.array(z.string()),
          expectedImpact: z.string(),
          timeline: z.string(),
        }),
      }),
      response: {
        200: z.object({
          success: z.boolean(),
          trackingId: z.string(),
          status: z.string(),
        }),
      },
    },
  }, async (request, reply) => {
    try {
      const userId = (request as any).user?.id;
      if (!userId) {
        return reply.status(401).send({
          success: false,
          trackingId: '',
          status: 'Unauthorized',
        });
      }

      const body = request.body as {
        roleId: string;
        suggestion: {
          category: string;
          priority: 'high' | 'medium' | 'low';
          title: string;
          description: string;
          actionableSteps: string[];
          expectedImpact: string;
          timeline: string;
        };
      };

      const trackingId = `track-${randomUUID().slice(0, 10)}`;
      const now = Date.now();

      const trackingRecord = {
        id: trackingId,
        userId,
        roleId: body.roleId,
        suggestion: body.suggestion,
        status: 'in_progress',
        progress: 0,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        notes: '',
      };

      await db.simpleCache.upsert({
        where: { key: `${SUGGESTION_TRACKING_PREFIX}${userId}.${trackingId}` },
        update: { value: JSON.stringify(trackingRecord) },
        create: { key: `${SUGGESTION_TRACKING_PREFIX}${userId}.${trackingId}`, value: JSON.stringify(trackingRecord) },
      });

      log({ module: 'suggestion-routes', level: 'info' },
        `Created suggestion tracking: ${trackingId} for user ${userId}`);

      return {
        success: true,
        trackingId,
        status: 'in_progress',
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        trackingId: '',
        status: 'Failed to track suggestion',
      });
    }
  });

  /**
   * GET /api/v5/suggestions/track/:roleId
   *
   * Get all suggestion progress for a role
   */
  fastify.get('/api/v5/suggestions/track/:roleId', {
    schema: {
      params: z.object({
        roleId: z.string(),
      }),
      response: {
        200: z.object({
          success: z.boolean(),
          tracking: z.array(z.object({
            id: z.string(),
            roleId: z.string(),
            suggestion: z.object({
              category: z.string(),
              priority: z.enum(['high', 'medium', 'low']),
              title: z.string(),
              description: z.string(),
            }),
            status: z.string(),
            progress: z.number(),
            createdAt: z.number(),
            updatedAt: z.number(),
            completedAt: z.number().nullable(),
          })),
        }),
      },
    },
  }, async (request, reply) => {
    try {
      const userId = (request as any).user?.id;
      if (!userId) {
        return reply.status(401).send({
          success: false,
          tracking: [],
        });
      }

      const { roleId } = request.params as { roleId: string };

      // List all tracking records for this user
      const rows = await db.simpleCache.findMany({
        where: { key: { startsWith: `${SUGGESTION_TRACKING_PREFIX}${userId}.` } },
        take: 100,
      });

      const tracking = rows
        .map((item) => JSON.parse(item.value) as any)
        .filter((record) => record.roleId === roleId)
        .map((record) => ({
          id: record.id,
          roleId: record.roleId,
          suggestion: {
            category: record.suggestion.category,
            priority: record.suggestion.priority,
            title: record.suggestion.title,
            description: record.suggestion.description,
          },
          status: record.status,
          progress: record.progress,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          completedAt: record.completedAt,
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt);

      return {
        success: true,
        tracking,
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        tracking: [],
        error: 'Failed to get tracking',
      });
    }
  });

  /**
   * PUT /api/v5/suggestions/track/:trackingId
   *
   * Update suggestion progress (mark complete, add notes, etc.)
   */
  fastify.put('/api/v5/suggestions/track/:trackingId', {
    schema: {
      params: z.object({
        trackingId: z.string(),
      }),
      body: z.object({
        progress: z.number().min(0).max(100).optional(),
        status: z.enum(['in_progress', 'completed', 'paused', 'abandoned']).optional(),
        notes: z.string().optional(),
      }),
      response: {
        200: z.object({
          success: z.boolean(),
          tracking: z.object({
            id: z.string(),
            status: z.string(),
            progress: z.number(),
            updatedAt: z.number(),
            completedAt: z.number().nullable(),
          }),
        }),
      },
    },
  }, async (request, reply) => {
    try {
      const userId = (request as any).user?.id;
      if (!userId) {
        return reply.status(401).send({
          success: false,
          tracking: null,
        });
      }

      const { trackingId } = request.params as { trackingId: string };
      const body = request.body as {
        progress?: number;
        status?: 'in_progress' | 'completed' | 'paused' | 'abandoned';
        notes?: string;
      };

      const key = `${SUGGESTION_TRACKING_PREFIX}${userId}.${trackingId}`;
      const existing = await db.simpleCache.findUnique({ where: { key } });

      if (!existing) {
        return reply.status(404).send({
          success: false,
          tracking: null,
          error: 'Tracking not found',
        });
      }

      const record = JSON.parse(existing.value) as {
        id: string;
        userId: string;
        roleId: string;
        suggestion: any;
        status: string;
        progress: number;
        createdAt: number;
        updatedAt: number;
        completedAt: number | null;
        notes: string;
      };

      // Update fields
      const now = Date.now();
      if (body.progress !== undefined) {
        record.progress = body.progress;
      }
      if (body.status) {
        record.status = body.status;
        if (body.status === 'completed' && !record.completedAt) {
          record.completedAt = now;
          record.progress = 100;
        }
      }
      if (body.notes !== undefined) {
        record.notes = body.notes;
      }
      record.updatedAt = now;

      await db.simpleCache.upsert({
        where: { key },
        update: { value: JSON.stringify(record) },
        create: { key, value: JSON.stringify(record) },
      });

      log({ module: 'suggestion-routes', level: 'info' },
        `Updated suggestion tracking: ${trackingId}, status: ${record.status}`);

      return {
        success: true,
        tracking: {
          id: record.id,
          status: record.status,
          progress: record.progress,
          updatedAt: record.updatedAt,
          completedAt: record.completedAt,
        },
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        tracking: null,
        error: 'Failed to update tracking',
      });
    }
  });

  /**
   * DELETE /api/v5/suggestions/track/:trackingId
   *
   * Remove a suggestion tracking record
   */
  fastify.delete('/api/v5/suggestions/track/:trackingId', {
    schema: {
      params: z.object({
        trackingId: z.string(),
      }),
      response: {
        200: z.object({
          success: z.boolean(),
        }),
      },
    },
  }, async (request, reply) => {
    try {
      const userId = (request as any).user?.id;
      if (!userId) {
        return reply.status(401).send({
          success: false,
        });
      }

      const { trackingId } = request.params as { trackingId: string };
      const key = `${SUGGESTION_TRACKING_PREFIX}${userId}.${trackingId}`;

      await db.simpleCache.delete({ where: { key } });

      log({ module: 'suggestion-routes', level: 'info' },
        `Deleted suggestion tracking: ${trackingId}`);

      return {
        success: true,
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to delete tracking',
      });
    }
  });
}
