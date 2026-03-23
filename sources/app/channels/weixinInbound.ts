import { db } from "@/storage/db";
import { encryptString } from "@/modules/encrypt";
import { kvMutate } from "@/app/kv/kvMutate";
import { eventRouter } from "@/app/events/eventRouter";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { randomUUID } from "crypto";
import { listAccessibleTeamArtifacts } from "@/app/team/teamArtifacts";

/**
 * Handle an inbound WeChat message from a user.
 *
 * Posts the text as a team message to the user's most recently active team.
 * Agents receive it via the existing team-message WebSocket broadcast and
 * coordinate themselves — no machine-level routing needed.
 */
export async function handleInboundWeixinMessage(
    uid: string,
    text: string,
    _contextToken: string,
    _senderId: string
): Promise<void> {
    const teams = await listAccessibleTeamArtifacts(uid);
    if (!teams.length) return;

    // Use the most recently updated team
    const team = teams[0];
    const teamId = team.id;

    const message = {
        id: randomUUID(),
        teamId,
        content: text,
        type: 'chat' as const,
        timestamp: Date.now(),
        fromSessionId: null,
        fromRole: 'user',
        fromDisplayName: '微信用户',
        shortContent: text.length > 150 ? text.substring(0, 150) + '...' : undefined,
    };

    // Persist
    const kvKey = `team_messages.${teamId}.${message.timestamp}.${message.id}`;
    const encryptionPath = [uid, teamId, message.id];
    const encryptedMessage = encryptString(encryptionPath, JSON.stringify(message));
    const serialized = Buffer.from(encryptedMessage instanceof Uint8Array
        ? encryptedMessage : encryptedMessage as any).toString('base64');

    await kvMutate({ uid }, [{ key: kvKey, value: serialized, version: -1 }]);

    // Broadcast to all sessions
    const sessionRows = await db.session.findMany({
        where: { accountId: uid },
        select: { id: true }
    });
    const sessionIds = new Set(sessionRows.map(s => s.id));
    if (sessionIds.size === 0) return;

    const updSeq = await allocateUserSeq(uid);
    eventRouter.emitUpdate({
        userId: uid,
        payload: {
            id: randomKeyNaked(12),
            body: { t: 'team-message' as const, teamId, message },
            seq: updSeq,
            createdAt: Date.now(),
        },
        recipientFilter: { type: 'specific-sessions', sessionIds },
    });
}
