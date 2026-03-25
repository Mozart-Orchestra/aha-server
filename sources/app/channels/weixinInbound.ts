import { db } from "@/storage/db";
import { encryptString } from "@/modules/encrypt";
import { kvMutate } from "@/app/kv/kvMutate";
import { eventRouter } from "@/app/events/eventRouter";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { randomUUID } from "crypto";
import { listAccessibleTeamArtifacts } from "@/app/team/teamArtifacts";
import { buildTeamMessageEncryptionPath } from "@/app/team/teamMessageCrypto";
import { log, warn } from "@/utils/log";
import { loadWeixinCredentials, saveWeixinCredentials } from "@/app/channels/weixin/weixinCredentials";
import { tryHandleCommand } from "@/app/channels/weixinCommandHandler";

interface PublishInboundWeixinMessageOptions {
    uid: string;
    text: string;
    teamId?: string;
    fromDisplayName?: string;
    metadata?: Record<string, unknown>;
}

async function resolveTeamId(uid: string, teamId?: string): Promise<string | null> {
    if (teamId) return teamId;

    const teams = await listAccessibleTeamArtifacts(uid);
    return teams[0]?.id ?? null;
}

/**
 * Persist and broadcast an inbound WeChat-originated team message.
 *
 * Used by both the iLink Bot bridge and the Official Account webhook so all
 * inbound WeChat messages enter the normal team-message timeline.
 */
export async function publishInboundWeixinMessage({
    uid,
    text,
    teamId,
    fromDisplayName = '微信用户',
    metadata,
}: PublishInboundWeixinMessageOptions): Promise<void> {
    const resolvedTeamId = await resolveTeamId(uid, teamId);
    if (!resolvedTeamId) {
        warn({ module: 'weixin-inbound', uid }, 'Skipping inbound WeChat message: no accessible team');
        return;
    }

    const message = {
        id: randomUUID(),
        teamId: resolvedTeamId,
        content: text,
        type: 'chat' as const,
        timestamp: Date.now(),
        fromSessionId: null,
        fromRole: 'user',
        fromDisplayName,
        shortContent: text.length > 150 ? text.substring(0, 150) + '...' : undefined,
        metadata,
    };

    // Persist
    const kvKey = `team_messages.${resolvedTeamId}.${message.timestamp}.${message.id}`;
    const encryptionPath = buildTeamMessageEncryptionPath(uid, resolvedTeamId, message.id);
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
    if (sessionIds.size === 0) {
        warn(
            { module: 'weixin-inbound', uid, teamId: resolvedTeamId, messageId: message.id },
            'Persisted inbound WeChat message, but no active sessions were available for broadcast',
        );
        return;
    }

    const updSeq = await allocateUserSeq(uid);
    eventRouter.emitUpdate({
        userId: uid,
        payload: {
            id: randomKeyNaked(12),
            body: { t: 'team-message' as const, teamId: resolvedTeamId, message },
            seq: updSeq,
            createdAt: Date.now(),
        },
        recipientFilter: { type: 'specific-sessions', sessionIds },
    });

    log(
        {
            module: 'weixin-inbound',
            uid,
            teamId: resolvedTeamId,
            messageId: message.id,
            sessionCount: sessionIds.size,
        },
        'Inbound WeChat message persisted and broadcasted',
    );
}

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
    contextToken: string,
    senderId: string
): Promise<void> {
    const creds = await loadWeixinCredentials(uid);
    if (creds && (creds.lastSenderId !== senderId || creds.lastContextToken !== contextToken)) {
        await saveWeixinCredentials(uid, {
            token: creds.token,
            baseUrl: creds.baseUrl,
            weixinUserId: creds.weixinUserId,
            accountId: creds.accountId,
            pushPolicy: creds.pushPolicy,
            lastSenderId: senderId,
            lastContextToken: contextToken,
        });
        log(
            {
                module: 'weixin-inbound',
                uid,
                senderId,
                contextToken: contextToken.slice(0, 16),
            },
            'Persisted Weixin reply context',
        );
    }

    // Intercept slash commands before publishing as team message
    const handled = await tryHandleCommand(uid, text);
    if (handled) return;

    await publishInboundWeixinMessage({
        uid,
        text,
        fromDisplayName: '微信用户',
        metadata: {
            channel: 'wechat',
            wechat: {
                source: 'weixin-bridge',
                senderId,
                contextToken,
            },
        },
    });
}
