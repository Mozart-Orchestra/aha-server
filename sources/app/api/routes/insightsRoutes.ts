import { z } from "zod";
import { Fastify } from "../types";
import { generateRatingInsightsReport } from "@/services/insights/RatingInsightsEngine";
import { sendErrorResponse } from "@/errors/errorHandler";
import { log } from "@/utils/log";

/**
 * V5 Insights Routes - Rating Diagnostic Reports API
 *
 * Task: V5-INSIGHTS-001
 *
 * Endpoints:
 * - POST /api/v5/insights/rating-report - Generate rating insights report
 * - GET /api/v5/insights/rating-trends/:roleId - Get rating trends
 * - GET /api/v5/insights/team-comparison/:roleId - Get team comparison
 */

const ReportTypeSchema = z.enum(["weekly", "monthly"]);

const RatingReportRequestSchema = z.object({
  roleId: z.string().min(1),
  teamId: z.string().optional(),
  reportType: ReportTypeSchema,
  customPeriod: z
    .object({
      startDate: z.number().positive(),
      endDate: z.number().positive(),
    })
    .optional(),
});

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === "string") {
    return new Error(error);
  }
  return new Error("Unknown error");
}

export async function insightsRoutes(fastify: Fastify) {
  /**
   * POST /api/v5/insights/rating-report
   * Generate a rating insights report
   */
  fastify.post("/api/v5/insights/rating-report", async (request, reply) => {
    try {
      const body = RatingReportRequestSchema.parse(request.body);
      const { roleId, teamId, reportType, customPeriod } = body;

      log(
        { module: "insights-routes" },
        `Generating ${reportType} report for role ${roleId}`
      );

      const result = await generateRatingInsightsReport(
        roleId,
        teamId,
        reportType
      );

      if (!result.success) {
        return reply.status(400).send({
          success: false,
          error: result.error || "Failed to generate report",
        });
      }

      return reply.send({
        success: true,
        data: result.report,
      });
    } catch (error) {
      log(
        { module: "insights-routes", level: "error" },
        `Rating report generation failed: ${error}`
      );
      return sendErrorResponse(reply, toError(error));
    }
  });

  /**
   * GET /api/v5/insights/rating-trends/:roleId
   * Get rating trends for a role
   */
  fastify.get(
    "/api/v5/insights/rating-trends/:roleId",
    async (request, reply) => {
      try {
        const params = z
          .object({
            roleId: z.string().min(1),
          })
          .parse(request.params);

        const query = z
          .object({
            period: ReportTypeSchema.optional().default("weekly"),
            teamId: z.string().optional(),
          })
          .parse(request.query);

        const { roleId } = params;
        const { period, teamId } = query;

        log(
          { module: "insights-routes" },
          `Fetching ${period} rating trends for role ${roleId}`
        );

        // TODO: Implement trend data fetching
        const mockTrend = {
          period,
          roleId,
          teamId,
          dataPoints: [],
          trend: {
            direction: "stable" as const,
            slope: 0,
            volatility: 0,
          },
          significant: false,
          changePoints: [],
        };

        return reply.send({
          success: true,
          data: mockTrend,
        });
      } catch (error) {
        log(
          { module: "insights-routes", level: "error" },
          `Rating trends fetch failed: ${error}`
        );
        return sendErrorResponse(reply, toError(error));
      }
    }
  );

  /**
   * GET /api/v5/insights/team-comparison/:roleId
   * Get team comparison data for a role
   */
  fastify.get(
    "/api/v5/insights/team-comparison/:roleId",
    async (request, reply) => {
      try {
        const params = z
          .object({
            roleId: z.string().min(1),
          })
          .parse(request.params);

        const query = z
          .object({
            teamId: z.string().min(1),
          })
          .parse(request.query);

        const { roleId } = params;
        const { teamId } = query;

        log(
          { module: "insights-routes" },
          `Fetching team comparison for role ${roleId} in team ${teamId}`
        );

        // TODO: Implement team comparison data fetching
        const mockComparison = {
          roleId,
          teamId,
          roleRating: 4.2,
          teamAverage: 4.0,
          gap: 0.2,
          percentile: 65,
          strengths: ["代码质量", "提交频率"],
          weaknesses: ["测试覆盖率"],
        };

        return reply.send({
          success: true,
          data: mockComparison,
        });
      } catch (error) {
        log(
          { module: "insights-routes", level: "error" },
          `Team comparison fetch failed: ${error}`
        );
        return sendErrorResponse(reply, toError(error));
      }
    }
  );
}
