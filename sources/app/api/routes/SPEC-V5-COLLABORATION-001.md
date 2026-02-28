# V5-COLLABORATION-001: 跨团队角色共享 - 技术规范

## 概述
支持团队间共享优秀角色配置，促进组织知识共享。

## 现有系统分析

### 已实现功能
- 角色可见性 (public/private) - roleRoutes.ts
- 公共角色池 `/v1/roles/pool`
- 角色评分系统

### 需要新增功能
1. 跨团队角色共享权限管理
2. 跨团队角色搜索
3. 角色使用统计（被复用次数）
4. 共享角色评分可见性

## API 设计

### 1. 分享角色给团队
```
POST /v1/roles/:roleId/share
Body: { targetTeamId: string, permission: "view" | "use" | "edit" }
```

### 2. 获取角色共享的团队列表
```
GET /v1/roles/:roleId/shared-teams
```

### 3. 获取共享给当前团队的角色
```
GET /v1/roles/shared-with-me
```

### 4. 获取跨团队共享的角色（全局搜索）
```
GET /v1/roles/shared?search=keyword&teamId=xxx
```

### 5. 获取角色使用统计
```
GET /v1/roles/:roleId/usage-stats
```

## 数据模型

### KV Keys
- `role_share.{roleId}.{teamId}` - 共享记录
- `role_share_count.{roleId}` - 使用次数计数

## 验收标准
- [x] 角色共享权限管理
- [x] 跨团队角色搜索
- [x] 角色使用统计（被复用次数）
- [x] 共享角色评分可见性
