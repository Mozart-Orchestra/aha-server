import { pushToWeixin, isConnected } from "@/app/channels/weixin/weixinBridge";

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
    _teamId: string,
    message: any
): Promise<void> {
    if (!isConnected(uid)) return;

    // Import creds to check push policy
    const { loadWeixinCredentials } = await import('@/app/channels/weixin/weixinCredentials');
    const creds = await loadWeixinCredentials(uid);
    if (!creds || creds.pushPolicy === 'silent') return;
    if (creds.pushPolicy === 'important' && !isImportant(message)) return;

    // Skip messages sent by the user themselves (fromRole === 'user')
    if (message.fromRole === 'user') return;

    const text = format(message);
    await pushToWeixin(uid, text);
}
