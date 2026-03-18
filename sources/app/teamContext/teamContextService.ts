import { Prisma } from '@prisma/client';

import { db } from '@/storage/db';

export const TEAM_CONTEXT_KINDS = ['fact', 'summary', 'decision', 'artifact', 'blocker'] as const;
export type TeamContextKind = typeof TEAM_CONTEXT_KINDS[number];

export type TeamContextItem = {
    key: string;
    kind: TeamContextKind;
    value: Prisma.JsonValue;
    summary?: string;
    tags?: string[];
    version: number;
    updatedBySessionId?: string;
    updatedByRole?: string;
    createdAt: number;
    updatedAt: number;
};

type TeamContextMutationInput = {
    sessionId?: string;
    role?: string;
    key: string;
    kind?: TeamContextKind;
    summary?: string;
    tags?: string[];
};

type TeamContextPutInput = TeamContextMutationInput & {
    value: Prisma.InputJsonValue;
};

type TeamContextPatchInput = TeamContextMutationInput & {
    patch: Prisma.InputJsonValue;
};

type TeamContextDeleteInput = {
    sessionId?: string;
    key: string;
};

type TeamContextListFilters = {
    sessionId?: string;
    prefix?: string;
    kind?: TeamContextKind;
    limit?: number;
};

export class TeamContextAccessError extends Error {
    statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.name = 'TeamContextAccessError';
        this.statusCode = statusCode;
    }
}

export function normalizeTeamContextKey(key: string): string {
    return key.trim();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseTags(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }

    const tags = value.filter((entry): entry is string => typeof entry === 'string');
    return tags.length > 0 ? tags : undefined;
}

function mapItem(entry: {
    key: string;
    kind: string;
    value: unknown;
    summary: string | null;
    tags: unknown;
    version: number;
    updatedBySessionId: string | null;
    updatedByRole: string | null;
    createdAt: Date;
    updatedAt: Date;
}): TeamContextItem {
    return {
        key: entry.key,
        kind: entry.kind as TeamContextKind,
        value: entry.value as Prisma.JsonValue,
        summary: entry.summary ?? undefined,
        tags: parseTags(entry.tags),
        version: entry.version,
        updatedBySessionId: entry.updatedBySessionId ?? undefined,
        updatedByRole: entry.updatedByRole ?? undefined,
        createdAt: entry.createdAt.getTime(),
        updatedAt: entry.updatedAt.getTime(),
    };
}

async function assertTeamContextAccess(userId: string, teamId: string, sessionId?: string): Promise<void> {
    const team = await db.artifact.findFirst({
        where: {
            id: teamId,
            accountId: userId,
        },
        select: { id: true },
    });

    if (!team) {
        throw new TeamContextAccessError(404, 'Team not found');
    }

    if (!sessionId) {
        return;
    }

    const session = await db.session.findFirst({
        where: {
            id: sessionId,
            accountId: userId,
        },
        select: {
            id: true,
            metadata: true,
        },
    });

    if (!session) {
        throw new TeamContextAccessError(403, `Session ${sessionId} does not belong to you`);
    }

    try {
        const metadata = JSON.parse(session.metadata) as { teamId?: string; roomId?: string };
        const sessionTeamId = metadata.teamId ?? metadata.roomId;
        if (sessionTeamId && sessionTeamId !== teamId) {
            throw new TeamContextAccessError(403, `Session ${sessionId} is not a member of team ${teamId}`);
        }
    } catch (error) {
        if (error instanceof TeamContextAccessError) {
            throw error;
        }
        throw new TeamContextAccessError(403, `Session ${sessionId} metadata is invalid for team context access`);
    }
}

export class TeamContextService {
    async list(userId: string, teamId: string, filters: TeamContextListFilters = {}): Promise<{ items: TeamContextItem[] }> {
        await assertTeamContextAccess(userId, teamId, filters.sessionId);

        const items = await db.teamContextEntry.findMany({
            where: {
                accountId: userId,
                teamId,
                ...(filters.prefix ? { key: { startsWith: filters.prefix } } : {}),
                ...(filters.kind ? { kind: filters.kind } : {}),
            },
            orderBy: { updatedAt: 'desc' },
            take: Math.min(filters.limit ?? 100, 500),
        });

        return {
            items: items.map(mapItem),
        };
    }

    async put(userId: string, teamId: string, input: TeamContextPutInput): Promise<TeamContextItem> {
        await assertTeamContextAccess(userId, teamId, input.sessionId);

        const key = normalizeTeamContextKey(input.key);

        const entry = await db.teamContextEntry.upsert({
            where: {
                accountId_teamId_key: {
                    accountId: userId,
                    teamId,
                    key,
                },
            },
            create: {
                accountId: userId,
                teamId,
                key,
                kind: input.kind ?? 'fact',
                value: input.value,
                summary: input.summary ?? null,
                tags: input.tags ?? null,
                updatedBySessionId: input.sessionId ?? null,
                updatedByRole: input.role ?? null,
            },
            update: {
                kind: input.kind ?? 'fact',
                value: input.value,
                summary: input.summary ?? null,
                tags: input.tags ?? null,
                updatedBySessionId: input.sessionId ?? null,
                updatedByRole: input.role ?? null,
                version: { increment: 1 },
            },
        });

        return mapItem(entry);
    }

    async patch(userId: string, teamId: string, input: TeamContextPatchInput): Promise<TeamContextItem> {
        await assertTeamContextAccess(userId, teamId, input.sessionId);

        const key = normalizeTeamContextKey(input.key);
        const existing = await db.teamContextEntry.findUnique({
            where: {
                accountId_teamId_key: {
                    accountId: userId,
                    teamId,
                    key,
                },
            },
        });

        if (!existing) {
            throw new TeamContextAccessError(404, 'Context entry not found');
        }

        const nextValue = isPlainObject(existing.value) && isPlainObject(input.patch)
            ? { ...(existing.value as Record<string, unknown>), ...input.patch }
            : input.patch;

        const entry = await db.teamContextEntry.update({
            where: {
                accountId_teamId_key: {
                    accountId: userId,
                    teamId,
                    key,
                },
            },
            data: {
                kind: input.kind ?? existing.kind,
                value: nextValue as Prisma.InputJsonValue,
                summary: input.summary ?? existing.summary,
                tags: (input.tags ?? existing.tags) as Prisma.InputJsonValue,
                updatedBySessionId: input.sessionId ?? null,
                updatedByRole: input.role ?? null,
                version: { increment: 1 },
            },
        });

        return mapItem(entry);
    }

    async delete(userId: string, teamId: string, input: TeamContextDeleteInput): Promise<void> {
        await assertTeamContextAccess(userId, teamId, input.sessionId);

        const key = normalizeTeamContextKey(input.key);

        try {
            await db.teamContextEntry.delete({
                where: {
                    accountId_teamId_key: {
                        accountId: userId,
                        teamId,
                        key,
                    },
                },
            });
        } catch (error) {
            if (
                error instanceof Prisma.PrismaClientKnownRequestError &&
                error.code === 'P2025'
            ) {
                throw new TeamContextAccessError(404, 'Context entry not found');
            }
            throw error;
        }
    }
}

export const teamContextService = new TeamContextService();
