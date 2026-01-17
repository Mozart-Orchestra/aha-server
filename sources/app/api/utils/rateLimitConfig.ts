import type { FastifyRateLimitOptions } from '@fastify/rate-limit';

// Rate limit configuration for different endpoint types
export const RATE_LIMIT_CONFIG = {
    // Default rate limit for most endpoints
    default: {
        max: 100, // 100 requests
        timeWindow: '1 minute',
    },
    // Auth endpoints - stricter limits to prevent brute force
    auth: {
        max: 10, // 10 requests
        timeWindow: '1 minute',
    },
    // Search endpoints - moderate limits
    search: {
        max: 30, // 30 requests
        timeWindow: '1 minute',
    },
    // KV storage - moderate limits
    kv: {
        max: 60, // 60 requests
        timeWindow: '1 minute',
    },
    // Upload endpoints - strict limits
    upload: {
        max: 10, // 10 requests
        timeWindow: '1 minute',
    },
} as const;

export function getDefaultRateLimitConfig(): FastifyRateLimitOptions {
    return {
        max: RATE_LIMIT_CONFIG.default.max,
        timeWindow: RATE_LIMIT_CONFIG.default.timeWindow,
        errorResponseBuilder: (request, context) => {
            return {
                statusCode: 429,
                error: 'Too Many Requests',
                message: `Rate limit exceeded. You can make ${context.max} requests per ${context.after}. Please try again later.`,
                retryAfter: context.after,
            };
        },
        keyGenerator: (request) => {
            // Use user ID if authenticated, otherwise use IP
            return (request as any).userId || request.ip;
        },
        // Skip rate limiting for health checks
        allowList: (request) => {
            return request.url === '/' || request.url === '/health';
        },
    };
}

// Route-specific rate limit options
export function getAuthRateLimitConfig(): FastifyRateLimitOptions {
    return {
        ...getDefaultRateLimitConfig(),
        max: RATE_LIMIT_CONFIG.auth.max,
        timeWindow: RATE_LIMIT_CONFIG.auth.timeWindow,
        keyGenerator: (request) => {
            // For auth endpoints, always use IP to prevent brute force
            return request.ip;
        },
    };
}

export function getSearchRateLimitConfig(): FastifyRateLimitOptions {
    return {
        ...getDefaultRateLimitConfig(),
        max: RATE_LIMIT_CONFIG.search.max,
        timeWindow: RATE_LIMIT_CONFIG.search.timeWindow,
    };
}

export function getKVRateLimitConfig(): FastifyRateLimitOptions {
    return {
        ...getDefaultRateLimitConfig(),
        max: RATE_LIMIT_CONFIG.kv.max,
        timeWindow: RATE_LIMIT_CONFIG.kv.timeWindow,
    };
}

export function getUploadRateLimitConfig(): FastifyRateLimitOptions {
    return {
        ...getDefaultRateLimitConfig(),
        max: RATE_LIMIT_CONFIG.upload.max,
        timeWindow: RATE_LIMIT_CONFIG.upload.timeWindow,
    };
}
