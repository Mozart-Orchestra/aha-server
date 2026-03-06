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

const ModelDistributionItemSchema = z.object({
    model: z.string(),
    tokenCount: z.number(),
    percentage: z.number()
});

// PRD R7 Team Stats Schema
const PRDTeamStatsSchema = z.object({
    teamId: z.string(),
    period: z.string(),
    memberCount: z.number(),
    activeMemberCount: z.number(),
    messageCount: z.number(),
    taskStats: z.object({
        total: z.number(),
        todo: z.number(),
        inProgress: z.number(),
        review: z.number(),
        done: z.number(),
        blocked: z.number()
    }),
    tokenUsage: z.object({
        total: z.number(),
        byModel: z.object({
            opus: z.number(),
            sonnet: z.number(),
            haiku: z.number()
        })
    }),
    modelDistribution: z.array(ModelDistributionItemSchema),
    codeMetrics: z.object({
        totalCommits: z.number(),
        totalLinesChanged: z.number(),
        totalFilesChanged: z.number()
    }),
    costMetrics: z.object({
        totalCost: z.number(),
        estimatedBudget: z.number(),
        budgetUtilization: z.number()
    }),
    lastActivityAt: z.string().nullable()
});

const BatchStatsSchema = z.record(z.string(), z.object({
    memberCount: z.number(),
    messageCount: z.number(),
    taskStats: z.object({
        total: z.number(),
        todo: z.number(),
        inProgress: z.number(),
        done: z.number()
    })
}));

