import { decryptString } from "@/modules/encrypt";

export function buildTeamMessageEncryptionPath(userId: string, teamId: string, messageId: string): string[] {
    return ['user', userId, 'teams', teamId, 'messages', messageId];
}

function buildLegacyWeixinInboundPath(userId: string, teamId: string, messageId: string): string[] {
    return [userId, teamId, messageId];
}

export function decryptTeamMessage(
    userId: string,
    teamId: string,
    messageId: string,
    encrypted: Uint8Array,
): string {
    try {
        return decryptString(buildTeamMessageEncryptionPath(userId, teamId, messageId), encrypted);
    } catch {
        return decryptString(buildLegacyWeixinInboundPath(userId, teamId, messageId), encrypted);
    }
}
