import { describe, expect, it } from 'vitest';
import {
  identifyDeclineCauses,
  generateRecommendations,
  calculateTrend,
  type RatingPeriod,
  type DeclineCause,
} from './RatingInsightsEngine';

describe('RatingInsightsEngine', () => {
  describe('identifyDeclineCauses', () => {
    it('should identify bugs increase as decline cause', () => {
      const current: RatingPeriod = {
        bugsCount: 10,
        commits: 5,
        codeLines: 500,
        reviewComments: 5,
        qualityScore: 60,
        testCoverage: 75,
        averageRating: 3.5,
        timestamp: Date.now(),
      };

      const previous: RatingPeriod = {
        bugsCount: 2,
        commits: 5,
        codeLines: 500,
        reviewComments: 5,
        qualityScore: 80,
        testCoverage: 80,
        averageRating: 4.2,
        timestamp: Date.now() - 7 * 24 * 60 * 60 * 1000,
      };

      const causes = identifyDeclineCauses(current, previous);

      expect(causes.length).toBeGreaterThan(0);
      expect(causes[0].factor).toBe('bugs');
      expect(causes[0].impact).toBeGreaterThan(0);
      expect(causes[0].currentValue).toBe(10);
      expect(causes[0].previousValue).toBe(2);
      expect(causes[0].change).toBe(8);
    });

    it('should identify commits decrease as decline cause', () => {
      const current: RatingPeriod = {
        bugsCount: 2,
        commits: 2,
        codeLines: 500,
        reviewComments: 5,
        qualityScore: 80,
        testCoverage: 75,
        averageRating: 3.8,
        timestamp: Date.now(),
      };

      const previous: RatingPeriod = {
        bugsCount: 2,
        commits: 10,
        codeLines: 500,
        reviewComments: 5,
        qualityScore: 80,
        testCoverage: 80,
        averageRating: 4.5,
        timestamp: Date.now() - 7 * 24 * 60 * 60 * 1000,
      };

      const causes = identifyDeclineCauses(current, previous);

      const commitsCause = causes.find(c => c.factor === 'commits');
      expect(commitsCause).toBeDefined();
      expect(commitsCause!.impact).toBeGreaterThan(0);
      expect(commitsCause!.change).toBe(-8);
    });

    it('should identify code lines decrease as decline cause', () => {
      const current: RatingPeriod = {
        bugsCount: 2,
        commits: 5,
        codeLines: 200,
        reviewComments: 5,
        qualityScore: 80,
        testCoverage: 75,
        averageRating: 3.9,
        timestamp: Date.now(),
      };

      const previous: RatingPeriod = {
        bugsCount: 2,
        commits: 5,
        codeLines: 800,
        reviewComments: 5,
        qualityScore: 80,
        testCoverage: 80,
        averageRating: 4.3,
        timestamp: Date.now() - 7 * 24 * 60 * 60 * 1000,
      };

      const causes = identifyDeclineCauses(current, previous);

      const codeLinesCause = causes.find(c => c.factor === 'codeLines');
      expect(codeLinesCause).toBeDefined();
      expect(codeLinesCause!.impact).toBeGreaterThan(0);
    });

    it('should identify quality score decrease as decline cause', () => {
      const current: RatingPeriod = {
        bugsCount: 2,
        commits: 5,
        codeLines: 500,
        reviewComments: 5,
        qualityScore: 50,
        testCoverage: 60,
        averageRating: 3.2,
        timestamp: Date.now(),
      };

      const previous: RatingPeriod = {
        bugsCount: 2,
        commits: 5,
        codeLines: 500,
        reviewComments: 5,
        qualityScore: 85,
        testCoverage: 85,
        averageRating: 4.5,
        timestamp: Date.now() - 7 * 24 * 60 * 60 * 1000,
      };

      const causes = identifyDeclineCauses(current, previous);

      const qualityCause = causes.find(c => c.factor === 'quality');
      expect(qualityCause).toBeDefined();
      expect(qualityCause!.impact).toBeGreaterThan(0);
    });

    it('should return empty array when no significant decline', () => {
      const current: RatingPeriod = {
        bugsCount: 2,
        commits: 10,
        codeLines: 1000,
        reviewComments: 8,
        qualityScore: 90,
        testCoverage: 90,
        averageRating: 4.8,
        timestamp: Date.now(),
      };

      const previous: RatingPeriod = {
        bugsCount: 2,
        commits: 5,
        codeLines: 500,
        reviewComments: 5,
        qualityScore: 80,
        testCoverage: 80,
        averageRating: 4.0,
        timestamp: Date.now() - 7 * 24 * 60 * 60 * 1000,
      };

      const causes = identifyDeclineCauses(current, previous);

      expect(causes).toHaveLength(0);
    });

    it('should sort causes by impact in descending order', () => {
      const current: RatingPeriod = {
        bugsCount: 15,
        commits: 2,
        codeLines: 100,
        reviewComments: 5,
        qualityScore: 40,
        testCoverage: 50,
        averageRating: 2.5,
        timestamp: Date.now(),
      };

      const previous: RatingPeriod = {
        bugsCount: 2,
        commits: 10,
        codeLines: 800,
        reviewComments: 8,
        qualityScore: 85,
        testCoverage: 90,
        averageRating: 4.5,
        timestamp: Date.now() - 7 * 24 * 60 * 60 * 1000,
      };

      const causes = identifyDeclineCauses(current, previous);

      expect(causes.length).toBeGreaterThan(1);
      for (let i = 1; i < causes.length; i++) {
        expect(causes[i - 1].impact).toBeGreaterThanOrEqual(causes[i].impact);
      }
    });
  });

  describe('generateRecommendations', () => {
    it('should generate recommendations for bugs increase', () => {
      const causes: DeclineCause[] = [
        {
          factor: 'bugs',
          impact: 50,
          description: 'Bug 数量增加了 8 个',
          currentValue: 10,
          previousValue: 2,
          change: 8,
        },
      ];

      const recommendations = generateRecommendations(causes);

      expect(recommendations.length).toBeGreaterThan(0);
      expect(recommendations[0].priority).toBe('high');
      expect(recommendations[0].category).toBe('quality');
      expect(recommendations[0].title).toContain('Bug');
      expect(recommendations[0].actionableSteps.length).toBeGreaterThan(0);
      expect(recommendations[0].expectedImpact).toBeDefined();
    });

    it('should generate recommendations for commits decrease', () => {
      const causes: DeclineCause[] = [
        {
          factor: 'commits',
          impact: 30,
          description: '提交次数减少了 8 次',
          currentValue: 2,
          previousValue: 10,
          change: -8,
        },
      ];

      const recommendations = generateRecommendations(causes);

      expect(recommendations.length).toBeGreaterThan(0);
      const commitsRec = recommendations.find(r =>
        r.title.includes('提交') || r.title.includes('频率')
      );
      expect(commitsRec).toBeDefined();
      expect(commitsRec!.category).toBe('productivity');
    });

    it('should generate recommendations for code lines decrease', () => {
      const causes: DeclineCause[] = [
        {
          factor: 'codeLines',
          impact: 20,
          description: '代码量减少了 600 行',
          currentValue: 200,
          previousValue: 800,
          change: -600,
        },
      ];

      const recommendations = generateRecommendations(causes);

      expect(recommendations.length).toBeGreaterThan(0);
      const codeRec = recommendations.find(r =>
        r.title.includes('代码') || r.title.includes('产出')
      );
      expect(codeRec).toBeDefined();
    });

    it('should generate recommendations for quality score decrease', () => {
      const causes: DeclineCause[] = [
        {
          factor: 'quality',
          impact: 40,
          description: '质量分数下降了 35 分',
          currentValue: 50,
          previousValue: 85,
          change: -35,
        },
      ];

      const recommendations = generateRecommendations(causes);

      expect(recommendations.length).toBeGreaterThan(0);
      const qualityRec = recommendations.find(r =>
        r.title.includes('质量') || r.title.includes('测试')
      );
      expect(qualityRec).toBeDefined();
    });

    it('should include actionable steps in recommendations', () => {
      const causes: DeclineCause[] = [
        {
          factor: 'bugs',
          impact: 50,
          description: 'Bug 数量增加',
          currentValue: 10,
          previousValue: 2,
          change: 8,
        },
      ];

      const recommendations = generateRecommendations(causes);

      for (const rec of recommendations) {
        expect(rec.actionableSteps.length).toBeGreaterThan(0);
        expect(rec.actionableSteps[0].length).toBeGreaterThan(10);  // Meaningful steps
      }
    });

    it('should include learning resources when available', () => {
      const causes: DeclineCause[] = [
        {
          factor: 'bugs',
          impact: 50,
          description: 'Bug 数量增加',
          currentValue: 10,
          previousValue: 2,
          change: 8,
        },
      ];

      const recommendations = generateRecommendations(causes);

      const withResources = recommendations.find(r => r.resources && r.resources.length > 0);
      expect(withResources).toBeDefined();
      expect(withResources!.resources![0]).toHaveProperty('title');
      expect(withResources!.resources![0]).toHaveProperty('type');
    });

    it('should return empty array when no causes', () => {
      const causes: DeclineCause[] = [];
      const recommendations = generateRecommendations(causes);
      expect(recommendations).toHaveLength(0);
    });
  });

  describe('calculateTrend', () => {
    it('should identify improving trend', () => {
      const dataPoints = [
        { rating: 3.5, timestamp: Date.now() - 6 * 24 * 60 * 60 * 1000 },
        { rating: 3.7, timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000 },
        { rating: 4.0, timestamp: Date.now() - 4 * 24 * 60 * 60 * 1000 },
        { rating: 4.2, timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000 },
        { rating: 4.5, timestamp: Date.now() - 2 * 24 * 60 * 60 * 1000 },
        { rating: 4.8, timestamp: Date.now() - 1 * 24 * 60 * 60 * 1000 },
      ];

      const trend = calculateTrend(dataPoints);

      expect(trend.direction).toBe('improving');
      expect(trend.slope).toBeGreaterThan(0);
    });

    it('should identify declining trend', () => {
      const dataPoints = [
        { rating: 4.8, timestamp: Date.now() - 6 * 24 * 60 * 60 * 1000 },
        { rating: 4.5, timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000 },
        { rating: 4.2, timestamp: Date.now() - 4 * 24 * 60 * 60 * 1000 },
        { rating: 3.9, timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000 },
        { rating: 3.6, timestamp: Date.now() - 2 * 24 * 60 * 60 * 1000 },
        { rating: 3.3, timestamp: Date.now() - 1 * 24 * 60 * 60 * 1000 },
      ];

      const trend = calculateTrend(dataPoints);

      expect(trend.direction).toBe('declining');
      expect(trend.slope).toBeLessThan(0);
    });

    it('should identify stable trend', () => {
      const dataPoints = [
        { rating: 4.0, timestamp: Date.now() - 6 * 24 * 60 * 60 * 1000 },
        { rating: 4.1, timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000 },
        { rating: 3.9, timestamp: Date.now() - 4 * 24 * 60 * 60 * 1000 },
        { rating: 4.0, timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000 },
        { rating: 4.1, timestamp: Date.now() - 2 * 24 * 60 * 60 * 1000 },
        { rating: 4.0, timestamp: Date.now() - 1 * 24 * 60 * 60 * 1000 },
      ];

      const trend = calculateTrend(dataPoints);

      expect(trend.direction).toBe('stable');
      expect(Math.abs(trend.slope)).toBeLessThan(0.1);
    });

    it('should calculate volatility', () => {
      const lowVolatilityData = [
        { rating: 4.0, timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000 },
        { rating: 4.1, timestamp: Date.now() - 4 * 24 * 60 * 60 * 1000 },
        { rating: 4.0, timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000 },
        { rating: 4.1, timestamp: Date.now() - 2 * 24 * 60 * 60 * 1000 },
        { rating: 4.0, timestamp: Date.now() - 1 * 24 * 60 * 60 * 1000 },
      ];

      const highVolatilityData = [
        { rating: 2.0, timestamp: Date.now() - 5 * 24 * 60 * 60 * 1000 },
        { rating: 5.0, timestamp: Date.now() - 4 * 24 * 60 * 60 * 1000 },
        { rating: 1.5, timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000 },
        { rating: 4.8, timestamp: Date.now() - 2 * 24 * 60 * 60 * 1000 },
        { rating: 3.0, timestamp: Date.now() - 1 * 24 * 60 * 60 * 1000 },
      ];

      const lowTrend = calculateTrend(lowVolatilityData);
      const highTrend = calculateTrend(highVolatilityData);

      expect(lowTrend.volatility).toBeLessThan(highTrend.volatility);
    });

    it('should handle insufficient data points', () => {
      const dataPoints = [
        { rating: 4.0, timestamp: Date.now() },
      ];

      const trend = calculateTrend(dataPoints);

      expect(trend.direction).toBe('stable');
      expect(trend.volatility).toBe(0);
    });
  });
});
