/**
 * Swagger/OpenAPI configuration for aha-server API documentation
 *
 * Provides interactive API documentation at /docs
 * Auto-generates schemas from Zod validators
 */

import { zodToJsonSchema } from 'zod-to-json-schema'
import { getPublicApiServers } from '../utils/publicBaseUrls'

/**
 * Convert Zod schema to JSON Schema for Swagger
 */
export function transformZodSchema(zodSchema: any) {
  try {
    return zodToJsonSchema(zodSchema, { target: 'openApi3' })
  } catch (error) {
    console.error('Error converting Zod schema:', error)
    return {}
  }
}

/**
 * Swagger configuration object
 */
export const swaggerConfig = {
  openapi: '3.0.0',
  info: {
    title: 'Aha Server API',
    description: `
# Aha Server API Documentation

Aha Server provides the backend infrastructure for the Aha CLI and team collaboration platform.

## Authentication

Most endpoints require Bearer token authentication. Include your token in the Authorization header:

\`\`\`
Authorization: Bearer YOUR_TOKEN_HERE
\`\`\`

## Rate Limiting

API requests are rate-limited to prevent abuse. Default limits:
- 100 requests per 15 minutes per IP
- Custom limits per endpoint

## WebSocket Support

Real-time updates are available via WebSocket at \`/socket.io/\`

## Error Handling

All errors follow this format:
\`\`\`json
{
  "error": "Error message description"
}
\`\`\`

HTTP Status Codes:
- 200: Success
- 401: Unauthorized
- 403: Forbidden
- 429: Rate limit exceeded
- 500: Server error

For more information, visit [GitHub Repository](https://github.com/Shiyao-Huang/happy-server)
    `,
    version: '1.0.0',
    contact: {
      name: 'Aha Team',
      url: 'https://github.com/Shiyao-Huang/happy-server',
      email: 'hsy863551305@gmail.com'
    },
    license: {
      name: 'MIT',
      url: 'https://opensource.org/licenses/MIT'
    }
  },
  servers: getPublicApiServers(),
  tags: [
    { name: 'Authentication', description: 'User authentication and authorization' },
    { name: 'Sessions', description: 'Claude Code session management' },
    { name: 'Machines', description: 'Machine registration and heartbeat' },
    { name: 'Artifacts', description: 'Session artifacts and outputs' },
    { name: 'Push', description: 'Push notification management' },
    { name: 'Connect', description: 'AI vendor API key management' },
    { name: 'Account', description: 'User account operations' },
    { name: 'Access Keys', description: 'Access key management' },
    { name: 'Voice', description: 'Voice-related features' },
    { name: 'User', description: 'User profile and settings' },
    { name: 'Feed', description: 'Activity feed operations' },
    { name: 'KV', description: 'Key-Value storage' },
    { name: 'Team Messages', description: 'Team collaboration messaging' },
    { name: 'Dev', description: 'Development and debugging endpoints' }
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'JWT token obtained from /v1/auth endpoint'
      }
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'string',
            description: 'Error message'
          }
        },
        required: ['error']
      },
      Success: {
        type: 'object',
        properties: {
          success: {
            type: 'boolean',
            example: true
          }
        },
        required: ['success']
      }
    }
  },
  security: [
    {
      bearerAuth: []
    }
  ]
}

/**
 * Swagger UI options
 */
export const swaggerUiOptions = {
  routePrefix: '/docs',
  exposeRoute: true,
  swagger: {
    info: swaggerConfig.info,
    servers: swaggerConfig.servers,
    tags: swaggerConfig.tags,
    components: swaggerConfig.components,
    security: swaggerConfig.security,
    externalDocs: {
      description: 'Find out more about Aha',
      url: 'https://github.com/Shiyao-Huang/happy-server/blob/main/README.md'
    }
  },
  uiConfig: {
    docExpansion: 'list', // 'list' or 'full' or 'none'
    deepLinking: true,
    persistAuthorization: true,
    displayRequestDuration: true,
    filter: true,
    tryItOutEnabled: true,
    defaultModelsExpandDepth: 1,
    defaultModelExpandDepth: 1,
    displayOperationId: false,
    showExtensions: true,
    showCommonExtensions: true
  }
}
