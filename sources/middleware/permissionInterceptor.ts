/**
 * Permission Interceptor Middleware
 *
 * Intercepts all requests to aha-server and validates permissions
 * based on user roles. Ensures that only authorized operations are performed.
 *
 * @author Builder (cmkj60r4)
 * @since 2026-01-18
 */

import { RolePermissionService, UserInfo, Operation } from '../services/rolePermissionService';
import { logger } from '@/utils/log';
import { decodePermissionToken, mapPermissionRouteToOperation, resolvePermissionUserInfo } from '@/utils/permissionRequest';

/**
 * Permission interceptor options
 */
export interface PermissionInterceptorOptions {
  enabled: boolean;
  strictMode: boolean; // If true, deny all unknown operations
  auditLog: boolean; // Log all permission checks
  bypassPaths: string[]; // Paths to bypass permission check
}

type PermissionNextFunction = () => void;

interface PermissionResponseLike {
  status(code: number): PermissionResponseLike;
  json(payload: unknown): PermissionResponseLike;
}

/**
 * Express-like request with user info
 */
interface AuthenticatedRequest {
  path: string;
  method: string;
  headers: Record<string, unknown>;
  body?: unknown;
  user?: UserInfo;
}

/**
 * Permission Interceptor Class
 */
export class PermissionInterceptor {
  constructor(
    private rolePermissionService: RolePermissionService,
    private options: PermissionInterceptorOptions = {
      enabled: true,
      strictMode: false,
      auditLog: true,
      bypassPaths: ['/health', '/ping', '/metrics']
    }
  ) {
    logger.info({ options: this.options }, '[PermissionInterceptor] Initialized with options');
  }

  /**
   * Express middleware function
   */
  async intercept(
    req: AuthenticatedRequest,
    res: PermissionResponseLike,
    next: PermissionNextFunction
  ): Promise<void> {
    // Skip if disabled
    if (!this.options.enabled) {
      return next();
    }

    // Skip bypass paths
    if (this.shouldBypass(req.path)) {
      return next();
    }

    try {
      // Extract user info from request
      const userInfo = await this.extractUserInfo(req);

      // Attach user info to request
      req.user = userInfo;

      // Extract operation from request
      const operation = this.extractOperation(req);

      // Check permission
      const result = this.rolePermissionService.isOperationAllowed(
        userInfo.role,
        operation
      );

      // Audit log
      if (this.options.auditLog) {
        this.logPermissionCheck(userInfo, operation, result);
      }

      if (result.allowed) {
        // Allowed - continue to route handler
        logger.debug({
          userId: userInfo.userId,
          role: userInfo.role,
          operation: operation.name
        }, '[PermissionInterceptor] Access granted');
        return next();
      } else {
        // Denied - return 403
        logger.warn({
          userId: userInfo.userId,
          role: userInfo.role,
          operation: operation.name,
          reason: result.reason
        }, '[PermissionInterceptor] Access denied');

        res.status(403).json({
          error: 'Forbidden',
          message: result.reason || 'You do not have permission to perform this operation',
          role: userInfo.role,
          operation: operation.name,
          requiresConfirmation: result.requiresConfirmation
        });
        return;
      }
    } catch (error) {
      logger.error({ error }, '[PermissionInterceptor] Error checking permission');

      // If we can't verify permissions, deny access for safety
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Error checking permissions'
      });
      return;
    }
  }

  /**
   * Check if path should be bypassed
   */
  private shouldBypass(path: string): boolean {
    return this.options.bypassPaths.some(bypassPath => {
      if (bypassPath.endsWith('*')) {
        const prefix = bypassPath.slice(0, -1);
        return path.startsWith(prefix);
      }
      return path === bypassPath;
    });
  }

  /**
   * Extract user info from request
   */
  private async extractUserInfo(req: AuthenticatedRequest): Promise<UserInfo> {
    return resolvePermissionUserInfo(req.headers as Record<string, unknown>);
  }

  /**
   * Extract operation from request
   */
  private extractOperation(req: AuthenticatedRequest): Operation {
    const path = req.path;
    const method = req.method;

    // Map route to operation name
    const operationName = this.mapRouteToOperation(path, method);

    return {
      type: 'api_call',
      name: operationName,
      input: req.body
    };
  }

  /**
   * Map route to operation name
   */
  private mapRouteToOperation(path: string, method: string): string {
    return mapPermissionRouteToOperation(path, method);
  }

  /**
   * Decode JWT token
   */
  private decodeToken(token: string): any {
    return decodePermissionToken(token);
  }

  /**
   * Log permission check
   */
  private logPermissionCheck(
    userInfo: UserInfo,
    operation: Operation,
    result: any
  ): void {
    const logData = {
      userId: userInfo.userId,
      teamId: userInfo.teamId,
      role: userInfo.role,
      operation: operation.name,
      operationType: operation.type,
      allowed: result.allowed,
      requiresConfirmation: result.requiresConfirmation,
      timestamp: new Date().toISOString()
    };

    if (result.allowed) {
      logger.debug(logData, '[PermissionInterceptor] Permission check passed');
    } else {
      logger.warn({
        ...logData,
        reason: result.reason
      }, '[PermissionInterceptor] Permission check failed');
    }
  }

  /**
   * Create middleware function
   */
  static create(
    rolePermissionService: RolePermissionService,
    options?: PermissionInterceptorOptions
  ) {
    const interceptor = new PermissionInterceptor(rolePermissionService, options);
    return interceptor.intercept.bind(interceptor);
  }
}

/**
 * Convenience function to create permission middleware
 */
export function createPermissionMiddleware(
  rolePermissionService: RolePermissionService,
  options?: Partial<PermissionInterceptorOptions>
) {
  const defaultOptions: PermissionInterceptorOptions = {
    enabled: process.env.PERMISSION_INTERCEPTOR_ENABLED !== 'false',
    strictMode: process.env.PERMISSION_STRICT_MODE === 'true',
    auditLog: process.env.PERMISSION_AUDIT_LOG !== 'false',
    bypassPaths: ['/health', '/ping', '/metrics']
  };

  const mergedOptions = { ...defaultOptions, ...options };
  return PermissionInterceptor.create(rolePermissionService, mergedOptions);
}
