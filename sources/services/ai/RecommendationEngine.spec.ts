import { describe, it, expect, vi } from 'vitest';
import { RecommendationEngine, ProjectRequirement, Role } from './RecommendationEngine';

// Mock Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => ({
  default: class MockAnthropic {
    messages = {
      create: vi.fn(async ({ model, messages }) => {
        const prompt = messages[0].content;

        // 项目需求分析响应
        if (prompt.includes('分析以下项目需求')) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                coreSkills: ['React', 'TypeScript', 'Node.js'],
                roleTypes: ['frontend', 'backend'],
                challenges: ['时间紧迫'],
                recommendedRoles: 2
              })
            }]
          };
        }

        // 角色匹配度计算响应
        if (prompt.includes('计算角色匹配度')) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                matchScore: 85,
                reasons: ['技能匹配度高', '项目类型符合'],
                skillMatch: {
                  matched: ['React', 'TypeScript'],
                  missing: ['Node.js'],
                  bonus: []
                }
              })
            }]
          };
        }

        return {
          content: [{
            type: 'text',
            text: '{}'
          }]
        };
      })
    };
  }
}));

describe('RecommendationEngine', () => {
  const engine = new RecommendationEngine();

  const mockRoles: Role[] = [
    {
      id: 'role-1',
      name: 'Frontend Developer',
      category: 'implementer',
      assignedSkills: ['React', 'TypeScript', 'CSS'],
      description: '前端开发专家'
    },
    {
      id: 'role-2',
      name: 'Backend Developer',
      category: 'implementer',
      assignedSkills: ['Node.js', 'TypeScript', 'PostgreSQL'],
      description: '后端开发专家'
    }
  ];

  const mockRequirement: ProjectRequirement = {
    techStack: ['React', 'TypeScript', 'Node.js'],
    teamSize: 3,
    projectType: 'fullstack',
    description: '全栈Web应用'
  };

  it('should recommend roles based on project requirements', async () => {
    const recommendations = await engine.recommendRoles(
      mockRequirement,
      mockRoles,
      3
    );

    expect(recommendations).toBeDefined();
    expect(recommendations.length).toBeGreaterThan(0);
    expect(recommendations.length).toBeLessThanOrEqual(3);

    const first = recommendations[0];
    expect(first.role).toBeDefined();
    expect(first.matchScore).toBeGreaterThanOrEqual(0);
    expect(first.matchScore).toBeLessThanOrEqual(100);
    expect(first.reasons).toBeInstanceOf(Array);
    expect(first.skillMatch).toBeDefined();
  });

  it('should return empty array when no roles available', async () => {
    const recommendations = await engine.recommendRoles(
      mockRequirement,
      [],
      5
    );

    expect(recommendations).toEqual([]);
  });

  it('should sort recommendations by match score', async () => {
    const recommendations = await engine.recommendRoles(
      mockRequirement,
      mockRoles,
      2
    );

    if (recommendations.length > 1) {
      expect(recommendations[0].matchScore)
        .toBeGreaterThanOrEqual(recommendations[1].matchScore);
    }
  });

  it('should include role statistics in matching', async () => {
    const rolesWithStats: Role[] = [
      {
        ...mockRoles[0],
        rating: 4.5,
        completedTasks: 42,
        successRate: 0.95
      }
    ];

    const recommendations = await engine.recommendRoles(
      mockRequirement,
      rolesWithStats,
      1
    );

    expect(recommendations[0].role.rating).toBe(4.5);
    expect(recommendations[0].role.completedTasks).toBe(42);
    expect(recommendations[0].role.successRate).toBe(0.95);
  });

  it('should handle batch recommendations', async () => {
    const requirements = [
      mockRequirement,
      { ...mockRequirement, projectType: 'api' as const }
    ];

    const results = await engine.batchRecommend(requirements, mockRoles);

    expect(results.size).toBe(2);
    results.forEach((recommendations) => {
      expect(recommendations).toBeInstanceOf(Array);
    });
  });

  it('should include skill match details', async () => {
    const recommendations = await engine.recommendRoles(
      mockRequirement,
      mockRoles,
      1
    );

    const first = recommendations[0];
    expect(first.skillMatch.matched).toBeInstanceOf(Array);
    expect(first.skillMatch.missing).toBeInstanceOf(Array);
    expect(first.skillMatch.bonus).toBeInstanceOf(Array);
  });
});
