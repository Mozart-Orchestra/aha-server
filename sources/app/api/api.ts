import fastify from "fastify";
import { log, logger } from "@/utils/log";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { onShutdown } from "@/utils/shutdown";
import { Fastify } from "./types";
import { authRoutes } from "./routes/authRoutes";
import { pushRoutes } from "./routes/pushRoutes";
import { sessionRoutes } from "./routes/sessionRoutes";
import { connectRoutes } from "./routes/connectRoutes";
import { accountRoutes } from "./routes/accountRoutes";
import { startSocket } from "./socket";
import { machinesRoutes } from "./routes/machinesRoutes";
import { devRoutes } from "./routes/devRoutes";
import { versionRoutes } from "./routes/versionRoutes";
import { voiceRoutes } from "./routes/voiceRoutes";
import { artifactsRoutes } from "./routes/artifactsRoutes";
import { accessKeysRoutes } from "./routes/accessKeysRoutes";
import { enableMonitoring } from "./utils/enableMonitoring";
import { enableErrorHandlers } from "./utils/enableErrorHandlers";
import { enableAuthentication } from "./utils/enableAuthentication";
import { enablePermissionInterceptor } from "./utils/enablePermissionInterceptor";
import { userRoutes } from "./routes/userRoutes";
import { feedRoutes } from "./routes/feedRoutes";
import { kvRoutes } from "./routes/kvRoutes";
import { teamMessagesRoutes } from "./routes/teamMessagesRoutes";
import { teamKeyRoutes } from "./routes/teamKeyRoutes";
import { taskRoutes } from "./routes/taskRoutes";
import { teamManagementRoutes } from "./routes/teamManagementRoutes";
import { evolutionRoutes } from "./routes/evolutionRoutes";
import { agentRoutes } from "./routes/agentRoutes";
import { teamContextRoutes } from "./routes/teamContextRoutes";
import { commerceObservabilityRoutes } from "./routes/commerceObservabilityRoutes";
import { marketListingRoutes } from "./routes/marketListingRoutes";
import { getCorsConfig } from "./utils/corsConfig";
import { getDefaultRateLimitConfig } from "./utils/rateLimitConfig";

export async function startApi() {

    // Configure
    log('Starting API...');

    // Start API
    const app = fastify({
        loggerInstance: logger,
        bodyLimit: 1024 * 1024 * 100, // 100MB
    });
    app.register(import('@fastify/cors'), getCorsConfig());

    // Security: Rate limiting to prevent brute force and DoS attacks
    await app.register(import('@fastify/rate-limit'), getDefaultRateLimitConfig());

    // Register Swagger for API documentation
    await app.register(await import('@fastify/swagger'), {
        openapi: {
            openapi: '3.0.0',
            info: {
                title: 'Aha Server API',
                description: 'Aha Server provides the backend infrastructure for the Aha CLI and team collaboration platform.',
                version: '1.0.0',
                contact: {
                    name: 'Aha Team',
                    url: 'https://github.com/slopus/aha-server',
                    email: 'steve@korshakov.com'
                },
                license: {
                    name: 'MIT',
                    url: 'https://opensource.org/licenses/MIT'
                }
            },
            servers: [
                {
                    url: 'http://localhost:3005',
                    description: 'Local development server'
                },
                {
                    url: 'https://top1vibe.com',
                    description: 'Production server'
                }
            ],
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
                }
            },
            security: [
                {
                    bearerAuth: []
                }
            ]
        }
    });

    await app.register(await import('@fastify/swagger-ui'), {
        routePrefix: '/docs',
        uiConfig: {
            docExpansion: 'list',
            deepLinking: true,
            persistAuthorization: true,
            displayRequestDuration: true,
            filter: true,
            tryItOutEnabled: true
        }
    });

    app.get('/', function (request, reply) {
        reply.send({
            message: 'Welcome to Aha Server!',
            docs: '/docs',
            health: '/health',
            version: '1.0.0'
        });
    });

    // Create typed provider
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;

    // Enable features
    enableMonitoring(typed);
    enableErrorHandlers(typed);
    enableAuthentication(typed);
    enablePermissionInterceptor(typed, {
        enabled: process.env.PERMISSION_INTERCEPTOR_ENABLED !== 'false',
        strictMode: process.env.PERMISSION_STRICT_MODE === 'true',
        auditLog: process.env.PERMISSION_AUDIT_LOG !== 'false',
        bypassPaths: ['/health', '/ping', '/metrics', '/api/health']
    });

    // Routes
    authRoutes(typed);
    pushRoutes(typed);
    sessionRoutes(typed);
    accountRoutes(typed);
    connectRoutes(typed);
    machinesRoutes(typed);
    artifactsRoutes(typed);
    accessKeysRoutes(typed);
    devRoutes(typed);
    versionRoutes(typed);
    voiceRoutes(typed);
    userRoutes(typed);
    feedRoutes(typed);
    kvRoutes(typed);
    teamMessagesRoutes(typed);
    teamKeyRoutes(typed);
    taskRoutes(typed);
    teamManagementRoutes(typed);
    evolutionRoutes(typed);
    agentRoutes(typed);
    teamContextRoutes(typed);
    commerceObservabilityRoutes(typed);
    marketListingRoutes(typed);

    // Start HTTP 
    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3005;
    await app.listen({ port, host: '0.0.0.0' });
    onShutdown('api', async () => {
        await app.close();
    });

    // Start Socket
    startSocket(typed);

    // End
    log('API ready on port http://localhost:' + port);
}
