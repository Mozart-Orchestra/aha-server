# PermissionInterceptor 技术设计文档

**作者**: Builder (cmkj60r4)
**日期**: 2026-01-18
**状态**: 设计阶段

---

## 📋 概述

### 目标

实现运行时权限验证拦截器，确保 aha-server 中的所有请求都经过严格的权限检查，而不是仅依赖客户端的 honor system。

### 当前问题

**现有系统（aha-cli）**:
- ✅ 完善的 `PermissionHandler` 类
- ✅ 4种权限模式：default, acceptEdits, bypassPermissions, plan
- ✅ 工具级别的权限控制（disallowedTools）
- ✅ 基于 `accessLevel` 的角色权限（read-only vs full-access）

**aha-server 现状**:
- ❌ **没有运行时权限验证**
- ❌ 依赖客户端遵守规则
- ❌ 服务器端不检查角色权限
- ❌ 任何人都可以调用任何 API

### 解决方案

在 aha-server 中实现 `PermissionInterceptor` 中间件，对所有 API 请求进行权限验证。

---

## 🏗️ 架构设计

### 系统组件图

```
┌─────────────────────────────────────────────────────────┐
│                  aha-server 架构                       │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  Client Request                                          │
│       │                                                  │
│       ▼                                                  │
│  ┌─────────────────┐                                    │
│  │ Express Router  │                                    │
│  └────────┬────────┘                                    │
│           │                                              │
│           ▼                                              │
│  ┌─────────────────────────────┐                       │
│  │  PermissionInterceptor ◀────┼──┐                    │
│  │  (NEW MIDDLEWARE)           │  │                    │
│  └────────┬─────────────────────┘  │                    │
│           │                        │                    │
│           ▼                        │                    │
│  ┌─────────────────┐              │                    │
│  │ Route Handlers  │              │                    │
│  └─────────────────┘              │                    │
│                                    │                    │
│  Extract User Info                 │                    │
│  └─────────────────────────────────┘                    │
│       │                                                  │
│       ▼                                                  │
│  ┌─────────────────────────────┐                       │
│  │  RolePermissionService      │                       │
│  │  - Load role definitions    │                       │
│  │  - Check permissions        │                       │
│  │  - Cache permissions        │                       │
│  └─────────────────────────────┘                       │
│                                                           │
└─────────────────────────────────────────────────────────┘
```

### 数据流

```
1. Client sends request with auth token
   ↓
2. PermissionInterceptor extracts user info (teamId, role)
   ↓
3. Load role permissions (with cache)
   ↓
4. Check if operation is allowed for role
   ├─ Allowed → Continue to route handler
   └─ Denied → Return 403 Forbidden
```

---

## 📊 接口设计

### 1. PermissionInterceptor 类

```typescript
/**
 * Permission Interceptor Middleware
 * Intercepts all requests to aha-server and validates permissions
 */
export class PermissionInterceptor {
  constructor(
    private rolePermissionService: RolePermissionService,
    private logger: Logger,
    private options?: PermissionInterceptorOptions
  ) {}

  /**
   * Express middleware function
   */
  intercept(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void>;

  /**
   * Check if operation is allowed for role
   */
  private checkPermission(
    role: string,
    operation: Operation
  ): Promise<boolean>;

  /**
   * Extract user info from request
   */
  private extractUserInfo(req: Request): UserInfo;
}
```

### 2. RolePermissionService 类

```typescript
/**
 * Service to manage role permissions
 */
export class RolePermissionService {
  private permissionCache = new Map<string, RolePermissions>();
  private roleDefinitions: Map<string, RoleDefinition>;

  constructor() {
    this.loadRoleDefinitions();
  }

  /**
   * Get permissions for a role (with cache)
   */
  async getPermissions(role: string): Promise<RolePermissions>;

  /**
   * Load role definitions from YAML or index.cjs
   */
  private async loadRoleDefinitions(): Promise<void>;

  /**
   * Check if tool is allowed for role
   */
  isToolAllowed(role: string, tool: string): boolean;

  /**
   * Check if operation is allowed for role
   */
  isOperationAllowed(
    role: string,
    operation: Operation
  ): boolean;

  /**
   * Clear permission cache
   */
  clearCache(role?: string): void;
}
```

### 3. 接口定义

