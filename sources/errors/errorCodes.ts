/**
 * API Error Code Definitions
 *
 * Unified error codes following HTTP standards + custom application codes
 * Format: {httpStatusCode}_{category}_{specificCode}
 */

export enum ErrorCode {
    // ==================== Client Errors (4xx) ====================

    // 400 Bad Request
    BAD_REQUEST = "BAD_REQUEST",
    INVALID_INPUT = "INVALID_INPUT",
    MISSING_PARAMETER = "MISSING_PARAMETER",
    INVALID_JSON = "INVALID_JSON",

    // 401 Unauthorized
    UNAUTHORIZED = "UNAUTHORIZED",
    TOKEN_EXPIRED = "TOKEN_EXPIRED",
    INVALID_TOKEN = "INVALID_TOKEN",

    // 403 Forbidden
    FORBIDDEN = "FORBIDDEN",
    INSUFFICIENT_PERMISSIONS = "INSUFFICIENT_PERMISSIONS",

    // 404 Not Found
    NOT_FOUND = "NOT_FOUND",
    ROLE_NOT_FOUND = "ROLE_NOT_FOUND",
    TEAM_NOT_FOUND = "TEAM_NOT_FOUND",
    RATING_NOT_FOUND = "RATING_NOT_FOUND",
    RESOURCE_NOT_FOUND = "RESOURCE_NOT_FOUND",

    // 409 Conflict
    CONFLICT = "CONFLICT",
    VERSION_MISMATCH = "VERSION_MISMATCH",
    DUPLICATE_ENTRY = "DUPLICATE_ENTRY",

    // 422 Unprocessable Entity
    VALIDATION_ERROR = "VALIDATION_ERROR",
    INVALID_RATING_SCORE = "INVALID_RATING_SCORE",
    INVALID_ROLE_DATA = "INVALID_ROLE_DATA",

    // ==================== Server Errors (5xx) ====================

    // 500 Internal Server Error
    INTERNAL_ERROR = "INTERNAL_ERROR",
    DATABASE_ERROR = "DATABASE_ERROR",
    CACHE_ERROR = "CACHE_ERROR",
    FILE_SYSTEM_ERROR = "FILE_SYSTEM_ERROR",

    // 503 Service Unavailable
    SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE",
    EXTERNAL_SERVICE_ERROR = "EXTERNAL_SERVICE_ERROR",
}

/**
 * Error Response Structure
 */
export interface ErrorResponse {
    error: string;
    code: ErrorCode;
    message: string;
    details?: Record<string, any>;
    timestamp: number;
    requestId?: string;
}

/**
 * HTTP Status Code Mapping
 */
export const ErrorCodeToHttpStatus: Record<ErrorCode, number> = {
    // 4xx
    [ErrorCode.BAD_REQUEST]: 400,
    [ErrorCode.INVALID_INPUT]: 400,
    [ErrorCode.MISSING_PARAMETER]: 400,
    [ErrorCode.INVALID_JSON]: 400,

    [ErrorCode.UNAUTHORIZED]: 401,
    [ErrorCode.TOKEN_EXPIRED]: 401,
    [ErrorCode.INVALID_TOKEN]: 401,

    [ErrorCode.FORBIDDEN]: 403,
    [ErrorCode.INSUFFICIENT_PERMISSIONS]: 403,

    [ErrorCode.NOT_FOUND]: 404,
    [ErrorCode.ROLE_NOT_FOUND]: 404,
    [ErrorCode.TEAM_NOT_FOUND]: 404,
    [ErrorCode.RATING_NOT_FOUND]: 404,
    [ErrorCode.RESOURCE_NOT_FOUND]: 404,

    [ErrorCode.CONFLICT]: 409,
    [ErrorCode.VERSION_MISMATCH]: 409,
    [ErrorCode.DUPLICATE_ENTRY]: 409,

    [ErrorCode.VALIDATION_ERROR]: 422,
    [ErrorCode.INVALID_RATING_SCORE]: 422,
    [ErrorCode.INVALID_ROLE_DATA]: 422,

    // 5xx
    [ErrorCode.INTERNAL_ERROR]: 500,
    [ErrorCode.DATABASE_ERROR]: 500,
    [ErrorCode.CACHE_ERROR]: 500,
    [ErrorCode.FILE_SYSTEM_ERROR]: 500,

    [ErrorCode.SERVICE_UNAVAILABLE]: 503,
    [ErrorCode.EXTERNAL_SERVICE_ERROR]: 503,
};

/**
 * Default Error Messages
 */
export const DefaultErrorMessages: Record<ErrorCode, string> = {
    // 4xx
    [ErrorCode.BAD_REQUEST]: "Bad request",
    [ErrorCode.INVALID_INPUT]: "Invalid input parameters",
    [ErrorCode.MISSING_PARAMETER]: "Missing required parameter",
    [ErrorCode.INVALID_JSON]: "Invalid JSON format",

    [ErrorCode.UNAUTHORIZED]: "Unauthorized access",
    [ErrorCode.TOKEN_EXPIRED]: "Authentication token has expired",
    [ErrorCode.INVALID_TOKEN]: "Invalid authentication token",

    [ErrorCode.FORBIDDEN]: "Access forbidden",
    [ErrorCode.INSUFFICIENT_PERMISSIONS]: "Insufficient permissions for this action",

    [ErrorCode.NOT_FOUND]: "Resource not found",
    [ErrorCode.ROLE_NOT_FOUND]: "Role not found",
    [ErrorCode.TEAM_NOT_FOUND]: "Team not found",
    [ErrorCode.RATING_NOT_FOUND]: "Rating not found",
    [ErrorCode.RESOURCE_NOT_FOUND]: "Requested resource not found",

    [ErrorCode.CONFLICT]: "Resource conflict",
    [ErrorCode.VERSION_MISMATCH]: "Version mismatch - resource has been modified",
    [ErrorCode.DUPLICATE_ENTRY]: "Duplicate entry already exists",

    [ErrorCode.VALIDATION_ERROR]: "Validation failed",
    [ErrorCode.INVALID_RATING_SCORE]: "Invalid rating score - must be between 0 and 5",
    [ErrorCode.INVALID_ROLE_DATA]: "Invalid role data format",

    // 5xx
    [ErrorCode.INTERNAL_ERROR]: "Internal server error",
    [ErrorCode.DATABASE_ERROR]: "Database operation failed",
    [ErrorCode.CACHE_ERROR]: "Cache operation failed",
    [ErrorCode.FILE_SYSTEM_ERROR]: "File system operation failed",

    [ErrorCode.SERVICE_UNAVAILABLE]: "Service temporarily unavailable",
    [ErrorCode.EXTERNAL_SERVICE_ERROR]: "External service error",
};
