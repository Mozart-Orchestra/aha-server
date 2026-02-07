# PermissionInterceptor 使用指南

**作者**: Builder (cmkj60r4)
**版本**: 1.0.0
**日期**: 2026-01-18

---

## 📋 概述

`PermissionInterceptor` 是 aha-server 的权限验证中间件，用于在运行时检查用户权限，确保只有授权的操作才能执行。

### 主要特性

✅ **基于角色的访问控制** (RBAC)
- 使用 Master 的 `ROLE_DEFINITIONS.yaml` 作为单一真相来源
- 支持多种权限模式：default, acceptEdits, bypassPermissions, plan
- 支持 read-only 和 full-access 访问级别

✅ **智能缓存**
- 5分钟权限缓存，减少文件读取
- 支持手动清除缓存
- 缓存统计和监控

✅ **审计日志**
- 记录所有权限检查
- 记录拒绝访问事件
- 支持调试和故障排除

✅ **灵活配置**
- 环境变量控制
- 路径白名单
- 严格模式开关

---

## 🚀 快速开始

### 1. 安装依赖

```bash
cd /Users/swmt/happy/aha-server
npm install js-yaml
npm install --save-dev @types/js-yaml
```

### 2. 集成到应用

在 `app.ts` 中添加：

```typescript
import { initializePermissionMiddleware } from './middleware/permission-integration';

// 在设置路由后、启动服务器前
initializePermissionMiddleware(app);
```

### 3. 配置环境变量

在 `.env` 文件中添加：

```bash
# 启用权限拦截器（默认：true）
PERMISSION_INTERCEPTOR_ENABLED=true

# 严格模式（默认：false）
PERMISSION_STRICT_MODE=false

# 审计日志（默认：true）
PERMISSION_AUDIT_LOG=true
```

### 4. 启动服务器

```bash
npm start
```

权限拦截器将自动保护所有 `/api/*` 路由。

---

## 📖 使用示例

### 基础使用

```typescript
import express from 'express';
import { RolePermissionService } from './services/rolePermissionService';
import { createPermissionMiddleware } from './middleware/permissionInterceptor';

const app = express();

// 创建服务实例
const rolePermissionService = new RolePermissionService();

// 创建并应用中间件
const permissionMiddleware = createPermissionMiddleware(rolePermissionService, {
  enabled: true,
  strictMode: false,
  auditLog: true,
  bypassPaths: ['/health', '/ping']
});

app.use('/api', permissionMiddleware);
```

### 手动权限检查

```typescript
import { globalRolePermissionService } from './middleware/permission-integration';

// 在路由处理程序中
app.get('/api/tasks', async (req, res) => {
  const userRole = req.user.role;

  // 手动检查权限
  const result = globalRolePermissionService.isOperationAllowed(userRole, {
    type: 'api_call',
    name: 'list_tasks'
  });

  if (result.allowed) {
    res.json({ tasks: [] });
  } else {
    res.status(403).json({ error: result.reason });
  }
});
```

### 角色中间件

```typescript
import { requireRole } from './middleware/permission-integration';

// 只允许 master 和 project-manager 访问
app.post(
  '/api/admin/settings',
  requireRole('master', 'project-manager'),
  (req, res) => {
    res.json({ settings: {} });
  }
);
```

---

## 🔧 API 参考

### RolePermissionService

#### 构造函数

```typescript
constructor()
```

创建角色权限服务实例，自动加载 `ROLE_DEFINITIONS.yaml`。

#### 方法

**getPermissions(role: string)**

获取角色的权限配置（带缓存）。

```typescript
const permissions = await rolePermissionService.getPermissions('builder');
console.log(permissions);
// {
//   permissionMode: 'yolo',
//   accessLevel: 'full-access',
//   disallowedTools: [],
//   allowedOperations: ['update_task', 'list_tasks', 'get_task', 'create_task']
// }
```

**isOperationAllowed(role: string, operation: Operation)**

检查操作是否被允许。

```typescript
const result = rolePermissionService.isOperationAllowed('scout', {
  type: 'api_call',
  name: 'delete_task'
});

console.log(result);
// {
//   allowed: false,
//   reason: 'Role scout has read-only access and cannot perform delete_task',
//   requiresConfirmation: false
// }
```

**isToolAllowed(role: string, tool: string)**

检查工具是否被允许。

```typescript
const allowed = rolePermissionService.isToolAllowed('scout', 'Bash');
console.log(allowed); // false (scout cannot use Bash)
```

**clearCache(role?: string)**

清除权限缓存。

```typescript
// 清除特定角色的缓存
rolePermissionService.clearCache('builder');

// 清除所有缓存
rolePermissionService.clearCache();
```

**reloadRoleDefinitions()**

重新加载角色定义（在 YAML 文件更新后）。

```typescript
rolePermissionService.reloadRoleDefinitions();
```

**getCacheStats()**

获取缓存统计信息。

```typescript
const stats = rolePermissionService.getCacheStats();
console.log(stats);
// {
//   size: 7,
//   cachedRoles: ['master', 'builder', 'framer', 'scout', 'scribe', 'qa', 'reviewer']
// }
```

