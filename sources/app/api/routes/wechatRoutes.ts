import { Fastify } from '../types'
import { z } from 'zod'
import { log } from '@/utils/log'
import { verifyWechatSignature } from '@/app/wechat/signature'
import {
  parseWechatXml,
  buildTextReplyXml,
  extractMessageText,
  WechatIncomingMessage,
} from '@/app/wechat/xmlParser'
import { publishInboundWeixinMessage } from '@/app/channels/weixinInbound'
import { eventRouter } from '@/app/events/eventRouter'
import { randomKeyNaked } from '@/utils/randomKeyNaked'
import { allocateUserSeq } from '@/storage/seq'
import { db } from '@/storage/db'

/**
 * WeChat Official Account (公众号) Routes
 *
 * - GET  /v1/wechat  — Server URL verification (token signature check)
 * - POST /v1/wechat  — Receive messages and events from WeChat
 *
 * These endpoints are PUBLIC (no Bearer auth) because WeChat
 * calls them directly. We authenticate via signature verification instead.
 */

function getWechatToken(): string {
  const token = process.env.WECHAT_TOKEN
  if (!token) {
    throw new Error('WECHAT_TOKEN environment variable is not configured')
  }
  return token
}

/**
 * Find the account and default team for routing WeChat messages.
 * Uses WECHAT_ACCOUNT_ID env or falls back to the first account.
 */
async function resolveMessageTarget(): Promise<{
  accountId: string
  teamId: string | null
} | null> {
  const configuredAccountId = process.env.WECHAT_ACCOUNT_ID
  if (configuredAccountId) {
    const team = await db.artifact.findFirst({
      where: { accountId: configuredAccountId },
      select: { id: true },
      orderBy: { updatedAt: 'desc' },
    })
    return { accountId: configuredAccountId, teamId: team?.id ?? null }
  }

  // Fallback: find any account with an active team
  const account = await db.account.findFirst({
    select: { id: true },
  })
  if (!account) return null

  const team = await db.artifact.findFirst({
    where: { accountId: account.id },
    select: { id: true },
    orderBy: { updatedAt: 'desc' },
  })
  return { accountId: account.id, teamId: team?.id ?? null }
}

/**
 * Route incoming WeChat message to the team event system.
 */
async function routeToTeamEvents(
  msg: WechatIncomingMessage,
  text: string,
  accountId: string,
  teamId: string
): Promise<void> {
  const updSeq = await allocateUserSeq(accountId)
  const messageEvent = {
    id: randomKeyNaked(12),
    body: {
      t: 'wechat-message' as const,
      teamId,
      wechat: {
        fromUser: msg.FromUserName,
        toUser: msg.ToUserName,
        msgType: msg.MsgType,
        content: text,
        createTime: Number(msg.CreateTime),
        msgId: 'MsgId' in msg ? msg.MsgId : undefined,
      },
    },
    seq: updSeq,
    createdAt: Date.now(),
  }

  eventRouter.emitUpdate({
    userId: accountId,
    payload: messageEvent,
  })
}