```typescript
/**
 * User information extracted from request
 */
interface UserInfo {
  userId: string;
  teamId: string;
  role: string;
  sessionId: string;
}

/**
 * Operation that requires permission check
 */
interface Operation {
  type: 'api_call' | 'tool_use' | 'file_access';
  name: string; // e.g., 'create_task', 'update_task', 'Bash'
  input?: any;
}

/**
 * Role permissions
 */
interface RolePermissions {
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  accessLevel: 'read-only' | 'full-access';
  disallowedTools: string[];
  allowedOperations: string[];
}

/**
 * Permission check result
 */
interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
  requiresConfirmation: boolean;
}
```

---

## 🔧 实现细节

### Phase 1: 基础拦截器（Day 1-2）

**文件**: `aha-server/sources/middleware/permissionInterceptor.ts`

```typescript
import { Request, Response, NextFunction } from 'express';
import { RolePermissionService } from '../services/rolePermissionService';
import { logger } from '@/utils/log';

export interface PermissionInterceptorOptions {
  enabled: boolean;
  strictMode: boolean; // If true, deny all unknown operations
  auditLog: boolean; // Log all permission checks
}

export class PermissionInterceptor {
  constructor(
    private rolePermissionService: RolePermissionService,
    private options: PermissionInterceptorOptions = {
      enabled: true,
      strictMode: false,
      auditLog: true
    }
  ) {}

  /**
   * Express middleware
   */
  async intercept(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    // Skip if disabled
    if (!this.options.enabled) {
      return next();
    }

    try {
      // Extract user info from request
      const userInfo = this.extractUserInfo(req);

      // Extract operation from request
      const operation = this.extractOperation(req);

      // Check permission
      const result = await this.checkPermission(
        userInfo.role,
        operation
      );

      if (result.allowed) {
        // Allowed - continue to route handler
        return next();
      } else {
        // Denied - return 403
        res.status(403).json({
          error: 'Forbidden',
          message: result.reason || 'You do not have permission to perform this operation',
          role: userInfo.role,
          operation: operation.name
        });

        // Audit log
        if (this.options.auditLog) {
          logger.warn('[PermissionInterceptor] Access denied', {
            userId: userInfo.userId,
            role: userInfo.role,
            operation: operation.name,
            reason: result.reason
          });
        }

        return;
      }
    } catch (error) {
      logger.error('[PermissionInterceptor] Error checking permission', error);
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Error checking permissions'
      });
      return;
    }
  }

  /**
   * Extract user info from request
   */
  private extractUserInfo(req: Request): UserInfo {
    // TODO: Extract from auth token or session
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      throw new Error('No authorization header');
    }

    // Parse token and extract user info
    const token = authHeader.replace('Bearer ', '');
    const decoded = this.decodeToken(token);

    return {
      userId: decoded.userId,
      teamId: decoded.teamId,
      role: decoded.role,
      sessionId: decoded.sessionId
    };
  }

  /**
   * Extract operation from request
   */
  private extractOperation(req: Request): Operation {
    const path = req.path;
    const method = req.method;

    // Map route to operation
    // Example: POST /api/tasks -> create_task
    const operationName = this.mapRouteToOperation(path, method);

    return {
      type: 'api_call',
      name: operationName,
      input: req.body
    };
  }

  /**
   * Check if operation is allowed for role
   */
  private async checkPermission(
    role: string,
    operation: Operation
  ): Promise<PermissionCheckResult> {
    // Get role permissions
    const permissions = await this.rolePermissionService.getPermissions(role);

    // Check if operation is in allowed list
    if (permissions.allowedOperations.includes(operation.name)) {
      return { allowed: true };
    }

    // Check if tool is disallowed
    if (permissions.disallowedTools.includes(operation.name)) {
      return {
        allowed: false,
        reason: `Role ${role} is not allowed to use ${operation.name}`
      };
    }

    // Check access level
    if (permissions.accessLevel === 'read-only') {
      const readOnlyOperations = [
        'list_tasks',
        'get_task',
        'list_team_messages',
        'get_file'
      ];

      if (!readOnlyOperations.includes(operation.name)) {
        return {
          allowed: false,
          reason: `Role ${role} has read-only access`
        };
      }
    }

    // Default: allow if not explicitly denied
    if (!this.options.strictMode) {
      return { allowed: true };
    }

    // Strict mode: deny unknown operations
    return {
      allowed: false,
      reason: `Operation ${operation.name} not explicitly allowed for role ${role}`
    };
  }

  /**
   * Map route to operation name
   */
  private mapRouteToOperation(path: string, method: string): string {
    // Remove /api prefix
    const route = path.replace(/^\/api\//, '');

    // Convert to operation name
    // Example: tasks -> list_tasks (GET), create_task (POST)
    const parts = route.split('/');
    const resource = parts[0];

    if (method === 'GET') {
      if (parts.length === 1) {
        return `list_${resource}`;
      } else {
        return `get_${resource}`;
      }
    } else if (method === 'POST') {
      return `create_${resource}`;
    } else if (method === 'PUT' || method === 'PATCH') {
      return `update_${resource}`;
    } else if (method === 'DELETE') {
      return `delete_${resource}`;
    }

    return `${method.toLowerCase()}_${resource}`;
  }

  /**
   * Decode JWT token
   */
  private decodeToken(token: string): any {
    // TODO: Implement JWT decoding
    // For now, return mock data
    return {
      userId: 'mock-user-id',
      teamId: 'mock-team-id',
      role: 'builder',
      sessionId: 'mock-session-id'
    };
  }
}
```

