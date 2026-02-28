import { log } from '@/utils/log';

/**
 * Rating Insights Engine - V5-INSIGHTS-001
 *
 * Analyzes rating trends, identifies decline causes, and generates improvement recommendations.
 */

// ============================================================================
// Types
// ============================================================================

export interface RatingPeriod {
  timestamp: number;
  averageRating: number;
  codeLines: number;
  commits: number;
  bugsCount: number;
  reviewComments: number;
  testCoverage?: number;
  qualityScore: number;
}

export interface DeclineCause {
  factor: 'bugs' | 'commits' | 'codeLines' | 'quality' | 'reviewComments' | 'testCoverage';
  impact: number;  // 0-100
  description: string;
  currentValue: number;
  previousValue: number;
  change: number;
}

export interface Recommendation {
  priority: 'high' | 'medium' | 'low';
  category: 'quality' | 'productivity' | 'collaboration' | 'technical';
  title: string;
  description: string;
  actionableSteps: string[];
  expectedImpact: string;
  resources?: Array<{
    title: string;
    url?: string;
    type: 'documentation' | 'course' | 'tool' | 'best-practice';
  }>;
}

export interface TrendResult {
  direction: 'improving' | 'declining' | 'stable';
  slope: number;
  volatility: number;
}

// ============================================================================
// Constants
// ============================================================================

const IMPACT_THRESHOLDS = {
  bugs: {
    impactPerUnit: 10,
    maxImpact: 50,
  },
  commits: {
    impactPerUnit: 5,
    maxImpact: 30,
  },
  codeLines: {
    impactPerHundred: 5,
    maxImpact: 20,
    threshold: 100,  // Minimum change to consider
  },
  quality: {
    impactPerUnit: 1,
    maxImpact: 40,
    threshold: 10,  // Minimum change to consider
  },
};

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Identify factors causing rating decline
 *
 * @param current - Current period metrics
 * @param previous - Previous period metrics
 * @returns Array of decline causes sorted by impact
 */
export function identifyDeclineCauses(
  current: RatingPeriod,
  previous: RatingPeriod
): DeclineCause[] {
  const causes: DeclineCause[] = [];

  // 1. Check bugs increase
  const bugsChange = current.bugsCount - previous.bugsCount;
  if (bugsChange > 0) {
    const impact = Math.min(
      bugsChange * IMPACT_THRESHOLDS.bugs.impactPerUnit,
      IMPACT_THRESHOLDS.bugs.maxImpact
    );
    causes.push({
      factor: 'bugs',
      impact,
      description: `Bug 数量增加了 ${bugsChange} 个`,
      currentValue: current.bugsCount,
      previousValue: previous.bugsCount,
      change: bugsChange,
    });
  }

  // 2. Check commits decrease
  const commitsChange = current.commits - previous.commits;
  if (commitsChange < 0) {
    const impact = Math.min(
      Math.abs(commitsChange) * IMPACT_THRESHOLDS.commits.impactPerUnit,
      IMPACT_THRESHOLDS.commits.maxImpact
    );
    causes.push({
      factor: 'commits',
      impact,
      description: `提交次数减少了 ${Math.abs(commitsChange)} 次`,
      currentValue: current.commits,
      previousValue: previous.commits,
      change: commitsChange,
    });
  }

  // 3. Check code lines decrease
  const codeLinesChange = current.codeLines - previous.codeLines;
  if (codeLinesChange < -IMPACT_THRESHOLDS.codeLines.threshold) {
    const impact = Math.min(
      Math.abs(codeLinesChange) / 100 * IMPACT_THRESHOLDS.codeLines.impactPerHundred,
      IMPACT_THRESHOLDS.codeLines.maxImpact
    );
    causes.push({
      factor: 'codeLines',
      impact,
      description: `代码量减少了 ${Math.abs(codeLinesChange)} 行`,
      currentValue: current.codeLines,
      previousValue: previous.codeLines,
      change: codeLinesChange,
    });
  }

  // 4. Check quality score decrease
  const qualityChange = current.qualityScore - previous.qualityScore;
  if (qualityChange < -IMPACT_THRESHOLDS.quality.threshold) {
    const impact = Math.min(
      Math.abs(qualityChange) * IMPACT_THRESHOLDS.quality.impactPerUnit,
      IMPACT_THRESHOLDS.quality.maxImpact
    );
    causes.push({
      factor: 'quality',
      impact,
      description: `质量分数下降了 ${Math.abs(qualityChange)} 分`,
      currentValue: current.qualityScore,
      previousValue: previous.qualityScore,
      change: qualityChange,
    });
  }

  // 5. Check test coverage decrease (if available)
  if (current.testCoverage !== undefined && previous.testCoverage !== undefined) {
    const coverageChange = current.testCoverage - previous.testCoverage;
    if (coverageChange < -10) {  // Significant decrease
      causes.push({
        factor: 'testCoverage',
        impact: Math.min(Math.abs(coverageChange) * 0.5, 20),
        description: `测试覆盖率下降了 ${Math.abs(coverageChange)}%`,
        currentValue: current.testCoverage,
        previousValue: previous.testCoverage,
        change: coverageChange,
      });
    }
  }

  // Sort by impact in descending order
  return causes.sort((a, b) => b.impact - a.impact);
}

