/**
 * V5-AI-002: Personalized Improvement Suggestions
 *
 * Analyzes rating data and generates personalized improvement suggestions
 * Uses Claude 3.5 Sonnet for high-quality, actionable recommendations
 */

import Anthropic from '@anthropic-ai/sdk';

export interface RatingData {
  overall: number;              // 总评分 0-5
  dimensions: {
    codeQuality: number;        // 代码质量
    collaboration: number;      // 协作沟通
    efficiency: number;         // 交付效率
    innovation: number;         // 创新能力
    problemSolving: number;     // 问题解决
  };
  trends: {
    direction: 'improving' | 'stable' | 'declining';
    changeRate: number;         // 变化率百分比
  };
  historicalData: Array<{
    date: string;
    score: number;
    taskId: string;
  }>;
}

export interface ImprovementSuggestion {
  category: string;             // 改进类别
  priority: 'high' | 'medium' | 'low';
  title: string;                // 建议标题
  description: string;          // 详细描述
  actionableSteps: string[];    // 可执行步骤
  resources: LearningResource[]; // 学习资源
  expectedImpact: string;       // 预期影响
  timeline: string;             // 预计时间
}

export interface LearningResource {
  type: 'article' | 'video' | 'course' | 'book' | 'tool';
  title: string;
  url: string;
  description: string;
  estimatedTime: string;
}

export interface UserProfile {
  roleId: string;
  roleName: string;
  totalTasks: number;
  averageRating: number;
  strengths: string[];
  weaknesses: string[];
}

export class ImprovementSuggestionEngine {
  private anthropic: Anthropic | null = null;

