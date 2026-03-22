import { Fastify } from "../types";
import { z } from "zod";
import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { getAccessibleTeamArtifact } from "@/app/team/teamArtifacts";

const ReviewSourceSchema = z.enum(["user", "master", "system"]);

const TeamReviewPayloadSchema = z.object({
    rating: z.number().min(1).max(5),
    codeScore: z.number().min(0).max(100).optional(),
    qualityScore: z.number().min(0).max(100).optional(),
    source: ReviewSourceSchema.optional(),
    sourceScores: z.object({
        user: z.number().optional(),
        master: z.number().optional(),
        system: z.number().optional(),
    }).optional(),
    roleIds: z.array(z.string()).optional(),
    comment: z.string().max(2000).optional(),
});

type ReviewSource = z.infer<typeof ReviewSourceSchema>;

type StoredTeamReview = {
    id: string;
    teamId: string;
    reviewerId: string;
    rating: number;
    codeScore?: number;
    qualityScore?: number;
    source?: ReviewSource;
    sourceScores?: {
        user?: number;
        master?: number;
        system?: number;
    };
    roleIds?: string[];
    comment?: string;
    createdAt: string;
    updatedAt: string;
};

function buildTeamReviewKey(teamId: string, reviewerId: string): string {
    return `team-review:${teamId}:${reviewerId}`;
}

function parseStoredTeamReview(raw: string | null | undefined): StoredTeamReview | null {
    if (!raw) return null;
    try {
        return JSON.parse(raw) as StoredTeamReview;
    } catch {
        return null;
    }
}

async function listStoredTeamReviews(teamId: string, limit?: number): Promise<StoredTeamReview[]> {
    const rows = await db.simpleCache.findMany({
        where: {
            key: {
                startsWith: `team-review:${teamId}:`,
            },
        },
        orderBy: {
            updatedAt: "desc",
        },
        ...(typeof limit === "number" ? { take: limit } : {}),
    });

    return rows
        .map((row) => parseStoredTeamReview(row.value))
        .filter((review): review is StoredTeamReview => review != null);
}

function buildTeamScorecard(reviews: StoredTeamReview[]) {
    const reviewCount = reviews.length;
    const averageRating = reviewCount > 0
        ? reviews.reduce((sum, review) => sum + review.rating, 0) / reviewCount
        : 0;
    const cumulativeCode = reviews.reduce((sum, review) => sum + (review.codeScore ?? 0), 0);
    const cumulativeQuality = reviews.reduce((sum, review) => sum + (review.qualityScore ?? 0), 0);
    const sourceScoreTotals = reviews.reduce((acc, review) => {
        if (review.sourceScores) {
            acc.user += review.sourceScores.user ?? 0;
            acc.master += review.sourceScores.master ?? 0;
            acc.system += review.sourceScores.system ?? 0;
        } else if (review.source) {
            acc[review.source] += review.rating;
        }
        return acc;
    }, { user: 0, master: 0, system: 0 });

    const lastReviewedAt = reviews.length > 0
        ? reviews.reduce((latest, review) => {
            const candidate = review.updatedAt || review.createdAt;
            return candidate > latest ? candidate : latest;
        }, reviews[0].updatedAt || reviews[0].createdAt)
        : null;

    return {
        averageRating,
        reviewCount,
        cumulativeCode,
        cumulativeQuality,
        sourceScoreTotals,
        lastReviewedAt,
    };
}

export function teamReviewRoutes(app: Fastify) {
    app.post('/v1/teams/:teamId/reviews', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string(),
            }),
            body: TeamReviewPayloadSchema,
        },
    }, async (request, reply) => {
        const { teamId } = request.params as { teamId: string };
        const reviewerId = request.userId;
        const payload = request.body as z.infer<typeof TeamReviewPayloadSchema>;

        try {
            const team = await getAccessibleTeamArtifact(reviewerId, teamId);
            if (!team) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            const key = buildTeamReviewKey(teamId, reviewerId);
            const existing = await db.simpleCache.findUnique({ where: { key } });
            const existingReview = parseStoredTeamReview(existing?.value);
            const now = new Date().toISOString();

            const review: StoredTeamReview = {
                id: existingReview?.id ?? key,
                teamId,
                reviewerId,
                rating: payload.rating,
                ...(payload.codeScore !== undefined ? { codeScore: payload.codeScore } : {}),
                ...(payload.qualityScore !== undefined ? { qualityScore: payload.qualityScore } : {}),
                ...(payload.source ? { source: payload.source } : {}),
                ...(payload.sourceScores ? { sourceScores: payload.sourceScores } : {}),
                ...(payload.roleIds ? { roleIds: payload.roleIds } : {}),
                ...(payload.comment ? { comment: payload.comment } : {}),
                createdAt: existingReview?.createdAt ?? now,
                updatedAt: now,
            };

            await db.simpleCache.upsert({
                where: { key },
                update: {
                    value: JSON.stringify(review),
                    updatedAt: new Date(now),
                },
                create: {
                    key,
                    value: JSON.stringify(review),
                },
            });

            const reviews = await listStoredTeamReviews(teamId);
            const scorecard = buildTeamScorecard(reviews);

            return reply.send({
                success: true,
                review,
                scorecard,
            });
        } catch (error) {
            log({ module: 'team-review', level: 'error' }, `Failed to write team review: ${error}`);
            return reply.code(500).send({ error: 'Failed to write team review' });
        }
    });

    app.get('/v1/teams/:teamId/reviews', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string(),
            }),
            querystring: z.object({
                limit: z.coerce.number().int().min(1).max(100).default(50),
            }),
        },
    }, async (request, reply) => {
        const { teamId } = request.params as { teamId: string };
        const { limit } = request.query as { limit: number };

        try {
            const team = await getAccessibleTeamArtifact(request.userId, teamId);
            if (!team) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            const reviews = await listStoredTeamReviews(teamId, limit);
            return reply.send({
                reviews,
                total: reviews.length,
            });
        } catch (error) {
            log({ module: 'team-review', level: 'error' }, `Failed to list team reviews: ${error}`);
            return reply.code(500).send({ error: 'Failed to list team reviews' });
        }
    });

    app.get('/v1/teams/:teamId/score', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                teamId: z.string(),
            }),
        },
    }, async (request, reply) => {
        const { teamId } = request.params as { teamId: string };

        try {
            const team = await getAccessibleTeamArtifact(request.userId, teamId);
            if (!team) {
                return reply.code(404).send({ error: 'Team not found' });
            }

            const reviews = await listStoredTeamReviews(teamId);
            return reply.send(buildTeamScorecard(reviews));
        } catch (error) {
            log({ module: 'team-review', level: 'error' }, `Failed to compute team score: ${error}`);
            return reply.code(500).send({ error: 'Failed to compute team score' });
        }
    });
}