/**
 * Generate improvement recommendations based on decline causes
 *
 * @param causes - Array of decline causes
 * @returns Array of recommendations
 */
export function generateRecommendations(causes: DeclineCause[]): Recommendation[] {
  const recommendations: Recommendation[] = [];

  for (const cause of causes) {
    switch (cause.factor) {
      case 'bugs':
        recommendations.push({
          priority: 'high',
          category: 'quality',
          title: '减少 Bug 数量',
          description: '当前 Bug 数量上升，建议加强代码审查和测试',
          actionableSteps: [
            '编写更全面的单元测试，确保覆盖率 > 80%',
            '使用静态代码分析工具 (ESLint, TypeScript strict mode)',
            '增加代码审查频率，至少每个 PR 需要一次审查',
            '使用 TDD 开发模式，先写测试再写代码',
            '建立 Bug 复盘机制，分析根本原因',
          ],
          expectedImpact: '预计可减少 40-60% 的 Bug 数量',
          resources: [
            {
              title: 'TDD 最佳实践指南',
              type: 'best-practice',
            },
            {
              title: '代码审查清单',
              type: 'documentation',
            },
            {
              title: 'ESLint 规则配置',
              type: 'tool',
            },
          ],
        });
        break;

      case 'commits':
        recommendations.push({
          priority: 'medium',
          category: 'productivity',
          title: '提高提交频率',
          description: '提交次数减少，可能表示开发效率下降或遇到阻碍',
          actionableSteps: [
            '拆分大任务为小任务，每天至少提交一次',
            '使用 Git 分支管理功能开发',
            '遇到阻碍及时沟通，寻求帮助',
            '设定每日提交目标，跟踪进度',
            '使用番茄工作法提高专注度',
          ],
          expectedImpact: '提高开发可见性和协作效率',
        });
        break;

      case 'codeLines':
        recommendations.push({
          priority: 'medium',
          category: 'productivity',
          title: '提升代码产出',
          description: '代码量显著减少，需要分析原因并提升产出',
          actionableSteps: [
            '评估任务难度，合理分配时间',
            '减少会议干扰，增加专注编码时间',
            '使用代码生成工具和脚手架提高效率',
            '复用现有组件和模块，避免重复造轮子',
            '定期与团队同步，确保方向正确',
          ],
          expectedImpact: '提升代码产出 50-100%',
        });
        break;

      case 'quality':
        recommendations.push({
          priority: 'high',
          category: 'quality',
          title: '提升代码质量',
          description: '质量分数下降，需要关注代码可维护性和测试',
          actionableSteps: [
            '增加单元测试和集成测试覆盖率',
            '进行代码重构，消除技术债务',
            '遵循编码规范，使用 Linter 检查',
            '增加代码审查参与度',
            '学习高质量代码示例，提升编码水平',
          ],
          expectedImpact: '提升质量分数 20-40 分',
          resources: [
            {
              title: 'Clean Code 书籍',
              type: 'documentation',
            },
            {
              title: '重构技巧',
              type: 'best-practice',
            },
          ],
        });
        break;

      case 'testCoverage':
        recommendations.push({
          priority: 'high',
          category: 'quality',
          title: '提升测试覆盖率',
          description: '测试覆盖率下降，增加了代码风险',
          actionableSteps: [
            '为新代码强制要求单元测试',
            '补充缺失的测试用例',
            '使用测试覆盖率工具识别未覆盖代码',
            '建立测试覆盖率门禁 (≥80%)',
            '学习测试金字塔理论，优化测试结构',
          ],
          expectedImpact: '提升测试覆盖率至 80%+',
          resources: [
            {
              title: '测试金字塔理论',
              type: 'documentation',
            },
          ],
        });
        break;

      case 'reviewComments':
        recommendations.push({
          priority: 'medium',
          category: 'collaboration',
          title: '增加代码审查参与',
          description: '代码审查参与度降低，影响团队协作质量',
          actionableSteps: [
            '主动参与他人代码审查',
            '及时响应代码审查请求',
            '提供建设性的审查意见',
            '学习优秀代码的写法',
          ],
          expectedImpact: '提升团队协作和代码质量',
        });
        break;
    }
  }

  return recommendations;
}

