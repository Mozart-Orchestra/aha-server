import { db } from "@/storage/db";
import type { AgentLifecycle } from "./spawnState";
import { parseTeamArtifactBody } from "@/utils/teamArtifacts";

type ArtifactLike = {
    id: string;
    accountId: string;
    body: Uint8Array | null;
    bodyVersion: number;
    createdAt: Date;
    updatedAt: Date;
};

export type TeamMemberRecord = {
    memberId?: string;
    sessionId: string;
    sessionTag?: string;
    candidateId?: string;
    roleId?: string;
    role?: string;
    displayName?: string;
    focusAreas?: string[];
    joinedAt?: number;
    sourceImageId?: string;
    sourceImageVersion?: number | null;
    specId?: string;
    genomeId?: string;
    genomeVersion?: number | null;
    customPrompt?: string;
    parentSessionId?: string;
    executionPlane?: string;
    runtimeType?: string;
    machineId?: string;
    machineName?: string;
    workspacePath?: string;
    spawnError?: string;
    lifecycle?: AgentLifecycle;
    [key: string]: unknown;
};

export type TeamSummary = {
    id: string;
    name: string;
    memberCount: number;
    taskCount: number;
    members?: TeamMemberRecord[];
    createdAt: number;
    updatedAt: number;
};

export type TeamMirrorMember = {
    memberId?: string;
    sessionId: string;
    sessionTag?: string;
    roleId?: string;
    displayName?: string;
    executionPlane?: string;
    runtimeType?: string;
    specId?: string;
    genomeId?: string;
    genomeVersion?: number | null;
    sourceImageId?: string;
    sourceImageVersion?: number | null;
    workspacePath?: string;
    machineId?: string;
    machineName?: string;
    lifecycle?: AgentLifecycle;
};

export type TeamMirrorTask = {
    id: string;
    title: string;
    status: string;
    priority: string | null;
    assigneeId: string | null;
    parentTaskId: string | null;
    approvalStatus: string | null;
    labels: string[];
    acceptanceCriteria: string[];
    commentCount: number;
    blockerCount: number;
    updatedAt: number | null;
};

export type TeamMirrorTaskCounts = {
    members: number;
    tasks: number;
    todo: number;
    inProgress: number;
    review: number;
    blocked: number;
    done: number;
};

