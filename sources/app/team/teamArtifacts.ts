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