### Phase 2: RolePermissionService（Day 3-4）

**文件**: `aha-server/sources/services/rolePermissionService.ts`

```typescript
import { logger } from '@/utils/log';
import { DEFAULT_ROLES } from '@aha/shared-team-config';

export class RolePermissionService {
  private permissionCache = new Map<string, RolePermissions>();
  private cacheTimeout = 5 * 60 * 1000; // 5 minutes

  /**
   * Get permissions for a role (with cache)
   */
  async getPermissions(role: string): Promise<RolePermissions> {
    // Check cache
    if (this.permissionCache.has(role)) {
      return this.permissionCache.get(role)!;
    }

    // Load from role definitions
    const permissions = await this.loadPermissions(role);

    // Cache with timeout
    this.permissionCache.set(role, permissions);

    // Clear cache after timeout
    setTimeout(() => {
      this.permissionCache.delete(role);
    }, this.cacheTimeout);

    return permissions;
  }

  /**
   * Load permissions from role definitions
   */
  private async loadPermissions(role: string): Promise<RolePermissions> {
    const roleDef = DEFAULT_ROLES[role];

    if (!roleDef) {
      logger.warn(`[RolePermissionService] Unknown role: ${role}`);
      // Return default permissions
      return {
        permissionMode: 'default',
        accessLevel: 'full-access',
        disallowedTools: [],
        allowedOperations: []
      };
    }

    // Map role definition to permissions
    const permissions: RolePermissions = {
      permissionMode: roleDef.policy?.permissionMode || 'default',
      accessLevel: roleDef.accessLevel || 'full-access',
      disallowedTools: roleDef.policy?.disallowedTools || [],
      allowedOperations: this.extractAllowedOperations(roleDef)
    };

    return permissions;
  }

  /**
   * Extract allowed operations from role definition
   */
  private extractAllowedOperations(roleDef: RoleDefinition): string[] {
    // Based on role responsibilities and protocols
    const operations: string[] = [];

    // Master can do everything
    if (roleDef.id === 'master') {
      operations.push('*'); // Wildcard means all operations
    }

    // Builder can update tasks
    if (roleDef.id === 'builder') {
      operations.push(
        'update_task',
        'list_tasks',
        'get_task'
      );
    }

    // Framer can update tasks (frontend only)
    if (roleDef.id === 'framer') {
      operations.push(
        'update_task',
        'list_tasks',
        'get_task'
      );
    }

    // Scout can only read
    if (roleDef.id === 'scout') {
      operations.push(
        'list_tasks',
        'get_task',
        'get_file',
        'search_code'
      );
    }

    // TODO: Add more roles

    return operations;
  }

  /**
   * Check if tool is allowed for role
   */
  isToolAllowed(role: string, tool: string): boolean {
    const permissions = this.permissionCache.get(role);
    if (!permissions) {
      return true; // Assume allowed if not loaded
    }

    return !permissions.disallowedTools.includes(tool);
  }

  /**
   * Clear cache
   */
  clearCache(role?: string): void {
    if (role) {
      this.permissionCache.delete(role);
    } else {
      this.permissionCache.clear();
    }
  }
}
```

### Phase 3: 集成到 aha-server（Day 5）

**文件**: `aha-server/sources/app.ts`

