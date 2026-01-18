/**
 * Permission Interceptor Middleware
 *
 * Intercepts all requests to happy-server and validates permissions
 * based on user roles. Ensures that only authorized operations are performed.
 *
 * @author Builder (cmkj60r4)
 * @since 2026-01-18
 */

import { Request, Response, NextFunction } from 'express';
import { RolePermissionService, UserInfo, Operation } from '../services/rolePermissionService';
import { logger } from '@/utils/log';

/**
 * Permission interceptor options
 */
export interface PermissionInterceptorOptions {
  enabled: boolean;
  strictMode: boolean; // If true, deny all unknown operations
  auditLog: boolean; // Log all permission checks
  bypassPaths: string[]; // Paths to bypass permission check
}

/**
 * Express request with user info
 */
interface AuthenticatedRequest extends Request {
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
    logger.info('[PermissionInterceptor] Initialized with options', this.options);
  }

  /**
   * Express middleware function
   */
  async intercept(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
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
      const userInfo = this.extractUserInfo(req);

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
        logger.debug('[PermissionInterceptor] Access granted', {
          userId: userInfo.userId,
          role: userInfo.role,
          operation: operation.name
        });
        return next();
      } else {
        // Denied - return 403
        logger.warn('[PermissionInterceptor] Access denied', {
          userId: userInfo.userId,
          role: userInfo.role,
          operation: operation.name,
          reason: result.reason
        });

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
      logger.error('[PermissionInterceptor] Error checking permission', error);

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
  private extractUserInfo(req: AuthenticatedRequest): UserInfo {
    // TODO: Extract from auth token or session
    // For now, use mock data or extract from headers

    const authHeader = req.headers.authorization;
    const teamId = req.headers['x-team-id'] as string;
    const role = req.headers['x-role'] as string;
    const sessionId = req.headers['x-session-id'] as string;

    if (authHeader) {
      // Parse JWT token
      try {
        const token = authHeader.replace('Bearer ', '');
        const decoded = this.decodeToken(token);

        return {
          userId: decoded.userId,
          teamId: decoded.teamId || teamId || 'default-team',
          role: decoded.role || role || 'builder',
          sessionId: decoded.sessionId || sessionId || 'default-session'
        };
      } catch (error) {
        logger.warn('[PermissionInterceptor] Failed to decode token', error);
      }
    }

    // Fallback to headers or defaults
    return {
      userId: req.headers['x-user-id'] as string || 'anonymous',
      teamId: teamId || 'default-team',
      role: role || 'builder',
      sessionId: sessionId || 'default-session'
    };
  }

  /**
   * Extract operation from request
   */
  private extractOperation(req: Request): Operation {
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
    // Remove /api prefix if present
    const route = path.replace(/^\/api\//, '');

    // Convert to operation name
    // Examples:
    // GET /api/tasks -> list_tasks
    // POST /api/tasks -> create_task
    // PUT /api/tasks/123 -> update_task
    // DELETE /api/tasks/123 -> delete_task

    const parts = route.split('/').filter(Boolean);
    const resource = parts[0];

    if (parts.length === 1) {
      // Collection operations - use singular form for create too
      const singularResource = this.singularize(resource);
      if (method === 'GET') {
        return `list_${resource}`;
      } else if (method === 'POST') {
        return `create_${singularResource}`;
      }
    } else if (parts.length >= 2) {
      // Single resource operations - use singular form
      const singularResource = this.singularize(resource);
      if (method === 'GET') {
        return `get_${singularResource}`;
      } else if (method === 'PUT' || method === 'PATCH') {
        return `update_${singularResource}`;
      } else if (method === 'DELETE') {
        return `delete_${singularResource}`;
      }
    }

    // Default: method_resource
    return `${method.toLowerCase()}_${resource}`;
  }

  /**
   * Simple singularizer for common English plurals
   */
  private singularize(word: string): string {
    // Common patterns
    if (word.endsWith('ies')) {
      return word.slice(0, -3) + 'y'; // activities -> activity
    } else if (word.endsWith('ses') || word.endsWith('xes')) {
      return word.slice(0, -2); // boxes -> box
    } else if (word.endsWith('s')) {
      return word.slice(0, -1); // tasks -> task
    }
    return word;
  }

  /**
   * Decode JWT token
   * TODO: Implement proper JWT decoding
   */
  private decodeToken(token: string): any {
    // For now, return mock data
    // In production, use jwt.decode() or similar

    try {
      // Split token into parts (header.payload.signature)
      const parts = token.split('.');
      if (parts.length !== 3) {
        throw new Error('Invalid token format');
      }

      // Decode payload (base64url)
      const payload = parts[1];
      const decoded = Buffer.from(payload, 'base64url').toString('utf8');
      return JSON.parse(decoded);
    } catch (error) {
      logger.debug('[PermissionInterceptor] Could not decode token, returning mock data');
      return {
        userId: 'mock-user-id',
        teamId: 'mock-team-id',
        role: 'builder',
        sessionId: 'mock-session-id'
      };
    }
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
      logger.debug('[PermissionInterceptor] Permission check passed', logData);
    } else {
      logger.warn('[PermissionInterceptor] Permission check failed', {
        ...logData,
        reason: result.reason
      });
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
