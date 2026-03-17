import { log } from "@/utils/log";
import { Fastify } from "../types";
import { z } from "zod";

const StructuredPropertyValueSchema = z.union([
    z.string().max(256),
    z.number(),
    z.boolean(),
    z.null(),
]);

const CommerceObservabilityEventSchema = z.object({
    name: z.enum([
        'paywall_entry_clicked',
        'paywall_presented',
        'paywall_result',
        'paywall_error',
        'purchase_attempted',
        'purchase_completed',
        'purchase_failed',
    ]),
    flow: z.enum(['paywall', 'direct-purchase']),
    surface: z.string().min(1).max(64).optional(),
    platform: z.string().min(1).max(16),
    appVersion: z.string().min(1).max(64).optional(),
    occurredAt: z.number().int().nonnegative(),
    properties: z.record(StructuredPropertyValueSchema).optional(),
}).strict();

const CommerceObservabilityResponseSchema = z.object({
    success: z.literal(true),
});

export function commerceObservabilityRoutes(app: Fastify) {
    app.post('/v1/observability/commerce-events', {
        preHandler: app.authenticate,
        schema: {
            body: CommerceObservabilityEventSchema,
            response: {
                200: CommerceObservabilityResponseSchema,
            },
        },
    }, async (request, reply) => {
        const userId = request.userId;
        const event = CommerceObservabilityEventSchema.parse(request.body);

        log({
            module: 'commerce-observability',
            category: 'structured-commerce-event',
            accountId: userId,
            eventName: event.name,
            flow: event.flow,
            surface: event.surface ?? 'unknown',
            platform: event.platform,
            appVersion: event.appVersion,
            occurredAt: event.occurredAt,
            properties: event.properties ?? {},
        }, 'Structured commerce observability event');

        return reply.send({ success: true });
    });
}
