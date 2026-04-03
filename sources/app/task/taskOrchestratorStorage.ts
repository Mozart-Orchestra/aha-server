import { eventRouter } from '@/app/events/eventRouter';
import { getAccessibleTeamArtifact } from '@/app/team/teamArtifacts';
import { allocateUserSeq } from '@/storage/seq';
import { db } from '@/storage/db';
import { parseTeamArtifactBody } from '@/utils/teamArtifacts';
import { log } from '@/utils/log';
import { randomKeyNaked } from '@/utils/randomKeyNaked';

import {
    DEFAULT_COLUMNS,
    type KanbanBoard,
    type KanbanTask,
    type TaskBoardEventType,
} from './taskOrchestratorTypes';

export async function getBoardFromArtifact(userId: string, teamId: string): Promise<KanbanBoard | null> {
    const artifact = await getAccessibleTeamArtifact(userId, teamId);

    if (!artifact) {
        log(
            { module: 'task-orchestrator', teamId, userId, level: 'warn' },
            'Team artifact not found or inaccessible. Team must exist and be accessible to the caller before task operations can proceed.',
        );
        return null;
    }

    if (!artifact.body) {
        log(
            { module: 'task-orchestrator', teamId, userId, level: 'warn' },
            'Team artifact exists but body is null - team initialization incomplete. Please open team in Kanban to complete setup.',
        );
        return null;
    }

    try {
        const parsed = parseTeamArtifactBody(artifact.body) as Record<string, any>;
        return {
            columns: parsed.columns || DEFAULT_COLUMNS,
            tasks: parsed.tasks || [],
            version: parsed.version || artifact.bodyVersion,
            updatedAt: parsed.updatedAt || artifact.updatedAt.getTime(),
            team: parsed.team,
        };
    } catch {
        return {
            columns: DEFAULT_COLUMNS,
            tasks: [],
            version: artifact.bodyVersion,
            updatedAt: artifact.updatedAt.getTime(),
        };
    }
}

export async function saveBoardToArtifact(
    userId: string,
    teamId: string,
    board: KanbanBoard,
    eventType: TaskBoardEventType,
    taskId: string,
    taskData?: Partial<KanbanTask>,
): Promise<void> {
    const artifact = await getAccessibleTeamArtifact(userId, teamId);
    if (!artifact) {
        log(
            { module: 'task-orchestrator', teamId, userId, level: 'warn' },
            'Refusing to persist task board for missing or inaccessible team artifact.',
        );
        throw new Error('Team not found');
    }

    board.version = (board.version || 0) + 1;
    board.updatedAt = Date.now();

    const bodyBuffer = Buffer.from(JSON.stringify(board));

    await db.artifact.update({
        where: { id: artifact.id },
        data: {
            body: bodyBuffer,
            bodyVersion: { increment: 1 },
            updatedAt: new Date(),
        },
    });

    await broadcastTaskEvent(userId, teamId, eventType, taskId, taskData);
}

async function broadcastTaskEvent(
    userId: string,
    teamId: string,
    eventType: TaskBoardEventType,
    taskId: string,
    taskData?: Partial<KanbanTask>,
): Promise<void> {
    const updSeq = await allocateUserSeq(userId);

    const payload = {
        id: randomKeyNaked(12),
        seq: updSeq,
        body: {
            t: eventType,
            teamId,
            taskId,
            task: taskData,
        },
        createdAt: Date.now(),
    };

    const allSessions = await db.session.findMany({
        where: { accountId: userId },
        select: { id: true },
    });

    const teamSessionIds = new Set<string>();
    for (const session of allSessions) {
        teamSessionIds.add(session.id);
    }

    if (teamSessionIds.size > 0) {
        eventRouter.emitUpdate({
            userId,
            payload,
            recipientFilter: { type: 'specific-sessions', sessionIds: teamSessionIds },
        });

        log(
            { module: 'task-orchestrator', teamId, taskId },
            `Broadcasted ${eventType} to ${teamSessionIds.size} sessions`,
        );
        return;
    }

    eventRouter.emitUpdate({
        userId,
        payload,
        recipientFilter: { type: 'all-user-authenticated-connections' },
    });

    log(
        { module: 'task-orchestrator', teamId, taskId },
        `Broadcasted ${eventType} (fallback to all connections)`,
    );
}
