# 2026-03-24 marketplace versioning fix

## 一句话
marketplace 发布版本的问题不只是 `version = 1` 的 TODO，而是“找历史版本”的查询条件本身也写错了。

## 三句话
1. 旧实现尝试按 `market.namespace + display.name` 查历史版本，但 `display` 里并没有 `name` 字段，真正的 agent 名字在 `spec.name / genome.name`。  
2. 我把版本来源改成基于 `ref` 前缀 `${namespace}/${name}:` 查现有 listing，再解析最大版本号 +1。  
3. 同时增加了 `ref` 唯一冲突重试，降低并发发布时重复版本的概率。  

## 关键修复
- 新增 `buildListingRef()` / `parseListingVersion()` / `getNextListingVersion()`
- 用 `db.marketListing.findMany({ where: { ref: { startsWith: prefix }}})` 取现有版本集合
- 计算 `max(version) + 1`
- 如果 Prisma `P2002` 命中 `ref` 唯一键，则重算版本并重试（最多 3 次）

## 风险与后续
- 目前仍没有专门的 market listing 单测，后续适合补 `marketListingRoutes.spec.ts`
- 如果未来要支持显式 major/minor channel，最好把 version 拆成独立字段，而不是继续只嵌在 `ref` 字符串里
