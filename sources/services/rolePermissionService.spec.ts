/**
 * PermissionInterceptor Unit Tests
 *
 * @author Builder (cmkj60r4)
 * @since 2026-01-18
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RolePermissionService } from './rolePermissionService';
import { PermissionInterceptor } from '../middleware/permissionInterceptor';
import { auth } from '@/app/auth/auth';

// Mock logger
vi.mock('../utils/log', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

vi.mock('@/app/auth/auth', () => ({
  auth: {
    verifyToken: vi.fn(),
  }
}));

describe('RolePermissionService', () => {
  let service: RolePermissionService;

  beforeEach(() => {
    vi.mocked(auth.verifyToken).mockResolvedValue(null);
    service = new RolePermissionService();
  });

  describe('getPermissions', () => {
    it('should load permissions for builder role', async () => {
      const permissions = await service.getPermissions('builder');

      expect(permissions).toBeDefined();
      expect(permissions.permissionMode).toBeDefined();
      expect(permissions.accessLevel).toBeDefined();
      expect(permissions.disallowedTools).toBeInstanceOf(Array);
      expect(permissions.allowedOperations).toBeInstanceOf(Array);
    });

    it('should cache permissions', async () => {
      // First call
      await service.getPermissions('builder');

      // Check cache
      const stats = service.getCacheStats();
      expect(stats.size).toBeGreaterThan(0);
      expect(stats.cachedRoles).toContain('builder');
    });

    it('should return default permissions for unknown role', async () => {
      const permissions = await service.getPermissions('unknown-role');

      expect(permissions.permissionMode).toBe('default');
      expect(permissions.accessLevel).toBe('full-access');
    });
  });

  describe('isOperationAllowed', () => {
    it('should allow master to perform any operation', () => {
      const result = service.isOperationAllowed('master', {
        type: 'api_call',
        name: 'any_operation'
      });

      expect(result.allowed).toBe(true);
    });

    it('should allow builder to update tasks', () => {
      const result = service.isOperationAllowed('builder', {
        type: 'api_call',
        name: 'update_task'
      });

      expect(result.allowed).toBe(true);
    });

    it('should deny scout from deleting tasks', () => {
      const result = service.isOperationAllowed('scout', {
        type: 'api_call',
        name: 'delete_task'
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('read-only');
    });

    it('should allow scout to list tasks', () => {
      const result = service.isOperationAllowed('scout', {
        type: 'api_call',
        name: 'list_tasks'
      });

      expect(result.allowed).toBe(true);
    });
  });

  describe('isToolAllowed', () => {
    it('should allow builder to use all tools', () => {
      const allowed = service.isToolAllowed('builder', 'Bash');
      expect(allowed).toBe(true);
    });

    it('should deny scout from using Bash', () => {
      const allowed = service.isToolAllowed('scout', 'Bash');
      expect(allowed).toBe(false);
    });
  });

  describe('clearCache', () => {
    it('should clear cache for specific role', async () => {
      // Load into cache
      await service.getPermissions('builder');

      // Clear cache
      service.clearCache('builder');

      // Verify cache is cleared
      const stats = service.getCacheStats();
      expect(stats.cachedRoles).not.toContain('builder');
    });

    it('should clear all cache', async () => {
      // Load into cache
      await service.getPermissions('master');
      await service.getPermissions('builder');

      // Clear all cache
      service.clearCache();

      // Verify cache is cleared
      const stats = service.getCacheStats();
      expect(stats.size).toBe(0);
    });
  });

  describe('getAvailableRoles', () => {
    it('should return list of available roles', () => {
      const roles = service.getAvailableRoles();

      expect(roles).toBeInstanceOf(Array);
      expect(roles.length).toBeGreaterThan(0);
      expect(roles).toContain('master');
      expect(roles).toContain('builder');
    });
  });

  describe('reloadRoleDefinitions', () => {
    it('should reload role definitions from file', () => {
      // Should not throw
      expect(() => {
        service.reloadRoleDefinitions();
      }).not.toThrow();
    });

    it('should clear cache on reload', async () => {
      // Load into cache
      await service.getPermissions('builder');

      // Reload
      service.reloadRoleDefinitions();

      // Verify cache is cleared
      const stats = service.getCacheStats();
      expect(stats.size).toBe(0);
    });
  });
});

describe('PermissionInterceptor', () => {
  let interceptor: PermissionInterceptor;
  let roleService: RolePermissionService;
  let mockRequest: any;
  let mockResponse: any;
  let mockNext: any;

  beforeEach(() => {
    vi.mocked(auth.verifyToken).mockResolvedValue(null);
    roleService = new RolePermissionService();
    interceptor = new PermissionInterceptor(roleService, {
      enabled: true,
      strictMode: false,
      auditLog: false,
      bypassPaths: ['/health']
    });

    mockRequest = {
      path: '/api/tasks',
      method: 'GET',
      headers: {
        authorization: 'Bearer mock-token',
        'x-role': 'builder',
        'x-user-id': 'user-123',
        'x-team-id': 'team-456',
        'x-session-id': 'session-789'
      }
    };

    mockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis()
    };

    mockNext = vi.fn();
  });

  describe('intercept', () => {
    it('should allow access for permitted operation', async () => {
      await interceptor.intercept(mockRequest, mockResponse, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it('should deny access for disallowed operation', async () => {
      // Set role to scout (read-only)
      mockRequest.headers['x-role'] = 'scout';
      mockRequest.method = 'DELETE';
      mockRequest.path = '/api/tasks/123';

      await interceptor.intercept(mockRequest, mockResponse, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockResponse.status).toHaveBeenCalledWith(403);
      expect(mockResponse.json).toHaveBeenCalled();
    });

    it('should bypass permission check for whitelisted paths', async () => {
      mockRequest.path = '/health';

      await interceptor.intercept(mockRequest, mockResponse, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should skip if disabled', async () => {
      const disabledInterceptor = new PermissionInterceptor(roleService, {
        enabled: false,
        strictMode: false,
        auditLog: false,
        bypassPaths: []
      });

      await disabledInterceptor.intercept(mockRequest, mockResponse, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('extractUserInfo', () => {
    it('should extract user info from request', () => {
      const userInfo = (interceptor as any).extractUserInfo(mockRequest);

      return expect(userInfo).resolves.toEqual({
        userId: 'user-123',
        teamId: 'team-456',
        role: 'builder',
        sessionId: 'session-789'
      });
    });

    it('should handle missing headers gracefully', () => {
      const requestWithoutHeaders = {
        path: '/api/tasks',
        method: 'GET',
        headers: {}
      };

      const userInfo = (interceptor as any).extractUserInfo(requestWithoutHeaders);

      return expect(userInfo).resolves.toMatchObject({
        userId: expect.any(String),
        role: expect.any(String),
      });
    });

    it('should prefer verified auth token identity when available', async () => {
      vi.mocked(auth.verifyToken).mockResolvedValue({
        userId: 'token-user',
        extras: {
          role: 'master',
          teamId: 'team-from-token',
          sessionId: 'session-from-token',
        }
      });

      const userInfo = await (interceptor as any).extractUserInfo({
        path: '/v1/teams/team-1/tasks',
        method: 'GET',
        headers: {
          authorization: 'Bearer header.payload.signature',
          'x-role': 'builder',
          'x-user-id': 'header-user',
        }
      });

      expect(userInfo).toEqual({
        userId: 'token-user',
        role: 'master',
        teamId: 'team-from-token',
        sessionId: 'session-from-token',
      });
    });
  });

  describe('mapRouteToOperation', () => {
    it('should map GET /api/tasks to list_tasks', () => {
      const operation = (interceptor as any).mapRouteToOperation('/api/tasks', 'GET');

      expect(operation).toBe('list_tasks');
    });

    it('should map POST /api/tasks to create_task', () => {
      const operation = (interceptor as any).mapRouteToOperation('/api/tasks', 'POST');

      expect(operation).toBe('create_task');
    });

    it('should map PUT /api/tasks/123 to update_task', () => {
      const operation = (interceptor as any).mapRouteToOperation('/api/tasks/123', 'PUT');

      expect(operation).toBe('update_task');
    });

    it('should map DELETE /api/tasks/123 to delete_task', () => {
      const operation = (interceptor as any).mapRouteToOperation('/api/tasks/123', 'DELETE');

      expect(operation).toBe('delete_task');
    });

    it('should map POST /v1/teams/:teamId/tasks/:taskId/start to start_task', () => {
      const operation = (interceptor as any).mapRouteToOperation('/v1/teams/team-1/tasks/task-1/start', 'POST');

      expect(operation).toBe('start_task');
    });

    it('should map GET /v1/teams/:teamId/tasks to list_tasks', () => {
      const operation = (interceptor as any).mapRouteToOperation('/v1/teams/team-1/tasks', 'GET');

      expect(operation).toBe('list_tasks');
    });
  });
});
