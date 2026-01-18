/**
 * Role Permission Service
 *
 * Manages role permissions and provides permission checking functionality.
 * Serves as the single source of truth for role-based access control.
 *
 * @author Builder (cmkj60r4)
 * @since 2026-01-18
 */

import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '@/utils/log';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Role permissions configuration
 */
export interface RolePermissions {
  permissionMode: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
  accessLevel: 'read-only' | 'full-access';
  disallowedTools: string[];
  allowedOperations: string[];
}

/**
 * Operation that requires permission check
 */
export interface Operation {
  type: 'api_call' | 'tool_use' | 'file_access';
  name: string;
  input?: any;
}

/**
 * Permission check result
 */
export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
  requiresConfirmation: boolean;
}

/**
 * User information
 */
export interface UserInfo {
  userId: string;
  teamId: string;
  role: string;
  sessionId: string;
}

/**
 * Role definition from YAML
 */
interface RoleDefinition {
  id: string;
  title: string;
  accessLevel: 'read-only' | 'full-access';
  policy?: {
    permissionMode?: string;
    disallowedTools?: string[];
  };
  responsibilities?: string[];
  protocol?: string[];
}

/**
 * Role definitions container
 */
interface RoleDefinitions {
  roles: RoleDefinition[];
  version: string;
}

/**
 * Service class to manage role permissions
 */
export class RolePermissionService {
  private permissionCache = new Map<string, RolePermissions>();
  private roleDefinitions: Map<string, RoleDefinition>;
  private cacheTimeout = 5 * 60 * 1000; // 5 minutes
  private roleDefinitionsPath: string;

  constructor() {
    // Path to Master's ROLE_DEFINITIONS.yaml
    this.roleDefinitionsPath = path.join(
      __dirname,
      '../../shared/role-definitions/ROLE_DEFINITIONS.yaml'
    );

    this.roleDefinitions = new Map();
    this.loadRoleDefinitions();
  }

  /**
   * Load role definitions from YAML file
   */
  private loadRoleDefinitions(): void {
    try {
      const fileContent = fs.readFileSync(this.roleDefinitionsPath, 'utf8');
      const definitions = yaml.load(fileContent) as RoleDefinitions;

      if (!definitions || !definitions.roles) {
        throw new Error('Invalid role definitions format');
      }

      // Load roles into map
      definitions.roles.forEach((role: RoleDefinition) => {
        this.roleDefinitions.set(role.id, role);
      });

      logger.info(`[RolePermissionService] Loaded ${definitions.roles.length} role definitions`);
    } catch (error) {
      logger.error('[RolePermissionService] Failed to load role definitions', error);

      // Fallback to default roles
      this.loadDefaultRoles();
    }
  }

  /**
   * Load default roles as fallback
   */
  private loadDefaultRoles(): void {
    logger.warn('[RolePermissionService] Using default role definitions');

    // TODO: Load from @happy/shared-team-config as fallback
    // For now, initialize with empty map
  }