/**
 * Calculate rating trend from historical data points
 *
 * @param dataPoints - Array of rating data points with timestamps
 * @returns Trend analysis result
 */
export function calculateTrend(
  dataPoints: Array<{ rating: number; timestamp: number }>
): TrendResult {
  if (dataPoints.length < 2) {
    return {
      direction: 'stable',
      slope: 0,
      volatility: 0,
    };
  }

  // Sort by timestamp
  const sorted = [...dataPoints].sort((a, b) => a.timestamp - b.timestamp);

  // Calculate linear regression slope
  const n = sorted.length;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (let i = 0; i < n; i++) {
    const x = i;  // Use index as x
    const y = sorted[i].rating;
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

  // Calculate volatility (standard deviation)
  const mean = sumY / n;
  let varianceSum = 0;
  for (const point of sorted) {
    varianceSum += Math.pow(point.rating - mean, 2);
  }
  const volatility = Math.sqrt(varianceSum / n);

  // Determine direction based on slope
  let direction: 'improving' | 'declining' | 'stable';
  if (Math.abs(slope) < 0.1) {
    direction = 'stable';
  } else if (slope > 0) {
    direction = 'improving';
  } else {
    direction = 'declining';
  }

  return {
    direction,
    slope,
    volatility,
  };
}

// ============================================================================
// Exported Service Functions (to be implemented)
// ============================================================================

/**
 * Generate a complete rating insights report
 *
 * @param roleId - Role ID to analyze
 * @param teamId - Optional team ID for comparison
 * @param reportType - Report type (weekly or monthly)
 * @returns Complete insights report
 */
export async function generateRatingInsightsReport(
  roleId: string,
  teamId: string | undefined,
  reportType: 'weekly' | 'monthly'
): Promise<{
  success: boolean;
  report?: any;
  error?: string;
}> {
  // TODO: Implement data fetching and report generation
  log(
    { module: 'rating-insights' },
    `Generating ${reportType} report for role ${roleId}`
  );

  return {
    success: true,
    report: {
      reportId: `report-${roleId}-${Date.now()}`,
      roleId,
      teamId,
      reportType,
      generatedAt: Date.now(),
    },
  };
}
