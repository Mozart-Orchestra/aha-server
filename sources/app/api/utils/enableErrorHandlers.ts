import { log } from "@/utils/log";
import { Fastify } from "../types";
import { ZodError } from "zod";

export function enableErrorHandlers(app: Fastify) {
    // Global error handler
    app.setErrorHandler(async (error, request, reply) => {
        const method = request.method;
        const url = request.url;
        const userAgent = request.headers['user-agent'] || 'unknown';
        const ip = request.ip || 'unknown';

        // Type guard for error
        const err = error as Error & { statusCode?: number; code?: string; validation?: any };

        // Handle Zod validation errors specially
        if (err.code === 'FST_ERR_VALIDATION' || err.validation) {
            log({
                module: 'fastify-validation-error',
                level: 'error',
                method,
                url,
                validation: JSON.stringify(err.validation || err.message)
            }, `Validation error: ${err.message}`);
            return reply.code(400).send({
                error: 'Validation Error',
                message: err.message,
                details: err.validation
            });
        }

        // Log the error with comprehensive context
        log({
            module: 'fastify-error',
            level: 'error',
            method,
            url,
            userAgent,
            ip,
            statusCode: err.statusCode || 500,
            errorCode: err.code,
            stack: err.stack
        }, `Unhandled error: ${err.message}`);

        // Return appropriate error response
        const statusCode = err.statusCode || 500;

        if (statusCode >= 500) {
            // Internal server errors - don't expose details
            return reply.code(statusCode).send({
                error: 'Internal Server Error',
                message: 'An unexpected error occurred',
                statusCode
            });
        } else {
            // Client errors - can expose more details
            return reply.code(statusCode).send({
                error: err.name || 'Error',
                message: err.message || 'An error occurred',
                statusCode
            });
        }
    });

    // Catch-all route for debugging 404s
    app.setNotFoundHandler((request, reply) => {
        log({ module: '404-handler' }, `404 - Method: ${request.method}, Path: ${request.url}, Headers: ${JSON.stringify(request.headers)}`);
        reply.code(404).send({ error: 'Not found', path: request.url, method: request.method });
    });

    // Error hook for additional logging
    app.addHook('onError', async (request, reply, error) => {
        const method = request.method;
        const url = request.url;
        const duration = (Date.now() - (request.startTime || Date.now())) / 1000;

        // Type guard for error
        const err = error as Error & { statusCode?: number; code?: string };

        log({
            module: 'fastify-hook-error',
            level: 'error',
            method,
            url,
            duration,
            statusCode: reply.statusCode || err.statusCode || 500,
            errorName: err.name,
            errorCode: err.code
        }, `Request error: ${err.message}`);
    });

    // Handle uncaught exceptions in routes
    app.addHook('preHandler', async (request, reply) => {
        // Store original reply.send to catch errors in response serialization
        const originalSend = reply.send.bind(reply);
        reply.send = function (payload: any) {
            try {
                return originalSend(payload);
            } catch (err) {
                const error = err as Error;
                log({
                    module: 'fastify-serialization-error',
                    level: 'error',
                    method: request.method,
                    url: request.url,
                    stack: error.stack
                }, `Response serialization error: ${error.message}`);
                throw error;
            }
        };
    });
}