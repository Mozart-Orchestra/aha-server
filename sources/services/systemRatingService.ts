import { db } from "@/storage/db";
import { log } from "@/utils/log";

/**
 * System Auto-Rating Service
 *
 * Analyzes task completion metrics and generates system ratings.
 * Used by RATING-SYSTEM-001 in the PRD.
 */

export interface TaskMetrics {
    codeLines: number;
    commits: number;
    bugsCount: number;
    filesChanged: number;
    reviewComments: number;
    testCoverage?: number;
}

export interface SystemRatingResult {
    rating: number;
    codeScore: number;
    qualityScore: number;
    systemScore: number;
    breakdown: {
        codeLinesScore: number;
        commitsScore: number;
        bugsScore: number;
        qualityBonus: number;
    };
    factors: {
        codeLines: number;
        commits: number;
        bugsCount: number;
        reviewComments: number;
        testCoverage?: number;
    };
}

// Weight configuration for scoring
const SCORING_WEIGHTS = {
    codeLines: {
        basePerLine: 0.1,
        maxScore: 40,
    },
    commits: {
        basePerCommit: 5,
        maxScore: 30,
    },
    bugs: {
        penaltyPerBug: 5,
        maxPenalty: 20,
    },
    reviewComments: {
        bonusPerComment: 2,
        maxBonus: 10,
    },
    testCoverage: {
        bonusPerPercent: 0.5,
        maxBonus: 20,
    },
};

/**
 * Calculate system rating based on task completion metrics
 *
 * @param metrics - Task metrics including code lines, commits, bugs, etc.
 * @returns SystemRatingResult with scores
 */
export function calculateSystemRating(metrics: TaskMetrics): SystemRatingResult {
    const {
        codeLines = 0,
        commits = 0,
        bugsCount = 0,
        filesChanged = 0,
        reviewComments = 0,
        testCoverage,
    } = metrics;

    // Calculate code lines score (0-40)
    const codeLinesScore = Math.min(
        codeLines * SCORING_WEIGHTS.codeLines.basePerLine,
        SCORING_WEIGHTS.codeLines.maxScore
    );

    // Calculate commits score (0-30)
    const commitsScore = Math.min(
        commits * SCORING_WEIGHTS.commits.basePerCommit,
        SCORING_WEIGHTS.commits.maxScore
    );

    // Calculate bugs penalty (0 to -20)
    const bugsPenalty = Math.min(
        bugsCount * SCORING_WEIGHTS.bugs.penaltyPerBug,
        SCORING_WEIGHTS.bugs.maxPenalty
    );
    const bugsScore = -bugsPenalty;

    // Calculate review comments bonus (0-10)
    const reviewBonus = Math.min(
        reviewComments * SCORING_WEIGHTS.reviewComments.bonusPerComment,
        SCORING_WEIGHTS.reviewComments.maxBonus
    );

    // Calculate test coverage bonus (0-20)
    let testCoverageBonus = 0;
    if (testCoverage !== undefined && testCoverage > 0) {
        testCoverageBonus = Math.min(
            testCoverage * SCORING_WEIGHTS.testCoverage.bonusPerPercent,
            SCORING_WEIGHTS.testCoverage.maxBonus
        );
    }

    // Quality bonus for balanced contribution
    const qualityBonus = calculateQualityBonus(
        codeLines,
        commits,
        filesChanged,
        reviewComments
    );

    // Calculate individual scores
    const codeScore = Math.round(codeLinesScore + commitsScore);
    const qualityScore = Math.round(bugsScore + reviewBonus + testCoverageBonus + qualityBonus);
    const systemScore = Math.round(qualityBonus);

    // Calculate overall rating (1-5 scale)
    const totalPoints = codeScore + qualityScore;
    const rating = calculateRatingFromPoints(totalPoints);

    return {
        rating,
        codeScore: Math.max(0, codeScore),
        qualityScore: Math.max(0, qualityScore),
        systemScore,
        breakdown: {
            codeLinesScore: Math.round(codeLinesScore),
            commitsScore: Math.round(commitsScore),
            bugsScore,
            qualityBonus: Math.round(qualityBonus),
        },
        factors: {
            codeLines,
            commits,
            bugsCount,
            reviewComments,
            testCoverage,
        },
    };
}

/**
 * Calculate quality bonus for balanced contributions
 */
function calculateQualityBonus(
    codeLines: number,
    commits: number,
    filesChanged: number,
    reviewComments: number
): number {
    // Bonus for reasonable commit frequency (not too few, not too many)
    let commitFrequencyBonus = 0;
    if (commits > 0 && codeLines > 0) {
        const avgLinesPerCommit = codeLines / commits;
        // Sweet spot: 20-100 lines per commit indicates thoughtful contributions
        if (avgLinesPerCommit >= 20 && avgLinesPerCommit <= 100) {
            commitFrequencyBonus = 10;
        } else if (avgLinesPerCommit >= 10 && avgLinesPerCommit <= 200) {
            commitFrequencyBonus = 5;
        }
    }

    // Bonus for code review participation
    const reviewBonus = reviewComments > 0 ? 5 : 0;

    // Bonus for multi-file changes (shows broader understanding)
    const multiFileBonus = filesChanged > 3 ? 5 : filesChanged > 1 ? 2 : 0;

    return commitFrequencyBonus + reviewBonus + multiFileBonus;
}

