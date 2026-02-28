/**
 * V5-AI-001: 智能角色推荐 API
 *
 * 端点: POST /api/v5/recommendations
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RecommendationEngine, ProjectRequirement, Role, RoleRecommendation } from '../../../services/ai/RecommendationEngine';
import { kvList } from '@/app/kv/kvList';
import { kvMutate } from '@/app/kv/kvMutate';
import { log } from '@/utils/log';

// 请求 schema
const RecommendationRequestSchema = z.object({
  techStack: z.array(z.string()),
  teamSize: z.number().min(1).max(50),
  projectType: z.enum(['webapp', 'api', 'mobile', 'fullstack']),
  description: z.string().optional(),
  timeline: z.string().optional(),
  maxRecommendations: z.number().min(1).max(10).default(5)
});

// 响应 schema
const RecommendationResponseSchema = z.object({
  success: z.boolean(),
  recommendations: z.array(z.object({
    role: z.object({
      id: z.string(),
      name: z.string(),
      category: z.string(),
      assignedSkills: z.array(z.string()),
      description: z.string(),
      rating: z.number().optional(),
      completedTasks: z.number().optional(),
      successRate: z.number().optional()
    }),
    matchScore: z.number(),
    reasons: z.array(z.string()),
    skillMatch: z.object({
      matched: z.array(z.string()),
      missing: z.array(z.string()),
      bonus: z.array(z.string())
    })
  }))
});

export async function recommendationRoutes(fastify: FastifyInstance) {
  const engine = new RecommendationEngine();

  /**
   * POST /api/v5/recommendations
   *
   * 为项目推荐最合适的角色组合
   */
  fastify.post('/api/v5/recommendations', {
    schema: {
      body: RecommendationRequestSchema,
      response: {
        200: RecommendationResponseSchema
      }
    }
  }, async (request, reply) => {
    try {
      const body = request.body as z.infer<typeof RecommendationRequestSchema>;

      // 转换为 ProjectRequirement
      const requirement: ProjectRequirement = {
        techStack: body.techStack,
        teamSize: body.teamSize,
        projectType: body.projectType,
        description: body.description,
        timeline: body.timeline
      };

      // 从数据库获取可用角色
      // Support both authenticated user and x-user-id header for flexibility
      const userId = (request as any).user?.id || (request as any).userId || (request.headers as any)['x-user-id'];
      if (!userId) {
        return reply.status(401).send({
          success: false,
          recommendations: [],
          error: 'Unauthorized'
        });
      }

      const ROLES_PREFIX = "roles.";
      const roleItems = await kvList({ uid: userId }, { prefix: ROLES_PREFIX, limit: 1000 });

      // 转换为 Role 格式
      const availableRoles: Role[] = roleItems.items
        .map((item: any): Role | null => {
          try {
            const role = JSON.parse(item.value);
            if (!role.id) return null;
            return {
              id: role.id,
              name: role.title || role.name || 'Unnamed Role',
              category: role.policy?.coordinationMode || 'implementer',
              assignedSkills: role.assignedSkills || [],
              description: role.summary || role.description || '',
              rating: role.stats?.averageRating,
              completedTasks: role.stats?.completionCount,
              successRate: role.stats?.completionCount && role.stats?.reviewCount
                ? role.stats.completionCount / role.stats.reviewCount
                : undefined
            };
          } catch (e) {
            return null;
          }
        })
        .filter((role): role is Role => role !== null);

      // 如果没有自定义角色，使用默认模板
      if (availableRoles.length === 0) {
        availableRoles.push(
          {
            id: 'default-frontend',
            name: 'Frontend Developer',
            category: 'implementer',
            assignedSkills: ['React', 'TypeScript', 'CSS'],
            description: '前端开发专家，擅长 React 和 TypeScript'
          },
          {
            id: 'default-backend',
            name: 'Backend Developer',
            category: 'implementer',
            assignedSkills: ['Node.js', 'TypeScript', 'PostgreSQL'],
            description: '后端开发专家，擅长 API 设计和数据库优化'
          },
          {
            id: 'default-qa',
            name: 'QA Engineer',
            category: 'qa',
            assignedSkills: ['Testing', 'E2E', 'Vitest'],
            description: '测试工程师，确保代码质量'
          }
        );
      }

      // 生成推荐
      const recommendations = await engine.recommendRoles(
        requirement,
        availableRoles,
        body.maxRecommendations
      );

      return {
        success: true,
        recommendations
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        recommendations: []
      });
    }
  });

  /**
   * POST /api/v5/recommendations/batch
   *
   * 批量推荐（用于多个项目场景）
   */
  fastify.post('/api/v5/recommendations/batch', {
    schema: {
      body: z.object({
        requirements: z.array(RecommendationRequestSchema)
      }),
      response: {
        200: z.object({
          success: z.boolean(),
          results: z.record(z.string(), z.array(z.any()))
        })
      }
    }
  }, async (request, reply) => {
    try {
      const userId = (request as any).user?.id || (request as any).userId;
      if (!userId) {
        return reply.status(401).send({
          success: false,
          results: {},
          error: 'Unauthorized'
        });
      }

      const { requirements } = request.body as { requirements: any[] };

      // Get available roles
      const ROLES_PREFIX = "roles.";
      const roleItems = await kvList({ uid: userId }, { prefix: ROLES_PREFIX, limit: 1000 });
      const availableRoles: Role[] = roleItems.items
        .map((item: any): Role | null => {
          try {
            const role = JSON.parse(item.value);
            if (!role.id) return null;
            return {
              id: role.id,
              name: role.title || role.name || 'Unnamed Role',
              category: role.policy?.coordinationMode || 'implementer',
              assignedSkills: role.assignedSkills || [],
              description: role.summary || role.description || '',
              rating: role.stats?.averageRating,
              completedTasks: role.stats?.completionCount,
              successRate: role.stats?.completionCount && role.stats?.reviewCount
                ? role.stats.completionCount / role.stats.reviewCount
                : undefined
            };
          } catch (e) {
            return null;
          }
        })
        .filter((role): role is Role => role !== null);

      // 批量推荐
      const results = await engine.batchRecommend(
        requirements.map(r => ({
          techStack: r.techStack,
          teamSize: r.teamSize,
          projectType: r.projectType,
          description: r.description,
          timeline: r.timeline
        })),
        availableRoles
      );

      // 转换为可序列化格式
      const serializedResults: Record<string, RoleRecommendation[]> = {};
      results.forEach((value: RoleRecommendation[], key: string) => {
        serializedResults[key] = value;
      });

      return {
        success: true,
        results: serializedResults
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        results: {}
      });
    }
  });

  /**
   * POST /api/v5/recommendations/apply
   *
   * 一键应用推荐 - 将推荐的角色应用到项目
   */
  fastify.post('/api/v5/recommendations/apply', {
    schema: {
      body: z.object({
        projectId: z.string(),
        recommendations: z.array(z.object({
          roleId: z.string(),
          matchScore: z.number().min(0).max(100)
        }))
      }),
      response: {
        200: z.object({
          success: z.boolean(),
          projectId: z.string(),
          appliedRoles: z.array(z.object({
            roleId: z.string(),
            roleName: z.string(),
            status: z.string()
          }))
        })
      }
    }
  }, async (request, reply) => {
    try {
      // Support both authenticated user and x-user-id header for flexibility
      const userId = (request as any).user?.id || (request as any).userId || (request.headers as any)['x-user-id'];
      if (!userId) {
        return reply.status(401).send({
          success: false,
          projectId: '',
          appliedRoles: [],
          error: 'Unauthorized'
        });
      }

      const body = request.body as {
        projectId: string;
        recommendations: Array<{
          roleId: string;
          matchScore: number;
        }>;
      };

      // Validate input
      if (!body.projectId) {
        return reply.status(400).send({
          success: false,
          projectId: '',
          appliedRoles: [],
          error: 'Project ID is required'
        });
      }

      if (!body.recommendations || body.recommendations.length === 0) {
        return reply.status(400).send({
          success: false,
          projectId: body.projectId,
          appliedRoles: [],
          error: 'Recommendations are required'
        });
      }

      // Get available roles to validate
      const ROLES_PREFIX = "roles.";
      const roleItems = await kvList({ uid: userId }, { prefix: ROLES_PREFIX, limit: 1000 });
      const availableRoles: Role[] = roleItems.items
        .map((item: any): Role | null => {
          try {
            const role = JSON.parse(item.value);
            if (!role.id) return null;
            return {
              id: role.id,
              name: role.title || role.name || 'Unnamed Role',
              category: role.policy?.coordinationMode || 'implementer',
              assignedSkills: role.assignedSkills || [],
              description: role.summary || role.description || ''
            };
          } catch (e) {
            return null;
          }
        })
        .filter((role): role is Role => role !== null);

      // Apply each recommended role to the project
      const appliedRoles = body.recommendations.map(rec => {
        const role = availableRoles.find(r => r.id === rec.roleId);
        return {
          roleId: rec.roleId,
          roleName: role?.name || 'Unknown Role',
          status: role ? 'applied' : 'not_found'
        };
      });

      // Store the applied roles in KV store
      const projectRolesKey = `projects.${body.projectId}.roles`;
      const projectRolesValue = JSON.stringify({
        appliedAt: new Date().toISOString(),
        roles: appliedRoles
      });

      await kvMutate({ uid: userId }, [{
        key: projectRolesKey,
        value: projectRolesValue,
        version: -1 // -1 means create new
      }]);

      log({
        module: 'recommendation',
        action: 'apply',
        userId,
        projectId: body.projectId,
        appliedCount: appliedRoles.length
      }, 'Applied role recommendations to project');

      return {
        success: true,
        projectId: body.projectId,
        appliedRoles
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        projectId: '',
        appliedRoles: []
      });
    }
  });

  /**
   * PUT /api/v5/recommendations/adjust
   *
   * 自定义调整推荐结果
   */
  fastify.put('/api/v5/recommendations/adjust', {
    schema: {
      body: z.object({
        projectId: z.string(),
        adjustments: z.array(z.object({
          roleId: z.string(),
          adjustedScore: z.number().min(0).max(100),
          reason: z.string().optional()
        }))
      }),
      response: {
        200: z.object({
          success: z.boolean(),
          adjustedRecommendations: z.array(z.any())
        })
      }
    }
  }, async (request, reply) => {
    try {
      // Support both authenticated user and x-user-id header for flexibility
      const userId = (request as any).user?.id || (request as any).userId || (request.headers as any)['x-user-id'];
      if (!userId) {
        return reply.status(401).send({
          success: false,
          adjustedRecommendations: [],
          error: 'Unauthorized'
        });
      }

      const body = request.body as {
        projectId: string;
        adjustments: Array<{
          roleId: string;
          adjustedScore: number;
          reason?: string;
        }>;
      };

      // Validate adjustments not empty
      if (!body.adjustments || body.adjustments.length === 0) {
        return reply.status(400).send({
          success: false,
          adjustedRecommendations: [],
          error: 'Adjustments cannot be empty'
        });
      }

      // 从数据库获取之前生成的推荐
      const ROLES_PREFIX = "roles.";
      const roleItems = await kvList({ uid: userId }, { prefix: ROLES_PREFIX, limit: 1000 });

      // 构建调整后的推荐列表
      const adjustedRecommendations = body.adjustments.map(adjustment => {
        const roleItem = roleItems.items.find((item: any) => {
          try {
            const role = JSON.parse(item.value);
            return role.id === adjustment.roleId;
          } catch {
            return false;
          }
        });

        let role = null;
        if (roleItem) {
          try {
            role = JSON.parse(roleItem.value);
          } catch {}
        }

        return {
          roleId: adjustment.roleId,
          originalScore: role?.rating ? role.rating * 20 : 50, // 转换为 0-100
          adjustedScore: adjustment.adjustedScore,
          reason: adjustment.reason || '用户手动调整',
          role: role || { id: adjustment.roleId, name: 'Unknown Role' }
        };
      });

      // 按调整后的评分排序
      adjustedRecommendations.sort((a, b) => b.adjustedScore - a.adjustedScore);

      return {
        success: true,
        adjustedRecommendations
      };
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        adjustedRecommendations: []
      });
    }
  });
}
