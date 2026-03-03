/**
 * R7 Team Stats Routes
 * Provides stats, usage, and export endpoints for team analytics
 * Uses in-memory cache for performance
 */

import { Fastify } from "../types";
import { z } from "zod";
import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { memoryCache } from "@/cache/memory";
import { parseTeamArtifactBody } from "@/utils/teamArtifacts";

// Cache TTL in seconds
const CACHE_TTL = 60; // 1 minute cache

// Response schemas
const TeamStatsSchema = z.object({
    teamId: z.string(),
    period: z.string(),
    sessions: z.number(),
    totalTokens: z.number(),
    totalCost: z.number(),
    tokensByType: z.object({
        input: z.number(),
        output: z.number(),
        cacheRead: z.number(),
        cacheWrite: z.number()
    }),
    costByType: z.object({
        input: z.number(),
        output: z.number(),
        cacheRead: z.number(),
        cacheWrite: z.number()
    }),
    avgTokensPerSession: z.number(),
    avgCostPerSession: z.number(),
    timestamp: z.number()
});

const UsageTimelineSchema = z.object({
    teamId: z.string(),
    period: z.string(),
    groupBy: z.enum(['hour', 'day']),
    data: z.array(z.object({
        timestamp: z.number(),
        tokens: z.number(),
        cost: z.number(),
        sessions: z.number()
    })),
    summary: z.object({
        totalTokens: z.number(),
        totalCost: z.number(),
        totalSessions: z.number()
    })
});

const ExportSchema = z.object({
    teamId: z.string(),
    format: z.enum(['json', 'csv']),
    period: z.string(),
    data: z.any(),
    exportedAt: z.number(),
    recordCount: z.number()
});

const ErrorResponse = z.object({ error: z.string() });

// Helper to extract session IDs from team artifact body
function extractSessionIdsFromTeam(artifactBody: Uint8Array | null): string[] {
    if (!artifactBody) return [];

    try {
        const board = parseTeamArtifactBody(artifactBody) as Record<string, any>;
        const members = board?.team?.members || [];
        return members.map((m: any) => m.sessionId).filter(Boolean);
    } catch {
        return [];
    }
}

// Helper to aggregate usage data
function aggregateUsageData(data: any): { tokens: number; cost: number; tokensInput: number; tokensOutput: number; tokensCacheRead: number; tokensCacheWrite: number; costInput: number; costOutput: number; costCacheRead: number; costCacheWrite: number } {
    const result = {
        tokens: 0,
        cost: 0,
        tokensInput: 0,
        tokensOutput: 0,
        tokensCacheRead: 0,
        tokensCacheWrite: 0,
        costInput: 0,
        costOutput: 0,
        costCacheRead: 0,
        costCacheWrite: 0
    };

    const tokens = data?.tokens;
    const cost = data?.cost;

    if (tokens) {
        result.tokens = tokens.total || 0;
        result.tokensInput = tokens.input || 0;
        result.tokensOutput = tokens.output || 0;
        result.tokensCacheRead = tokens.cacheRead || 0;
        result.tokensCacheWrite = tokens.cacheWrite || 0;
    }

    if (cost) {
        result.cost = cost.total || 0;
        result.costInput = cost.input || 0;
        result.costOutput = cost.output || 0;
        result.costCacheRead = cost.cacheRead || 0;
        result.costCacheWrite = cost.cacheWrite || 0;
    }

    return result;
}

