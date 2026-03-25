import { pushToWeixin, isConnected } from "@/app/channels/weixin/weixinBridge";
import { error, log } from "@/utils/log";

const ROLE_EMOJI: Record<string, string> = {
    orchestrator: '✨', master: '🎯',
    implementer: '💻', builder: '💻', coder: '💻',
    architect: '🏛️', 'qa-engineer': '🧪', tester: '🧪',
    reviewer: '🔍', 'org-manager': '🏢', supervisor: '⚙️',
    'help-agent': '🆘', 'agent-builder': '🧬', researcher: '🔬',
    system: '📋',
};

const IMPORTANT_TYPES = new Set(['task-update', 'help-needed', 'vote', 'handoff']);

function isImportant(message: any): boolean {
    if (IMPORTANT_TYPES.has(message.type)) return true;
    const p = message.metadata?.priority;
    if (p === 'high' || p === 'urgent') return true;
    return false;
}

function format(message: any): string {
    const role: string = message.fromRole ?? 'agent';
    const name: string = message.fromDisplayName || role;
    const emoji = ROLE_EMOJI[role] ?? '🤖';
    return `${emoji} [${name}]\n${message.content}`;
}

/**
 * Push a team message to WeChat for a user, if they have an active bridge.
 * Applies push policy filtering before sending.
 */
export async function pushToWeixinIfBound(
    uid: string,
    teamId: string,
    message: any
): Promise<void> {
    if (!isConnected(uid)) {
        log({ module: 'weixin-outbound', uid, teamId, messageId: message.id, reason: 'bridge-not-connected' }, 'Skipping Weixin push');
        return;
    }

    // Import creds to check push policy
    const { loadWeixinCredentials } = await import('@/app/channels/weixin/weixinCredentials');
    const creds = await loadWeixinCredentials(uid);
    if (!creds) {
        log({ module: 'weixin-outbound', uid, teamId, messageId: message.id, reason: 'missing-credentials' }, 'Skipping Weixin push');
        return;
    }
    if (creds.pushPolicy === 'silent') {
        log({ module: 'weixin-outbound', uid, teamId, messageId: message.id, reason: 'push-policy-silent' }, 'Skipping Weixin push');
        return;
    }
    if (creds.pushPolicy === 'important' && !isImportant(message)) {
        log({ module: 'weixin-outbound', uid, teamId, messageId: message.id, reason: 'not-important' }, 'Skipping Weixin push');
        return;
    }

    // Skip messages sent by the user themselves (fromRole === 'user')
    if (message.fromRole === 'user') {
        log({ module: 'weixin-outbound', uid, teamId, messageId: message.id, reason: 'user-message' }, 'Skipping Weixin push');
        return;
    }

    const text = format(message);
    log(
        {
            module: 'weixin-outbound',
            uid,
            teamId,
            messageId: message.id,
            messageType: message.type,
            fromRole: message.fromRole,
        },
        'Dispatching Weixin push',
    );

    try {
        const sent = await pushToWeixin(uid, text);
        if (!sent) {
            log(
                {
                    module: 'weixin-outbound',
                    uid,
                    teamId,
                    messageId: message.id,
                    messageType: message.type,
                    fromRole: message.fromRole,
                },
                'Weixin push was skipped by the bridge',
            );
            return;
        }
        log(
            {
                module: 'weixin-outbound',
                uid,
                teamId,
                messageId: message.id,
                messageType: message.type,
                fromRole: message.fromRole,
            },
            'Dispatched Weixin push',
        );
    } catch (cause) {
        error(
            {
                module: 'weixin-outbound',
                uid,
                teamId,
                messageId: message.id,
                messageType: message.type,
                fromRole: message.fromRole,
                cause: cause instanceof Error ? cause.message : String(cause),
            },
            'Failed to dispatch Weixin push',
        );
        throw cause;
    }
}
