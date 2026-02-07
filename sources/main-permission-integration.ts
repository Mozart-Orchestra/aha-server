/**
 * PermissionInterceptor 集成到 main.ts 的示例代码
 *
 * 这个文件展示了如何将 PermissionInterceptor 集成到 aha-server 的主应用中
 *
 * @author Builder (cmkj60r4)
 * @date: 2026-01-18
 */

import express from 'express';
import { RolePermissionService } from './services/rolePermissionService';
import { PermissionInterceptor, createPermissionMiddleware } from './middleware/permissionInterceptor';

/**
 * 初始化权限中间件
 *
 * 在 main.ts 中调用此函数来设置权限拦截
 */
export function initializePermissionSystem(app: express.Application): void {
  console.log('[PermissionSystem] Initializing...');

  // 1. 创建角色权限服务
  const rolePermissionService = new RolePermissionService();

  // 2. 创建全局实例（供其他模块使用）
  (global as any).rolePermissionService = rolePermissionService;

  // 3. 配置权限拦截器选项
  const permissionOptions = {
    // 从环境变量读取配置
    enabled: process.env.PERMISSION_INTERCEPTOR_ENABLED !== 'false',
    strictMode: process.env.PERMISSION_STRICT_MODE === 'true',
    auditLog: process.env.PERMISSION_AUDIT_LOG !== 'false',

    // 跳过权限检查的路径（健康检查、认证等）
    bypassPaths: [
      '/health',
      '/ping',
      '/metrics',
      '/api/health',
      '/api/auth/login',
      '/api/auth/register',
      '/api/auth/logout'
    ]
  };

  console.log('[PermissionSystem] Configuration:', permissionOptions);

  // 4. 创建权限中间件
  const permissionMiddleware = createPermissionMiddleware(
    rolePermissionService,
    permissionOptions
  );

  // 5. 应用中间件到所有 API 路由
  // 重要：必须在认证中间件之后，路由处理器之前
  app.use('/api', permissionMiddleware);

  console.log('[PermissionSystem] Permission middleware applied to /api routes');

  // 6. 打印可用角色信息
  const availableRoles = rolePermissionService.getAvailableRoles();
  console.log(`[PermissionSystem] Available roles: ${availableRoles.join(', ')}`);

  console.log('[PermissionSystem] ✓ Initialization complete');
}

/**
 * 在 main.ts 中的使用示例：
 *
 * ```
 * import express from 'express';
 * import { initializePermissionSystem } from './main-permission-integration';
 *
 * const app = express();
 *
 * // 其他中间件设置...
 * app.use(express.json());
 * app.use(express.urlencoded({ extended: true }));
 *
 * // 认证中间件...
 *
 * // ✓ 在这里初始化权限系统
 * initializePermissionSystem(app);
 *
 * // 路由设置...
 * app.use('/api', apiRoutes);
 *
 * // 启动服务器...
 * const PORT = process.env.PORT || 3000;
 * app.listen(PORT, () => {
 *   console.log(`Server running on port ${PORT}`);
 * });
 * ```
 */
