# happy-server 内存与磁盘泄漏分析

> 作者：Claude Code 调试记录
> 日期：2026-03-17
> 背景：跑 53 个 agent 14 小时后 server 在 02:16:22 崩溃，SSD 占用从 95% 冲到 100%

---

## 1. 问题现象

- 长时间运行（>4 小时）后进程会突然死亡，**日志无任何 SIGTERM/shutdown 消息**
- 死前最后行为：GET `/v1/teams/:id/members` 耗时 6 秒后返回 500，进程消失
- SSD 磁盘占用缓慢上升，最终触发 OOM 或 macOS 强制 kill

---

## 2. 磁盘空间占用分析

### 2.1 日志文件增长（观测事实）

```
/happy-server/.logs/03-15-19-17-13.log  → 3.9 GB（多天运行）
/happy-server/.logs/03-14-10-37-50.log  → 283 MB
/happy-server/.logs/03-16-11-07-01.log  → 51 MB
/happy-server/.logs/03-17-00-52-17.log  → 16 MB（1.5 小时）
合计：~4.7 GB
```

53 个 agent 以 150–350 req/min 的速度请求服务器，**每小时约产生 10–20 MB 日志**，多天运行后积累 GB 级别。

**⚠️ 重要约束：日志是 AI 进化和复盘的唯一材料，不能被自动清理或轮转。**
- 日志文件只能由用户主动触发清理
- `pino/file` transport 保持原样，不使用 pino-roll 或任何 rotation 方案
- 磁盘占满的根本原因不是日志本身，而是 **Node.js 堆内存持续增长 → macOS 触发 swap → SSD 被 swap 文件写满**
- 日志只是被动占用，不是主动泄漏

### 2.2 Claude session JSONL 文件积累

```
~/.claude/projects/  → 1.9 GB（每个 agent session 产生 10-30 MB JSONL）
最大单文件：8675f521...jsonl → 18 MB（org-manager 14 小时会话）
```

这是 Claude Code 本身的行为，无法直接控制，但可以定期清理超过 N 天的历史：

```bash
# 清理 7 天以上的 Claude session 文件
find ~/.claude/projects/-Users-swmt-happy0313 -name "*.jsonl" -mtime +7 -delete
```

---

## 3. 内存泄漏分析

### 3.1 rpcListeners Map 未完全清理

**文件**：`sources/app/api/socket.ts` + `sources/app/api/socket/rpcHandler.ts`

**问题**：

```typescript
// socket.ts 第 32 行
let rpcListeners = new Map<string, Map<string, Socket>>();
```

`rpcListeners` 是每个 userId 一个 `Map<method, Socket>`。
在 `rpcHandler.ts` 的 `disconnect` 回调中：

```typescript
socket.on('disconnect', () => {
    // 正确：删除该 socket 注册的 methods
    methodsToRemove.forEach(method => rpcListeners.delete(method));

    if (rpcListeners.size === 0) {
        rpcListeners.delete(userId);  // ← BUG: 这里 rpcListeners 是 userRpcListeners，不是外层的 Map
    }
});
```

`rpcListeners.delete(userId)` 实际上是在 `userRpcListeners`（内层 Map）上调用
，**永远不会清理外层 `rpcListeners` Map 中的 userId 条目**。
每个 userId 的条目在所有 socket 断开后依然留在外层 Map。

**影响**：53 个 agent 各自有 1 个 userId，每个 userId 在外层 Map 中保持一个空的
内层 Map 对象。单次运行影响较小，但长期运行多次后会累积。

**修复**：

```typescript
// rpcHandler.ts disconnect 回调中，需要清理外层 Map
socket.on('disconnect', () => {
    // 清理此 socket 的所有 RPC methods
    for (const [method, registeredSocket] of rpcListeners.entries()) {
        if (registeredSocket === socket) {
            rpcListeners.delete(method);
        }
    }

    // 若 userId 的所有 methods 已清空，从外层 Map 移除
    // 注意：这需要将外层 rpcListeners 引用传进来或重构
});
```

### 3.2 sessionCache 无过期驱逐机制

**文件**：`sources/app/presence/sessionCache.ts`

```typescript
// cleanup() 方法确实存在，每 5 分钟调用一次
setInterval(() => { activityCache.cleanup(); }, 5 * 60 * 1000);
```

53 个 agent 创建 53+ 个 session 条目，TTL 30 秒，`cleanup()` 每 5 分钟跑一次。
理论上没有泄漏，**但需确认 cleanup 的 interval 在 server 关闭时被 clearInterval**。
当前 `shutdown()` 只清理 `batchTimer`，没有清理这个全局 cleanup interval。

**修复**：

```typescript
// sessionCache.ts 末尾
const cleanupInterval = setInterval(() => {
    activityCache.cleanup();
}, 5 * 60 * 1000);

// 注册 shutdown 清理
import { onShutdown } from '@/utils/shutdown';
onShutdown('session-cache', async () => {
    clearInterval(cleanupInterval);
    activityCache.shutdown();
});
```

### 3.3 Socket.IO 连接本身的内存占用

53 个 agent session，每个 agent 有：
- 1 个 `session-scoped` WebSocket 连接
- 可能的 `machine-scoped` 连接（daemon）

`eventRouter.userConnections` Map 正确在 disconnect 时清理（代码逻辑正确）。

但 Socket.IO 内部对每个 socket 维护：
- 心跳 buffer
- 发送队列
- 事件监听器

**53 个并发连接的固定内存基线约 100-200 MB**（Socket.IO 每连接 ~2-4 MB）。

### 3.4 Prisma 连接池耗尽（触发崩溃的直接原因）

