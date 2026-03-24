import { Fastify } from "../types";
import { z } from "zod";
import { log } from "@/utils/log";
import {
    loadWeixinCredentials,
    saveWeixinCredentials,
    deleteWeixinCredentials,
    WeixinCredentials,
} from "@/app/channels/weixin/weixinCredentials";
import {
    startBridge,
    stopBridge,
    isConnected,
    updatePushPolicy,
} from "@/app/channels/weixin/weixinBridge";
import { handleInboundWeixinMessage } from "@/app/channels/weixinInbound";

/**
 * Channel Routes — WeChat iLink Bot binding and management.
 *
 * GET  /v1/channels/status              — binding status for all channels
 * POST /v1/channels/weixin/qr           — get QR code to scan
 * POST /v1/channels/weixin/poll         — poll QR scan status
 * POST /v1/channels/weixin/bind         — confirm binding with credentials
 * DELETE /v1/channels/weixin            — unbind WeChat
 * PATCH /v1/channels/weixin/policy      — update push policy
 */

export function channelRoutes(app: Fastify) {
    log({ module: 'api' }, 'Registering channelRoutes...');

    // GET /v1/channels/status
    app.get('/v1/channels/status', {
        preHandler: app.authenticate,
        schema: {},
    }, async (request) => {
        const uid = request.userId;
        const creds = await loadWeixinCredentials(uid);
        return {
            weixin: creds ? {
                connected: isConnected(uid),
                pushPolicy: creds.pushPolicy,
                boundAt: true,
            } : null,
        };
    });

    // POST /v1/channels/weixin/qr — get a fresh QR code from iLink
    app.post('/v1/channels/weixin/qr', {
        preHandler: app.authenticate,
        schema: {},
    }, async (_request, reply) => {
        try {
            const res = await fetch('https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3');
            if (!res.ok) {
                reply.code(502);
                return { error: `iLink API error: ${res.status}` };
            }
            const data = await res.json() as any;
            return {
                qrcode: data.qrcode as string,
                displayUrl: (data.qrcode_img_content ?? `https://ilinkai.weixin.qq.com/qr/${data.qrcode}`) as string,
            };
        } catch (e) {
            reply.code(502);
            return { error: String(e) };
        }
    });

    // POST /v1/channels/weixin/poll — poll QR scan status
    app.post('/v1/channels/weixin/poll', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({ qrcode: z.string() }),
        },
    }, async (request, reply) => {
        const { qrcode } = request.body as { qrcode: string };
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 35_000);
            const res = await fetch(
                `https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
                { signal: controller.signal }
            ).finally(() => clearTimeout(timer));

            if (!res.ok) {
                reply.code(502);
                return { error: `iLink API error: ${res.status}` };
            }
            const data = await res.json() as any;
            const status = (data.status ?? 'wait') as string;
            return {
                status,
                credentials: status === 'confirmed' ? {
                    token: data.bot_token as string,
                    baseUrl: (data.baseurl ?? 'https://ilinkai.weixin.qq.com/') as string,
                    weixinUserId: data.ilink_user_id as string | undefined,
                    accountId: data.ilink_bot_id as string | undefined,
                } : undefined,
            };
        } catch (e: any) {
            if (e?.name === 'AbortError') return { status: 'wait' };
            reply.code(502);
            return { error: String(e) };
        }
    });

    // POST /v1/channels/weixin/bind — save credentials and start bridge
    app.post('/v1/channels/weixin/bind', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                token: z.string().min(1),
                baseUrl: z.string().url(),
                weixinUserId: z.string().optional(),
                accountId: z.string().optional(),
            }),
        },
    }, async (request) => {
        const uid = request.userId;
        const { token, baseUrl, weixinUserId, accountId } = request.body as {
            token: string;
            baseUrl: string;
            weixinUserId?: string;
            accountId?: string;
        };

        const creds: WeixinCredentials = {
            token,
            baseUrl,
            weixinUserId,
            accountId,
            pushPolicy: 'all',
        };

        await saveWeixinCredentials(uid, creds);
        startBridge(uid, creds, handleInboundWeixinMessage);

        return { ok: true };
    });

    // DELETE /v1/channels/weixin — unbind
    app.delete('/v1/channels/weixin', {
        preHandler: app.authenticate,
        schema: {},
    }, async (request) => {
        const uid = request.userId;
        stopBridge(uid);
        await deleteWeixinCredentials(uid);
        return { ok: true };
    });

    // PATCH /v1/channels/weixin/policy
    app.patch('/v1/channels/weixin/policy', {
        preHandler: app.authenticate,
        schema: {
            body: z.object({
                pushPolicy: z.enum(['all', 'important', 'silent']),
            }),
        },
    }, async (request) => {
        const uid = request.userId;
        const { pushPolicy } = request.body as { pushPolicy: 'all' | 'important' | 'silent' };

        updatePushPolicy(uid, pushPolicy);

        const creds = await loadWeixinCredentials(uid);
        if (creds) {
            await saveWeixinCredentials(uid, { ...creds, pushPolicy });
        }

        return { ok: true };
    });
}
