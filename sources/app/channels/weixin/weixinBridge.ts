import { randomBytes } from "crypto";
import type { WeixinCredentials } from "./weixinCredentials";
import { decryptTeamMessage } from "@/app/team/teamMessageCrypto";
import { error, log, warn } from "@/utils/log";

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

function preview(value: string | undefined, length = 16): string | undefined {
    if (!value) return undefined;
    return value.length <= length ? value : `${value.slice(0, length)}...`;
}

async function hydrateReplyContextFromRecentMessages(uid: string, creds: WeixinCredentials): Promise<WeixinCredentials> {
    if (creds.lastSenderId && creds.lastContextToken) {
        return creds;
    }

    const rows = await import('@/storage/db').then(m => m.db.userKVStore.findMany({
        where: {
            accountId: uid,
            key: { startsWith: 'team_messages.' },
            value: { not: null },
        },
        orderBy: { key: 'desc' },
        take: 50,
        select: { key: true, value: true },
    }));

    for (const row of rows) {
        const parts = row.key.split('.');
        if (parts.length < 4) continue;
        const [, teamId, , messageId] = parts;

        try {
            const decrypted = decryptTeamMessage(uid, teamId, messageId, row.value as Uint8Array);
            const message = JSON.parse(decrypted) as any;
            const source = message?.metadata?.wechat?.source;
            const senderId = message?.metadata?.wechat?.senderId;
            const contextToken = message?.metadata?.wechat?.contextToken;

            if (source === 'weixin-bridge' && typeof senderId === 'string' && typeof contextToken === 'string') {
                return {
                    ...creds,
                    lastSenderId: senderId,
                    lastContextToken: contextToken,
                };
            }
        } catch {
            continue;
        }
    }

    return creds;
}

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

export function extractText(msg: any): string {
    const items: any[] = msg.item_list ?? [];
    const parts: string[] = [];
    for (const item of items) {
        if (item.type === 1 && item.text_item?.text) parts.push(item.text_item.text);
        else if (item.type === 2) parts.push(`[图片] ${item.image_item?.url ?? item.image_item?.pic_url ?? '(图片)'}`);
        else if (item.type === 3) parts.push(item.voice_item?.text ?? item.voice_item?.recognition ?? '(语音)');
        else if (item.type === 4) parts.push(`[文件] ${item.file_item?.file_name ?? 'unknown'} ${item.file_item?.url ?? ''}`);
        else if (item.type === 5) parts.push(`[视频] ${item.video_item?.url ?? item.video_item?.thumb_url ?? '(视频)'}`);
        else if (item.type === 6 || item.link_item) parts.push(`[链接] ${item.link_item?.title ?? ''} ${item.link_item?.url ?? item.link_item?.link ?? ''}`);
        else if (item.type === 49 || item.app_item) parts.push(`[链接] ${item.app_item?.title ?? item.title ?? ''} ${item.app_item?.url ?? item.url ?? ''}`);
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
                warn(
                    { module: 'weixin-bridge', uid: state.uid, ret: resp.ret, failures },
                    'Weixin bridge poll returned a non-zero status',
                );
                if (failures >= MAX_FAILURES) { failures = 0; await sleep(30_000); }
                else await sleep(2_000);
                continue;
            }
            failures = 0;
            if (resp.get_updates_buf) state.syncBuf = resp.get_updates_buf;
            for (const msg of (resp.msgs ?? []) as any[]) {
                if (msg.message_type === 2) continue; // skip bot outbound replies
                const senderId: string = msg.from_user_id;
                if (!senderId) continue;
                if (msg.context_token) {
                    state.contextTokenMap.set(senderId, msg.context_token);
                    log(
                        {
                            module: 'weixin-bridge',
                            uid: state.uid,
                            senderId,
                            contextToken: preview(msg.context_token),
                            knownContexts: state.contextTokenMap.size,
                        },
                        'Stored Weixin context token',
                    );
                }
                const text = extractText(msg);
                const ct = msg.context_token ?? state.contextTokenMap.get(senderId);
                if (!ct) {
                    warn(
                        { module: 'weixin-bridge', uid: state.uid, senderId, textLength: text.length },
                        'Skipping inbound Weixin message without a context token',
                    );
                    continue;
                }

                log(
                    {
                        module: 'weixin-bridge',
                        uid: state.uid,
                        senderId,
                        textLength: text.length,
                        contextToken: preview(ct),
                    },
                    'Received inbound Weixin message',
                );
                state.onInbound(state.uid, text, ct, senderId);
            }
        } catch (cause) {
            failures++;
            warn(
                {
                    module: 'weixin-bridge',
                    uid: state.uid,
                    failures,
                    cause: cause instanceof Error ? cause.message : String(cause),
                },
                'Weixin bridge poll failed',
            );
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
    if (creds.lastSenderId && creds.lastContextToken) {
        state.contextTokenMap.set(creds.lastSenderId, creds.lastContextToken);
        log(
            {
                module: 'weixin-bridge',
                uid,
                senderId: creds.lastSenderId,
                contextToken: preview(creds.lastContextToken),
            },
            'Restored persisted Weixin reply context',
        );
    }
    bridges.set(uid, state);
    log(
        {
            module: 'weixin-bridge',
            uid,
            pushPolicy: creds.pushPolicy,
            baseUrl: creds.baseUrl,
            weixinUserId: creds.weixinUserId,
        },
        'Started Weixin bridge',
    );
    runPollLoop(state).catch((err) => {
        warn(
            { module: 'weixin-bridge', uid: state.uid, cause: err instanceof Error ? err.message : String(err) },
            'Weixin bridge poll loop terminated unexpectedly',
        );
    });
}

