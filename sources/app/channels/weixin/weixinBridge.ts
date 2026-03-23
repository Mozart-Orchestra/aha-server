import { randomBytes } from "crypto";
import { loadWeixinCredentials, WeixinCredentials } from "./weixinCredentials";

/**
 * WeChat iLink Bot bridge — server-side per-user long-poll.
 *
 * Manages one persistent HTTP long-poll connection to ilinkai.weixin.qq.com
 * per bound user. Receives inbound WeChat messages and forwards them to
 * the team message handler. Sends outbound messages on behalf of agents.
 *
 * Functional design: no classes. All state is in the bridges Map.
 */

interface BridgeState {
    uid: string;
    token: string;
    baseUrl: string;
    pushPolicy: 'all' | 'important' | 'silent';
    syncBuf: string;
    running: boolean;
    contextTokenMap: Map<string, string>; // weixinUserId → contextToken
    onInbound: (uid: string, text: string, contextToken: string, senderId: string) => void;
}

// uid → BridgeState
const bridges = new Map<string, BridgeState>();

// ── API helpers ───────────────────────────────────────────────────────────────

function buildHeaders(token: string): Record<string, string> {
    const uint32 = randomBytes(4).readUInt32BE(0);
    const uin = Buffer.from(String(uint32), 'utf-8').toString('base64');
    return {
        'Content-Type': 'application/json',
        'AuthorizationType': 'ilink_bot_token',
        'Authorization': `Bearer ${token}`,
        'X-WECHAT-UIN': uin,
    };
}

async function apiFetch(baseUrl: string, token: string, endpoint: string, body: object, timeoutMs = 15_000): Promise<any> {
    const url = new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : baseUrl + '/').toString();
    const bodyStr = JSON.stringify(body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { ...buildHeaders(token), 'Content-Length': String(Buffer.byteLength(bodyStr, 'utf-8')) },
            body: bodyStr,
            signal: controller.signal,
        });
        clearTimeout(timer);
        const text = await res.text();
        if (!res.ok) throw new Error(`${endpoint} ${res.status}: ${text}`);
        return JSON.parse(text);
    } catch (e) {
        clearTimeout(timer);
        throw e;
    }
}

async function getUpdates(state: BridgeState): Promise<any> {
    try {
        return await apiFetch(state.baseUrl, state.token, 'ilink/bot/getupdates', {
            get_updates_buf: state.syncBuf,
            base_info: { channel_version: '0.1.0' },
        }, 35_000);
    } catch (e: any) {
        if (e?.name === 'AbortError') return { ret: 0, msgs: [], get_updates_buf: state.syncBuf };
        throw e;
    }
}

async function sendMessage(state: BridgeState, toUserId: string, text: string, contextToken: string): Promise<void> {
    const chunks = chunkText(text, 2000);
    for (const chunk of chunks) {
        await apiFetch(state.baseUrl, state.token, 'ilink/bot/sendmessage', {
            msg: {
                from_user_id: '',
                to_user_id: toUserId,
                client_id: `aha-server-${Date.now()}-${randomBytes(4).toString('hex')}`,
                message_type: 2,
                message_state: 2,
                item_list: [{ type: 1, text_item: { text: chunk } }],
                context_token: contextToken,
            },
            base_info: { channel_version: '0.1.0' },
        });
    }
}

function extractText(msg: any): string {
    const items: any[] = msg.item_list ?? [];
    const parts: string[] = [];
    for (const item of items) {
        if (item.type === 1 && item.text_item?.text) parts.push(item.text_item.text);
        else if (item.type === 2) parts.push('(图片)');
        else if (item.type === 3) parts.push(item.voice_item?.text ?? '(语音)');
        else if (item.type === 4) parts.push(`(文件: ${item.file_item?.file_name ?? 'unknown'})`);
    }
    return parts.join('\n') || '(空消息)';
}

