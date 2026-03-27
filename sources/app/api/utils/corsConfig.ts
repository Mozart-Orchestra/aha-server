import type { FastifyCorsOptions } from '@fastify/cors';
import type { CorsOptions as SocketCorsOptions } from 'cors';

// Security: Allowed origins for production
const ALLOWED_ORIGINS_PRODUCTION = [
    'https://aha.engineering',
    'https://app.aha.engineering',
    'https://www.aha.engineering',
    'https://top1vibe.com',
    'https://app.top1vibe.com',
    'https://www.top1vibe.com',
    // Mobile app origins (Expo)
    'exp://localhost:8081',
    'exp://localhost:19000',
];

// Development origins
const ALLOWED_ORIGINS_DEVELOPMENT = [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:8081',
    'http://localhost:19000',
    'http://localhost:19006',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:8081',
    // Expo development
    /^exp:\/\/.*$/,
    /^http:\/\/192\.168\.\d+\.\d+:\d+$/,
];

// Standard headers for API requests
const ALLOWED_HEADERS = [
    'Content-Type',
    'Authorization',
    'X-Request-Id',
    'X-Client-Version',
    'X-Device-Id',
];

// HTTP methods used by the API
const ALLOWED_METHODS: ('GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS')[] = [
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'OPTIONS',
];

function isProduction(): boolean {
    return process.env.NODE_ENV === 'production';
}

function shouldAllowLocalOrigins(): boolean {
    return process.env.ALLOW_LOCALHOST_ORIGINS === 'true';
}

function getDevelopmentOriginHandler(): NonNullable<FastifyCorsOptions['origin']> {
    return ((origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) {
            callback(null, true);
            return;
        }

        const isAllowed = ALLOWED_ORIGINS_DEVELOPMENT.some(allowed => {
            if (typeof allowed === 'string') {
                return origin === allowed;
            }
            return allowed.test(origin);
        });

        if (isAllowed) {
            callback(null, true);
        } else {
            // In development, allow all but log unexpected origins
            console.warn(`[CORS] Unexpected origin in development: ${origin}`);
            callback(null, true);
        }
    }) as NonNullable<FastifyCorsOptions['origin']>;
}

type SocketOriginHandler = NonNullable<SocketCorsOptions['origin']>;

function getDevelopmentSocketOriginHandler(): SocketOriginHandler {
    return ((origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) {
            callback(null, true);
            return;
        }

        const isAllowed = ALLOWED_ORIGINS_DEVELOPMENT.some(allowed => {
            if (typeof allowed === 'string') {
                return origin === allowed;
            }
            return allowed.test(origin);
        });

        if (isAllowed) {
            callback(null, true);
        } else {
            console.warn(`[Socket CORS] Unexpected origin in development: ${origin}`);
            callback(null, true);
        }
    }) as SocketOriginHandler;
}

export function getCorsConfig(): FastifyCorsOptions {
    if (isProduction() && !shouldAllowLocalOrigins()) {
        return {
            origin: ALLOWED_ORIGINS_PRODUCTION,
            allowedHeaders: ALLOWED_HEADERS,
            methods: ALLOWED_METHODS,
            credentials: true,
            maxAge: 86400, // Cache preflight for 24 hours
        };
    }

    // Development: more permissive but still structured
    return {
        origin: getDevelopmentOriginHandler(),
        allowedHeaders: [...ALLOWED_HEADERS, '*'], // More permissive in dev
        methods: ALLOWED_METHODS,
        credentials: true,
    };
}

// Export for WebSocket configuration
export function getSocketCorsConfig(): SocketCorsOptions {
    if (isProduction() && !shouldAllowLocalOrigins()) {
        return {
            origin: ALLOWED_ORIGINS_PRODUCTION,
            methods: ['GET', 'POST', 'OPTIONS'],
            credentials: true,
            allowedHeaders: ALLOWED_HEADERS,
        };
    }

    return {
        origin: getDevelopmentSocketOriginHandler(),
        methods: ['GET', 'POST', 'OPTIONS'],
        credentials: true,
        allowedHeaders: [...ALLOWED_HEADERS, '*'],
    };
}