/**
 * Convert point score to 1-5 rating
 */
function calculateRatingFromPoints(points: number): number {
    // Map 0-100+ points to 1-5 rating
    if (points >= 70) return 5;
    if (points >= 55) return 4;
    if (points >= 40) return 3;
    if (points >= 20) return 2;
    return 1;
}

/**
 * Submit system rating to the role rating system
 *
 * @param roleId - Role ID to rate
 * @param metrics - Task completion metrics
 * @param teamId - Optional team ID
 * @returns Rating result with updated stats
 */
export async function submitSystemRating(
    roleId: string,
    metrics: TaskMetrics,
    teamId?: string
): Promise<{
    success: boolean;
    rating: number;
    codeScore: number;
    qualityScore: number;
    error?: string;
}> {
    try {
        const result = calculateSystemRating(metrics);

        // Get the role from pool to update stats
        const ROLE_POOL_PREFIX = "role_pool.";

        const existingCache = await db.simpleCache.findUnique({
            where: { key: `${ROLE_POOL_PREFIX}${roleId}` },
        });

        if (!existingCache) {
            log(
                { module: "system-rating", level: "warn" },
                `Role not found in pool: ${roleId}`
            );
            return {
                success: false,
                rating: result.rating,
                codeScore: result.codeScore,
                qualityScore: result.qualityScore,
                error: "Role not found in pool",
            };
        }

        // Parse existing stats
        let existingStats = {
            reviewCount: 0,
            completionCount: 0,
            totalRating: 0,
            averageRating: 0,
            cumulativeCode: 0,
            cumulativeQuality: 0,
            sourceScoreTotals: {
                user: 0,
                master: 0,
                system: 0,
            },
        };

        try {
            const parsed = JSON.parse(existingCache.value);
            existingStats = parsed.stats || existingStats;
        } catch {
            // Use defaults if parsing fails
        }

        // Update stats with system rating
        const nextReviewCount = existingStats.reviewCount + 1;
        const nextTotalRating = existingStats.totalRating + result.rating;
        const nextCumulativeCode = existingStats.cumulativeCode + metrics.codeLines;
        const nextCumulativeQuality =
            existingStats.cumulativeQuality + result.qualityScore;

        const updatedStats = {
            reviewCount: nextReviewCount,
            completionCount: existingStats.completionCount + 1,
            totalRating: nextTotalRating,
            averageRating: Number((nextTotalRating / nextReviewCount).toFixed(3)),
            cumulativeCode: nextCumulativeCode,
            cumulativeQuality: nextCumulativeQuality,
            sourceScoreTotals: {
                user: existingStats.sourceScoreTotals.user,
                master: existingStats.sourceScoreTotals.master,
                system: existingStats.sourceScoreTotals.system + result.systemScore,
            },
            lastReviewedAt: Date.now(),
        };

        // Update the cache
        const existingValue = JSON.parse(existingCache.value);
        await db.simpleCache.update({
            where: { key: `${ROLE_POOL_PREFIX}${roleId}` },
            data: {
                value: JSON.stringify({
                    ...existingValue,
                    stats: updatedStats,
                    updatedAt: Date.now(),
                }),
            },
        });

        log(
            { module: "system-rating" },
            `System rating submitted for role ${roleId}: ${result.rating}/5`
        );

        return {
            success: true,
            rating: result.rating,
            codeScore: result.codeScore,
            qualityScore: result.qualityScore,
        };
    } catch (error) {
        log(
            { module: "system-rating", level: "error" },
            `Failed to submit system rating: ${error}`
        );
        return {
            success: false,
            rating: 0,
            codeScore: 0,
            qualityScore: 0,
            error: String(error),
        };
    }
}

/**
 * Get system rating for a role (read-only)
 */
export async function getRoleSystemRating(
    roleId: string
): Promise<SystemRatingResult | null> {
    try {
        const ROLE_POOL_PREFIX = "role_pool.";

        const cache = await db.simpleCache.findUnique({
            where: { key: `${ROLE_POOL_PREFIX}${roleId}` },
        });

        if (!cache) {
            return null;
        }

        const parsed = JSON.parse(cache.value);
        const stats = parsed.stats || {};

        // Calculate what the system rating would be based on current stats
        return calculateSystemRating({
            codeLines: stats.cumulativeCode || 0,
            commits: stats.completionCount || 0,
            bugsCount: 0, // Not tracked in stats
            filesChanged: 0,
            reviewComments: stats.reviewCount || 0,
            testCoverage: undefined,
        });
    } catch (error) {
        log(
            { module: "system-rating", level: "error" },
            `Failed to get system rating: ${error}`
        );
        return null;
    }
}
