/**
 * V5-AI-001: 智能角色推荐引擎
 *
 * 功能:
 * 1. 分析项目需求（技术栈、团队规模、项目类型）
 * 2. 基于角色技能进行匹配度评分
 * 3. 生成推荐列表和推荐理由
 */

import Anthropic from '@anthropic-ai/sdk';

let _anthropic: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
    if (!_anthropic) {
        if (!process.env.ANTHROPIC_API_KEY) {
            throw new Error('ANTHROPIC_API_KEY is not set — cannot use RecommendationEngine');
        }
        _anthropic = new Anthropic();
    }
    return _anthropic;
}

export interface ProjectRequirement {
  techStack: string[];        // 技术栈 ['React', 'TypeScript', 'Node.js']
  teamSize: number;           // 团队规模 1-50
  projectType: string;        // 项目类型 'webapp' | 'api' | 'mobile' | 'fullstack'
  description?: string;       // 项目描述（可选）
  timeline?: string;          // 时间线 '1周' | '1个月' | '3个月'
}

export interface Role {
  id: string;
  name: string;
  category: string;           // 角色 category (implementer, architect, qa, etc.)
  assignedSkills: string[];   // 技能标签 ['TypeScript', 'React', 'Node.js']
  description: string;
  rating?: number;            // 当前评分 0-5
  completedTasks?: number;    // 完成任务数
  successRate?: number;       // 成功率 0-1
}

export interface RoleRecommendation {
  role: Role;
  matchScore: number;         // 匹配度 0-100
  reasons: string[];          // 推荐理由
  skillMatch: {
    matched: string[];        // 匹配的技能
    missing: string[];        // 缺失的技能
    bonus: string[];          // 额外相关技能
  };
}

export class RecommendationEngine {
  /**
   * 为项目推荐最合适的角色组合
   */
  async recommendRoles(
    requirement: ProjectRequirement,
    availableRoles: Role[],
    maxRecommendations: number = 5
  ): Promise<RoleRecommendation[]> {
    // Step 1: 使用 Claude 分析项目需求
    const projectAnalysis = await this.analyzeProjectRequirement(requirement);

    // Step 2: 计算每个角色的匹配度
    const recommendations = await Promise.all(
      availableRoles.map(role => this.calculateMatchScore(projectAnalysis, role))
    );

    // Step 3: 排序并返回 top N 推荐
    return recommendations
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, maxRecommendations);
  }

  /**
   * 使用 Claude 3.5 Sonnet 分析项目需求
   */
  private async analyzeProjectRequirement(requirement: ProjectRequirement): Promise<string> {
    const prompt = `分析以下项目需求，提取关键特征：

项目类型: ${requirement.projectType}
技术栈: ${requirement.techStack.join(', ')}
团队规模: ${requirement.teamSize} 人
${requirement.description ? `项目描述: ${requirement.description}` : ''}
${requirement.timeline ? `时间线: ${requirement.timeline}` : ''}

请输出：
1. 核心技能需求（按优先级排序）
2. 角色类型需求（如前端、后端、测试等）
3. 关键挑战（如时间紧迫、技术复杂度等）
4. 推荐的角色组合（数量和类型）

以 JSON 格式输出。`;

    const message = await getAnthropicClient().messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    });

    const content = message.content[0];
    if (content.type === 'text') {
      return content.text;
    }

    throw new Error('Failed to analyze project requirement');
  }

  /**
   * 计算角色匹配度评分
   */
  private async calculateMatchScore(
    projectAnalysis: string,
    role: Role
  ): Promise<RoleRecommendation> {
    const prompt = `基于项目分析结果，计算角色匹配度：

项目分析:
${projectAnalysis}

候选角色:
- 名称: ${role.name}
- 类别: ${role.category}
- 技能: ${role.assignedSkills.join(', ')}
- 描述: ${role.description}
${role.rating ? `- 评分: ${role.rating}/5` : ''}
${role.completedTasks ? `- 完成任务: ${role.completedTasks}` : ''}
${role.successRate ? `- 成功率: ${(role.successRate * 100).toFixed(0)}%` : ''}

请输出：
{
  "matchScore": <0-100>,
  "reasons": ["理由1", "理由2", ...],
  "skillMatch": {
    "matched": ["匹配的技能"],
    "missing": ["缺失的技能"],
    "bonus": ["额外相关技能"]
  }
}`;

    const message = await getAnthropicClient().messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }]
    });

    const content = message.content[0];
    if (content.type === 'text') {
      try {
        const result = JSON.parse(content.text);
        return {
          role,
          matchScore: result.matchScore,
          reasons: result.reasons,
          skillMatch: result.skillMatch
        };
      } catch (error) {
        // 如果 JSON 解析失败，返回默认值
        return {
          role,
          matchScore: 50,
          reasons: ['角色可用'],
          skillMatch: {
            matched: [],
            missing: [],
            bonus: []
          }
        };
      }
    }

    throw new Error('Failed to calculate match score');
  }

  /**
   * 批量推荐（支持缓存优化）
   */
  async batchRecommend(
    requirements: ProjectRequirement[],
    availableRoles: Role[]
  ): Promise<Map<string, RoleRecommendation[]>> {
    const results = new Map<string, RoleRecommendation[]>();

    // 使用 Promise.all 并行处理（注意 API 速率限制）
    await Promise.all(
      requirements.map(async (req) => {
        const key = JSON.stringify(req);
        const recommendations = await this.recommendRoles(req, availableRoles);
        results.set(key, recommendations);
      })
    );

    return results;
  }
}

export default RecommendationEngine;