export function teamStatsRoutes(app: Fastify) {
    log({ module: 'api' }, 'Registering teamStatsRoutes...');

    /**
     * GET /v1/teams/:teamId/stats
     * Get aggregated stats for a team
     */
    app.get('/v1/teams/:teamId/stats', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            querystring: z.object({
                period: z.enum(['day', 'week', 'month', 'all']).optional().default('week')
            }),
            response: {
                200: TeamStatsSchema,
                404: ErrorResponse,
                500: ErrorResponse
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const { period } = request.query as { period: string };

        try {
            // Check cache first
            const cacheKey = `team-stats:${teamId}:${period}:${userId}`;
            const cached = memoryCache.get(cacheKey);
            if (cached) {
                return reply.send(JSON.parse(cached));
            }

            // Verify team exists
            const artifact = await db.artifact.findFirst({
                where: { id: teamId }
            });

            if (!artifact) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            // Extract session IDs from team body
            const sessionIds = extractSessionIdsFromTeam(artifact.body);

            // Calculate time range
            const now = Date.now();
            let startTime: number;
            switch (period) {
                case 'day':
                    startTime = now - 24 * 60 * 60 * 1000;
                    break;
                case 'week':
                    startTime = now - 7 * 24 * 60 * 60 * 1000;
                    break;
                case 'month':
                    startTime = now - 30 * 24 * 60 * 60 * 1000;
                    break;
                case 'all':
                default:
                    startTime = 0;
            }

            // Get usage reports for these sessions
            const reports = await db.usageReport.findMany({
                where: {
                    sessionId: { in: sessionIds },
                    createdAt: startTime > 0 ? { gte: new Date(startTime) } : undefined
                }
            });

            // Aggregate stats
            let totalTokens = 0;
            let totalCost = 0;
            let tokensInput = 0;
            let tokensOutput = 0;
            let tokensCacheRead = 0;
            let tokensCacheWrite = 0;
            let costInput = 0;
            let costOutput = 0;
            let costCacheRead = 0;
            let costCacheWrite = 0;

            for (const report of reports) {
                const data = report.data as any;
                const agg = aggregateUsageData(data);
                totalTokens += agg.tokens;
                totalCost += agg.cost;
                tokensInput += agg.tokensInput;
                tokensOutput += agg.tokensOutput;
                tokensCacheRead += agg.tokensCacheRead;
                tokensCacheWrite += agg.tokensCacheWrite;
                costInput += agg.costInput;
                costOutput += agg.costOutput;
                costCacheRead += agg.costCacheRead;
                costCacheWrite += agg.costCacheWrite;
            }

            const sessionCount = sessionIds.length;
            const result = {
                teamId,
                period,
                sessions: sessionCount,
                totalTokens,
                totalCost,
                tokensByType: {
                    input: tokensInput,
                    output: tokensOutput,
                    cacheRead: tokensCacheRead,
                    cacheWrite: tokensCacheWrite
                },
                costByType: {
                    input: costInput,
                    output: costOutput,
                    cacheRead: costCacheRead,
                    cacheWrite: costCacheWrite
                },
                avgTokensPerSession: sessionCount > 0 ? Math.round(totalTokens / sessionCount) : 0,
                avgCostPerSession: sessionCount > 0 ? Number((totalCost / sessionCount).toFixed(6)) : 0,
                timestamp: Date.now()
            };

            // Cache the result
            memoryCache.set(cacheKey, JSON.stringify(result), CACHE_TTL);

            return reply.send(result);
        } catch (error: any) {
            log({ module: 'team-stats', level: 'error' }, `Failed to get stats: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    /**
     * GET /v1/teams/:teamId/usage
     * Get usage timeline for a team
     */
    app.get('/v1/teams/:teamId/usage', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            querystring: z.object({
                period: z.enum(['day', 'week', 'month']).optional().default('week'),
                groupBy: z.enum(['hour', 'day']).optional().default('day')
            }),
            response: {
                200: UsageTimelineSchema,
                404: ErrorResponse,
                500: ErrorResponse
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const { period, groupBy } = request.query as { period: string; groupBy: string };

        try {
            // Check cache first
            const cacheKey = `team-usage:${teamId}:${period}:${groupBy}:${userId}`;
            const cached = memoryCache.get(cacheKey);
            if (cached) {
                return reply.send(JSON.parse(cached));
            }

            // Verify team exists
            const artifact = await db.artifact.findFirst({
                where: { id: teamId }
            });

            if (!artifact) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            // Extract session IDs from team body
            const sessionIds = extractSessionIdsFromTeam(artifact.body);

            // Calculate time range
            const now = Date.now();
            let startTime: number;
            switch (period) {
                case 'day':
                    startTime = now - 24 * 60 * 60 * 1000;
                    break;
                case 'week':
                    startTime = now - 7 * 24 * 60 * 60 * 1000;
                    break;
                case 'month':
                    startTime = now - 30 * 24 * 60 * 60 * 1000;
                    break;
                default:
                    startTime = now - 7 * 24 * 60 * 60 * 1000;
            }

            // Get usage reports
            const reports = await db.usageReport.findMany({
                where: {
                    sessionId: { in: sessionIds },
                    createdAt: { gte: new Date(startTime) }
                },
                orderBy: { createdAt: 'asc' }
            });

            // Aggregate by time period
            const aggregated = new Map<number, { tokens: number; cost: number; sessions: Set<string> }>();

            for (const report of reports) {
                const data = report.data as any;
                const date = new Date(report.createdAt);

                // Calculate timestamp based on groupBy
                let timestamp: number;
                if (groupBy === 'hour') {
                    const hourDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), 0, 0, 0);
                    timestamp = Math.floor(hourDate.getTime() / 1000);
                } else {
                    const dayDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
                    timestamp = Math.floor(dayDate.getTime() / 1000);
                }

                if (!aggregated.has(timestamp)) {
                    aggregated.set(timestamp, { tokens: 0, cost: 0, sessions: new Set() });
                }

                const agg = aggregated.get(timestamp)!;
                const usageAgg = aggregateUsageData(data);
                agg.tokens += usageAgg.tokens;
                agg.cost += usageAgg.cost;
                if (report.sessionId) {
                    agg.sessions.add(report.sessionId);
                }
            }

            // Convert to array and sort
            const data = Array.from(aggregated.entries())
                .sort((a, b) => a[0] - b[0])
                .map(([timestamp, agg]) => ({
                    timestamp,
                    tokens: agg.tokens,
                    cost: agg.cost,
                    sessions: agg.sessions.size
                }));

            // Calculate summary
            const summary = {
                totalTokens: data.reduce((sum, d) => sum + d.tokens, 0),
                totalCost: data.reduce((sum, d) => sum + d.cost, 0),
                totalSessions: new Set(reports.map(r => r.sessionId).filter(Boolean)).size
            };

            const result = {
                teamId,
                period,
                groupBy: groupBy as 'hour' | 'day',
                data,
                summary
            };

            // Cache the result
            memoryCache.set(cacheKey, JSON.stringify(result), CACHE_TTL);

            return reply.send(result);
        } catch (error: any) {
            log({ module: 'team-stats', level: 'error' }, `Failed to get usage: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    /**
     * GET /v1/teams/:teamId/export
     * Export team stats in JSON or CSV format
     */
    app.get('/v1/teams/:teamId/export', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            querystring: z.object({
                format: z.enum(['json', 'csv']).optional().default('json'),
                period: z.enum(['day', 'week', 'month', 'all']).optional().default('week')
            }),
            response: {
                200: ExportSchema,
                404: ErrorResponse,
                500: ErrorResponse
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const { format, period } = request.query as { format: string; period: string };

        try {
            // Verify team exists
            const artifact = await db.artifact.findFirst({
                where: { id: teamId }
            });

            if (!artifact) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            // Extract session IDs from team body
            const sessionIds = extractSessionIdsFromTeam(artifact.body);

            // Calculate time range
            const now = Date.now();
            let startTime: number;
            switch (period) {
                case 'day':
                    startTime = now - 24 * 60 * 60 * 1000;
                    break;
                case 'week':
                    startTime = now - 7 * 24 * 60 * 60 * 1000;
                    break;
                case 'month':
                    startTime = now - 30 * 24 * 60 * 60 * 1000;
                    break;
                case 'all':
                default:
                    startTime = 0;
            }

            // Get sessions for tag lookup
            const sessions = await db.session.findMany({
                where: { id: { in: sessionIds } },
                select: { id: true, tag: true, createdAt: true }
            });
            const sessionMap = new Map(sessions.map(s => [s.id, s]));

            // Get usage reports
            const reports = await db.usageReport.findMany({
                where: {
                    sessionId: { in: sessionIds },
                    createdAt: startTime > 0 ? { gte: new Date(startTime) } : undefined
                },
                orderBy: { createdAt: 'desc' }
            });

            // Prepare export data
            const exportData = reports.map(report => {
                const session = sessionMap.get(report.sessionId || '');
                const data = report.data as any;
                const agg = aggregateUsageData(data);
                return {
                    sessionId: report.sessionId,
                    sessionTag: session?.tag || 'Unknown',
                    timestamp: Math.floor(new Date(report.createdAt).getTime() / 1000),
                    tokens: {
                        total: agg.tokens,
                        input: agg.tokensInput,
                        output: agg.tokensOutput,
                        cacheRead: agg.tokensCacheRead,
                        cacheWrite: agg.tokensCacheWrite
                    },
                    cost: {
                        total: agg.cost,
                        input: agg.costInput,
                        output: agg.costOutput
                    }
                };
            });

            // Format output
            let outputData: any;
            if (format === 'csv') {
                // Convert to CSV
                const headers = ['session_id', 'session_tag', 'timestamp', 'tokens_total', 'tokens_input', 'tokens_output', 'cost_total', 'cost_input', 'cost_output'];
                const rows = exportData.map(d => [
                    d.sessionId,
                    d.sessionTag,
                    d.timestamp,
                    d.tokens.total,
                    d.tokens.input,
                    d.tokens.output,
                    d.cost.total,
                    d.cost.input,
                    d.cost.output
                ].join(','));
                outputData = [headers.join(','), ...rows].join('\n');
            } else {
                outputData = exportData;
            }

            return reply.send({
                teamId,
                format: format as 'json' | 'csv',
                period,
                data: outputData,
                exportedAt: Date.now(),
                recordCount: exportData.length
            });
        } catch (error: any) {
            log({ module: 'team-stats', level: 'error' }, `Failed to export: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    /**
     * DELETE /v1/teams/:teamId/stats/cache
     * Clear stats cache for a team (admin utility)
     */
    app.delete('/v1/teams/:teamId/stats/cache', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            response: {
                200: z.object({ success: z.literal(true), cleared: z.number() }),
                500: ErrorResponse
            }
        }
    }, async (request, reply) => {
        const { teamId } = request.params as { teamId: string };

        try {
            // Find and delete all cache keys for this team
            const patterns = [
                `team-stats:${teamId}:*`,
                `team-usage:${teamId}:*`
            ];

            let cleared = 0;
            for (const pattern of patterns) {
                const keys = memoryCache.keys(pattern);
                for (const key of keys) {
                    memoryCache.del(key);
                    cleared++;
                }
            }

            return reply.send({ success: true, cleared });
        } catch (error: any) {
            log({ module: 'team-stats', level: 'error' }, `Failed to clear cache: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });
}
