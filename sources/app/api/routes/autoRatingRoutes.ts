/**
 * Auto-Rating API Routes for R9 Feature
 *
 * Provides endpoints for auto-rating configuration, triggering, and results.
 */

import { Fastify } from '../types';
import { z } from 'zod';
import {
  runAutoRatingForTeam,
  getAutoRatingConfig,
  setAutoRatingConfig,
  calculateConfidenceScore,
  type AutoRatingConfig,
  type ConfidenceScore
} from '@/services/autoRatingService';
import { appendTeamEvidence } from '@/services/evolutionEvidenceService';
import { db } from '@/storage/db';
import { log } from '@/utils/log';

export function autoRatingRoutes(app: Fastify) {
  log({ module: 'api' }, 'Registering autoRatingRoutes...');

  // POST /v1/teams/:teamId/auto-rate - Trigger auto-rating for a team
  app.post('/v1/teams/:teamId/auto-rate', {
    preHandler: app.authenticate,
    schema: {
      params: z.object({
        teamId: z.string()
      }),
      body: z.object({
        triggerType: z.enum(['periodic', 'task-complete', 'manual']).optional().default('manual')
      }),
      response: {
        200: z.object({
          success: z.boolean(),
          ratings: z.array(z.object({
            roleId: z.string(),
            rating: z.number(),
            codeScore: z.number(),
            qualityScore: z.number(),
            confidence: z.object({
              score: z.number(),
              sampleSize: z.number(),
              ratingCount: z.number(),
              period: z.object({
                start: z.string(),
                end: z.string()
              }),
              breakdown: z.object({
                dataQuality: z.number(),
                sampleAdequacy: z.number(),
                recency: z.number(),
                consistency: z.number()
              })
            })
          })),
          triggerType: z.string(),
          timestamp: z.string()
        }),
        403: z.object({
          error: z.string()
        }),
        404: z.object({
          error: z.literal('Team not found')
        })
      }
    }
  }, async (request, reply) => {
    const userId = request.userId;
    const { teamId } = request.params as { teamId: string };
    const { triggerType } = request.body as { triggerType?: 'periodic' | 'task-complete' | 'manual' };

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

      log({ module: 'auto-rating', teamId, userId },
        `Auto-rating triggered: ${triggerType}`);

      const result = await runAutoRatingForTeam(teamId, triggerType || 'manual');

      return reply.send({
        success: true,
        ...result,
        timestamp: result.timestamp.toISOString()
      });

    } catch (error) {
      log({ module: 'auto-rating', level: 'error', teamId },
        `Auto-rating failed: ${error}`);
      return reply.code(500).send({
        success: false,
        ratings: [],
        triggerType: triggerType || 'manual',
        timestamp: new Date().toISOString()
      });
    }
  });

  // GET /v1/teams/:teamId/auto-rate/config - Get auto-rating configuration
  app.get('/v1/teams/:teamId/auto-rate/config', {
    preHandler: app.authenticate,
    schema: {
      params: z.object({
        teamId: z.string()
      }),
      response: {
        200: z.object({
          enabled: z.boolean(),
          frequency: z.enum(['hourly', 'daily', 'weekly']),
          minRoundsBeforeRate: z.number(),
          lastRun: z.string().nullable()
        })
      }
    }
  }, async (request, reply) => {
    const config = getAutoRatingConfig();
    return reply.send({
      enabled: config.enabled,
      frequency: config.frequency,
      minRoundsBeforeRate: config.minRoundsBeforeRate,
      lastRun: config.lastRun?.toISOString() || null
    });
  });

  // PUT /v1/teams/:teamId/auto-rate/config - Update auto-rating configuration
  app.put('/v1/teams/:teamId/auto-rate/config', {
    preHandler: app.authenticate,
    schema: {
      params: z.object({
        teamId: z.string()
      }),
      body: z.object({
        enabled: z.boolean().optional(),
        frequency: z.enum(['hourly', 'daily', 'weekly']).optional(),
        minRoundsBeforeRate: z.number().min(1).max(10).optional()
      }),
      response: {
        200: z.object({
          success: z.boolean(),
          config: z.object({
            enabled: z.boolean(),
            frequency: z.enum(['hourly', 'daily', 'weekly']),
            minRoundsBeforeRate: z.number(),
            lastRun: z.string().nullable()
          })
        })
      }
    }
  }, async (request, reply) => {
    const { teamId } = request.params as { teamId: string };
    const body = request.body as Partial<AutoRatingConfig>;

    try {
      const updatedConfig = setAutoRatingConfig(body);

      // Restart cron if frequency changed
      if (body.frequency && app.restartAutoRatingCron) {
        app.restartAutoRatingCron();
      }

      log({ module: 'auto-rating', teamId },
        `Config updated: ${JSON.stringify(body)}`);

      return reply.send({
        success: true,
        config: {
          enabled: updatedConfig.enabled,
          frequency: updatedConfig.frequency,
          minRoundsBeforeRate: updatedConfig.minRoundsBeforeRate,
          lastRun: updatedConfig.lastRun?.toISOString() || null
        }
      });

    } catch (error) {
      log({ module: 'auto-rating', level: 'error', teamId },
        `Config update failed: ${error}`);
      return reply.code(500).send({
        success: false,
        config: {
          enabled: false,
          frequency: 'daily',
          minRoundsBeforeRate: 3,
          lastRun: null
        }
      });
    }
  });

  // GET /v1/teams/:teamId/agents/:sessionId/metrics - Get metrics for a session
  app.get('/v1/teams/:teamId/agents/:sessionId/metrics', {
    preHandler: app.authenticate,
    schema: {
      params: z.object({
        teamId: z.string(),
        sessionId: z.string()
      }),
      response: {
        200: z.object({
          metrics: z.object({
            codeLines: z.number(),
            commits: z.number(),
            filesChanged: z.number(),
            insertions: z.number(),
            deletions: z.number(),
            bugsFixed: z.number(),
            reviewComments: z.number(),
            testCoverage: z.number()
          }).optional()
        }),
        404: z.object({
          error: z.literal('Metrics not found')
        })
      }
    }
  }, async (request, reply) => {
    const { teamId, sessionId } = request.params as { teamId: string; sessionId: string };

    try {
      const metricsRecord = await db.userKVStore.findFirst({
        where: {
          key: `metrics:${sessionId}`
        }
      });

      if (!metricsRecord) {
        return reply.code(404).send({ error: 'Metrics not found' });
      }

      const valueStr = metricsRecord.value ? Buffer.from(metricsRecord.value).toString('utf-8') : '{}';
      const metrics = JSON.parse(valueStr);

      return reply.send({ metrics });

    } catch (error) {
      log({ module: 'auto-rating', level: 'error', sessionId },
        `Failed to get metrics: ${error}`);
      return reply.code(404).send({ error: 'Metrics not found' });
    }
  });

  // POST /v1/teams/:teamId/agents/:sessionId/metrics - Submit metrics from CLI
  app.post('/v1/teams/:teamId/agents/:sessionId/metrics', {
    preHandler: app.authenticate,
    schema: {
      params: z.object({
        teamId: z.string(),
        sessionId: z.string()
      }),
      body: z.object({
        codeLines: z.number().optional().default(0),
        commits: z.number().optional().default(0),
        filesChanged: z.number().optional().default(0),
        insertions: z.number().optional().default(0),
        deletions: z.number().optional().default(0),
        bugsFixed: z.number().optional().default(0),
        reviewComments: z.number().optional().default(0),
        testCoverage: z.number().optional().default(0),
        periodStart: z.string().optional(),
        periodEnd: z.string().optional()
      }),
      response: {
        200: z.object({
          success: z.boolean()
        })
      }
    }
  }, async (request, reply) => {
    const userId = request.userId;
    const { teamId, sessionId } = request.params as { teamId: string; sessionId: string };
    const metrics = request.body as Record<string, number | string>;

    try {
      const metricsKey = `metrics:${sessionId}`;
      const metricsValue = Buffer.from(JSON.stringify(metrics));
      const submittedAt = new Date().toISOString();

      // Store metrics in UserKVStore using accountId from the authenticated user
      await db.userKVStore.upsert({
        where: {
          accountId_key: {
            accountId: userId,
            key: metricsKey
          }
        },
        update: {
          value: metricsValue as unknown as Uint8Array,
          updatedAt: new Date()
        },
        create: {
          accountId: userId,
          key: metricsKey,
          value: metricsValue as unknown as Uint8Array
        }
      });

      await db.simpleCache.create({
        data: {
          key: `code-metrics:${teamId}:${sessionId}:${Date.now()}`,
          value: JSON.stringify({
            ...metrics,
            sessionId,
            submittedAt,
            source: 'cli-metrics'
          })
        }
      });

      await appendTeamEvidence({
        teamId,
        category: 'code',
        source: 'agent-metrics',
        title: `Code metrics from ${sessionId}`,
        summary: `${metrics.commits || 0} commits · ${((metrics.insertions as number) || 0) + ((metrics.deletions as number) || 0)} changed lines · ${metrics.filesChanged || 0} files touched.`,
        actor: sessionId,
        refs: [{ type: 'session', id: sessionId }],
        metadata: {
          testCoverage: metrics.testCoverage || 0,
          reviewComments: metrics.reviewComments || 0,
        },
        timestamp: submittedAt,
      });

      log({ module: 'auto-rating', sessionId },
        `Metrics submitted: ${metrics.commits} commits, ${metrics.codeLines} lines`);

      return reply.send({ success: true });

    } catch (error) {
      // Silent failure as per spec
      log({ module: 'auto-rating', level: 'error', sessionId },
        `Failed to store metrics: ${error}`);
      return reply.send({ success: true });
    }
  });

  // GET /v1/teams/:teamId/confidence - Get confidence score for team ratings
  app.get('/v1/teams/:teamId/confidence', {
    preHandler: app.authenticate,
    schema: {
      params: z.object({
        teamId: z.string()
      }),
      querystring: z.object({
        periodStart: z.string().optional(),
        periodEnd: z.string().optional()
      }),
      response: {
        200: z.object({
          confidence: z.object({
            score: z.number(),
            sampleSize: z.number(),
            ratingCount: z.number(),
            period: z.object({
              start: z.string(),
              end: z.string()
            }),
            breakdown: z.object({
              dataQuality: z.number(),
              sampleAdequacy: z.number(),
              recency: z.number(),
              consistency: z.number()
            })
          })
        })
      }
    }
  }, async (request, reply) => {
    const { teamId } = request.params as { teamId: string };
    const { periodStart, periodEnd } = request.query as {
      periodStart?: string;
      periodEnd?: string;
    };

    const now = new Date();
    const start = periodStart ? new Date(periodStart) : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const end = periodEnd ? new Date(periodEnd) : now;

    try {
      // Get ratings for the period
      const ratings = await db.simpleCache.findMany({
        where: {
          key: { startsWith: `rating:team:${teamId}:` },
          updatedAt: { gte: start, lte: end }
        }
      });

      const ratingData = ratings.map(r => ({
        rating: parseFloat(r.value as string) || 0,
        createdAt: r.updatedAt,
        source: 'system'
      }));

      const confidence = calculateConfidenceScore(ratingData, { start, end });

      return reply.send({ confidence });

    } catch (error) {
      log({ module: 'auto-rating', level: 'error', teamId },
        `Failed to calculate confidence: ${error}`);

      // Return default low confidence
      return reply.send({
        confidence: {
          score: 0,
          sampleSize: 0,
          ratingCount: 0,
          period: { start: start.toISOString(), end: end.toISOString() },
          breakdown: {
            dataQuality: 0,
            sampleAdequacy: 0,
            recency: 0,
            consistency: 0
          }
        }
      });
    }
  });
}