export type TeamMirrorSnapshot = {
    sourceOfTruth: {
        artifactId: string;
        artifactBodyVersion: number;
        artifactUpdatedAt: number;
        source: 'team-artifact';
    };
    team: {
        id: string;
        name: string;
        description: string;
        createdAt: number;
        updatedAt: number;
        boardVersion: number | null;
    };
    goal: {
        initialObjective: string | null;
    };
    bootContext: Record<string, unknown> | null;
    projectMap: unknown | null;
    counts: TeamMirrorTaskCounts;
    members: TeamMirrorMember[];
    tasks: TeamMirrorTask[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toMirrorMembers(members: TeamMemberRecord[]): TeamMirrorMember[] {
    return members.map((member) => ({
        ...(typeof member.memberId === 'string' ? { memberId: member.memberId } : {}),
        sessionId: member.sessionId,
        ...(typeof member.sessionTag === 'string' ? { sessionTag: member.sessionTag } : {}),
        ...(typeof member.roleId === 'string' ? { roleId: member.roleId } : {}),
        ...(typeof member.displayName === 'string' ? { displayName: member.displayName } : {}),
        ...(typeof member.executionPlane === 'string' ? { executionPlane: member.executionPlane } : {}),
        ...(typeof member.runtimeType === 'string' ? { runtimeType: member.runtimeType } : {}),
        ...(typeof member.specId === 'string' ? { specId: member.specId } : {}),
        ...(typeof member.genomeId === 'string' ? { genomeId: member.genomeId } : {}),
        ...(typeof member.genomeVersion === 'number' || member.genomeVersion === null
            ? { genomeVersion: member.genomeVersion ?? null }
            : {}),
        ...(typeof member.sourceImageId === 'string' ? { sourceImageId: member.sourceImageId } : {}),
        ...(typeof member.sourceImageVersion === 'number' || member.sourceImageVersion === null
            ? { sourceImageVersion: member.sourceImageVersion ?? null }
            : {}),
        ...(typeof member.workspacePath === 'string' ? { workspacePath: member.workspacePath } : {}),
        ...(typeof member.machineId === 'string' ? { machineId: member.machineId } : {}),
        ...(typeof member.machineName === 'string' ? { machineName: member.machineName } : {}),
        ...(member.lifecycle ? { lifecycle: member.lifecycle } : {}),
    }));
}

function toMirrorTasks(tasks: any[]): TeamMirrorTask[] {
    return tasks
        .filter((task) => task && typeof task.id === 'string' && !task.isDeleted)
        .map((task) => ({
            id: task.id,
            title: typeof task.title === 'string' ? task.title : task.id,
            status: typeof task.status === 'string' ? task.status : 'todo',
            priority: typeof task.priority === 'string' ? task.priority : null,
            assigneeId: typeof task.assigneeId === 'string' ? task.assigneeId : null,
            parentTaskId: typeof task.parentTaskId === 'string' ? task.parentTaskId : null,
            approvalStatus: typeof task.approvalStatus === 'string' ? task.approvalStatus : null,
            labels: Array.isArray(task.labels)
                ? task.labels.filter((value: unknown): value is string => typeof value === 'string')
                : [],
            acceptanceCriteria: Array.isArray(task.acceptanceCriteria)
                ? task.acceptanceCriteria.filter((value: unknown): value is string => typeof value === 'string')
                : [],
            commentCount: Array.isArray(task.comments) ? task.comments.length : 0,
            blockerCount: Array.isArray(task.blockers) ? task.blockers.length : 0,
            updatedAt: typeof task.updatedAt === 'number' ? task.updatedAt : null,
        }));
}

function buildTaskCounts(tasks: TeamMirrorTask[], memberCount: number): TeamMirrorTaskCounts {
    const counts: TeamMirrorTaskCounts = {
        members: memberCount,
        tasks: tasks.length,
        todo: 0,
        inProgress: 0,
        review: 0,
        blocked: 0,
        done: 0,
    };

    for (const task of tasks) {
        switch (task.status) {
            case 'todo':
                counts.todo += 1;
                break;
            case 'in-progress':
                counts.inProgress += 1;
                break;
            case 'review':
                counts.review += 1;
                break;
            case 'blocked':
                counts.blocked += 1;
                break;
            case 'done':
                counts.done += 1;
                break;
            default:
                break;
        }
    }

    return counts;
}

export function extractTeamBoard(artifact: Pick<ArtifactLike, 'body'>): Record<string, any> {
    if (!artifact.body) {
        return {};
    }
    return parseTeamArtifactBody(artifact.body) as Record<string, any>;
}

export function isTeamArtifact(artifact: Pick<ArtifactLike, 'body'>): boolean {
    const board = extractTeamBoard(artifact);
    if (board?.type === 'standalone') {
        return false;
    }
    return Array.isArray(board.tasks)
        || Array.isArray(board.columns)
        || (board.team && typeof board.team === 'object');
}

export function isArchivedTeamBoard(board: Record<string, any>): boolean {
    const archivedAt = board?.archivedAt ?? board?.team?.archivedAt;
    return typeof archivedAt === 'number' && archivedAt > 0;
}

export function extractTeamMembers(board: Record<string, any>): TeamMemberRecord[] {
    if (!Array.isArray(board?.team?.members)) {
        return [];
    }
    return board.team.members as TeamMemberRecord[];
}

export function extractTeamSessionIds(board: Record<string, any>): string[] {
    return extractTeamMembers(board)
        .map((member) => member?.sessionId)
        .filter((value): value is string => typeof value === 'string' && value.length > 0);
}

export function extractTeamName(board: Record<string, any>, fallbackId: string): string {
    const candidate = board?.team?.name || board?.name;
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
        return candidate.trim();
    }
    return `Team ${fallbackId.slice(0, 8)}`;
}

export function serializeTeamBoard(board: Record<string, any>): Buffer {
    return Buffer.from(JSON.stringify({ body: JSON.stringify(board) }));
}

export function summarizeTeamArtifact(
    artifact: Pick<ArtifactLike, 'id' | 'body' | 'createdAt' | 'updatedAt'>,
    opts?: { includeMembers?: boolean }
): TeamSummary {
    const board = extractTeamBoard(artifact);
    const members = extractTeamMembers(board);

    return {
        id: artifact.id,
        name: extractTeamName(board, artifact.id),
        memberCount: members.length,
        taskCount: Array.isArray(board.tasks) ? board.tasks.length : 0,
        ...(opts?.includeMembers ? { members } : {}),
        createdAt: artifact.createdAt.getTime(),
        updatedAt: artifact.updatedAt.getTime(),
    };
}

export function buildTeamMirrorSnapshot(
    artifact: Pick<ArtifactLike, 'id' | 'body' | 'bodyVersion' | 'createdAt' | 'updatedAt'>
): TeamMirrorSnapshot {
    const board = extractTeamBoard(artifact);
    const members = extractTeamMembers(board);
    const mirrorTasks = toMirrorTasks(Array.isArray(board.tasks) ? board.tasks : []);
    const rawBootContext = isPlainObject(board?.team?.bootContext) ? board.team.bootContext : null;
    const projectMap = board?.projectMap ?? board?.team?.projectMap ?? rawBootContext?.projectMap ?? null;

    return {
        sourceOfTruth: {
            artifactId: artifact.id,
            artifactBodyVersion: artifact.bodyVersion,
            artifactUpdatedAt: artifact.updatedAt.getTime(),
            source: 'team-artifact',
        },
        team: {
            id: artifact.id,
            name: extractTeamName(board, artifact.id),
            description: typeof board.description === 'string' ? board.description : '',
            createdAt: artifact.createdAt.getTime(),
            updatedAt: artifact.updatedAt.getTime(),
            boardVersion: typeof board.version === 'number' ? board.version : null,
        },
        goal: {
            initialObjective: typeof rawBootContext?.initialObjective === 'string'
                ? rawBootContext.initialObjective
                : null,
        },
        bootContext: rawBootContext ? {
            ...(typeof rawBootContext.teamDescription === 'string' ? { teamDescription: rawBootContext.teamDescription } : {}),
            ...(typeof rawBootContext.initialObjective === 'string' ? { initialObjective: rawBootContext.initialObjective } : {}),
        } : null,
        projectMap,
        counts: buildTaskCounts(mirrorTasks, members.length),
        members: toMirrorMembers(members),
        tasks: mirrorTasks,
    };
}

export async function getAccessibleTeamArtifact(userId: string, teamId: string, options?: { includeArchived?: boolean }): Promise<ArtifactLike | null> {
    const artifact = await db.artifact.findUnique({
        where: { id: teamId },
        select: {
            id: true,
            accountId: true,
            body: true,
            bodyVersion: true,
            createdAt: true,
            updatedAt: true,
        },
    });

    if (!artifact || !isTeamArtifact(artifact)) {
        return null;
    }

    const board = extractTeamBoard(artifact);
    if (!options?.includeArchived && isArchivedTeamBoard(board)) {
        return null;
    }

    if (artifact.accountId === userId) {
        return artifact;
    }

    const memberSessionIds = extractTeamMembers(board)
        .map(member => member?.sessionId)
        .filter((value): value is string => typeof value === 'string' && value.length > 0);

    if (memberSessionIds.length === 0) {
        return null;
    }

    const session = await db.session.findFirst({
        where: {
            accountId: userId,
            id: { in: memberSessionIds },
        },
        select: { id: true },
    });

    return session ? artifact : null;
}

export async function getTeamMemberSessionIds(teamId: string): Promise<string[]> {
    const artifact = await db.artifact.findUnique({
        where: { id: teamId },
        select: { body: true },
    });

    if (!artifact || !isTeamArtifact(artifact)) {
        return [];
    }

    return extractTeamSessionIds(extractTeamBoard(artifact));
}

export async function listAccessibleTeamArtifacts(userId: string): Promise<ArtifactLike[]> {
    const [artifacts, sessions] = await Promise.all([
        db.artifact.findMany({
            orderBy: { updatedAt: 'desc' },
            select: {
                id: true,
                accountId: true,
                body: true,
                bodyVersion: true,
                createdAt: true,
                updatedAt: true,
            },
        }),
        db.session.findMany({
            where: { accountId: userId },
            select: { id: true },
        }),
    ]);

    const ownedOrMembershipSessionIds = new Set(sessions.map(session => session.id));

    return artifacts.filter(artifact => {
        if (!isTeamArtifact(artifact)) {
            return false;
        }

        const board = extractTeamBoard(artifact);
        if (isArchivedTeamBoard(board)) {
            return false;
        }

        if (artifact.accountId === userId) {
            return true;
        }

        return extractTeamMembers(board).some(member => ownedOrMembershipSessionIds.has(member.sessionId));
    });
}