export function wechatRoutes(app: Fastify) {
  log({ module: 'api' }, 'Registering wechatRoutes...')

  // Register custom content-type parser for XML
  // WeChat sends application/xml or text/xml
  const xmlContentTypes = ['text/xml', 'application/xml']
  for (const ct of xmlContentTypes) {
    app.addContentTypeParser(ct, { parseAs: 'string' }, (_req, body, done) => {
      done(null, body)
    })
  }

  /**
   * GET /v1/wechat — Token verification endpoint
   *
   * WeChat sends: signature, timestamp, nonce, echostr
   * We verify the signature and return echostr as plain text.
   */
  app.get(
    '/v1/wechat',
    {
      schema: {
        querystring: z.object({
          signature: z.string(),
          timestamp: z.string(),
          nonce: z.string(),
          echostr: z.string(),
        }),
      },
    },
    async (request, reply) => {
      const { signature, timestamp, nonce, echostr } = request.query as {
        signature: string
        timestamp: string
        nonce: string
        echostr: string
      }

      try {
        const token = getWechatToken()
        const valid = verifyWechatSignature(token, signature, timestamp, nonce)

        if (valid) {
          log({ module: 'wechat' }, 'Token verification succeeded')
          return reply.type('text/plain').send(echostr)
        }

        log({ module: 'wechat', level: 'warn' }, 'Token verification failed: signature mismatch')
        return reply.code(403).send('Forbidden')
      } catch (error) {
        log({ module: 'wechat', level: 'error' }, `Token verification error: ${error}`)
        return reply.code(500).send('Internal Server Error')
      }
    }
  )

  /**
   * POST /v1/wechat — Receive messages from WeChat
   *
   * WeChat sends XML body with message data.
   * We also verify the signature from query params before processing.
   */
  app.post(
    '/v1/wechat',
    {
      schema: {
        querystring: z.object({
          signature: z.string(),
          timestamp: z.string(),
          nonce: z.string(),
          openid: z.string().optional(),
          msg_signature: z.string().optional(),
        }),
      },
    },
    async (request, reply) => {
      const { signature, timestamp, nonce } = request.query as {
        signature: string
        timestamp: string
        nonce: string
      }

      // Verify signature
      try {
        const token = getWechatToken()
        const valid = verifyWechatSignature(token, signature, timestamp, nonce)

        if (!valid) {
          log({ module: 'wechat', level: 'warn' }, 'Message signature verification failed')
          return reply.code(403).send('Forbidden')
        }
      } catch (error) {
        log({ module: 'wechat', level: 'error' }, `Signature verification error: ${error}`)
        return reply.code(500).send('Internal Server Error')
      }

      // Parse the XML body
      const rawBody = request.body as string
      if (!rawBody) {
        return reply.code(400).send('Empty body')
      }

      let msg: WechatIncomingMessage
      try {
        msg = parseWechatXml(rawBody)
      } catch (error) {
        log({ module: 'wechat', level: 'error' }, `XML parse error: ${error}`)
        return reply.code(400).send('Invalid XML')
      }

      log(
        { module: 'wechat', msgType: msg.MsgType, from: msg.FromUserName },
        `Received ${msg.MsgType} message`
      )

      // Handle events (subscribe/unsubscribe)
      if (msg.MsgType === 'event') {
        const event = msg.Event
        log({ module: 'wechat' }, `Event: ${event}`)

        if (event === 'subscribe') {
          const welcomeXml = buildTextReplyXml(
            msg.FromUserName,
            msg.ToUserName,
            '欢迎关注！我是 Aha AI 助手，有什么可以帮您的？'
          )
          return reply.type('application/xml').send(welcomeXml)
        }

        // Other events: return empty success
        return reply.type('text/plain').send('success')
      }

      // Extract text from message
      const text = extractMessageText(msg)

      // Route to team event system (fire-and-forget, don't block reply)
      const target = await resolveMessageTarget()
      if (target?.teamId) {
        publishInboundWeixinMessage({
          uid: target.accountId,
          teamId: target.teamId,
          text,
          fromDisplayName: '公众号用户',
          metadata: {
            channel: 'wechat',
            wechat: {
              source: 'official-account',
              fromUser: msg.FromUserName,
              toUser: msg.ToUserName,
              msgType: msg.MsgType,
              createTime: Number(msg.CreateTime),
              msgId: 'MsgId' in msg ? msg.MsgId : undefined,
              ...(msg.MsgType === 'image' ? { picUrl: msg.PicUrl, mediaId: msg.MediaId } : {}),
              ...(msg.MsgType === 'voice' ? { mediaId: msg.MediaId, format: msg.Format, recognition: msg.Recognition } : {}),
              ...((msg.MsgType === 'video' || msg.MsgType === 'shortvideo') ? { mediaId: msg.MediaId, thumbMediaId: msg.ThumbMediaId } : {}),
              ...(msg.MsgType === 'link' ? { title: msg.Title, description: msg.Description, url: msg.Url } : {}),
            },
          },
        }).catch((err) =>
          log({ module: 'wechat', level: 'error' }, `Failed to persist inbound message: ${err}`)
        )

        routeToTeamEvents(msg, text, target.accountId, target.teamId).catch((err) =>
          log({ module: 'wechat', level: 'error' }, `Failed to route message: ${err}`)
        )
      }

      // Passive reply: acknowledge receipt
      // For now, send a simple echo reply for text messages
      // In production, this would integrate with AI processing pipeline
      if (msg.MsgType === 'text') {
        const replyContent = `收到：${text}`
        const replyXml = buildTextReplyXml(msg.FromUserName, msg.ToUserName, replyContent)
        return reply.type('application/xml').send(replyXml)
      }

      // Non-text messages: return success (no reply)
      return reply.type('text/plain').send('success')
    }
  )
}
