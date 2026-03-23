# 2026-03-24 permission interceptor fix

## 一句话
permissionInterceptor 的关键缺口不是只有 TODO，而是“身份提取”和“路由→操作映射”两条链都不完整。

## 三句话
1. Express 版 `permissionInterceptor.ts` 原先对 userId 的提取依赖未实现 TODO，token decode 也只是 stub。  
2. Fastify 版 `enablePermissionInterceptor.ts` 虽然在运行时生效，但没有从 bearer token 解析身份，而且把 `/v1/...` 路由错误映射成了 `*_v1` 一类操作名。  
3. 我补了共享工具 `sources/utils/permissionRequest.ts`，统一处理 bearer token 身份解析与 route→operation 映射，并让两套拦截器共用。  

## 关键修复
- 新增 `resolvePermissionUserInfo()`：优先用 `auth.verifyToken()` 提取可信 userId，再结合 token extras / headers 补 teamId、role、sessionId
- 新增 `decodePermissionToken()`：移除 TODO stub，使用 `jsonwebtoken.decode` + base64url fallback
- 新增 `mapPermissionRouteToOperation()`：支持 `/v1/teams/:teamId/tasks/...`、`start_task`、`complete_task`、`report_blocker`、`resolve_blocker`、`list_team_messages`
- Fastify 插件现在会把解析出的 `userId/userRole/teamId/sessionId` 挂到 request 上，便于审计日志

## 验证状态
- 已补单测：verified token 优先级、`/v1/teams/.../tasks` 映射、`start_task` 映射
- 受限：本机当前 `happy-server` 未安装项目依赖，无法在本地完整跑 `vitest` / `tsc`
