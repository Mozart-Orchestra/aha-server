import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseCommand } from './weixinCommandHandler'

vi.mock('@/app/channels/weixin/weixinBridge', () => ({
    pushToWeixin: vi.fn().mockResolvedValue(true),
    updatePushPolicy: vi.fn(),
}))

vi.mock('@/app/team/teamArtifacts', () => ({
    listAccessibleTeamArtifacts: vi.fn().mockResolvedValue([]),
    extractTeamBoard: vi.fn().mockReturnValue({}),
    extractTeamMembers: vi.fn().mockReturnValue([]),
    extractTeamName: vi.fn().mockReturnValue('Test Team'),
}))

vi.mock('@/app/channels/weixin/weixinCredentials', () => ({
    loadWeixinCredentials: vi.fn().mockResolvedValue(null),
    saveWeixinCredentials: vi.fn(),
}))

vi.mock('@/storage/db', () => ({
    db: {
        session: {
            findMany: vi.fn().mockResolvedValue([]),
        },
    },
}))

vi.mock('@/utils/log', () => ({
    log: vi.fn(),
    warn: vi.fn(),
}))

describe('parseCommand', () => {
    it('should parse a simple command', () => {
        expect(parseCommand('/help')).toEqual({ command: 'help', args: [] })
    })

    it('should parse a command with args', () => {
        expect(parseCommand('/t 2')).toEqual({ command: 't', args: ['2'] })
    })

    it('should parse a command with multiple args', () => {
        expect(parseCommand('/task create new feature')).toEqual({
            command: 'task',
            args: ['create', 'new', 'feature'],
        })
    })

    it('should handle leading/trailing whitespace', () => {
        expect(parseCommand('  /teams  ')).toEqual({ command: 'teams', args: [] })
    })

    it('should normalize command to lowercase', () => {
        expect(parseCommand('/HELP')).toEqual({ command: 'help', args: [] })
    })

    it('should return null for non-command text', () => {
        expect(parseCommand('hello world')).toBeNull()
    })

    it('should return null for empty string', () => {
        expect(parseCommand('')).toBeNull()
    })

    it('should return null for just a slash', () => {
        expect(parseCommand('/')).toBeNull()
    })

    it('should return null for text starting with @ or #', () => {
        expect(parseCommand('@master hello')).toBeNull()
        expect(parseCommand('#team1 do something')).toBeNull()
    })
})

describe('tryHandleCommand', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('should return false for non-command text', async () => {
        const { tryHandleCommand } = await import('./weixinCommandHandler')
        const result = await tryHandleCommand('user-1', 'hello world')
        expect(result).toBe(false)
    })

    it('should return true for /help command', async () => {
        const { tryHandleCommand } = await import('./weixinCommandHandler')
        const result = await tryHandleCommand('user-1', '/help')
        expect(result).toBe(true)
    })

    it('should send help text via pushToWeixin for /help', async () => {
        const { pushToWeixin } = await import('@/app/channels/weixin/weixinBridge')
        const { tryHandleCommand } = await import('./weixinCommandHandler')

        await tryHandleCommand('user-1', '/help')

        expect(pushToWeixin).toHaveBeenCalledTimes(1)
        const reply = vi.mocked(pushToWeixin).mock.calls[0]?.[1]
        expect(reply).toContain('📖 微信指令')
        expect(reply).toContain('/teams')
        expect(reply).toContain('/status')
    })

    it('should handle /teams command', async () => {
        const { pushToWeixin } = await import('@/app/channels/weixin/weixinBridge')
        const { tryHandleCommand } = await import('./weixinCommandHandler')

        await tryHandleCommand('user-1', '/teams')

        expect(pushToWeixin).toHaveBeenCalledTimes(1)
        const reply = vi.mocked(pushToWeixin).mock.calls[0]?.[1]
        expect(reply).toContain('暂无 Team')
    })

    it('should return daemon-required message for /spawn', async () => {
        const { pushToWeixin } = await import('@/app/channels/weixin/weixinBridge')
        const { tryHandleCommand } = await import('./weixinCommandHandler')

        await tryHandleCommand('user-1', '/spawn builder')

        expect(pushToWeixin).toHaveBeenCalledTimes(1)
        const reply = vi.mocked(pushToWeixin).mock.calls[0]?.[1]
        expect(reply).toContain('CLI daemon')
    })

    it('should return unknown command message for invalid commands', async () => {
        const { pushToWeixin } = await import('@/app/channels/weixin/weixinBridge')
        const { tryHandleCommand } = await import('./weixinCommandHandler')

        await tryHandleCommand('user-1', '/xyz')

        expect(pushToWeixin).toHaveBeenCalledTimes(1)
        const reply = vi.mocked(pushToWeixin).mock.calls[0]?.[1]
        expect(reply).toContain('未知命令')
        expect(reply).toContain('/xyz')
    })

    it('should handle /mute command', async () => {
        const { pushToWeixin } = await import('@/app/channels/weixin/weixinBridge')
        const { updatePushPolicy } = await import('@/app/channels/weixin/weixinBridge')
        const { tryHandleCommand } = await import('./weixinCommandHandler')

        await tryHandleCommand('user-1', '/mute')

        expect(updatePushPolicy).toHaveBeenCalledWith('user-1', 'important')
        expect(pushToWeixin).toHaveBeenCalledTimes(1)
        const reply = vi.mocked(pushToWeixin).mock.calls[0]?.[1]
        expect(reply).toContain('🔇')
    })

    it('should handle /unmute command', async () => {
        const { pushToWeixin } = await import('@/app/channels/weixin/weixinBridge')
        const { updatePushPolicy } = await import('@/app/channels/weixin/weixinBridge')
        const { tryHandleCommand } = await import('./weixinCommandHandler')

        await tryHandleCommand('user-1', '/unmute')

        expect(updatePushPolicy).toHaveBeenCalledWith('user-1', 'all')
        expect(pushToWeixin).toHaveBeenCalledTimes(1)
        const reply = vi.mocked(pushToWeixin).mock.calls[0]?.[1]
        expect(reply).toContain('🔔')
    })
})
