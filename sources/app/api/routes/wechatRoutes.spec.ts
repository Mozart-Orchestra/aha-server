import fastify from 'fastify'
import { createHash } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod'

vi.mock('@/storage/db', () => ({
  db: {
    artifact: {
      findFirst: vi.fn(),
    },
    account: {
      findFirst: vi.fn(),
    },
  },
}))

vi.mock('@/app/channels/weixinInbound', () => ({
  publishInboundWeixinMessage: vi.fn(),
}))

vi.mock('@/app/events/eventRouter', () => ({
  eventRouter: {
    emitUpdate: vi.fn(),
  },
}))

vi.mock('@/storage/seq', () => ({
  allocateUserSeq: vi.fn().mockResolvedValue(7),
}))

vi.mock('@/utils/randomKeyNaked', () => ({
  randomKeyNaked: vi.fn().mockReturnValue('upd-123'),
}))

import { db } from '@/storage/db'
import { publishInboundWeixinMessage } from '@/app/channels/weixinInbound'
import { wechatRoutes } from './wechatRoutes'

function buildApp() {
  const app = fastify()
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  const typed = app.withTypeProvider<ZodTypeProvider>() as any
  wechatRoutes(typed)
  return typed
}

function sign(token: string, timestamp: string, nonce: string): string {
  return createHash('sha1').update([token, timestamp, nonce].sort().join('')).digest('hex')
}

describe('wechatRoutes', () => {
  const oldWechatToken = process.env.WECHAT_TOKEN
  const oldWechatAccountId = process.env.WECHAT_ACCOUNT_ID

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.WECHAT_TOKEN = 'test-token'
    process.env.WECHAT_ACCOUNT_ID = 'account-1'
    vi.mocked(db.artifact.findFirst).mockResolvedValue({ id: 'team-1' } as never)
    vi.mocked(publishInboundWeixinMessage).mockResolvedValue(undefined as never)
  })

  afterEach(() => {
    if (oldWechatToken === undefined) delete process.env.WECHAT_TOKEN
    else process.env.WECHAT_TOKEN = oldWechatToken

    if (oldWechatAccountId === undefined) delete process.env.WECHAT_ACCOUNT_ID
    else process.env.WECHAT_ACCOUNT_ID = oldWechatAccountId
  })

  it('persists official account inbound text as a team message', async () => {
    const app = buildApp()
    const timestamp = '1710000000'
    const nonce = 'nonce-1'
    const signature = sign('test-token', timestamp, nonce)

    const response = await app.inject({
      method: 'POST',
      url: `/v1/wechat?signature=${signature}&timestamp=${timestamp}&nonce=${nonce}`,
      headers: {
        'content-type': 'application/xml',
      },
      payload: [
        '<xml>',
        '<ToUserName><![CDATA[gh_test123]]></ToUserName>',
        '<FromUserName><![CDATA[o_openid_456]]></FromUserName>',
        '<CreateTime>1710000000</CreateTime>',
        '<MsgType><![CDATA[text]]></MsgType>',
        '<Content><![CDATA[你好，官方号]]></Content>',
        '<MsgId>1234567890</MsgId>',
        '</xml>',
      ].join(''),
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('收到：你好，官方号')
    expect(publishInboundWeixinMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: 'account-1',
        teamId: 'team-1',
        text: '你好，官方号',
        fromDisplayName: '公众号用户',
        metadata: {
          channel: 'wechat',
          wechat: {
            source: 'official-account',
            fromUser: 'o_openid_456',
            toUser: 'gh_test123',
            msgType: 'text',
            createTime: 1710000000,
            msgId: '1234567890',
          },
        },
      })
    )

    await app.close()
  })
})
