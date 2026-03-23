# 2026-03-24 happy-server task API capability map for kanban migration

## 1句
happy-server 已经具备 server-driven task lifecycle 主干，但 kanban 目前只接了 human-lock，尚未接 create/update/delete/start/complete/comment 等主写路径。

## 3句
1. `taskRoutes.ts` 已公开 list/get/create/update/delete/start/complete/blocker/comment/human-lock 全套端点。  
2. `taskOrchestrator.updateTask()` 还内建了状态变更评论、handoff 评论、approval 评论与人工锁保护。  
3. 真正阻碍收敛的不是 server 缺主干，而是 kanban 侧没有 task client，以及双方字段/动作模型仍有差距。

## 关键能力
- create/update/delete/list/get
- start / complete
- blocker / resolve blocker
- add comment
- set / clear human lock
- server-side board save + broadcast

## 已确认的迁移约束
1. `PUT /tasks/:id` **不能** 用来把任务改到 `in-progress`；server 明确要求该动作走 `startTask()`。  
2. human lock 已有独立端点；kanban 当前已经在 `teams/[id].tsx:1000-1075` 调用。  
3. route schema 当前公开字段是：`title/description/status/priority/assigneeId/reporterId/parentTaskId/labels/approvalStatus` + `comment/actor`。  
4. route schema **未公开** kanban 本地常用字段：`dueDate/tags/source/sourceMessageId/relatedMessageIds/todoId/linkedSessionIds/dependencies/checklists/attachments/...`。  
5. server comment type 目前比 kanban 小一圈，若 UI 想无损迁移 plan/execution-check 等类型，需要先扩 schema 或在该路径限制类型集合。

## Step 2 设计含义
- 先迁 **最小公共子集**：create + update(title/description/priority/assigneeId/approvalStatus) + comment + delete。  
- 状态迁移单独走 start/complete/update 三分流，不要继续把所有状态切换都塞进普通 update。  
- tags ↔ labels、dueDate/source/todo linkage 等字段，先定义兼容映射或 Phase 2.5 再补。  
- 让 kanban 继续从 artifact/socket 读 board，但把写入收敛到 server task API，由 server 负责再写 board / broadcast。
