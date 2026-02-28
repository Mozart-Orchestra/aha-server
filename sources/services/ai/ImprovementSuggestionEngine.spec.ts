import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ImprovementSuggestionEngine, RatingData, UserProfile } from './ImprovementSuggestionEngine';

// Mock Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: vi.fn(),
      },
    })),
  };
});

describe('ImprovementSuggestionEngine', () => {
  let engine: ImprovementSuggestionEngine;
  let mockAnthropic: any;

  beforeEach(() => {
    engine = new ImprovementSuggestionEngine();
    mockAnthropic = (engine as any).anthropic;
    vi.clearAllMocks();
  });

  describe('analyzeWeaknesses', () => {
    it('should identify dimensions below threshold', () => {
      const ratingData: RatingData = {
        overall: 3.2,
        dimensions: {
          codeQuality: 2.5,  // Below threshold
          collaboration: 4.0,
          efficiency: 3.0,   // Below threshold
          innovation: 3.8,
          problemSolving: 2.8, // Below threshold
        },
        trends: {
          direction: 'stable',
          changeRate: 0,
        },
        historicalData: [],
      };

      const weaknesses = engine.analyzeWeaknesses(ratingData);

      expect(weaknesses).toContain('代码质量需要提升');
      expect(weaknesses).toContain('交付效率需要优化');
      expect(weaknesses).toContain('问题解决能力需要提高');
      expect(weaknesses).not.toContain('协作沟通能力有待加强');
    });

    it('should detect declining trend', () => {
      const ratingData: RatingData = {
        overall: 3.5,
        dimensions: {
          codeQuality: 4.0,
          collaboration: 4.0,
          efficiency: 4.0,
          innovation: 4.0,
          problemSolving: 4.0,
        },
        trends: {
          direction: 'declining',
          changeRate: -15,
        },
        historicalData: [],
      };

      const weaknesses = engine.analyzeWeaknesses(ratingData);

      expect(weaknesses).toContain('评分呈下降趋势，需要关注');
    });

    it('should return empty array for good performance', () => {
      const ratingData: RatingData = {
        overall: 4.5,
        dimensions: {
          codeQuality: 4.5,
          collaboration: 4.6,
          efficiency: 4.4,
          innovation: 4.7,
          problemSolving: 4.5,
        },
        trends: {
          direction: 'improving',
          changeRate: 10,
        },
        historicalData: [],
      };

      const weaknesses = engine.analyzeWeaknesses(ratingData);

      expect(weaknesses.length).toBe(0);
    });
  });

  describe('generateSuggestions', () => {
    const mockProfile: UserProfile = {
      roleId: 'frontend-dev',
      roleName: 'Frontend Developer',
      totalTasks: 50,
      averageRating: 3.2,
      strengths: ['快速学习', '团队协作'],
      weaknesses: ['代码质量', '测试覆盖率'],
    };

    const mockRatingData: RatingData = {
      overall: 3.2,
      dimensions: {
        codeQuality: 2.5,
        collaboration: 4.0,
        efficiency: 3.5,
        innovation: 3.0,
        problemSolving: 3.2,
      },
      trends: {
        direction: 'stable',
        changeRate: 0,
      },
      historicalData: [],
    };

    it('should generate suggestions using Claude API', async () => {
      const mockSuggestions = [
        {
          category: 'Code Quality',
          priority: 'high',
          title: 'Improve Code Testing',
          description: 'Focus on writing unit tests',
          actionableSteps: ['Learn testing frameworks', 'Write tests for new features'],
          resources: [],
          expectedImpact: 'Higher code reliability',
          timeline: '2 weeks',
        },
      ];

      mockAnthropic.messages.create.mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockSuggestions),
          },
        ],
      });

      const suggestions = await engine.generateSuggestions(mockProfile, mockRatingData);

      expect(suggestions.length).toBe(1);
      expect(suggestions[0].category).toBe('Code Quality');
      expect(suggestions[0].priority).toBe('high');
      expect(mockAnthropic.messages.create).toHaveBeenCalled();
    });

    it('should return empty array when no weaknesses', async () => {
      const goodRatingData: RatingData = {
        ...mockRatingData,
        overall: 4.5,
        dimensions: {
          codeQuality: 4.5,
          collaboration: 4.6,
          efficiency: 4.4,
          innovation: 4.7,
          problemSolving: 4.5,
        },
      };

      const suggestions = await engine.generateSuggestions(mockProfile, goodRatingData);

      expect(suggestions.length).toBe(0);
      expect(mockAnthropic.messages.create).not.toHaveBeenCalled();
    });

    it('should limit suggestions to maxSuggestions', async () => {
      const mockSuggestions = Array(10)
        .fill(null)
        .map((_, i) => ({
          category: 'Code Quality',
          priority: 'medium',
          title: `Suggestion ${i + 1}`,
          description: 'Description',
          actionableSteps: [],
          resources: [],
          expectedImpact: 'Impact',
          timeline: '1 week',
        }));

      mockAnthropic.messages.create.mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: JSON.stringify(mockSuggestions),
          },
        ],
      });

      const result = await engine.generateSuggestions(mockProfile, mockRatingData, {
        maxSuggestions: 3,
      });

      expect(result.length).toBe(3);
    });

    it('should handle API errors gracefully', async () => {
      mockAnthropic.messages.create.mockRejectedValueOnce(new Error('API Error'));

      await expect(
        engine.generateSuggestions(mockProfile, mockRatingData)
      ).rejects.toThrow('Failed to generate improvement suggestions');
    });

    it('should parse JSON from Claude response', async () => {
      const mockSuggestions = [
        {
          category: 'Code Quality',
          priority: 'high',
          title: 'Test',
          description: 'Test description',
          actionableSteps: ['Step 1'],
          resources: [],
          expectedImpact: 'Impact',
          timeline: '1 week',
        },
      ];

      const responseText = `Here are the suggestions:\n\`\`\`json\n${JSON.stringify(
        mockSuggestions
      )}\n\`\`\`\n\nLet me know if you need more details.`;

      mockAnthropic.messages.create.mockResolvedValueOnce({
        content: [
          {
            type: 'text',
            text: responseText,
          },
        ],
      });

      const suggestions = await engine.generateSuggestions(mockProfile, mockRatingData);

      expect(suggestions.length).toBe(1);
      expect(suggestions[0].title).toBe('Test');
    });
  });

  describe('batchGenerateSuggestions', () => {
    it('should generate suggestions for multiple users', async () => {
      const users = [
        {
          profile: {
            roleId: 'role-1',
            roleName: 'Frontend Developer',
            totalTasks: 50,
            averageRating: 3.2,
            strengths: [],
            weaknesses: ['Code Quality'],
          },
          ratingData: {
            overall: 3.2,
            dimensions: {
              codeQuality: 2.5,
              collaboration: 4.0,
              efficiency: 4.0,
              innovation: 4.0,
              problemSolving: 4.0,
            },
            trends: { direction: 'stable' as const, changeRate: 0 },
            historicalData: [],
          },
        },
        {
          profile: {
            roleId: 'role-2',
            roleName: 'Backend Developer',
            totalTasks: 40,
            averageRating: 3.5,
            strengths: [],
            weaknesses: ['Efficiency'],
          },
          ratingData: {
            overall: 3.5,
            dimensions: {
              codeQuality: 4.0,
              collaboration: 4.0,
              efficiency: 2.8,
              innovation: 4.0,
              problemSolving: 4.0,
            },
            trends: { direction: 'stable' as const, changeRate: 0 },
            historicalData: [],
          },
        },
      ];

      mockAnthropic.messages.create
        .mockResolvedValueOnce({
          content: [
            {
              type: 'text',
              text: JSON.stringify([
                {
                  category: 'Code Quality',
                  priority: 'high',
                  title: 'Suggestion 1',
                  description: 'Description',
                  actionableSteps: [],
                  resources: [],
                  expectedImpact: 'Impact',
                  timeline: '1 week',
                },
              ]),
            },
          ],
        })
        .mockResolvedValueOnce({
          content: [
            {
              type: 'text',
              text: JSON.stringify([
                {
                  category: 'Efficiency',
                  priority: 'medium',
                  title: 'Suggestion 2',
                  description: 'Description',
                  actionableSteps: [],
                  resources: [],
                  expectedImpact: 'Impact',
                  timeline: '1 week',
                },
              ]),
            },
          ],
        });

      const results = await engine.batchGenerateSuggestions(users as any);

      expect(results.size).toBe(2);
      expect(results.has('role-1')).toBe(true);
      expect(results.has('role-2')).toBe(true);
      expect(mockAnthropic.messages.create).toHaveBeenCalledTimes(2);
    });
  });

  describe('getDefaultResources', () => {
    it('should return default learning resources', () => {
      const resources = engine.getDefaultResources();

      expect(resources.length).toBeGreaterThan(0);
      expect(resources[0]).toHaveProperty('type');
      expect(resources[0]).toHaveProperty('title');
      expect(resources[0]).toHaveProperty('url');
      expect(resources[0]).toHaveProperty('description');
      expect(resources[0]).toHaveProperty('estimatedTime');
    });

    it('should include resources for different categories', () => {
      const resources = engine.getDefaultResources();

      const types = new Set(resources.map(r => r.type));
      expect(types.size).toBeGreaterThan(1); // Multiple resource types
    });
  });

  describe('buildPrompt', () => {
    it('should include all relevant information in prompt', () => {
      const profile: UserProfile = {
        roleId: 'test-role',
        roleName: 'Test Role',
        totalTasks: 100,
        averageRating: 3.5,
        strengths: ['Strength 1'],
        weaknesses: ['Weakness 1'],
      };

      const ratingData: RatingData = {
        overall: 3.5,
        dimensions: {
          codeQuality: 3.0,
          collaboration: 4.0,
          efficiency: 3.5,
          innovation: 4.0,
          problemSolving: 3.5,
        },
        trends: { direction: 'improving', changeRate: 5 },
        historicalData: [],
      };

      const weaknesses = ['Code quality needs improvement'];
      const prompt = (engine as any).buildPrompt(profile, ratingData, weaknesses);

      expect(prompt).toContain('Test Role');
      expect(prompt).toContain('3.5/5.0');
      expect(prompt).toContain('Strength 1');
      expect(prompt).toContain('Weakness 1');
      expect(prompt).toContain('Code quality needs improvement');
    });
  });
});
