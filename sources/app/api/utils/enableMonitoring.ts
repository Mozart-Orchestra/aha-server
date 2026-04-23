import { db } from "@/storage/db";
import { Fastify } from "../types";
import { httpRequestsCounter, httpRequestDurationHistogram } from "@/app/monitoring/metrics2";
import { log } from "@/utils/log";
import { applyAhaTraceResponseHeaders, createAhaTraceContext, getAhaTraceLogFields } from "./traceContext";

export function enableMonitoring(app: Fastify) {
    // Add metrics hooks
    app.addHook('onRequest', async (request, reply) => {
        request.startTime = Date.now();
        request.ahaTrace = createAhaTraceContext(request);
        applyAhaTraceResponseHeaders(reply, request.ahaTrace);
    });

    app.addHook('onResponse', async (request, reply) => {
        const duration = (Date.now() - (request.startTime || Date.now())) / 1000;
        const method = request.method;
        // Use routeOptions.url for the route template, fallback to parsed URL path
        const route = request.routeOptions?.url || request.url.split('?')[0] || 'unknown';
        const status = reply.statusCode.toString();

        // Increment request counter
        httpRequestsCounter.inc({ method, route, status });

        // Record request duration
        httpRequestDurationHistogram.observe({ method, route, status }, duration);

        log({
            module: 'http-trace',
            ...getAhaTraceLogFields(request),
            method,
            route,
            status: reply.statusCode,
            durationMs: Math.round(duration * 1000),
            accountId: (request as any).userId,
        }, `${method} ${route} -> ${reply.statusCode}`);
    });

    app.get('/health', async (request, reply) => {
        try {
            // Test database connectivity
            await db.$queryRaw`SELECT 1`;
            reply.send({
                status: 'ok',
                timestamp: new Date().toISOString(),
                service: 'aha-server'
            });
        } catch (error) {
            log({ module: 'health', level: 'error' }, `Health check failed: ${error}`);
            reply.code(503).send({
                status: 'error',
                timestamp: new Date().toISOString(),
                service: 'aha-server',
                error: 'Database connectivity failed'
            });
        }
    });
}