const ModelDistributionSchema = z.object({
    distribution: z.array(ModelDistributionItemSchema)
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

const TeamBoardSummarySchema = z.object({
    memberCount: z.number(),
    taskStats: z.object({
        total: z.number(),
        todo: z.number(),
        inProgress: z.number(),
        review: z.number(),
        done: z.number(),
        blocked: z.number(),
    }),
});

const TeamBoardSchema = z.object({
    teamId: z.string(),
    board: z.object({
        name: z.string().nullable(),
        version: z.number(),
        updatedAt: z.number().nullable(),
        team: z.object({
            members: z.array(z.any()),
            roles: z.array(z.any()),
            agreements: z.any().nullable(),
        }),
        tasks: z.array(z.any()),
    }),
    summary: TeamBoardSummarySchema,
});

const TeamInfoSchema = z.object({
    teamId: z.string(),
    period: z.string(),
    name: z.string().nullable(),
    memberCount: z.number(),
    activeMemberCount: z.number(),
    messageCount: z.number(),
    taskStats: z.object({
        total: z.number(),
        todo: z.number(),
        inProgress: z.number(),
        review: z.number(),
        done: z.number(),
        blocked: z.number(),
    }),
    tokenUsage: z.object({
        total: z.number(),
        byModel: z.object({
            opus: z.number(),
            sonnet: z.number(),
            haiku: z.number(),
        }),
    }),
    lastActivityAt: z.string().nullable(),
});

const ErrorResponse = z.object({ error: z.string() });

type TaskStats = {
    total: number;
    todo: number;
    inProgress: number;
    review: number;
    done: number;
    blocked: number;
};

type TokenUsage = {
    total: number;
    byModel: {
        opus: number;
        sonnet: number;
        haiku: number;
    };
};

type ModelDistributionPoint = z.infer<typeof ModelDistributionItemSchema>;

type UsageAggregation = {
    tokenUsage: TokenUsage;
    modelDistribution: ModelDistributionPoint[];
    totalCost: number;
};

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

function parseBoardPayload(artifactBody: Uint8Array | null): Record<string, any> {
    if (!artifactBody || artifactBody.length === 0) return {};
    return parseTeamArtifactBody(artifactBody) as Record<string, any>;
}

function emptyTaskStats(): TaskStats {
    return { total: 0, todo: 0, inProgress: 0, review: 0, done: 0, blocked: 0 };
}

function normalizeTaskStatus(status: unknown): Exclude<keyof TaskStats, 'total'> | null {
    const normalized = String(status ?? '').trim().toLowerCase();
    if (!normalized) return null;

    if (normalized === 'todo' || normalized === 'to-do') return 'todo';
    if (normalized === 'in-progress' || normalized === 'in_progress' || normalized === 'inprogress') return 'inProgress';
    if (normalized === 'review') return 'review';
    if (normalized === 'done' || normalized === 'completed' || normalized === 'complete') return 'done';
    if (normalized === 'blocked' || normalized === 'block' || normalized === 'on-hold' || normalized === 'on_hold') return 'blocked';
    return null;
}

function deriveTaskStatsFromArtifactBody(artifactBody: Uint8Array | null): TaskStats {
    const stats = emptyTaskStats();
    if (!artifactBody) return stats;

    try {
        const board = parseTeamArtifactBody(artifactBody) as Record<string, any>;
        const tasks = Array.isArray(board?.tasks) ? board.tasks : [];
        for (const task of tasks) {
            const status = normalizeTaskStatus(task?.status);
            if (!status) continue;
            stats.total += 1;
            stats[status] += 1;
        }
    } catch {
        return stats;
    }

    return stats;
}

async function countTeamMessages(userId: string, teamId: string): Promise<number> {
    const teamMessageStore = (db as any).teamMessage;
    if (teamMessageStore?.count) {
        return teamMessageStore.count({ where: { teamId } });
    }

    return db.userKVStore.count({
        where: {
            accountId: userId,
            key: { startsWith: `team_messages.${teamId}.` },
            value: { not: null }
        }
    });
}

async function deriveTaskStats(userId: string, teamId: string, artifactBody: Uint8Array | null): Promise<TaskStats> {
    const teamMessageStore = (db as any).teamMessage;
    if (teamMessageStore?.findMany) {
        const taskMessages = await teamMessageStore.findMany({
            where: {
                teamId,
                type: 'task'
            },
            select: { content: true }
        });

        const stats = emptyTaskStats();
        for (const msg of taskMessages as Array<{ content?: unknown }>) {
            try {
                const data = JSON.parse(String(msg.content ?? '{}'));
                const status = normalizeTaskStatus(data?.status);
                if (!status) continue;
                stats.total += 1;
                stats[status] += 1;
            } catch {
                // Skip invalid task data
            }
        }

        return stats;
    }

    // Fallback for current Prisma schema: derive from kanban artifact board tasks.
    return deriveTaskStatsFromArtifactBody(artifactBody);
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

function parseJsonBlob(value: unknown): any | null {
    if (value === null || value === undefined) return null;

    try {
        if (typeof value === 'string') {
            return JSON.parse(value);
        }
        if (value instanceof Uint8Array) {
            return JSON.parse(Buffer.from(value).toString('utf8'));
        }
        if (Buffer.isBuffer(value)) {
            return JSON.parse(value.toString('utf8'));
        }
        if (typeof value === 'object') {
            return value;
        }
    } catch {
        return null;
    }

    return null;
}

function readTokenCount(data: any): number {
    if (typeof data?.tokens === 'number') return data.tokens;
    if (typeof data?.tokens?.total === 'number') return data.tokens.total;
    return 0;
}

function readCostCount(data: any): number {
    if (typeof data?.cost === 'number') return data.cost;
    if (typeof data?.cost?.total === 'number') return data.cost.total;
    return 0;
}

function resolvePeriodStartTime(period: string): number {
    const now = Date.now();
    switch (period) {
        case 'day':
            return now - 24 * 60 * 60 * 1000;
        case 'week':
            return now - 7 * 24 * 60 * 60 * 1000;
        case 'month':
            return now - 30 * 24 * 60 * 60 * 1000;
        case 'all':
        default:
            return 0;
    }
}

function aggregateUsageRecords(records: Array<{ value: unknown }>): UsageAggregation {
    const tokenUsage: TokenUsage = {
        total: 0,
        byModel: { opus: 0, sonnet: 0, haiku: 0 }
    };
    const modelCounts = new Map<string, number>();
    let totalCost = 0;

    for (const record of records) {
        const data = parseJsonBlob(record.value);
        if (!data) continue;

        const tokens = readTokenCount(data);
        const cost = readCostCount(data);
        if (tokens <= 0 && cost <= 0) continue;

        totalCost += cost;

        if (tokens <= 0) {
            continue;
        }

        tokenUsage.total += tokens;

        const model = String(data.model || '').trim().toLowerCase();
        const modelKey = model || 'unknown';
        modelCounts.set(modelKey, (modelCounts.get(modelKey) || 0) + tokens);

        if (model.includes('opus')) tokenUsage.byModel.opus += tokens;
        else if (model.includes('sonnet')) tokenUsage.byModel.sonnet += tokens;
        else if (model.includes('haiku')) tokenUsage.byModel.haiku += tokens;
    }

    const modelDistribution = Array.from(modelCounts.entries())
        .map(([model, tokenCount]) => ({
            model,
            tokenCount,
            percentage: tokenUsage.total > 0
                ? Math.round((tokenCount / tokenUsage.total) * 100)
                : 0,
        }))
        .sort((left, right) => right.tokenCount - left.tokenCount);

    return {
        tokenUsage,
        modelDistribution,
        totalCost,
    };
}

export function teamStatsRoutes(app: Fastify) {
    log({ module: 'api' }, 'Registering teamStatsRoutes...');

    /**
     * GET /v1/teams/:teamId/board
     * Read team board snapshot for board tab initialization
     */
    app.get('/v1/teams/:teamId/board', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            response: {
                200: TeamBoardSchema,
                404: ErrorResponse,
                500: ErrorResponse
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };

        try {
            const artifact = await db.artifact.findFirst({
                where: {
                    id: teamId,
                    accountId: userId
                },
                select: {
                    id: true,
                    body: true,
                    updatedAt: true
                }
            });

            if (!artifact) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            const rawBoard = parseBoardPayload((artifact as { body: Uint8Array | null }).body);
            const teamData = (rawBoard?.team && typeof rawBoard.team === 'object') ? rawBoard.team : {};
            const members = Array.isArray((teamData as any).members) ? (teamData as any).members : [];
            const roles = Array.isArray((teamData as any).roles) ? (teamData as any).roles : [];
            const tasks = Array.isArray(rawBoard?.tasks) ? rawBoard.tasks : [];
            const version = typeof rawBoard?.version === 'number' ? rawBoard.version : 1;
            const boardUpdatedAt = typeof rawBoard?.updatedAt === 'number'
                ? rawBoard.updatedAt
                : artifact.updatedAt?.getTime?.() || null;
            const boardName = typeof rawBoard?.name === 'string'
                ? rawBoard.name
                : (typeof (teamData as any)?.name === 'string' ? (teamData as any).name : null);
            const taskStats = deriveTaskStatsFromArtifactBody(artifact.body);

            return reply.send({
                teamId,
                board: {
                    name: boardName,
                    version,
                    updatedAt: boardUpdatedAt,
                    team: {
                        members,
                        roles,
                        agreements: (teamData as any)?.agreements ?? null,
                    },
                    tasks,
                },
                summary: {
                    memberCount: members.length,
                    taskStats
                }
            });
        } catch (error: any) {
            log({ module: 'team-stats', level: 'error', teamId },
                `Failed to get board snapshot: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    /**
     * GET /v1/teams/:teamId/info
     * Lightweight info tab payload for dashboard/CLI side panels
     */
    app.get('/v1/teams/:teamId/info', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            querystring: z.object({
                period: z.enum(['day', 'week', 'month', 'all']).optional().default('week')
            }),
            response: {
                200: TeamInfoSchema,
                404: ErrorResponse,
                500: ErrorResponse
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const { period } = request.query as { period: string };

        try {
            const artifact = await db.artifact.findFirst({
                where: {
                    id: teamId,
                    accountId: userId
                },
                select: {
                    id: true,
                    body: true,
                    updatedAt: true
                }
            });

            if (!artifact) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            const board = parseBoardPayload((artifact as { body: Uint8Array | null }).body);
            const teamBlock = (board?.team && typeof board.team === 'object') ? board.team as Record<string, any> : {};
            const members = Array.isArray(teamBlock?.members) ? teamBlock.members : [];
            const sessionIds = members.map((m: any) => m?.sessionId).filter(Boolean) as string[];

            const activeSessions = await db.session.findMany({
                where: {
                    accountId: userId,
                    id: { in: sessionIds },
                    lastActiveAt: {
                        gte: new Date(Date.now() - 24 * 60 * 60 * 1000)
                    }
                },
                select: { id: true }
            });

            const startTime = resolvePeriodStartTime(period);
            const messageCount = await countTeamMessages(userId, teamId);
            const taskStats = await deriveTaskStats(userId, teamId, artifact.body);

            const usageRecords = await db.userKVStore.findMany({
                where: {
                    accountId: userId,
                    key: { startsWith: `usage:${teamId}:` },
                    ...(startTime > 0 ? { updatedAt: { gte: new Date(startTime) } } : {})
                }
            });

            const { tokenUsage } = aggregateUsageRecords(usageRecords);

            const name = typeof board?.name === 'string'
                ? board.name
                : (typeof teamBlock?.name === 'string' ? teamBlock.name : null);

            return reply.send({
                teamId,
                period,
                name,
                memberCount: members.length,
                activeMemberCount: activeSessions.length,
                messageCount,
                taskStats,
                tokenUsage,
                lastActivityAt: artifact.updatedAt?.toISOString() || null
            });
        } catch (error: any) {
            log({ module: 'team-stats', level: 'error', teamId },
                `Failed to get team info: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    /**
     * GET /v1/teams/:teamId/stats
     * Get PRD R7 team stats (memberCount, taskStats, tokenUsage, codeMetrics)
     */
    app.get('/v1/teams/:teamId/stats', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            querystring: z.object({
                period: z.enum(['day', 'week', 'month', 'all']).optional().default('week')
            }),
            response: {
                200: PRDTeamStatsSchema,
                404: ErrorResponse,
                500: ErrorResponse
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const { period } = request.query as { period: string };

        try {
            // Verify team exists and user has access
            const team = await db.artifact.findFirst({
                where: {
                    id: teamId,
                    accountId: userId
                },
                select: { id: true, body: true, updatedAt: true }
            });

            if (!team) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            // Extract session IDs from team body
            const sessionIds = extractSessionIdsFromTeam(team.body);

            // Get member count
            const memberCount = sessionIds.length;
            const startTime = resolvePeriodStartTime(period);

            // Get active members (sessions with recent activity)
            const activeSessions = await db.session.findMany({
                where: {
                    accountId: userId,
                    id: { in: sessionIds },
                    lastActiveAt: {
                        gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Active in last 24h
                    }
                },
                select: { id: true }
            });
            const activeMemberCount = activeSessions.length;

            // Get message count
            const messageCount = await countTeamMessages(userId, teamId);
            const taskStats = await deriveTaskStats(userId, teamId, team.body);

            // Get token usage by model
            const usageRecords = await db.userKVStore.findMany({
                where: {
                    accountId: userId,
                    key: { startsWith: `usage:${teamId}:` },
                    ...(startTime > 0 ? { updatedAt: { gte: new Date(startTime) } } : {})
                }
            });

            const { tokenUsage, modelDistribution, totalCost } = aggregateUsageRecords(usageRecords);

            // Get code metrics from simpleCache
            const codeMetricsRecords = await db.simpleCache.findMany({
                where: {
                    key: { startsWith: `code-metrics:${teamId}:` },
                    ...(startTime > 0 ? { updatedAt: { gte: new Date(startTime) } } : {})
                }
            });

            let codeMetrics = { totalCommits: 0, totalLinesChanged: 0, totalFilesChanged: 0 };
            for (const record of codeMetricsRecords) {
                try {
                    const data = JSON.parse(record.value as string);
                    codeMetrics.totalCommits += data.commits || 0;
                    codeMetrics.totalLinesChanged += (data.insertions || 0) + (data.deletions || 0);
                    codeMetrics.totalFilesChanged += data.filesChanged || 0;
                } catch {
                    // Skip invalid metrics
                }
            }

            const estimatedBudget = Number(process.env.TEAM_STATS_BUDGET_USD || 100);
            const safeEstimatedBudget = Number.isFinite(estimatedBudget) && estimatedBudget > 0 ? estimatedBudget : 100;
            const budgetUtilization = Number(((totalCost / safeEstimatedBudget) * 100).toFixed(2));

            const result = {
                teamId,
                period,
                memberCount,
                activeMemberCount,
                messageCount,
                taskStats,
                tokenUsage,
                modelDistribution,
                codeMetrics,
                costMetrics: {
                    totalCost: Number(totalCost.toFixed(6)),
                    estimatedBudget: safeEstimatedBudget,
                    budgetUtilization
                },
                lastActivityAt: team.updatedAt?.toISOString() || null
            };

            return reply.send(result);

        } catch (error: any) {
            log({ module: 'team-stats', level: 'error', teamId },
                `Failed to get PRD stats: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    /**
     * POST /v1/teams/stats/batch
     * Get stats for multiple teams (for team list preview)
     */
    app.post('/v1/teams/stats/batch', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                teamIds: z.array(z.string()).max(50)
            }),
            response: {
                200: BatchStatsSchema,
                500: ErrorResponse
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamIds } = request.body as { teamIds: string[] };

        try {
            const result: Record<string, any> = {};

            for (const teamId of teamIds) {
                // Get team
                const team = await db.artifact.findFirst({
                    where: {
                        id: teamId,
                        accountId: userId
                    },
                    select: { id: true, body: true }
                });

                if (!team) continue;

                // Extract session IDs
                const sessionIds = extractSessionIdsFromTeam(team.body);

                // Get message count
                const messageCount = await countTeamMessages(userId, teamId);
                const taskStats = await deriveTaskStats(userId, teamId, team.body);

                result[teamId] = {
                    memberCount: sessionIds.length,
                    messageCount,
                    taskStats: {
                        total: taskStats.total,
                        todo: taskStats.todo,
                        inProgress: taskStats.inProgress,
                        done: taskStats.done
                    }
                };
            }

            return reply.send(result);

        } catch (error: any) {
            log({ module: 'team-stats', level: 'error' },
                `Failed to get batch stats: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    /**
     * GET /v1/teams/:teamId/usage/models
     * Get model usage distribution (for Info tab chart)
     */
    app.get('/v1/teams/:teamId/usage/models', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({ teamId: z.string() }),
            querystring: z.object({
                period: z.enum(['day', 'week', 'month']).optional().default('week')
            }),
            response: {
                200: ModelDistributionSchema,
                404: ErrorResponse,
                500: ErrorResponse
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { teamId } = request.params as { teamId: string };
        const { period } = request.query as { period: string };

        try {
            // Verify team exists
            const team = await db.artifact.findFirst({
                where: {
                    id: teamId,
                    accountId: userId
                }
            });

            if (!team) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            // Calculate time range
            const startTime = resolvePeriodStartTime(period);

            // Get usage records
            const usageRecords = await db.userKVStore.findMany({
                where: {
                    accountId: userId,
                    key: { startsWith: `usage:${teamId}:` },
                    updatedAt: { gte: new Date(startTime) }
                }
            });

            // Aggregate by model
            const { modelDistribution } = aggregateUsageRecords(usageRecords);

            return reply.send({ distribution: modelDistribution });

        } catch (error: any) {
            log({ module: 'team-stats', level: 'error', teamId },
                `Failed to get model usage: ${error}`);
            return reply.code(500).send({ error: error.message });
        }
    });

    /**
     * GET /v1/teams/:teamId/stats/legacy
     * Legacy aggregated stats endpoint (kept for backwards compatibility)
     */
    app.get('/v1/teams/:teamId/stats/legacy', {
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
                where: {
                    id: teamId,
                    accountId: userId
                }
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
                where: {
                    id: teamId,
                    accountId: userId
                }
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
                where: {
                    id: teamId,
                    accountId: userId
                }
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
