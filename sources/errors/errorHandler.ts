/**
 * API Error Handler
 *
 * Unified error handling for Fastify API routes
 */

import { FastifyReply } from "fastify";
import { ErrorCode, ErrorResponse, ErrorCodeToHttpStatus, DefaultErrorMessages } from "./errorCodes";

export class ApiError extends Error {
    public readonly code: ErrorCode;
    public readonly httpStatus: number;
    public readonly details?: Record<string, any>;

    constructor(
        code: ErrorCode,
        message?: string,
        details?: Record<string, any>
    ) {
        super(message || DefaultErrorMessages[code]);
        this.code = code;
        this.httpStatus = ErrorCodeToHttpStatus[code];
        this.details = details;
        this.name = "ApiError";
    }

    /**
     * Convert to API response format
     */
    toResponse(requestId?: string): ErrorResponse {
        return {
            error: this.message,
            code: this.code,
            message: this.message,
            details: this.details,
            timestamp: Date.now(),
            requestId,
        };
    }
}

/**
 * Error Factory Functions
 */
export const ApiErrors = {
    // 400 Bad Request
    badRequest: (message?: string, details?: Record<string, any>) =>
        new ApiError(ErrorCode.BAD_REQUEST, message, details),

    invalidInput: (field: string, reason: string) =>
        new ApiError(ErrorCode.INVALID_INPUT, `Invalid input: ${field}`, { field, reason }),

    missingParameter: (param: string) =>
        new ApiError(ErrorCode.MISSING_PARAMETER, `Missing required parameter: ${param}`, { parameter: param }),

    invalidJson: (reason?: string) =>
        new ApiError(ErrorCode.INVALID_JSON, reason),

    // 401 Unauthorized
    unauthorized: (message?: string) =>
        new ApiError(ErrorCode.UNAUTHORIZED, message),

    tokenExpired: () =>
        new ApiError(ErrorCode.TOKEN_EXPIRED),

    invalidToken: (reason?: string) =>
        new ApiError(ErrorCode.INVALID_TOKEN, reason),

    // 403 Forbidden
    forbidden: (action?: string) =>
        new ApiError(ErrorCode.FORBIDDEN, action ? `Forbidden: ${action}` : undefined),

    insufficientPermissions: (requiredPermission?: string) =>
        new ApiError(ErrorCode.INSUFFICIENT_PERMISSIONS, undefined, { requiredPermission }),

    // 404 Not Found
    notFound: (resource?: string) =>
        new ApiError(ErrorCode.NOT_FOUND, resource ? `${resource} not found` : undefined),

    roleNotFound: (roleId?: string) =>
        new ApiError(ErrorCode.ROLE_NOT_FOUND, undefined, { roleId }),

    teamNotFound: (teamId?: string) =>
        new ApiError(ErrorCode.TEAM_NOT_FOUND, undefined, { teamId }),

    ratingNotFound: (ratingId?: string) =>
        new ApiError(ErrorCode.RATING_NOT_FOUND, undefined, { ratingId }),

    resourceNotFound: (resourceType: string, resourceId?: string) =>
        new ApiError(ErrorCode.RESOURCE_NOT_FOUND, `${resourceType} not found`, { resourceType, resourceId }),

    // 409 Conflict
    conflict: (message?: string, details?: Record<string, any>) =>
        new ApiError(ErrorCode.CONFLICT, message, details),

    versionMismatch: (currentVersion?: number, providedVersion?: number) =>
        new ApiError(ErrorCode.VERSION_MISMATCH, "Version mismatch - resource has been modified", {
            currentVersion,
            providedVersion,
        }),

    duplicateEntry: (field: string, value: string) =>
        new ApiError(ErrorCode.DUPLICATE_ENTRY, `Duplicate entry: ${field} already exists`, { field, value }),

    // 422 Validation Error
    validationError: (field: string, reason: string) =>
        new ApiError(ErrorCode.VALIDATION_ERROR, `Validation failed: ${field}`, { field, reason }),

    invalidRatingScore: (score: number) =>
        new ApiError(ErrorCode.INVALID_RATING_SCORE, undefined, { score, validRange: "0-5" }),

    invalidRoleData: (reason?: string) =>
        new ApiError(ErrorCode.INVALID_ROLE_DATA, reason),

    // 500 Internal Server Error
    internalError: (message?: string, details?: Record<string, any>) =>
        new ApiError(ErrorCode.INTERNAL_ERROR, message, details),

    databaseError: (operation: string, details?: Record<string, any>) =>
        new ApiError(ErrorCode.DATABASE_ERROR, `Database operation failed: ${operation}`, { operation, ...details }),

    cacheError: (operation: string) =>
        new ApiError(ErrorCode.CACHE_ERROR, `Cache operation failed: ${operation}`, { operation }),

    fileSystemError: (operation: string, path?: string) =>
        new ApiError(ErrorCode.FILE_SYSTEM_ERROR, `File system operation failed: ${operation}`, { operation, path }),

    // 503 Service Unavailable
    serviceUnavailable: (service?: string) =>
        new ApiError(ErrorCode.SERVICE_UNAVAILABLE, service ? `${service} is temporarily unavailable` : undefined),

    externalServiceError: (service: string, reason?: string) =>
        new ApiError(ErrorCode.EXTERNAL_SERVICE_ERROR, `External service error: ${service}`, { service, reason }),
};

/**
 * Send Error Response
 *
 * Utility function to send standardized error responses
 */
export function sendErrorResponse(
    reply: FastifyReply,
    error: ApiError | Error,
    requestId?: string
): FastifyReply {
    // Handle ApiError instances
    if (error instanceof ApiError) {
        return reply
            .code(error.httpStatus)
            .send(error.toResponse(requestId));
    }

    // Handle generic errors (wrap as internal error)
    const internalError = ApiErrors.internalError(error.message, {
        originalError: error.name,
        stack: error.stack,
    });

    return reply
        .code(500)
        .send(internalError.toResponse(requestId));
}

/**
 * Async Route Handler Wrapper
 *
 * Wraps async route handlers to catch errors and send standardized responses
 */
export function asyncRouteHandler<T = any>(
    handler: () => Promise<T>
): Promise<T> {
    return handler().catch((error) => {
        // Re-throw ApiError to be handled by the route
        if (error instanceof ApiError) {
            throw error;
        }
        // Wrap unknown errors as internal errors
        throw ApiErrors.internalError(error.message, {
            originalError: error.name,
            stack: error.stack,
        });
    });
}
