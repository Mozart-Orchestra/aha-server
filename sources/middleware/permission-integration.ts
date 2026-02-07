/**
 * Permission Interceptor Integration Example
 *
 * This file demonstrates how to integrate the PermissionInterceptor
 * into aha-server's Express application.
 *
 * @author Builder (cmkj60r4)
 * @since 2026-01-18
 */

import express from 'express';
import { RolePermissionService } from '../services/rolePermissionService';
import { PermissionInterceptor, createPermissionMiddleware } from './permissionInterceptor';

/**
 * Example: Initialize and apply permission middleware
 */
export function initializePermissionMiddleware(app: express.Application): void {
  // 1. Create role permission service instance
  const rolePermissionService = new RolePermissionService();

  // 2. Configure permission interceptor options
  const permissionOptions = {
    enabled: process.env.PERMISSION_INTERCEPTOR_ENABLED !== 'false',
    strictMode: process.env.PERMISSION_STRICT_MODE === 'true',
    auditLog: process.env.PERMISSION_AUDIT_LOG !== 'false',
    bypassPaths: [
      '/health',
      '/ping',
      '/metrics',
      '/api/health', // Health check endpoints
      '/api/auth/login', // Login endpoint (before auth)
      '/api/auth/register' // Register endpoint (before auth)
    ]
  };

  // 3. Create permission middleware
  const permissionMiddleware = createPermissionMiddleware(
    rolePermissionService,
    permissionOptions
  );

  // 4. Apply middleware to all API routes
  // IMPORTANT: Must be applied AFTER authentication middleware
  // but BEFORE route handlers
  app.use('/api', permissionMiddleware);

  // Log initialization
  console.log('[PermissionInterceptor] Middleware initialized and applied to /api routes');
  console.log('[PermissionInterceptor] Options:', permissionOptions);
}

/**
 * Example: Making the service available globally
 *
 * This allows other parts of the application to check permissions
 */
export let globalRolePermissionService: RolePermissionService;

export function initializeGlobalPermissionService(): void {
  globalRolePermissionService = new RolePermissionService();

  // Make it available globally (optional)
  (global as any).rolePermissionService = globalRolePermissionService;

  console.log('[PermissionInterceptor] Global role permission service initialized');
}

/**
 * Example: Manual permission check in route handlers
 *
 * Some routes may need to check permissions manually
 */
export async function checkPermissionInHandler(
  role: string,
  operation: { name: string; type: string }
): Promise<boolean> {
  if (!globalRolePermissionService) {
    console.warn('[PermissionInterceptor] Global role permission service not initialized');
    return true; // Allow if service not available
  }

  const result = globalRolePermissionService.isOperationAllowed(role, operation as any);
  return result.allowed;
}

/**
 * Example: Route handler with manual permission check
 */
export function createProtectedRouteHandler(
  requiredRole: string,
  handler: express.RequestHandler
): express.RequestHandler {
  return async (req, res, next) => {
    // Get user role from request (set by authentication middleware)
    const userRole = (req as any).user?.role;

    if (!userRole) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'User not authenticated'
      });
    }

    // Check if user has required role
    if (userRole !== requiredRole) {
      const hasPermission = await checkPermissionInHandler(userRole, {
        name: 'access_route',
        type: 'api_call'
      });

      if (!hasPermission) {
        return res.status(403).json({
          error: 'Forbidden',
          message: `You do not have permission to access this route`,
          requiredRole
        });
      }
    }

    // User has permission, proceed to handler
    return handler(req, res, next);
  };
}

/**
 * Example: Middleware factory for role-based access control
 */
export function requireRole(...allowedRoles: string[]) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const userRole = (req as any).user?.role;

    if (!userRole) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'User not authenticated'
      });
    }

    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({
        error: 'Forbidden',
        message: `Role '${userRole}' is not allowed to access this resource`,
        allowedRoles
      });
    }

    next();
  };
}

/**
 * Example: Usage in app.ts
 */
/*
import express from 'express';
import {
  initializePermissionMiddleware,
  initializeGlobalPermissionService
} from './middleware/permission-integration';

const app = express();

// 1. Initialize global service (for manual checks)
initializeGlobalPermissionService();

// 2. Apply middleware to all API routes
initializePermissionMiddleware(app);

// 3. Routes are now protected
app.get('/api/tasks', (req, res) => {
  // Permission check already done by middleware
  res.json({ tasks: [] });
});

// 4. Use role-based middleware for specific routes
import { requireRole } from './middleware/permission-integration';

app.post(
  '/api/admin/settings',
  requireRole('master', 'project-manager'),
  (req, res) => {
    // Only master and project-manager can access
    res.json({ settings: {} });
  }
);
*/
