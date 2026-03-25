/**
 * Server-side WeChat command handler.
 *
 * Intercepts `/command` messages from WeChat users and executes them
 * using server-side APIs. Sends replies back via the WeChat bridge.
 *
 * This replaces the CLI-only command execution so that commands work
 * in Docker deployments where the CLI daemon is not running.
 */

import { pushToWeixin, updatePushPolicy } from "@/app/channels/weixin/weixinBridge";
import {
    listAccessibleTeamArtifacts,
    extractTeamBoard,
    extractTeamMembers,
    extractTeamName,
} from "@/app/team/teamArtifacts";
import { loadWeixinCredentials, saveWeixinCredentials } from "@/app/channels/weixin/weixinCredentials";
import { db } from "@/storage/db";
import { log, warn } from "@/utils/log";

interface ParsedCommand {
    command: string;
    args: string[];
}

const STATUS_ICONS: Record<string, string> = {
    todo: '⏳', 'in-progress': '🔄', done: '✅', blocked: '🚫',
};

/**
 * Parse a raw text message into a command if it starts with `/`.
 * Returns null if the message is not a command.
 */
export function parseCommand(text: string): ParsedCommand | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) return null;

    const parts = trimmed.slice(1).trim().split(/\s+/);
    const command = parts[0]?.toLowerCase();
    if (!command) return null;

    return { command, args: parts.slice(1) };
}

/**
 * Try to handle an inbound WeChat message as a command.
 * Returns true if the message was a command and was handled.
 * Returns false if the message is not a command (caller should continue normal flow).
 */
export async function tryHandleCommand(uid: string, text: string): Promise<boolean> {
    const parsed = parseCommand(text);
    if (!parsed) return false;

    log(
        { module: 'weixin-command', uid, command: parsed.command, argCount: parsed.args.length },
        'Processing WeChat command',
    );

    const reply = await executeCommand(uid, parsed.command, parsed.args);

    try {
        await pushToWeixin(uid, reply);
    } catch (cause) {
        warn(
            {
                module: 'weixin-command',
                uid,
                command: parsed.command,
                cause: cause instanceof Error ? cause.message : String(cause),
            },
            'Failed to send command reply via WeChat',
        );
    }

    return true;
}

async function executeCommand(uid: string, command: string, args: string[]): Promise<string> {
    switch (command) {
        case 'help':   return showHelp();
        case 'teams':  return listTeams(uid);
        case 'status': return teamStatus(uid);
        case 'tasks':  return listTasks(uid);
        case 'agents': return listAgents(uid);
        case 'mute':   return setPushPolicy(uid, 'important');
        case 'unmute': return setPushPolicy(uid, 'all');
        case 'new':
        case 'stop':
        case 'spawn':
        case 'kill':
            return `⚠️ /${command} 需要 CLI daemon 运行。\n请在本地启动 aha daemon 后使用此命令。\n\n服务端可用命令：/help /teams /status /tasks /agents /mute /unmute`;
        default:
            return `❓ 未知命令: /${command}\n输入 /help 查看可用命令`;
    }
}

// ── /help ──────────────────────────────────────────────────────────────────

function showHelp(): string {
    return `📖 微信指令:

聊天:
  直接打字       → 发给 master
  @角色名        → 指定 Agent
  #team名        → 指定 Team

常用:
  /teams         — 列出 Teams
  /status        — 当前状态
  /tasks         — 任务列表
  /agents        — Agent 列表
  /mute          — 仅重要消息
  /unmute        — 全部消息
  /help          — 显示此帮助`;
}

// ── /teams ─────────────────────────────────────────────────────────────────

async function listTeams(uid: string): Promise<string> {
    try {
        const artifacts = await listAccessibleTeamArtifacts(uid);
        if (!artifacts.length) {
            return '📋 暂无 Team';
        }
        const lines = artifacts.map((a, i) => {
            const board = extractTeamBoard(a);
            const name = extractTeamName(board, a.id);
            return `${i + 1}. ${name}`;
        });
        return `📋 你的 Teams:\n${lines.join('\n')}`;
    } catch (e) {
        return `❌ 获取 Teams 失败: ${e instanceof Error ? e.message : String(e)}`;
    }
}

// ── /status ────────────────────────────────────────────────────────────────

