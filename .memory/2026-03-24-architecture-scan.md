# 2026-03-24 architecture scan

## 一句话
happy-server 是基于 Fastify + Prisma + Redis 的服务端真相层：负责 API、团队任务/消息、artifact 持久化、会话/机器同步，并通过 WebSocket 广播实时更新。

## 三句话
1. 启动入口是 `sources/main.ts`：先连 DB/Redis，再初始化加密、GitHub、文件与 auth，随后启动 API、metrics、presence timeout，并 seed 系统 genomes。  
2. HTTP 入口是 `sources/app/api/api.ts`：集中注册 auth/session/machine/artifact/team/task/evolution/market 等 route，并附带 swagger、rate-limit、权限拦截和 socket 推送。  
3. 团队协作的核心真相层在 `sources/app/task/taskOrchestrator.ts` + `sources/app/team/teamArtifacts.ts`：任务板写入 `Artifact.body`，团队消息进入 `UserKVStore`（加密字符串），之后广播到客户端。  

## 关键文件
- `sources/main.ts` — 服务启动编排
- `sources/app/api/api.ts` — Fastify 装配与 route 注册
- `sources/app/api/routes/taskRoutes.ts` — 任务 API（list/get/create/update/start/complete/blocker/human-lock）
- `sources/app/api/routes/teamManagementRoutes.ts` — team 生命周期管理
- `sources/app/api/routes/teamMessagesRoutes.ts` — team chat 存取与广播
- `sources/app/task/taskOrchestrator.ts` — 任务状态机、执行链接、阻塞传播、父子任务联动
- `sources/app/team/teamArtifacts.ts` — team board 解析、访问控制、摘要
- `sources/app/team/teamOverview.ts` — team 级 tokens / completed tasks 聚合缓存
- `prisma/schema.prisma` — Account / Session / Machine / Artifact / UserKVStore / Genome / MarketReview 等核心模型

## 当前观察
- route 层很全，后端已经具备“服务端驱动 task orchestration”的骨架。  
- 任务板仍以整块 `Artifact.body` JSON 持久化，单次任务变更是 coarse-grained overwrite。  
- `taskOrchestrator.ts`（1116 行）和 `teamManagementRoutes.ts`（1290 行）都已进入“继续长大就会难维护”的体量。  

## 初步进化点
1. 继续把任务相关写路径收敛到 server-side task API / orchestrator，减少多处直接改 board JSON。  
2. 拆分 `taskOrchestrator.ts`：按 lifecycle / blockers / human-lock / propagation / broadcast 分模块。  
3. 给 team board 引入更明确的 schema/version 演进策略，降低整板覆盖与兼容风险。  
