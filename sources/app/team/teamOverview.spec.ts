import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/storage/db', () => ({
    db: {
        usageReport: {
            findMany: vi.fn(),
        },
    },
}));

vi.mock('@/storage/redis', () => ({
    redis: {
        get: vi.fn(),
        set: vi.fn(),
        del: vi.fn(),
    },
}));

vi.mock('@/app/team/teamArtifacts', () => ({
    listAccessibleTeamArtifacts: vi.fn(),
    extractTeamBoard: vi.fn(),
    extractTeamMembers: vi.fn(),
    extractTeamName: vi.fn(),
}));

import { db } from '@/storage/db';
import { redis } from '@/storage/redis';
import {
    computeTeamOverviewSnapshot,
    getTeamOverviewSnapshot,
    invalidateTeamOverviewSnapshot,
} from '@/app/team/teamOverview';
import {
    extractTeamBoard,
    extractTeamMembers,
    extractTeamName,
    listAccessibleTeamArtifacts,
} from '@/app/team/teamArtifacts';

function buildArtifact(id: string) {
    return {
        id,
        accountId: 'user-1',
        body: Buffer.from('team-body'),
        createdAt: new Date('2026-03-19T00:00:00Z'),
        updatedAt: new Date('2026-03-19T00:05:00Z'),
    };
}

describe('teamOverview', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('aggregates persisted team usage and completed task counts', async () => {
        vi.mocked(listAccessibleTeamArtifacts).mockResolvedValue([
            buildArtifact('team-1'),
            buildArtifact('team-2'),
        ] as never);
        vi.mocked(extractTeamBoard)
            .mockReturnValueOnce({
                tasks: [
                    { id: 'task-1', status: 'done' },
                    { id: 'task-2', status: 'todo' },
                ],
            } as never)
            .mockReturnValueOnce({
                tasks: [
                    { id: 'task-3', status: 'done' },
                    { id: 'task-4', status: 'done', isDeleted: true },
                ],
            } as never);
        vi.mocked(extractTeamMembers)
            .mockReturnValueOnce([
                { sessionId: 'session-1', displayName: 'Builder', roleId: 'builder' },
                { sessionId: 'session-2', displayName: 'Reviewer', roleId: 'reviewer' },
            ] as never)
            .mockReturnValueOnce([
                { sessionId: 'session-2', displayName: 'Reviewer', roleId: 'reviewer' },
            ] as never);
        vi.mocked(extractTeamName)
            .mockReturnValueOnce('Backend Team' as never)
            .mockReturnValueOnce('Review Team' as never);
        vi.mocked(db.usageReport.findMany).mockResolvedValue([
            { sessionId: 'session-1', data: { tokens: { total: 1200 }, cost: { total: 1 } } },
            { sessionId: 'session-2', data: { tokens: { total: 800 }, cost: { total: 1 } } },
            { sessionId: 'session-2', data: { tokens: { total: 200 }, cost: { total: 1 } } },
        ] as never);

        const overview = await computeTeamOverviewSnapshot('user-1');

        expect(overview.teamCount).toBe(2);
        expect(overview.teamTotalTokens).toBe(3200);
        expect(overview.agentTotalTokens).toBe(2200);
        expect(overview.completedTasksTotal).toBe(2);
        expect(overview.teamUsageItems).toEqual([
            { id: 'team-1', label: 'Backend Team', tokens: 2200 },
            { id: 'team-2', label: 'Review Team', tokens: 1000 },
        ]);
        expect(overview.agentUsageItems).toEqual([
            { id: 'session-1', label: 'Builder · builder', tokens: 1200 },
            { id: 'session-2', label: 'Reviewer · reviewer', tokens: 1000 },
        ]);
        expect(overview.completedTaskItems).toEqual([
            { id: 'team-1', label: 'Backend Team', completedTasks: 1 },
            { id: 'team-2', label: 'Review Team', completedTasks: 1 },
        ]);
    });

    it('returns cached snapshots when redis already has one', async () => {
        vi.mocked(redis.get).mockResolvedValue(JSON.stringify({
            generatedAt: 1710800000000,
            teamCount: 1,
            teamTotalTokens: 100,
            agentTotalTokens: 100,
            completedTasksTotal: 1,
            teamUsageItems: [],
            agentUsageItems: [],
            completedTaskItems: [],
        }) as never);

        const overview = await getTeamOverviewSnapshot('user-1');

        expect(overview.teamCount).toBe(1);
        expect(listAccessibleTeamArtifacts).not.toHaveBeenCalled();
        expect(db.usageReport.findMany).not.toHaveBeenCalled();
    });

    it('invalidates the cached snapshot key', async () => {
        await invalidateTeamOverviewSnapshot('user-1');
        expect(redis.del).toHaveBeenCalledWith('team-overview:user-1');
    });
});
