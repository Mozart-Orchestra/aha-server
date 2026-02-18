import { z } from "zod";
import { Fastify } from "../types";
import { kvGet } from "@/app/kv/kvGet";
import { kvList } from "@/app/kv/kvList";
import { kvMutate } from "@/app/kv/kvMutate";
import { log } from "@/utils/log";
import { randomUUID } from "node:crypto";

/**
 * Custom Role Routes - User-defined Role Management API
 *
 * Allows users to create, update, and delete custom roles for their teams.
 * Roles are stored per-user in KV storage with prefix "roles."
 *
 * Custom Role Schema extends SharedTeamRole with additional fields:
 * - modelConfig: { model, temperature, maxTokens }
 * - assignedSkills: string[]
 */

// Schema for model configuration
const ModelConfigSchema = z.object({
    model: z.string().optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().min(1).max(1000000).optional(),
});

// Schema for tool permissions
const ToolPermissionsSchema = z.object({
    allowRead: z.boolean().optional().default(true),
    allowWrite: z.boolean().optional().default(true),
    allowEdit: z.boolean().optional().default(true),
    allowBash: z.boolean().optional().default(false),
    allowedTools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
});

// Schema for policy (subset of SharedTeamRolePolicy)
const RolePolicySchema = z.object({
    permissionMode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan']).optional(),
    accessLevel: z.enum(['read-only', 'full-access']).optional(),
    disallowedTools: z.array(z.string()).optional(),
    coordinationMode: z.enum(['strong', 'weak']).optional(),
});

// Schema for custom role (extends SharedTeamRole with user-configurable fields)
const CustomRoleSchema = z.object({
    // Basic info
    id: z.string().optional(), // Auto-generated if not provided
    title: z.string().min(1).max(100),
    summary: z.string().max(500).optional(),
    icon: z.string().max(10).optional(), // Emoji or short icon

    // Role configuration
    modelConfig: ModelConfigSchema.optional(),
    toolPermissions: ToolPermissionsSchema.optional(),
    assignedSkills: z.array(z.string()).optional(),
    policy: RolePolicySchema.optional(),

    // SharedTeamRole compatibility
    responsibilities: z.array(z.string()).optional(),
    abilityBoundaries: z.array(z.string()).optional(),
    handoffProtocol: z.array(z.string()).optional(),
    protocol: z.array(z.string()).optional(),

    // Metadata
    isTemplate: z.boolean().optional().default(false),
    templateSource: z.string().optional(), // ID of original template if copied
});

// Schema for role export
const RoleExportSchema = z.object({
    version: z.literal('1.0'),
    exportedAt: z.number(),
    role: CustomRoleSchema,
});

// KV key prefix for custom roles
const ROLES_PREFIX = 'roles.';

/**
 * Generate a unique role ID
 */
function generateRoleId(): string {
    return `custom-${randomUUID().slice(0, 8)}`;
}

/**
 * Parse role from KV storage
 */