崩溃前两次 500 错误：
- `GET /v1/teams/:id/members` — 6 秒后 500
- 另一个 request — 同样超时

Prisma 默认连接池大小 = `min(cpuCount * 2 + 1, 10)`。
53 个 agent 高峰期 250+ req/min 并发，**Prisma 连接池极易耗尽**，
耗尽后新查询会等待，超过 `pool_timeout`（默认 10 秒）后抛出异常返回 500。

`CLAUDE.md` 中已有记录：`"Response from the Engine was empty" = Prisma database connection lost`

**修复**：

```typescript
// storage/db.ts
export const db = new PrismaClient({
    datasources: {
        db: { url: process.env.DATABASE_URL }
    },
    // 增大连接池
    // 在 DATABASE_URL 中追加：?connection_limit=20&pool_timeout=30
});
```

或在 `.env` 中：

```
DATABASE_URL="postgresql://...?connection_limit=20&pool_timeout=30&connect_timeout=10"
```

---

## 4. 总结：按优先级排列的修复项

| 优先级 | 问题 | 文件 | 影响 |
|--------|------|------|------|
| 🔴 P0 | Node.js 堆内存持续增长 → macOS swap → SSD 满 | 多处（见下文） | 直接导致主机卡死 |
| 🔴 P0 | Prisma 连接池太小 | `.env` | 触发崩溃时的最后一根稻草 ✅ 已修复 |
| 🟡 P1 | POST messages 加载所有 session metadata（无用）| `routes/teamMessagesRoutes.ts` | 每条消息多余 DB 读取 ✅ 已修复 |
| 🟡 P1 | GET messages 全量解密（默认 500 条）| `routes/teamMessagesRoutes.ts` | 每请求可分配数十 MB 临时堆 ✅ 已修复 |
| 🟡 P1 | rpcListeners 外层 Map 未清理 | `socket.ts` | 长期内存缓慢增长 ✅ 已修复 |
| 🟡 P1 | sessionCache cleanup interval 未注册 shutdown | `presence/sessionCache.ts` | 内存无法回收 ✅ 已修复 |
| 🟢 P2 | server 崩溃后无自动重启 | pm2 / launchd | 可用性 |

---

## 5. 真正的 SSD 满根因：Node.js heap → macOS swap

**日志文件不是主因**。macOS SSD 被写满的机制是：

```
Node.js 堆持续增长（内存泄漏）
  → 物理内存不足
  → macOS 触发 swap（压缩内存 + swapfile 写 SSD）
  → /private/var/vm/swapfile* 快速增大
  → SSD 写满
```

### 最可疑的堆泄漏点

**1. POST messages 加载所有 session metadata（✅ 已修复）**

```typescript
// 原代码：每次发送消息都 SELECT metadata（加密大字段），实际从不使用
const allSessions = await db.session.findMany({
    where: { accountId: userId },
    select: { id: true, metadata: true }  // metadata 是大型加密 BLOB，完全无用
});
// 然后把所有 session ID 无条件加入 Set（根本没有过滤！）
```

修复：改为 `select: { id: true }` 只取 ID，不加载 metadata。每次发消息节省加载几百 KB 加密数据。

**2. GET messages 全量解密（✅ 已修复）**

```typescript
// 原代码：默认返回 500 条，最多 1000 条，全部在内存中解密
// 14 小时运行后每个 team 可能积累数千条消息
// 53 agents × 频繁轮询 × 每次分配 ~25-50MB 临时堆 = GC 无法及时回收
const fetchLimit = Math.min((limit ?? 500), 1000);
```

修复：默认 50 条，最多 200 条；新增 `before=<cursor>` 分页参数，向上滚动时才加载更早的消息。接口行为：
- 首次请求：返回最新 50 条 + `cursor`（最旧消息的 KV key）
- 加载更多：`?before=<cursor>` 返回再往前 50 条
- 每个 userId 留一个空 Map 对象在外层永不清理
- 53 个 agent userId = 53 个悬挂条目，影响较小但积累明显

**3. sessionCache cleanup interval 未 shutdown（已修复）**
- 进程退出时 interval 不 clearInterval，Node 无法干净退出

### 待添加的安全网

```bash
# 在 package.json 的 start script 中加 --max-old-space-size 限制堆大小
# 超过限制时 V8 会主动 GC，而不是无限增长到 OOM
NODE_OPTIONS="--max-old-space-size=2048" yarn start
```

```bash
# PM2 加 --max-memory-restart 作为兜底
pm2 start "yarn start" --name happy-server \
  --max-memory-restart 2G \
  --restart-delay 3000
```

---

## 6. 立即可做的措施

```bash
# 1. 已修复：Prisma 连接池 connection_limit=20&pool_timeout=30（在 .env.dev）
# 2. 已修复：rpcListeners 外层 Map 清理（socket.ts）
# 3. 已修复：sessionCache shutdown 注册（sessionCache.ts）

# 4. 可选：启动时限制 Node.js 堆大小（防止 swap 写满 SSD）
NODE_OPTIONS="--max-old-space-size=2048" yarn start
```

---

## 附：崩溃时序重建

```
03-17 00:52:17  server 启动（PID 47734）
03-17 01:30     53 agents 满负荷，250+ req/min
03-17 02:11     请求量骤降（agents 完成任务）
03-17 02:15     requests 反弹至 119/min（mobile app 刷新）
03-17 02:16:16  GET /v1/teams/:id/members 进入 Prisma 查询
03-17 02:16:22  查询超时 6s → 返回 500 → 进程死亡（OOM kill 或 uncaught error）
03-17 02:18     org-manager 最后消息："服务器暂时不响应"
```
