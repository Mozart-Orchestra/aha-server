/**
 * Fastify Permission Interceptor Plugin
 *
 * Fastify plugin version of PermissionInterceptor for runtime permission validation.
 * Integrates with Aha's role-based access control system.
 *
 * @author Builder (cmkj60r4)
 * @since 2026-01-18
 */

import { Fastify } from "../types";
import { log, logger } from "@/utils/log";
import { RolePermissionService } from "@/services/rolePermissionService";
import { mapPermissionRouteToOperation, resolvePermissionUserInfo } from "@/utils/permissionRequest";

/**
 * Permission interceptor options
 */
export interface PermissionInterceptorOptions {
  enabled?: boolean; // Enable/disable interceptor (default: true)
  strictMode?: boolean; // Deny unknown operations (default: false)
  auditLog?: boolean; // Log all checks (default: true)
  bypassPaths?: string[]; // Paths to skip (default: health endpoints)
}

/**
 * Fastify plugin for permission interception
 */
export async function enablePermissionInterceptor(
  app: Fastify,
  options: PermissionInterceptorOptions = {}
) {
  const {
    enabled = process.env.PERMISSION_INTERCEPTOR_ENABLED !== 'false',
    strictMode = process.env.PERMISSION_STRICT_MODE === 'true',
    auditLog = process.env.PERMISSION_AUDIT_LOG !== 'false',
    bypassPaths = ['/health', '/ping', '/metrics', '/api/health']
  } = options;

  log({
    module: 'PermissionInterceptor',
    enabled,
    strictMode,
    auditLog,
    bypassPaths
  }, 'Initializing PermissionInterceptor');

  // Create role permission service instance
  const rolePermissionService = new RolePermissionService();

  // Make service available globally
  (global as any).rolePermissionService = rolePermissionService;

  // Decorate request with permission checker
  app.decorate('checkPermission', async function (operationName: string) {
    const request = this as any;
    const role = request.userRole || 'builder';

    const result = rolePermissionService.isOperationAllowed(role, {
      type: 'api_call',
      name: operationName
    });

    if (auditLog) {
      log({
        module: 'PermissionInterceptor',
        userId: request.userId,
        role,
        operation: operationName,
        allowed: result.allowed
      }, `Permission check: ${result.allowed ? 'GRANTED' : 'DENIED'}`);
    }

    return result;
  });

  // Add onRequest hook for automatic permission checking
  app.addHook('onRequest', async (request, reply) => {
    // Skip if disabled
    if (!enabled) {
      return;
    }

    // Skip bypass paths
    if (shouldBypass(request.url, bypassPaths)) {
      return;
    }

    try {
      const resolvedUser = await resolvePermissionUserInfo(request.headers as Record<string, unknown>);
      const userRole = (request as any).userRole || resolvedUser.role;

      // Store resolved identity on request for later use/audit
      (request as any).userId = (request as any).userId || resolvedUser.userId;
      (request as any).userRole = userRole;
      (request as any).teamId = (request as any).teamId || resolvedUser.teamId;
      (request as any).sessionId = (request as any).sessionId || resolvedUser.sessionId;

      // Map route to operation name
      const operationName = mapPermissionRouteToOperation(request.url, request.method);

      // Check permission
      const result = rolePermissionService.isOperationAllowed(userRole, {
        type: 'api_call',
        name: operationName
      });

      // Audit log
      if (auditLog) {
        log({
          module: 'PermissionInterceptor',
          userId: (request as any).userId,
          role: userRole,
          operation: operationName,
          method: request.method,
          url: request.url,
          allowed: result.allowed,
          requiresConfirmation: result.requiresConfirmation
        }, `Permission ${result.allowed ? 'GRANTED' : 'DENIED'}: ${operationName}`);
      }

      if (!result.allowed) {
        // Access denied
        log({
          module: 'PermissionInterceptor',
          userId: (request as any).userId,
          role: userRole,
          operation: operationName,
          reason: result.reason
        }, `Access DENIED: ${operationName}`);

        return reply.code(403).send({
          error: 'Forbidden',
          message: result.reason || 'You do not have permission to perform this operation',
          role: userRole,
          operation: operationName,
          requiresConfirmation: result.requiresConfirmation
        });
      }

      // Access granted - continue to route handler
      if (auditLog) {
        log({
          module: 'PermissionInterceptor',
          userId: (request as any).userId,
          role: userRole,
          operation: operationName
        }, `Access GRANTED: ${operationName}`);
      }
    } catch (error) {
      log({
        module: 'PermissionInterceptor',
        level: 'error',
        error: error instanceof Error ? error.message : String(error)
      }, 'Error checking permissions');

      // Fail safe - deny access on error
      return reply.code(500).send({
        error: 'Internal Server Error',
        message: 'Error checking permissions'
      });
    }
  });

  // Log available roles
  const availableRoles = rolePermissionService.getAvailableRoles();
  log({
    module: 'PermissionInterceptor',
    count: availableRoles.length,
    roles: availableRoles
  }, `Available roles: ${availableRoles.join(', ')}`);

  log({ module: 'PermissionInterceptor' }, '✓ PermissionInterceptor initialized successfully');
}

/**
 * Check if path should be bypassed
 */
function shouldBypass(url: string, bypassPaths: string[]): boolean {
  return bypassPaths.some(bypassPath => {
    if (bypassPath.endsWith('*')) {
      const prefix = bypassPath.slice(0, -1);
      return url.startsWith(prefix);
    }
    return url === bypassPath || url.startsWith(bypassPath + '?');
  });
}

/**
 * Map route to operation name
 *
 * Examples:
 * - GET /api/tasks -> list_tasks
 * - POST /api/tasks -> create_task
 * - PUT /api/tasks/123 -> update_task
 * - DELETE /api/tasks/123 -> delete_task
 */
/**
 * Export role permission service getter for manual permission checks
 */
export function getRolePermissionService(): RolePermissionService {
  const service = (global as any).rolePermissionService as RolePermissionService;
  if (!service) {
    throw new Error('RolePermissionService not initialized. Call enablePermissionInterceptor first.');
  }
  return service;
}