  /**
   * Get permissions for a role (with cache)
   */
  async getPermissions(role: string): Promise<RolePermissions> {
    // Check cache first
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
      logger.debug(`[RolePermissionService] Cache expired for role: ${role}`);
    }, this.cacheTimeout);

    return permissions;
  }

  /**
   * Load permissions from role definition
   */
  private async loadPermissions(role: string): Promise<RolePermissions> {
    const roleDef = this.roleDefinitions.get(role);

    if (!roleDef) {
      logger.warn(`[RolePermissionService] Unknown role: ${role}`);

      // Return default permissive permissions
      return {
        permissionMode: 'default',
        accessLevel: 'full-access',
        disallowedTools: [],
        allowedOperations: []
      };
    }

    // Map role definition to permissions
    const permissions: RolePermissions = {
      permissionMode: (roleDef.policy?.permissionMode as any) || 'default',
      accessLevel: roleDef.accessLevel || 'full-access',
      disallowedTools: roleDef.policy?.disallowedTools || [],
      allowedOperations: this.extractAllowedOperations(roleDef)
    };

    logger.debug(`[RolePermissionService] Loaded permissions for role: ${role}`, {
      permissionMode: permissions.permissionMode,
      accessLevel: permissions.accessLevel,
      disallowedToolsCount: permissions.disallowedTools.length,
      allowedOperationsCount: permissions.allowedOperations.length
    });

    return permissions;
  }

  /**
   * Extract allowed operations from role definition
   */
  private extractAllowedOperations(roleDef: RoleDefinition): string[] {
    const operations: string[] = [];
    const roleId = roleDef.id;

    // Master and Orchestrator can do everything
    if (roleId === 'master' || roleId === 'orchestrator') {
      operations.push('*'); // Wildcard means all operations
      return operations;
    }

    // Builder can update tasks
    if (roleId === 'builder') {
      operations.push(
        'update_task',
        'list_tasks',
        'get_task',
        'create_task'
      );
    }

    // Framer can update tasks (frontend only)
    if (roleId === 'framer') {
      operations.push(
        'update_task',
        'list_tasks',
        'get_task',
        'create_task'
      );
    }

    // Scout can only read
    if (roleId === 'scout') {
      operations.push(
        'list_tasks',
        'get_task',
        'get_file',
        'search_code',
        'read_file'
      );
    }

    // Scribe can edit documentation
    if (roleId === 'scribe') {
      operations.push(
        'list_tasks',
        'get_task',
        'update_documentation',
        'create_documentation'
      );
    }

    // QA can test
    if (roleId === 'qa') {
      operations.push(
        'list_tasks',
        'get_task',
        'run_tests',
        'create_test_report'
      );
    }

    // Reviewer can review
    if (roleId === 'reviewer') {
      operations.push(
        'list_tasks',
        'get_task',
        'review_code',
        'get_file'
      );
    }

    return operations;
  }

  /**
   * Check if operation is allowed for role
   */
  isOperationAllowed(role: string, operation: Operation): PermissionCheckResult {
    const permissions = this.permissionCache.get(role);

    if (!permissions) {
      // If not cached, assume allowed for now (will be checked on next request)
      return { allowed: true, requiresConfirmation: false };
    }

    // Check if wildcard is present
    if (permissions.allowedOperations.includes('*')) {
      return { allowed: true, requiresConfirmation: false };
    }

    // Check if operation is explicitly allowed
    if (permissions.allowedOperations.includes(operation.name)) {
      return { allowed: true, requiresConfirmation: false };
    }

    // Check access level
    if (permissions.accessLevel === 'read-only') {
      const readOnlyOperations = [
        'list_tasks',
        'get_task',
        'list_team_messages',
        'get_file',
        'read_file',
        'search_code'
      ];

      if (!readOnlyOperations.includes(operation.name)) {
        return {
          allowed: false,
          reason: `Role ${role} has read-only access and cannot perform ${operation.name}`,
          requiresConfirmation: false
        };
      }
    }

    // Check permission mode
    if (permissions.permissionMode === 'plan') {
      // Plan mode: only allow read operations
      const planAllowedOperations = [
        'list_tasks',
        'get_task',
        'get_file',
        'read_file'
      ];

      if (!planAllowedOperations.includes(operation.name)) {
        return {
          allowed: false,
          reason: `Role ${role} is in plan mode and cannot perform ${operation.name}`,
          requiresConfirmation: true
        };
      }
    }

    // Default: allow if not explicitly denied
    return { allowed: true, requiresConfirmation: false };
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
   * Reload role definitions from file
   */
  reloadRoleDefinitions(): void {
    logger.info('[RolePermissionService] Reloading role definitions');
    this.clearCache();
    this.roleDefinitions.clear();
    this.loadRoleDefinitions();
  }

  /**
   * Clear cache (for a specific role or all)
   */
  clearCache(role?: string): void {
    if (role) {
      this.permissionCache.delete(role);
      logger.debug(`[RolePermissionService] Cache cleared for role: ${role}`);
    } else {
      this.permissionCache.clear();
      logger.debug('[RolePermissionService] All cache cleared');
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; cachedRoles: string[] } {
    return {
      size: this.permissionCache.size,
      cachedRoles: Array.from(this.permissionCache.keys())
    };
  }

  /**
   * Get all available roles
   */
  getAvailableRoles(): string[] {
    return Array.from(this.roleDefinitions.keys());
  }

  /**
   * Get role definition
   */
  getRoleDefinition(role: string): RoleDefinition | undefined {
    return this.roleDefinitions.get(role);
  }
}