async function teamStatus(uid: string): Promise<string> {
    try {
        const artifacts = await listAccessibleTeamArtifacts(uid);
        const artifact = artifacts[0];
        if (!artifact) return '❌ 暂无 Team';

        const board = extractTeamBoard(artifact);
        const name = extractTeamName(board, artifact.id);
        const members = extractTeamMembers(board);

        const lines: string[] = [
            `📊 ${name} 状态:`,
            '━━━━━━━━━━━',
        ];

        if (members.length > 0) {
            lines.push('Agents:');
            for (const m of members) {
                const role = (m as Record<string, unknown>).role ?? (m as Record<string, unknown>).roleId ?? 'unknown';
                lines.push(`  🤖 ${role}`);
            }
        }

        const tasks: unknown[] = (board as Record<string, unknown>).tasks as unknown[] ?? [];
        if (Array.isArray(tasks)) {
            lines.push(`\n任务: ${tasks.length} 个`);
        }

        return lines.join('\n');
    } catch (e) {
        return `❌ 获取状态失败: ${e instanceof Error ? e.message : String(e)}`;
    }
}

// ── /tasks ─────────────────────────────────────────────────────────────────

async function listTasks(uid: string): Promise<string> {
    try {
        const artifacts = await listAccessibleTeamArtifacts(uid);
        const artifact = artifacts[0];
        if (!artifact) return '❌ 暂无 Team';

        const board = extractTeamBoard(artifact);
        const name = extractTeamName(board, artifact.id);
        const tasks: unknown[] = (board as Record<string, unknown>).tasks as unknown[] ?? [];

        if (!Array.isArray(tasks) || tasks.length === 0) {
            return `📋 ${name} 暂无任务`;
        }

        const lines = tasks.slice(0, 20).map((t: unknown, i: number) => {
            const task = t as Record<string, unknown>;
            const status = STATUS_ICONS[task.status as string] ?? '📌';
            return `${i + 1}. ${status} ${task.title ?? task.id ?? '无标题'}`;
        });
        return `📋 ${name} 任务:\n${lines.join('\n')}`;
    } catch (e) {
        return `❌ 获取任务失败: ${e instanceof Error ? e.message : String(e)}`;
    }
}

// ── /agents ────────────────────────────────────────────────────────────────

async function listAgents(uid: string): Promise<string> {
    try {
        const artifacts = await listAccessibleTeamArtifacts(uid);
        const artifact = artifacts[0];
        if (!artifact) return '❌ 暂无 Team';

        const board = extractTeamBoard(artifact);
        const name = extractTeamName(board, artifact.id);
        const members = extractTeamMembers(board);

        if (!members.length) {
            return `🤖 ${name} 暂无 Agent`;
        }

        const sessionIds = members
            .map((m: Record<string, unknown>) => m.sessionId as string)
            .filter(Boolean);

        const activeSessions = sessionIds.length > 0
            ? await db.session.findMany({
                where: { id: { in: sessionIds } },
                select: { id: true, lastActiveAt: true },
            })
            : [];

        const activeSet = new Set(activeSessions.map(s => s.id));

        const lines = members.map((m: Record<string, unknown>) => {
            const role = m.role ?? m.roleId ?? 'unknown';
            const sessionId = m.sessionId as string | undefined;
            const isActive = sessionId ? activeSet.has(sessionId) : false;
            const icon = isActive ? '🟢' : '🔴';
            return `${icon} ${role}`;
        });

        return `🤖 ${name} Agents:\n${lines.join('\n')}`;
    } catch (e) {
        return `❌ 获取 Agent 列表失败: ${e instanceof Error ? e.message : String(e)}`;
    }
}

// ── /mute /unmute ──────────────────────────────────────────────────────────

async function setPushPolicy(uid: string, policy: 'all' | 'important'): Promise<string> {
    try {
        updatePushPolicy(uid, policy);

        const creds = await loadWeixinCredentials(uid);
        if (creds) {
            await saveWeixinCredentials(uid, { ...creds, pushPolicy: policy });
        }

        return policy === 'important'
            ? '🔇 已静默。仅推送任务完成/失败/求助。\n输入 /unmute 恢复全部推送。'
            : '🔔 已恢复全部推送。';
    } catch (e) {
        return `❌ 设置推送策略失败: ${e instanceof Error ? e.message : String(e)}`;
    }
}
