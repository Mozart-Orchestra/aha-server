import { db } from '@/storage/db';
import { redis } from '@/storage/redis';
import { log } from '@/utils/log';
import {
    extractTeamBoard,
    extractTeamMembers,
    extractTeamName,
    listAccessibleTeamArtifacts,
} from '@/app/team/teamArtifacts';

const TEAM_OVERVIEW_CACHE_PREFIX = 'team-overview';
const TEAM_OVERVIEW_CACHE_TTL_SECONDS = 10;

type TeamOverviewUsageItem = {
    id: string;
    label: string;
    tokens: number;
};

type TeamOverviewCompletedItem = {
    id: string;
    label: string;
    completedTasks: number;
};

export interface TeamOverviewSnapshot {
    generatedAt: number;
    teamCount: number;
    teamTotalTokens: number;
    agentTotalTokens: number;
    completedTasksTotal: number;
    teamUsageItems: TeamOverviewUsageItem[];
    agentUsageItems: TeamOverviewUsageItem[];
    completedTaskItems: TeamOverviewCompletedItem[];
}

function getCacheKey(userId: string): string {
    return `${TEAM_OVERVIEW_CACHE_PREFIX}:${userId}`;
}

function getUsageTokenTotal(data: unknown): number {
    const usage = data as Partial<PrismaJson.UsageReportData> | null | undefined;
    return typeof usage?.tokens?.total === 'number' ? usage.tokens.total : 0;
}

function formatSessionLabel(member: Record<string, unknown>, sessionId: string): string {
    const displayName = typeof member.displayName === 'string' && member.displayName.trim().length > 0
        ? member.displayName.trim()
        : null;
    const role = typeof member.role === 'string' && member.role.trim().length > 0
        ? member.role.trim()
        : typeof member.roleId === 'string' && member.roleId.trim().length > 0
            ? member.roleId.trim()
            : null;

    if (displayName && role && displayName !== role) {
        return `${displayName} · ${role}`;
    }

    return displayName ?? role ?? sessionId;
}

async function readCachedSnapshot(userId: string): Promise<TeamOverviewSnapshot | null> {
    try {
        const cached = await redis.get(getCacheKey(userId));
        if (!cached) {
            return null;
        }

        return JSON.parse(cached) as TeamOverviewSnapshot;
    } catch (error) {
        log({ module: 'team-overview', level: 'warn', userId }, `Failed to read team overview cache: ${error}`);
        return null;
    }
}

async function writeCachedSnapshot(userId: string, snapshot: TeamOverviewSnapshot): Promise<void> {
    try {
        await redis.set(getCacheKey(userId), JSON.stringify(snapshot), 'EX', TEAM_OVERVIEW_CACHE_TTL_SECONDS);
    } catch (error) {
        log({ module: 'team-overview', level: 'warn', userId }, `Failed to write team overview cache: ${error}`);
    }
}

export async function invalidateTeamOverviewSnapshot(userId: string): Promise<void> {
    try {
        await redis.del(getCacheKey(userId));
    } catch (error) {
        log({ module: 'team-overview', level: 'warn', userId }, `Failed to invalidate team overview cache: ${error}`);
    }
}

export async function computeTeamOverviewSnapshot(userId: string): Promise<TeamOverviewSnapshot> {
    const artifacts = await listAccessibleTeamArtifacts(userId);
    const sessionIds = new Set<string>();
    const sessionLabels = new Map<string, string>();

    const teamRows = artifacts.map((artifact) => {
        const board = extractTeamBoard(artifact);
        const members = extractTeamMembers(board);
        const teamSessionIds = new Set<string>();

        for (const member of members) {
            if (!member || typeof member.sessionId !== 'string' || member.sessionId.length === 0) {
                continue;
            }

            teamSessionIds.add(member.sessionId);
            sessionIds.add(member.sessionId);
            if (!sessionLabels.has(member.sessionId)) {
                sessionLabels.set(member.sessionId, formatSessionLabel(member as Record<string, unknown>, member.sessionId));
            }
        }

        const tasks = Array.isArray(board.tasks) ? board.tasks : [];
        const completedTasks = tasks.filter((task: any) => !task?.isDeleted && task?.status === 'done').length;

        return {
            id: artifact.id,
            label: extractTeamName(board, artifact.id),
            sessionIds: Array.from(teamSessionIds),
            completedTasks,
        };
    });

    const usageReports = sessionIds.size > 0
        ? await db.usageReport.findMany({
            where: {
                accountId: userId,
                sessionId: { in: Array.from(sessionIds) },
            },
            select: {
                sessionId: true,
                data: true,
            },
        })
        : [];

    const tokensBySessionId = new Map<string, number>();
    for (const report of usageReports) {
        if (!report.sessionId) {
            continue;
        }

        tokensBySessionId.set(
            report.sessionId,
            (tokensBySessionId.get(report.sessionId) ?? 0) + getUsageTokenTotal(report.data),
        );
    }

    const teamUsageRows = teamRows.map((team) => ({
        id: team.id,
        label: team.label,
        tokens: team.sessionIds.reduce((total, sessionId) => total + (tokensBySessionId.get(sessionId) ?? 0), 0),
        completedTasks: team.completedTasks,
    }));

    const agentUsageRows = Array.from(sessionIds).map((sessionId) => ({
        id: sessionId,
        label: sessionLabels.get(sessionId) ?? sessionId,
        tokens: tokensBySessionId.get(sessionId) ?? 0,
    }));

    return {
        generatedAt: Date.now(),
        teamCount: teamRows.length,
        teamTotalTokens: teamUsageRows.reduce((total, team) => total + team.tokens, 0),
        agentTotalTokens: agentUsageRows.reduce((total, agent) => total + agent.tokens, 0),
        completedTasksTotal: teamUsageRows.reduce((total, team) => total + team.completedTasks, 0),
        teamUsageItems: teamUsageRows
            .filter((team) => team.tokens > 0)
            .sort((a, b) => b.tokens - a.tokens)
            .slice(0, 4)
            .map(({ id, label, tokens }) => ({ id, label, tokens })),
        agentUsageItems: agentUsageRows
            .filter((agent) => agent.tokens > 0)
            .sort((a, b) => b.tokens - a.tokens)
            .slice(0, 4),
        completedTaskItems: teamUsageRows
            .filter((team) => team.completedTasks > 0)
            .sort((a, b) => b.completedTasks - a.completedTasks)
            .slice(0, 4)
            .map(({ id, label, completedTasks }) => ({ id, label, completedTasks })),
    };
}

export async function getTeamOverviewSnapshot(userId: string): Promise<TeamOverviewSnapshot> {
    const cached = await readCachedSnapshot(userId);
    if (cached) {
        return cached;
    }

    const snapshot = await computeTeamOverviewSnapshot(userId);
    await writeCachedSnapshot(userId, snapshot);
    return snapshot;
}
