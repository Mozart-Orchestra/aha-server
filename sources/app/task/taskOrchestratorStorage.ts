import { eventRouter } from '@/app/events/eventRouter';
import { getAccessibleTeamArtifact, getTeamMemberSessionIds } from '@/app/team/teamArtifacts';
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

export interface ArtifactRef {
    id: string;
    bodyVersion: number;
}

export interface BoardWithRef {
    board: KanbanBoard;
    artifactRef: ArtifactRef;
}

export async function getBoardFromArtifact(userId: string, teamId: string): Promise<BoardWithRef | null> {
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

    const artifactRef: ArtifactRef = { id: artifact.id, bodyVersion: artifact.bodyVersion };

    try {
        const parsed = parseTeamArtifactBody(artifact.body) as Record<string, any>;
        return {
            board: {
                columns: parsed.columns || DEFAULT_COLUMNS,
                tasks: parsed.tasks || [],
                version: parsed.version || artifact.bodyVersion,
                updatedAt: parsed.updatedAt || artifact.updatedAt.getTime(),
                team: parsed.team,
            },
            artifactRef,
        };
    } catch {
        return {
            board: {
                columns: DEFAULT_COLUMNS,
                tasks: [],
                version: artifact.bodyVersion,
                updatedAt: artifact.updatedAt.getTime(),
            },
            artifactRef,
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
    artifactRef?: ArtifactRef,
): Promise<ArtifactRef> {
    if (!artifactRef) {
        const artifact = await getAccessibleTeamArtifact(userId, teamId);
        if (!artifact) {
            log(
                { module: 'task-orchestrator', teamId, userId, level: 'warn' },
                'Refusing to persist task board for missing or inaccessible team artifact.',
            );
            throw new Error('Team not found');
        }
        artifactRef = { id: artifact.id, bodyVersion: artifact.bodyVersion };
    }

    board.version = (board.version || 0) + 1;
    board.updatedAt = Date.now();

    const bodyBuffer = Buffer.from(JSON.stringify(board));

    const result = await db.artifact.updateMany({
        where: { id: artifactRef.id, bodyVersion: artifactRef.bodyVersion },
        data: {
            body: bodyBuffer,
            bodyVersion: { increment: 1 },
            updatedAt: new Date(),
        },
    });

    if (result.count === 0) {
        throw new Error('Concurrent write conflict - board was modified by another operation, please retry');
    }

    const updatedRef: ArtifactRef = { id: artifactRef.id, bodyVersion: artifactRef.bodyVersion + 1 };

    await broadcastTaskEvent(userId, teamId, eventType, taskId, taskData);

    return updatedRef;
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

    const teamSessionIds = new Set(await getTeamMemberSessionIds(teamId));

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