/**
 * Stop and remove bridge for a user.
 */
export function stopBridge(uid: string): void {
    const state = bridges.get(uid);
    if (state) {
        state.running = false;
        bridges.delete(uid);
        log({ module: 'weixin-bridge', uid }, 'Stopped Weixin bridge');
    }
}

/**
 * Push a formatted message to WeChat for a user.
 * No-op if user has no active bridge or no contextToken yet.
 */
export async function pushToWeixin(uid: string, text: string): Promise<boolean> {
    const state = bridges.get(uid);
    if (!state || !state.running) {
        warn({ module: 'weixin-bridge', uid, reason: 'bridge-not-running' }, 'Skipping outbound Weixin send');
        return false;
    }
    if (state.pushPolicy === 'silent') {
        log({ module: 'weixin-bridge', uid, reason: 'push-policy-silent' }, 'Skipping outbound Weixin send');
        return false;
    }

    const entries = Array.from(state.contextTokenMap.entries());
    if (!entries.length) {
        warn({ module: 'weixin-bridge', uid, reason: 'missing-context-token' }, 'Skipping outbound Weixin send');
        return false;
    }

    const [senderId, contextToken] = entries[entries.length - 1];
    log(
        {
            module: 'weixin-bridge',
            uid,
            senderId,
            textLength: text.length,
            contextToken: preview(contextToken),
        },
        'Sending outbound Weixin message',
    );

    try {
        await sendMessage(state, senderId, text, contextToken);
        log(
            {
                module: 'weixin-bridge',
                uid,
                senderId,
                textLength: text.length,
                contextToken: preview(contextToken),
            },
            'Sent outbound Weixin message',
        );
        return true;
    } catch (cause) {
        error(
            {
                module: 'weixin-bridge',
                uid,
                senderId,
                textLength: text.length,
                contextToken: preview(contextToken),
                cause: cause instanceof Error ? cause.message : String(cause),
            },
            'Failed to send outbound Weixin message',
        );
        throw cause;
    }
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

    const {
        loadWeixinCredentials: load,
        saveWeixinCredentials,
    } = await import('./weixinCredentials');
    let started = 0;
    for (const row of rows) {
        const rawCreds = await load(row.accountId);
        if (rawCreds && rawCreds.token && rawCreds.pushPolicy !== 'silent') {
            const hydratedCreds = await hydrateReplyContextFromRecentMessages(row.accountId, rawCreds);
            if (
                hydratedCreds.lastSenderId &&
                hydratedCreds.lastContextToken &&
                (!rawCreds.lastSenderId || !rawCreds.lastContextToken)
            ) {
                await saveWeixinCredentials(row.accountId, {
                    token: hydratedCreds.token,
                    baseUrl: hydratedCreds.baseUrl,
                    weixinUserId: hydratedCreds.weixinUserId,
                    accountId: hydratedCreds.accountId,
                    pushPolicy: hydratedCreds.pushPolicy,
                    lastSenderId: hydratedCreds.lastSenderId,
                    lastContextToken: hydratedCreds.lastContextToken,
                });
                log(
                    {
                        module: 'weixin-bridge',
                        uid: row.accountId,
                        senderId: hydratedCreds.lastSenderId,
                        contextToken: preview(hydratedCreds.lastContextToken),
                    },
                    'Backfilled persisted Weixin reply context from recent messages',
                );
            }

            startBridge(row.accountId, hydratedCreds, onInbound);
            started++;
            continue;
        }

        log(
            {
                module: 'weixin-bridge',
                uid: row.accountId,
                reason: !rawCreds ? 'missing-credentials' : rawCreds.pushPolicy === 'silent' ? 'push-policy-silent' : 'missing-token',
            },
            'Skipping Weixin bridge startup',
        );
    }

    log({ module: 'weixin-bridge', boundUsers: rows.length, started }, 'Finished Weixin bridge startup');
}
