import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/storage/db', () => ({
  db: {
    session: {
      findMany: vi.fn(),
    },
  },
}))

vi.mock('@/modules/encrypt', () => ({
  encryptString: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
}))

vi.mock('@/app/kv/kvMutate', () => ({
  kvMutate: vi.fn(),
}))

vi.mock('@/app/events/eventRouter', () => ({
  eventRouter: {
    emitUpdate: vi.fn(),
  },
}))

vi.mock('@/storage/seq', () => ({
  allocateUserSeq: vi.fn(),
}))

vi.mock('@/utils/randomKeyNaked', () => ({
  randomKeyNaked: vi.fn(),
}))

vi.mock('@/app/team/teamArtifacts', () => ({
  listAccessibleTeamArtifacts: vi.fn(),
}))

vi.mock('@/app/channels/weixin/weixinCredentials', () => ({
  loadWeixinCredentials: vi.fn().mockResolvedValue(null),
  saveWeixinCredentials: vi.fn(),
}))

import { db } from '@/storage/db'
import { kvMutate } from '@/app/kv/kvMutate'
import { eventRouter } from '@/app/events/eventRouter'
import { allocateUserSeq } from '@/storage/seq'
import { randomKeyNaked } from '@/utils/randomKeyNaked'
import { listAccessibleTeamArtifacts } from '@/app/team/teamArtifacts'
import { encryptString } from '@/modules/encrypt'
import { handleInboundWeixinMessage, publishInboundWeixinMessage } from './weixinInbound'

describe('weixinInbound', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(db.session.findMany).mockResolvedValue([{ id: 'session-1' }, { id: 'session-2' }] as never)
    vi.mocked(allocateUserSeq).mockResolvedValue(42 as never)
    vi.mocked(randomKeyNaked).mockReturnValue('upd-123')
    vi.mocked(listAccessibleTeamArtifacts).mockResolvedValue([{ id: 'team-1' }] as never)
  })

  it('persists and broadcasts official-account inbound team messages with metadata', async () => {
    await publishInboundWeixinMessage({
      uid: 'account-1',
      teamId: 'team-1',
      text: '你好，公众号',
      fromDisplayName: '公众号用户',
      metadata: {
        channel: 'wechat',
        wechat: {
          source: 'official-account',
          fromUser: 'openid-1',
        },
      },
    })

    expect(kvMutate).toHaveBeenCalledTimes(1)
    const mutatePayload = vi.mocked(kvMutate).mock.calls[0]?.[1]?.[0]
    expect(mutatePayload?.key).toMatch(/^team_messages\.team-1\.\d+\./)
    expect(encryptString).toHaveBeenCalledWith(
      ['user', 'account-1', 'teams', 'team-1', 'messages', expect.any(String)],
      expect.any(String),
    )
    expect(eventRouter.emitUpdate).toHaveBeenCalledTimes(1)

    const emitArg = vi.mocked(eventRouter.emitUpdate).mock.calls[0]?.[0]
    expect(emitArg?.userId).toBe('account-1')
    expect(emitArg?.payload?.body?.t).toBe('team-message')
    expect(emitArg?.payload?.body?.teamId).toBe('team-1')
    expect(emitArg?.payload?.body?.message).toEqual(
      expect.objectContaining({
        teamId: 'team-1',
        content: '你好，公众号',
        fromRole: 'user',
        fromDisplayName: '公众号用户',
        metadata: {
          channel: 'wechat',
          wechat: {
            source: 'official-account',
            fromUser: 'openid-1',
          },
        },
      })
    )
  })

  it('reuses the shared helper for bridge inbound messages', async () => {
    await handleInboundWeixinMessage('account-1', '桥接消息', 'ctx-1', 'sender-1')

    expect(listAccessibleTeamArtifacts).toHaveBeenCalledWith('account-1')
    expect(eventRouter.emitUpdate).toHaveBeenCalledTimes(1)
    const message = vi.mocked(eventRouter.emitUpdate).mock.calls[0]?.[0]?.payload?.body?.message
    expect(message).toEqual(
      expect.objectContaining({
        fromDisplayName: '微信用户',
        content: '桥接消息',
        metadata: {
          channel: 'wechat',
          wechat: {
            source: 'weixin-bridge',
            senderId: 'sender-1',
            contextToken: 'ctx-1',
          },
        },
      })
    )
  })
})