```typescript
import { PermissionInterceptor } from './middleware/permissionInterceptor';
import { RolePermissionService } from './services/rolePermissionService';

// Create services
const rolePermissionService = new RolePermissionService();
const permissionInterceptor = new PermissionInterceptor(
  rolePermissionService,
  logger,
  {
    enabled: process.env.PERMISSION_INTERCEPTOR_ENABLED !== 'false',
    strictMode: false,
    auditLog: true
  }
);

// Apply middleware to all API routes
app.use('/api', permissionInterceptor.intercept.bind(permissionInterceptor));
```

---

## 🧪 测试策略

### 单元测试

**文件**: `aha-server/test/middleware/permissionInterceptor.test.ts`

```typescript
import { PermissionInterceptor } from '../../sources/middleware/permissionInterceptor';
import { RolePermissionService } from '../../sources/services/rolePermissionService';

describe('PermissionInterceptor', () => {
  let interceptor: PermissionInterceptor;
  let roleService: RolePermissionService;

  beforeEach(() => {
    roleService = new RolePermissionService();
    interceptor = new PermissionInterceptor(roleService, logger, {
      enabled: true,
      strictMode: false,
      auditLog: false
    });
  });

  test('should allow access for permitted operation', async () => {
    const req = mockRequest({
      headers: { authorization: 'Bearer valid-token' },
      path: '/api/tasks',
      method: 'GET'
    });
    const res = mockResponse();
    const next = jest.fn();

    await interceptor.intercept(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test('should deny access for disallowed operation', async () => {
    const req = mockRequest({
      headers: { authorization: 'Bearer valid-token' },
      path: '/api/tasks',
      method: 'DELETE'
    });
    const res = mockResponse();
    const next = jest.fn();

    await interceptor.intercept(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('should allow read-only operations for scout role', async () => {
    // TODO: Implement test
  });

  test('should deny write operations for scout role', async () => {
    // TODO: Implement test
  });
});
```

### 集成测试

**文件**: `aha-server/test/integration/permission.test.ts`

```typescript
import request from 'supertest';
import { app } from '../../sources/app';

describe('Permission Integration Tests', () => {
  test('POST /api/tasks should require permission', async () => {
    const response = await request(app)
      .post('/api/tasks')
      .set('Authorization', 'Bearer scout-token')
      .send({ title: 'Test Task' });

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('Forbidden');
  });

  test('GET /api/tasks should allow read-only access', async () => {
    const response = await request(app)
      .get('/api/tasks')
      .set('Authorization', 'Bearer scout-token');

    expect(response.status).toBe(200);
  });
});
```

---

## 📝 审计日志

所有权限检查都应记录到审计日志：

```typescript
logger.info('[PermissionInterceptor] Permission check', {
  userId,
  role,
  operation,
  allowed,
  timestamp: new Date().toISOString()
});
```

审计日志应包含：
- User ID
- Role
- Operation
- Allowed/Denied
- Timestamp
- Reason (if denied)

---

## 🚀 部署计划

### Phase 1: 开发（Day 1-5）
- ✅ 实现 PermissionInterceptor
- ✅ 实现 RolePermissionService
- ✅ 编写单元测试

### Phase 2: 集成（Day 6）
- ✅ 集成到 aha-server
- ✅ 配置环境变量
- ✅ 编写集成测试

### Phase 3: 测试（Day 7）
- ✅ 端到端测试
- ✅ 性能测试
- ✅ 安全测试

### Phase 4: 部署（Day 10+）
- ✅ 灰度发布（先测试环境）
- ✅ 监控和日志
- ✅ 逐步推广到生产

---

## ⚠️ 风险和缓解

### 风险1: 性能影响
**缓解**: 使用缓存、异步检查、批量加载

### 风险2: 向后兼容性
**缓解**: 默认禁用、逐步启用、提供开关

### 风险3: 误拒绝
**缓解**: 详细日志、监控警报、快速回滚机制

---

## 📊 成功指标

- ✅ 所有 API 请求都经过权限检查
- ✅ 测试覆盖率 >80%
- ✅ 性能影响 <10ms per request
- ✅ 零误拒绝率 <0.1%

---

## 📚 参考资料

- 现有代码：
  - `aha-cli/src/claude/utils/permissionHandler.ts`
  - `aha-cli/src/claude/team/roles.ts`
  - `aha-server/sources/app/auth/auth.ts`
- 角色定义：
  - `kanban/sources/team-config/index.cjs`
  - `kanban/sources/team-config/skills/`

---

**文档版本**: 1.0
**最后更新**: 2026-01-18