function chunkText(text: string, limit: number): string[] {
    if (text.length <= limit) return [text];
    const out: string[] = [];
    let rest = text;
    while (rest.length > limit) {
        const para = rest.lastIndexOf('\n\n', limit);
        const line = rest.lastIndexOf('\n', limit);
        const space = rest.lastIndexOf(' ', limit);
        const cut = para > limit / 2 ? para : line > limit / 2 ? line : space > 0 ? space : limit;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n+/, '');
    }
    if (rest) out.push(rest);
    return out;
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function runPollLoop(state: BridgeState): Promise<void> {
    let failures = 0;
    const MAX_FAILURES = 3;

    while (state.running) {
        try {
            const resp = await getUpdates(state);
            if (resp.ret !== undefined && resp.ret !== 0) {
                failures++;
                if (failures >= MAX_FAILURES) { failures = 0; await sleep(30_000); }
                else await sleep(2_000);
                continue;
            }
            failures = 0;
            if (resp.get_updates_buf) state.syncBuf = resp.get_updates_buf;
            for (const msg of (resp.msgs ?? []) as any[]) {
                if (msg.message_type !== 1) continue;
                const senderId: string = msg.from_user_id;
                if (!senderId) continue;
                if (msg.context_token) state.contextTokenMap.set(senderId, msg.context_token);
                const text = extractText(msg);
                const ct = msg.context_token ?? state.contextTokenMap.get(senderId);
                if (ct) state.onInbound(state.uid, text, ct, senderId);
            }
        } catch {
            failures++;
            if (failures >= MAX_FAILURES) { failures = 0; await sleep(30_000); }
            else await sleep(2_000);
        }
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start WeChat bridge for a user. Idempotent — stops old bridge first if running.
 */
export function startBridge(
    uid: string,
    creds: WeixinCredentials,
    onInbound: (uid: string, text: string, contextToken: string, senderId: string) => void
): void {
    stopBridge(uid);
    const state: BridgeState = {
        uid,
        token: creds.token,
        baseUrl: creds.baseUrl,
        pushPolicy: creds.pushPolicy,
        syncBuf: '',
        running: true,
        contextTokenMap: new Map(),
        onInbound,
    };
    bridges.set(uid, state);
    runPollLoop(state).catch(() => { /* silently restart on fatal errors */ });
}

/**
 * Stop and remove bridge for a user.
 */
export function stopBridge(uid: string): void {
    const state = bridges.get(uid);
    if (state) { state.running = false; bridges.delete(uid); }
}

/**
 * Push a formatted message to WeChat for a user.
 * No-op if user has no active bridge or no contextToken yet.
 */
export async function pushToWeixin(uid: string, text: string): Promise<void> {
    const state = bridges.get(uid);
    if (!state || !state.running) return;
    if (state.pushPolicy === 'silent') return;

    const entries = Array.from(state.contextTokenMap.entries());
    if (!entries.length) return; // User hasn't sent a message yet

    const [senderId, contextToken] = entries[entries.length - 1];
    await sendMessage(state, senderId, text, contextToken).catch(() => { /* non-fatal */ });
}

/**
 * Update push policy for a running bridge.
 */
export function updatePushPolicy(uid: string, policy: 'all' | 'important' | 'silent'): void {
    const state = bridges.get(uid);
    if (state) state.pushPolicy = policy;
}

/**
 * Check if a user has an active bridge.
 */
export function isConnected(uid: string): boolean {
    return bridges.has(uid);
}

/**
 * Load all bound users from DB and start their bridges on server startup.
 */
export async function startAllBridges(
    onInbound: (uid: string, text: string, contextToken: string, senderId: string) => void
): Promise<void> {
    const rows = await import('@/storage/db').then(m => m.db.userKVStore.findMany({
        where: { key: 'channels.weixin.credentials', value: { not: null } },
        select: { accountId: true }
    }));

    const { loadWeixinCredentials: load } = await import('./weixinCredentials');
    for (const row of rows) {
        const creds = await load(row.accountId);
        if (creds && creds.token && creds.pushPolicy !== 'silent') {
            startBridge(row.accountId, creds, onInbound);
        }
    }
}
