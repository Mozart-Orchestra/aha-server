export type TeamArtifactBody = Record<string, unknown>;

/**
 * Ensures a session is linked to a team artifact's header.sessions array.
 * This is idempotent - safe to call multiple times.
 *
 * Used by:
 * - sessionRoutes.ts: When creating a session with teamId in metadata
 * - teamMessagesRoutes.ts: When an agent sends a message (auto-link on join)
 */
export async function ensureSessionLinkedToTeam(
    db: any,
    userId: string,
    sessionId: string,
    teamId: string,
    pk: {
        encodeBase64: (buffer: Uint8Array, encoding?: 'base64' | 'base64url') => string;
        decodeBase64: (str: string, encoding?: 'base64' | 'base64url') => Uint8Array;
    },
    logFn?: (meta: Record<string, unknown>, msg: string) => void,
    memberInfo?: { roleId?: string; displayName?: string }
): Promise<{ success: boolean; alreadyLinked: boolean }> {
    const log = logFn || (() => {});

    try {
        const artifact = await db.artifact.findFirst({
            where: { id: teamId, accountId: userId },
            select: { id: true, header: true, headerVersion: true, seq: true, body: true, bodyVersion: true }
        });

        if (!artifact) {
            log({ module: 'session-artifact-link', sessionId, teamId, level: 'warn' },
                `Team artifact not found. Session not linked.`);
            return { success: false, alreadyLinked: false };
        }

        try {
            // Decode header to check sessions list
            const headerStr = pk.encodeBase64(artifact.header);
            const header = JSON.parse(Buffer.from(headerStr, 'base64').toString());

            // Check if already linked
            if (header.sessions && header.sessions.includes(sessionId)) {
                log({ module: 'session-artifact-link', sessionId, teamId },
                    `Session already linked to artifact`);
                return { success: true, alreadyLinked: true };
            }

            // Add session ID to sessions array
            header.sessions = [...(header.sessions || []), sessionId];

            // Encode updated header
            const newHeaderStr = Buffer.from(JSON.stringify(header)).toString('base64');
            const newHeader = pk.decodeBase64(newHeaderStr);

            // Also ensure a member entry exists in the artifact body
            // This fixes the Kanban "0 members" bug where header.sessions
            // is populated but body.team.members is empty.
            const updateData: Record<string, unknown> = {
                header: newHeader as any,
                headerVersion: artifact.headerVersion + 1,
                seq: artifact.seq + 1,
                updatedAt: new Date()
            };

            if (artifact.body) {
                try {
                    const body = parseTeamArtifactBody(artifact.body);
                    const team = (body.team as Record<string, unknown>) ?? {};
                    const members = (team.members as Array<Record<string, unknown>>) ?? [];

                    const alreadyInBody = members.some(m => m.sessionId === sessionId);
                    if (!alreadyInBody) {
                        const newMember: Record<string, unknown> = {
                            sessionId,
                            roleId: memberInfo?.roleId ?? 'builder',
                            displayName: memberInfo?.displayName ?? sessionId.substring(0, 8),
                            focusAreas: [],
                            joinedAt: Date.now(),
                        };
                        const updatedMembers = [...members, newMember];
                        const updatedBody = {
                            ...body,
                            team: { ...team, members: updatedMembers },
                        };
                        const bodyBuffer = Buffer.from(JSON.stringify(updatedBody), 'utf-8');
                        updateData.body = bodyBuffer;
                        updateData.bodyVersion = (artifact.bodyVersion ?? 0) + 1;

                        log({ module: 'session-artifact-link', sessionId, teamId },
                            `Added member entry to body.team.members (${updatedMembers.length} total)`);
                    }
                } catch (bodyError) {
                    log({ module: 'session-artifact-link', level: 'debug' },
                        `Could not update body members: ${bodyError}`);
                }
            }

            // Update artifact
            await db.artifact.update({
                where: { id: artifact.id },
                data: updateData
            });

            log({ module: 'session-artifact-link', sessionId, teamId, artifactId: artifact.id },
                `Successfully linked session to artifact. New headerVersion: ${artifact.headerVersion + 1}`);
            return { success: true, alreadyLinked: false };
        } catch (headerError) {
            // This is expected for encrypted artifacts - skip silently
            log({ module: 'session-artifact-link', level: 'debug' },
                `Skipping link for encrypted artifact header`);
            return { success: false, alreadyLinked: false };
        }
    } catch (error) {
        log({ module: 'session-artifact-link', sessionId, teamId, level: 'error' },
            `Failed to link session to artifact: ${error}`);
        return { success: false, alreadyLinked: false };
    }
}

const coerceTeamArtifactBody = (value: unknown): TeamArtifactBody => {
    if (typeof value === 'string') {
        try {
            return coerceTeamArtifactBody(JSON.parse(value));
        } catch {
            return {};
        }
    }

    if (!value || typeof value !== 'object') {
        return {};
    }

    if ('body' in value) {
        const inner = (value as { body?: unknown }).body;
        if (typeof inner === 'string') {
            try {
                return coerceTeamArtifactBody(JSON.parse(inner));
            } catch {
                return {};
            }
        }
        if (inner && typeof inner === 'object') {
            return inner as TeamArtifactBody;
        }
        return {};
    }

    return value as TeamArtifactBody;
};

export const parseTeamArtifactBody = (body: Uint8Array): TeamArtifactBody => {
    const bodyStr = Buffer.from(body).toString('utf-8');
    try {
        const parsed = JSON.parse(bodyStr);
        return coerceTeamArtifactBody(parsed);
    } catch {
        return {};
    }
};