  constructor() {
    if (process.env.ANTHROPIC_API_KEY) {
      this.anthropic = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
      });
    }
  }

  private getClient(): Anthropic {
    if (!this.anthropic) {
      throw new Error('ANTHROPIC_API_KEY is not set — ImprovementSuggestionEngine unavailable');
    }
    return this.anthropic;
  }

  /**
   * Analyze rating weaknesses and identify improvement areas
   */
  analyzeWeaknesses(ratingData: RatingData): string[] {
    const weaknesses: string[] = [];
    const { dimensions, trends } = ratingData;

    // Find dimensions below threshold
    const threshold = 3.5;
    if (dimensions.codeQuality < threshold) {
      weaknesses.push('代码质量需要提升');
    }
    if (dimensions.collaboration < threshold) {
      weaknesses.push('协作沟通能力有待加强');
    }
    if (dimensions.efficiency < threshold) {
      weaknesses.push('交付效率需要优化');
    }
    if (dimensions.innovation < threshold) {
      weaknesses.push('创新能力可以进一步发展');
    }
    if (dimensions.problemSolving < threshold) {
      weaknesses.push('问题解决能力需要提高');
    }

    // Check for declining trend
    if (trends.direction === 'declining') {
      weaknesses.push('评分呈下降趋势，需要关注');
    }

    return weaknesses;
  }

  /**
   * Generate personalized improvement suggestions using Claude 3.5 Sonnet
   */
  async generateSuggestions(
    userProfile: UserProfile,
    ratingData: RatingData,
    options: {
      maxSuggestions?: number;
      focusAreas?: string[];
    } = {}
  ): Promise<ImprovementSuggestion[]> {
    const { maxSuggestions = 5, focusAreas } = options;

    // Identify weaknesses
    const weaknesses = this.analyzeWeaknesses(ratingData);

    if (weaknesses.length === 0) {
      return []; // No improvements needed
    }

    // Build prompt for Claude
    const prompt = this.buildPrompt(userProfile, ratingData, weaknesses, focusAreas);

    try {
      const message = await this.getClient().messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 4000,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      // Parse Claude's response
      const content = message.content[0];
      if (content.type === 'text') {
        return this.parseSuggestions(content.text, maxSuggestions);
      }

      return [];
    } catch (error) {
      console.error('Failed to generate suggestions:', error);
      throw new Error('Failed to generate improvement suggestions');
    }
  }

  /**
   * Build prompt for Claude API
   */
  private buildPrompt(
    profile: UserProfile,
    ratingData: RatingData,
    weaknesses: string[],
    focusAreas?: string[]
  ): string {
    return `You are an expert career development coach for software developers. Generate personalized improvement suggestions based on the following data:

**User Profile**:
- Role: ${profile.roleName}
- Total Tasks Completed: ${profile.totalTasks}
- Average Rating: ${profile.averageRating.toFixed(2)}/5.0
- Strengths: ${profile.strengths.join(', ')}
- Weaknesses: ${profile.weaknesses.join(', ')}

**Rating Data**:
- Overall Score: ${ratingData.overall.toFixed(2)}/5.0
- Code Quality: ${ratingData.dimensions.codeQuality.toFixed(1)}/5.0
- Collaboration: ${ratingData.dimensions.collaboration.toFixed(1)}/5.0
- Efficiency: ${ratingData.dimensions.efficiency.toFixed(1)}/5.0
- Innovation: ${ratingData.dimensions.innovation.toFixed(1)}/5.0
- Problem Solving: ${ratingData.dimensions.problemSolving.toFixed(1)}/5.0
- Trend: ${ratingData.trends.direction} (${ratingData.trends.changeRate > 0 ? '+' : ''}${ratingData.trends.changeRate.toFixed(1)}%)

**Identified Weaknesses**:
${weaknesses.map(w => `- ${w}`).join('\n')}

${focusAreas ? `**Focus Areas**: ${focusAreas.join(', ')}` : ''}

Generate ${focusAreas ? focusAreas.length : 5} highly actionable, specific improvement suggestions in the following JSON format:

\`\`\`json
[
  {
    "category": "Code Quality | Collaboration | Efficiency | Innovation | Problem Solving",
    "priority": "high | medium | low",
    "title": "Specific improvement action",
    "description": "Detailed explanation of what to do and why",
    "actionableSteps": [
      "Step 1: ...",
      "Step 2: ...",
      "Step 3: ..."
    ],
    "resources": [
      {
        "type": "article | video | course | book | tool",
        "title": "Resource title",
        "url": "https://...",
        "description": "What this resource covers",
        "estimatedTime": "X hours/days"
      }
    ],
    "expectedImpact": "How this will improve performance",
    "timeline": "X weeks to see improvement"
  }
]
\`\`\`

**Requirements**:
1. Suggestions must be specific to the user's role and weaknesses
2. Each suggestion should have 3-5 actionable steps
3. Include 2-3 high-quality learning resources per suggestion
4. Be realistic about timelines (1-4 weeks)
5. Prioritize suggestions that address the biggest gaps
6. Focus on actionable, practical improvements

Return ONLY the JSON array, no additional text.`;
  }

  /**
   * Parse Claude's response into structured suggestions
   */
  private parseSuggestions(responseText: string, maxSuggestions: number): ImprovementSuggestion[] {
    try {
      // Extract JSON from response
      const jsonMatch = responseText.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (!jsonMatch) {
        console.error('No JSON array found in response');
        return [];
      }

      const suggestions = JSON.parse(jsonMatch[0]) as ImprovementSuggestion[];

      // Validate and limit suggestions
      return suggestions.slice(0, maxSuggestions).map(suggestion => ({
        ...suggestion,
        priority: suggestion.priority || 'medium',
        actionableSteps: suggestion.actionableSteps || [],
        resources: suggestion.resources || [],
      }));
    } catch (error) {
      console.error('Failed to parse suggestions:', error);
      return [];
    }
  }

  /**
   * Generate suggestions for a batch of users
   */
  async batchGenerateSuggestions(
    users: Array<{
      profile: UserProfile;
      ratingData: RatingData;
    }>,
    options?: {
      maxSuggestions?: number;
      focusAreas?: string[];
    }
  ): Promise<Map<string, ImprovementSuggestion[]>> {
    const results = new Map<string, ImprovementSuggestion[]>();

    for (const user of users) {
      const suggestions = await this.generateSuggestions(
        user.profile,
        user.ratingData,
        options
      );
      results.set(user.profile.roleId, suggestions);
    }

    return results;
  }

  /**
   * Get default learning resources database
   */
  getDefaultResources(): LearningResource[] {
    return [
      // Code Quality
      {
        type: 'book',
        title: 'Clean Code',
        url: 'https://www.oreilly.com/library/view/clean-code-a/9780136083238/',
        description: 'Robert C. Martin\'s guide to writing readable, maintainable code',
        estimatedTime: '2-3 weeks',
      },
      {
        type: 'course',
        title: 'Refactoring Guru',
        url: 'https://refactoring.guru/',
        description: 'Online resource for code refactoring patterns and techniques',
        estimatedTime: '1-2 weeks',
      },

      // Collaboration
      {
        type: 'article',
        title: 'GitHub Pull Request Best Practices',
        url: 'https://github.blog/2015-01-21-how-to-write-the-perfect-pull-request/',
        description: 'Best practices for code review and collaboration',
        estimatedTime: '1 hour',
      },

      // Efficiency
      {
        type: 'tool',
        title: 'Pomodoro Technique',
        url: 'https://francescocirillo.com/products/the-pomodoro-technique',
        description: 'Time management method for improved focus and productivity',
        estimatedTime: '1 week to adopt',
      },

      // Innovation
      {
        type: 'video',
        title: 'Design Patterns in Practice',
        url: 'https://www.youtube.com/watch?v=v9ejT8FO-7I',
        description: 'Practical applications of software design patterns',
        estimatedTime: '2 hours',
      },

      // Problem Solving
      {
        type: 'course',
        title: 'Algorithm Design and Analysis',
        url: 'https://www.coursera.org/learn/algorithms',
        description: 'Stanford course on algorithmic problem solving',
        estimatedTime: '4-6 weeks',
      },
    ];
  }
}