function parseRole(value: string): z.infer<typeof CustomRoleSchema> | null {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

/**
 * Serialize role for KV storage
 */
function serializeRole(role: z.infer<typeof CustomRoleSchema>): string {
    return JSON.stringify(role);
}

export function roleRoutes(app: Fastify) {
    log({ module: 'api' }, 'Registering roleRoutes...');

    // GET /v1/roles - List user's custom roles
    app.get('/v1/roles', {
        preHandler: app.authenticate,
        schema: {
            querystring: z.object({
                includeTemplates: z.coerce.boolean().optional().default(false),
                limit: z.coerce.number().int().min(1).max(100).default(50)
            }),
            response: {
                200: z.object({
                    roles: z.array(CustomRoleSchema),
                    total: z.number()
                }),
                500: z.object({
                    error: z.literal('Failed to list roles')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { includeTemplates, limit } = request.query as { includeTemplates: boolean; limit: number };

        try {
            // List all roles for this user
            const result = await kvList({ uid: userId }, { prefix: ROLES_PREFIX, limit: 1000 });
            const roles: z.infer<typeof CustomRoleSchema>[] = [];

            for (const item of result.items) {
                const role = parseRole(item.value);
                if (role) {
                    // Filter templates unless explicitly requested
                    if (!includeTemplates && role.isTemplate) {
                        continue;
                    }
                    roles.push(role);
                }
            }

            // Apply limit after filtering
            const limitedRoles = roles.slice(0, limit);

            return reply.send({
                roles: limitedRoles,
                total: roles.length
            });
        } catch (error) {
            log({ module: 'role-routes', level: 'error' }, `Failed to list roles: ${error}`);
            return reply.code(500).send({ error: 'Failed to list roles' });
        }
    });

    // GET /v1/roles/:id - Get single role
    app.get('/v1/roles/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            response: {
                200: CustomRoleSchema,
                404: z.object({
                    error: z.literal('Role not found')
                }),
                500: z.object({
                    error: z.literal('Failed to get role')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params as { id: string };

        try {
            const result = await kvGet({ uid: userId }, `${ROLES_PREFIX}${id}`);

            if (!result) {
                return reply.code(404).send({ error: 'Role not found' });
            }

            const role = parseRole(result.value);
            if (!role) {
                return reply.code(404).send({ error: 'Role not found' });
            }

            return reply.send(role);
        } catch (error) {
            log({ module: 'role-routes', level: 'error' }, `Failed to get role: ${error}`);
            return reply.code(500).send({ error: 'Failed to get role' });
        }
    });

    // POST /v1/roles - Create custom role
    app.post('/v1/roles', {
        preHandler: app.authenticate,
        schema: {
            body: CustomRoleSchema,
            response: {
                200: z.object({
                    success: z.literal(true),
                    role: CustomRoleSchema
                }),
                400: z.object({
                    error: z.string()
                }),
                409: z.object({
                    error: z.literal('Role with this ID already exists')
                }),
                500: z.object({
                    error: z.literal('Failed to create role')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const roleData = request.body as z.infer<typeof CustomRoleSchema>;

        try {
            // Generate ID if not provided
            const roleId = roleData.id || generateRoleId();

            // Check if role already exists
            const existing = await kvGet({ uid: userId }, `${ROLES_PREFIX}${roleId}`);
            if (existing) {
                return reply.code(409).send({ error: 'Role with this ID already exists' });
            }

            // Create role with generated ID
            const role: z.infer<typeof CustomRoleSchema> = {
                ...roleData,
                id: roleId,
                summary: roleData.summary || `Custom role: ${roleData.title}`,
                responsibilities: roleData.responsibilities || [],
                abilityBoundaries: roleData.abilityBoundaries || [],
                handoffProtocol: roleData.handoffProtocol || [],
                protocol: roleData.protocol || [],
                assignedSkills: roleData.assignedSkills || [],
                isTemplate: roleData.isTemplate ?? false,
            };

            // Store in KV
            await kvMutate({ uid: userId }, [{
                key: `${ROLES_PREFIX}${roleId}`,
                value: serializeRole(role),
                version: -1 // New key
            }]);

            log({ module: 'role-routes', roleId }, 'Custom role created');
            return reply.send({ success: true, role });
        } catch (error) {
            log({ module: 'role-routes', level: 'error' }, `Failed to create role: ${error}`);
            return reply.code(500).send({ error: 'Failed to create role' });
        }
    });

    // PUT /v1/roles/:id - Update custom role
    app.put('/v1/roles/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            body: CustomRoleSchema.partial(),
            response: {
                200: z.object({
                    success: z.literal(true),
                    role: CustomRoleSchema
                }),
                404: z.object({
                    error: z.literal('Role not found')
                }),
                409: z.object({
                    error: z.literal('Version mismatch')
                }),
                500: z.object({
                    error: z.literal('Failed to update role')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params as { id: string };
        const updates = request.body as Partial<z.infer<typeof CustomRoleSchema>>;

        try {
            // Get existing role
            const existing = await kvGet({ uid: userId }, `${ROLES_PREFIX}${id}`);
            if (!existing) {
                return reply.code(404).send({ error: 'Role not found' });
            }

            const existingRole = parseRole(existing.value);
            if (!existingRole) {
                return reply.code(404).send({ error: 'Role not found' });
            }

            // Merge updates
            const updatedRole: z.infer<typeof CustomRoleSchema> = {
                ...existingRole,
                ...updates,
                id, // Ensure ID doesn't change
            };

            // Handle nested object merges
            if (updates.modelConfig) {
                updatedRole.modelConfig = { ...existingRole.modelConfig, ...updates.modelConfig };
            }
            if (updates.toolPermissions) {
                updatedRole.toolPermissions = { ...existingRole.toolPermissions, ...updates.toolPermissions };
            }
            if (updates.policy) {
                updatedRole.policy = { ...existingRole.policy, ...updates.policy };
            }

            // Store updated role
            await kvMutate({ uid: userId }, [{
                key: `${ROLES_PREFIX}${id}`,
                value: serializeRole(updatedRole),
                version: existing.version
            }]);

            log({ module: 'role-routes', roleId: id }, 'Custom role updated');
            return reply.send({ success: true, role: updatedRole });
        } catch (error: any) {
            if (error.message?.includes('version')) {
                return reply.code(409).send({ error: 'Version mismatch' });
            }
            log({ module: 'role-routes', level: 'error' }, `Failed to update role: ${error}`);
            return reply.code(500).send({ error: 'Failed to update role' });
        }
    });

    // DELETE /v1/roles/:id - Delete custom role
    app.delete('/v1/roles/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                404: z.object({
                    error: z.literal('Role not found')
                }),
                500: z.object({
                    error: z.literal('Failed to delete role')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params as { id: string };

        try {
            // Check if role exists
            const existing = await kvGet({ uid: userId }, `${ROLES_PREFIX}${id}`);
            if (!existing) {
                return reply.code(404).send({ error: 'Role not found' });
            }

            // Delete by setting value to null
            await kvMutate({ uid: userId }, [{
                key: `${ROLES_PREFIX}${id}`,
                value: null,
                version: existing.version
            }]);

            log({ module: 'role-routes', roleId: id }, 'Custom role deleted');
            return reply.send({ success: true });
        } catch (error) {
            log({ module: 'role-routes', level: 'error' }, `Failed to delete role: ${error}`);
            return reply.code(500).send({ error: 'Failed to delete role' });
        }
    });

    // POST /v1/roles/:id/export - Export role template
    app.post('/v1/roles/:id/export', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            response: {
                200: RoleExportSchema,
                404: z.object({
                    error: z.literal('Role not found')
                }),
                500: z.object({
                    error: z.literal('Failed to export role')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params as { id: string };

        try {
            const existing = await kvGet({ uid: userId }, `${ROLES_PREFIX}${id}`);
            if (!existing) {
                return reply.code(404).send({ error: 'Role not found' });
            }

            const role = parseRole(existing.value);
            if (!role) {
                return reply.code(404).send({ error: 'Role not found' });
            }

            // Create export format
            const exportData: z.infer<typeof RoleExportSchema> = {
                version: '1.0',
                exportedAt: Date.now(),
                role: {
                    ...role,
                    id: undefined, // Remove ID for export (will be generated on import)
                    templateSource: id, // Reference to original
                }
            };

            log({ module: 'role-routes', roleId: id }, 'Role exported');
            return reply.send(exportData);
        } catch (error) {
            log({ module: 'role-routes', level: 'error' }, `Failed to export role: ${error}`);
            return reply.code(500).send({ error: 'Failed to export role' });
        }
    });

    // POST /v1/roles/import - Import role template
    app.post('/v1/roles/import', {
        preHandler: app.authenticate,
        schema: {
            body: RoleExportSchema,
            response: {
                200: z.object({
                    success: z.literal(true),
                    role: CustomRoleSchema
                }),
                400: z.object({
                    error: z.string()
                }),
                500: z.object({
                    error: z.literal('Failed to import role')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const importData = request.body as z.infer<typeof RoleExportSchema>;

        try {
            // Validate version
            if (importData.version !== '1.0') {
                return reply.code(400).send({ error: 'Unsupported export version' });
            }

            // Generate new ID for imported role
            const roleId = generateRoleId();

            // Create imported role
            const role: z.infer<typeof CustomRoleSchema> = {
                ...importData.role,
                id: roleId,
                isTemplate: false, // Imported roles are not templates by default
            };

            // Store in KV
            await kvMutate({ uid: userId }, [{
                key: `${ROLES_PREFIX}${roleId}`,
                value: serializeRole(role),
                version: -1 // New key
            }]);

            log({ module: 'role-routes', roleId, sourceId: importData.role.templateSource }, 'Role imported');
            return reply.send({ success: true, role });
        } catch (error) {
            log({ module: 'role-routes', level: 'error' }, `Failed to import role: ${error}`);
            return reply.code(500).send({ error: 'Failed to import role' });
        }
    });

    // GET /v1/roles/templates/list - List built-in role templates
    app.get('/v1/roles/templates/list', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    templates: z.array(z.object({
                        id: z.string(),
                        title: z.string(),
                        summary: z.string(),
                        icon: z.string().optional(),
                    }))
                })
            }
        }
    }, async (request, reply) => {
        // Built-in role templates (from TEAM_ROLE_LIBRARY)
        const templates = [
            { id: 'master', title: 'Master', summary: 'Team coordinator and task distributor', icon: '🎯' },
            { id: 'architect', title: 'Architect', summary: 'System design and architecture decisions', icon: '🏗️' },
            { id: 'implementer', title: 'Implementer', summary: 'Code implementation and execution', icon: '⚙️' },
            { id: 'reviewer', title: 'Reviewer', summary: 'Code review and quality assurance', icon: '🔍' },
            { id: 'qa', title: 'QA', summary: 'Testing and quality validation', icon: '✅' },
            { id: 'observer', title: 'Observer', summary: 'Progress monitoring and reporting', icon: '👁️' },
            { id: 'user', title: 'User', summary: 'Human team member with full access', icon: '👤' },
        ];

        return reply.send({ templates });
    });
}