**getAvailableRoles()**

获取所有可用角色列表。

```typescript
const roles = rolePermissionService.getAvailableRoles();
console.log(roles);
// ['master', 'builder', 'framer', 'scout', 'scribe', 'qa', 'reviewer', ...]
```

### PermissionInterceptor

#### 构造函数

```typescript
constructor(
  rolePermissionService: RolePermissionService,
  options?: PermissionInterceptorOptions
)
```

**选项**：

```typescript
interface PermissionInterceptorOptions {
  enabled: boolean;           // 是否启用（默认：true）
  strictMode: boolean;         // 严格模式（默认：false）
  auditLog: boolean;           // 审计日志（默认：true）
  bypassPaths: string[];       // 跳过检查的路径
}
```

#### 方法

**intercept(req, res, next)**

Express 中间件函数。

```typescript
const interceptor = new PermissionInterceptor(rolePermissionService, {
  enabled: true,
  strictMode: false,
  auditLog: true
});

app.use('/api', interceptor.intercept.bind(interceptor));
```

---

## 🔐 权限模式

### 1. default（默认模式）

- 大多数操作需要用户确认
- 工具级别的权限检查生效
- read-only 角色不能写入

### 2. acceptEdits（接受编辑）

- 允许所有编辑操作（Edit、Write 等）
- 其他操作仍需确认

### 3. bypassPermissions（绕过权限）

- 允许所有操作，无需确认
- 相当于 "sudo" 模式

### 4. plan（规划模式）

- 只允许读取操作
- 用于规划和设计阶段

---

## 📊 操作映射

PermissionInterceptor 自动将 HTTP 请求映射到操作名称：

| HTTP 方法 | 路径 | 操作名称 |
|-----------|------|----------|
| GET | /api/tasks | list_tasks |
| GET | /api/tasks/123 | get_task |
| POST | /api/tasks | create_task |
| PUT/PATCH | /api/tasks/123 | update_task |
| DELETE | /api/tasks/123 | delete_task |

---

## 🧪 测试

### 单元测试

```typescript
import { RolePermissionService } from '../services/rolePermissionService';

describe('RolePermissionService', () => {
  let service: RolePermissionService;

  beforeEach(() => {
    service = new RolePermissionService();
  });

  test('should allow builder to create task', async () => {
    const permissions = await service.getPermissions('builder');
    const result = service.isOperationAllowed('builder', {
      type: 'api_call',
      name: 'create_task'
    });

    expect(result.allowed).toBe(true);
  });

  test('should deny scout from deleting task', () => {
    const result = service.isOperationAllowed('scout', {
      type: 'api_call',
      name: 'delete_task'
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('read-only');
  });
});
```

### 集成测试

```typescript
import request from 'supertest';
import { app } from '../app';

describe('Permission Integration Tests', () => {
  test('should deny scout from POST /api/tasks', async () => {
    const response = await request(app)
      .post('/api/tasks')
      .set('Authorization', 'Bearer scout-token')
      .set('X-Role', 'scout')
      .send({ title: 'Test Task' });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Forbidden');
  });

  test('should allow builder to GET /api/tasks', async () => {
    const response = await request(app)
      .get('/api/tasks')
      .set('Authorization', 'Bearer builder-token')
      .set('X-Role', 'builder');

    expect(response.status).toBe(200);
  });
});
```

---

## 🐛 故障排除

### 问题1: 权限总是被拒绝

**原因**:
- 用户信息未正确传递
- JWT token 解码失败
- 角色未在 ROLE_DEFINITIONS.yaml 中定义

**解决方案**:
```typescript
// 启用调试日志
process.env.DEBUG = 'permission:*';

// 检查用户信息
console.log('User info:', req.user);

// 检查角色定义
const stats = rolePermissionService.getCacheStats();
console.log('Available roles:', stats.cachedRoles);
```

### 问题2: 性能下降

**原因**:
- 权限缓存未生效
- 每次请求都读取 YAML 文件

**解决方案**:
```typescript
// 检查缓存统计
const stats = rolePermissionService.getCacheStats();
console.log('Cache size:', stats.size);

// 预热缓存
await rolePermissionService.getPermissions('master');
await rolePermissionService.getPermissions('builder');
// ... 其他角色
```

### 问题3: 角色定义更新后未生效

**原因**:
- 缓存未清除
- YAML 文件未重新加载

**解决方案**:
```typescript
// 清除缓存
rolePermissionService.clearCache();

// 重新加载角色定义
rolePermissionService.reloadRoleDefinitions();
```

---

## 📚 相关文档

- [技术设计文档](./PERMISSION_INTERCEPTOR_DESIGN.md)
- [ROLE_DEFINITIONS.yaml](../../shared/role-definitions/ROLE_DEFINITIONS.yaml)
- [角色定义生成脚本](../../shared/role-definitions/README.md)

---

## 🤝 贡献

如果您发现问题或有改进建议，请：

1. 创建 issue
2. Fork 项目
3. 创建 pull request

---

## 📄 许可证

MIT License - see LICENSE file for details

---

**文档版本**: 1.0
**最后更新**: 2026-01-18
