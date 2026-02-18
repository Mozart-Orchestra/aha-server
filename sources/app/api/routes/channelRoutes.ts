import { z } from "zod";
import { Fastify } from "../types";
import { kvGet } from "@/app/kv/kvGet";
import { kvList } from "@/app/kv/kvList";
import { kvMutate } from "@/app/kv/kvMutate";
import { log } from "@/utils/log";
import { encryptString, decryptString } from "@/modules/encrypt";
import { randomUUID } from "node:crypto";

/**
 * API Channel Routes - Multi-Provider API Key Management
 *
 * Allows users to configure multiple API provider keys (Anthropic, OpenAI, Google, DeepSeek, custom).
 * API keys are encrypted using the server's encryption module before storage.
 *
 * Each channel has:
 * - id: Unique identifier
 * - name: User-friendly name
 * - provider: Provider type (anthropic, openai, google, deepseek, custom)
 * - apiKey: Encrypted API key
 * - baseUrl: Optional custom base URL
 * - models: List of available models for this channel
 */

// Supported providers
const ProviderSchema = z.enum(['anthropic', 'openai', 'google', 'deepseek', 'custom']);

// Schema for API channel
const ApiChannelSchema = z.object({
    id: z.string().optional(), // Auto-generated if not provided
    name: z.string().min(1).max(100),
    provider: ProviderSchema,
    apiKey: z.string().min(1), // Will be encrypted before storage
    baseUrl: z.string().url().optional(),
    models: z.array(z.object({
        id: z.string(),
        label: z.string(),
        tier: z.enum(['opus', 'sonnet', 'haiku', 'premium', 'standard', 'economy']).optional(),
    })).optional(),
    isDefault: z.boolean().optional().default(false),
    isActive: z.boolean().optional().default(true),
});

// Schema for stored channel (with encrypted key)
const StoredChannelSchema = z.object({
    id: z.string(),
    name: z.string(),
    provider: ProviderSchema,
    encryptedKey: z.instanceof(Uint8Array), // Encrypted API key
    baseUrl: z.string().optional(),
    models: z.array(z.object({
        id: z.string(),
        label: z.string(),
        tier: z.enum(['opus', 'sonnet', 'haiku', 'premium', 'standard', 'economy']).optional(),
    })).optional(),
    isDefault: z.boolean(),
    isActive: z.boolean(),
    createdAt: z.number(),
    updatedAt: z.number(),
});

// Schema for channel response (without exposing API key)
const ChannelResponseSchema = z.object({
    id: z.string(),
    name: z.string(),
    provider: ProviderSchema,
    baseUrl: z.string().optional(),
    models: z.array(z.object({
        id: z.string(),
        label: z.string(),
        tier: z.enum(['opus', 'sonnet', 'haiku', 'premium', 'standard', 'economy']).optional(),
    })).optional(),
    isDefault: z.boolean(),
    isActive: z.boolean(),
    hasApiKey: z.boolean(), // Indicates if API key is set
    createdAt: z.number(),
    updatedAt: z.number(),
});

// KV key prefix for API channels
const CHANNELS_PREFIX = 'channels.';

// Default models per provider
const DEFAULT_MODELS: Record<string, Array<{ id: string; label: string; tier: 'opus' | 'sonnet' | 'haiku' | 'premium' | 'standard' | 'economy' }>> = {
    anthropic: [
        { id: 'claude-opus-4-5', label: 'Claude Opus 4.5', tier: 'opus' },
        { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', tier: 'sonnet' },
        { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', tier: 'haiku' },
    ],
    openai: [
        { id: 'gpt-4o', label: 'GPT-4o', tier: 'premium' },
        { id: 'gpt-4o-mini', label: 'GPT-4o Mini', tier: 'standard' },
        { id: 'o1', label: 'o1', tier: 'premium' },
        { id: 'o1-mini', label: 'o1 Mini', tier: 'standard' },
    ],
    google: [
        { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', tier: 'premium' },
        { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', tier: 'standard' },
    ],
    deepseek: [
        { id: 'deepseek-chat', label: 'DeepSeek Chat', tier: 'standard' },
        { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner', tier: 'premium' },
    ],
    custom: [],
};

/**
 * Generate a unique channel ID
 */
function generateChannelId(): string {
    return `channel-${randomUUID().slice(0, 8)}`;
}

/**
 * Parse channel from KV storage
 */
function parseChannel(value: string): z.infer<typeof StoredChannelSchema> | null {
    try {
        const parsed = JSON.parse(value);
        // Convert encryptedKey back to Uint8Array if it's an array
        if (Array.isArray(parsed.encryptedKey)) {
            parsed.encryptedKey = new Uint8Array(parsed.encryptedKey);
        }
        return parsed;
    } catch {
        return null;
    }
}

/**
 * Serialize channel for KV storage
 */
function serializeChannel(channel: z.infer<typeof StoredChannelSchema>): string {
    // Convert Uint8Array to array for JSON serialization
    return JSON.stringify({
        ...channel,
        encryptedKey: Array.from(channel.encryptedKey),
    });
}

/**
 * Convert stored channel to response (without API key)
 */
function toChannelResponse(channel: z.infer<typeof StoredChannelSchema>): z.infer<typeof ChannelResponseSchema> {
    return {
        id: channel.id,
        name: channel.name,
        provider: channel.provider,
        baseUrl: channel.baseUrl,
        models: channel.models,
        isDefault: channel.isDefault,
        isActive: channel.isActive,
        hasApiKey: channel.encryptedKey.length > 0,
        createdAt: channel.createdAt,
        updatedAt: channel.updatedAt,
    };
}

export function channelRoutes(app: Fastify) {
    log({ module: 'api' }, 'Registering channelRoutes...');

    // GET /v1/channels - List user's API channels
    app.get('/v1/channels', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    channels: z.array(ChannelResponseSchema),
                    total: z.number()
                }),
                500: z.object({
                    error: z.literal('Failed to list channels')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;

        try {
            const result = await kvList({ uid: userId }, { prefix: CHANNELS_PREFIX, limit: 100 });
            const channels: z.infer<typeof ChannelResponseSchema>[] = [];

            for (const item of result.items) {
                const channel = parseChannel(item.value);
                if (channel) {
                    channels.push(toChannelResponse(channel));
                }
            }

            return reply.send({
                channels,
                total: channels.length
            });
        } catch (error) {
            log({ module: 'channel-routes', level: 'error' }, `Failed to list channels: ${error}`);
            return reply.code(500).send({ error: 'Failed to list channels' });
        }
    });

    // GET /v1/channels/:id - Get single channel (without API key)
    app.get('/v1/channels/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            response: {
                200: ChannelResponseSchema,
                404: z.object({
                    error: z.literal('Channel not found')
                }),
                500: z.object({
                    error: z.literal('Failed to get channel')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params as { id: string };

        try {
            const result = await kvGet({ uid: userId }, `${CHANNELS_PREFIX}${id}`);

            if (!result) {
                return reply.code(404).send({ error: 'Channel not found' });
            }

            const channel = parseChannel(result.value);
            if (!channel) {
                return reply.code(404).send({ error: 'Channel not found' });
            }

            return reply.send(toChannelResponse(channel));
        } catch (error) {
            log({ module: 'channel-routes', level: 'error' }, `Failed to get channel: ${error}`);
            return reply.code(500).send({ error: 'Failed to get channel' });
        }
    });

    // POST /v1/channels - Create API channel
    app.post('/v1/channels', {
        preHandler: app.authenticate,
        schema: {
            body: ApiChannelSchema,
            response: {
                200: z.object({
                    success: z.literal(true),
                    channel: ChannelResponseSchema
                }),
                400: z.object({
                    error: z.string()
                }),
                409: z.object({
                    error: z.literal('Channel with this ID already exists')
                }),
                500: z.object({
                    error: z.literal('Failed to create channel')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const channelData = request.body as z.infer<typeof ApiChannelSchema>;

        try {
            // Generate ID if not provided
            const channelId = channelData.id || generateChannelId();

            // Check if channel already exists
            const existing = await kvGet({ uid: userId }, `${CHANNELS_PREFIX}${channelId}`);
            if (existing) {
                return reply.code(409).send({ error: 'Channel with this ID already exists' });
            }

            // Encrypt the API key
            const encryptedKey = encryptString(
                ['channels', userId, channelId],
                channelData.apiKey
            );

            // Use default models if not provided
            const models = channelData.models || DEFAULT_MODELS[channelData.provider] || [];

            // Create channel
            const channel: z.infer<typeof StoredChannelSchema> = {
                id: channelId,
                name: channelData.name,
                provider: channelData.provider,
                encryptedKey,
                baseUrl: channelData.baseUrl,
                models,
                isDefault: channelData.isDefault ?? false,
                isActive: channelData.isActive ?? true,
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };

            // Store in KV
            await kvMutate({ uid: userId }, [{
                key: `${CHANNELS_PREFIX}${channelId}`,
                value: serializeChannel(channel),
                version: -1 // New key
            }]);

            // If this is set as default, unset other defaults
            if (channel.isDefault) {
                const result = await kvList({ uid: userId }, { prefix: CHANNELS_PREFIX, limit: 100 });
                for (const item of result.items) {
                    const existingChannel = parseChannel(item.value);
                    if (existingChannel && existingChannel.id !== channelId && existingChannel.isDefault) {
                        existingChannel.isDefault = false;
                        existingChannel.updatedAt = Date.now();
                        await kvMutate({ uid: userId }, [{
                            key: `${CHANNELS_PREFIX}${existingChannel.id}`,
                            value: serializeChannel(existingChannel),
                            version: item.version
                        }]);
                    }
                }
            }

            log({ module: 'channel-routes', channelId }, 'API channel created');
            return reply.send({ success: true, channel: toChannelResponse(channel) });
        } catch (error) {
            log({ module: 'channel-routes', level: 'error' }, `Failed to create channel: ${error}`);
            return reply.code(500).send({ error: 'Failed to create channel' });
        }
    });

    // PUT /v1/channels/:id - Update API channel
    app.put('/v1/channels/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            body: ApiChannelSchema.partial(),
            response: {
                200: z.object({
                    success: z.literal(true),
                    channel: ChannelResponseSchema
                }),
                404: z.object({
                    error: z.literal('Channel not found')
                }),
                409: z.object({
                    error: z.literal('Version mismatch')
                }),
                500: z.object({
                    error: z.literal('Failed to update channel')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params as { id: string };
        const updates = request.body as Partial<z.infer<typeof ApiChannelSchema>>;

        try {
            // Get existing channel
            const existing = await kvGet({ uid: userId }, `${CHANNELS_PREFIX}${id}`);
            if (!existing) {
                return reply.code(404).send({ error: 'Channel not found' });
            }

            const existingChannel = parseChannel(existing.value);
            if (!existingChannel) {
                return reply.code(404).send({ error: 'Channel not found' });
            }

            // Update fields
            const updatedChannel: z.infer<typeof StoredChannelSchema> = {
                ...existingChannel,
                name: updates.name ?? existingChannel.name,
                provider: updates.provider ?? existingChannel.provider,
                baseUrl: updates.baseUrl ?? existingChannel.baseUrl,
                models: updates.models ?? existingChannel.models,
                isDefault: updates.isDefault ?? existingChannel.isDefault,
                isActive: updates.isActive ?? existingChannel.isActive,
                updatedAt: Date.now(),
            };

            // Update API key if provided
            if (updates.apiKey) {
                updatedChannel.encryptedKey = encryptString(
                    ['channels', userId, id],
                    updates.apiKey
                );
            }

            // Store updated channel
            await kvMutate({ uid: userId }, [{
                key: `${CHANNELS_PREFIX}${id}`,
                value: serializeChannel(updatedChannel),
                version: existing.version
            }]);

            // If this is set as default, unset other defaults
            if (updatedChannel.isDefault && !existingChannel.isDefault) {
                const result = await kvList({ uid: userId }, { prefix: CHANNELS_PREFIX, limit: 100 });
                for (const item of result.items) {
                    const otherChannel = parseChannel(item.value);
                    if (otherChannel && otherChannel.id !== id && otherChannel.isDefault) {
                        otherChannel.isDefault = false;
                        otherChannel.updatedAt = Date.now();
                        await kvMutate({ uid: userId }, [{
                            key: `${CHANNELS_PREFIX}${otherChannel.id}`,
                            value: serializeChannel(otherChannel),
                            version: item.version
                        }]);
                    }
                }
            }

            log({ module: 'channel-routes', channelId: id }, 'API channel updated');
            return reply.send({ success: true, channel: toChannelResponse(updatedChannel) });
        } catch (error: any) {
            if (error.message?.includes('version')) {
                return reply.code(409).send({ error: 'Version mismatch' });
            }
            log({ module: 'channel-routes', level: 'error' }, `Failed to update channel: ${error}`);
            return reply.code(500).send({ error: 'Failed to update channel' });
        }
    });

    // DELETE /v1/channels/:id - Delete API channel
    app.delete('/v1/channels/:id', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            response: {
                200: z.object({
                    success: z.literal(true)
                }),
                404: z.object({
                    error: z.literal('Channel not found')
                }),
                500: z.object({
                    error: z.literal('Failed to delete channel')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params as { id: string };

        try {
            // Check if channel exists
            const existing = await kvGet({ uid: userId }, `${CHANNELS_PREFIX}${id}`);
            if (!existing) {
                return reply.code(404).send({ error: 'Channel not found' });
            }

            // Delete by setting value to null
            await kvMutate({ uid: userId }, [{
                key: `${CHANNELS_PREFIX}${id}`,
                value: null,
                version: existing.version
            }]);

            log({ module: 'channel-routes', channelId: id }, 'API channel deleted');
            return reply.send({ success: true });
        } catch (error) {
            log({ module: 'channel-routes', level: 'error' }, `Failed to delete channel: ${error}`);
            return reply.code(500).send({ error: 'Failed to delete channel' });
        }
    });

    // POST /v1/channels/:id/validate - Test channel connection
    app.post('/v1/channels/:id/validate', {
        preHandler: app.authenticate,
        schema: {
            params: z.object({
                id: z.string()
            }),
            response: {
                200: z.object({
                    success: z.literal(true),
                    valid: z.boolean(),
                    message: z.string().optional(),
                    models: z.array(z.string()).optional()
                }),
                404: z.object({
                    error: z.literal('Channel not found')
                }),
                500: z.object({
                    error: z.literal('Failed to validate channel')
                })
            }
        }
    }, async (request, reply) => {
        const userId = request.userId;
        const { id } = request.params as { id: string };

        try {
            const existing = await kvGet({ uid: userId }, `${CHANNELS_PREFIX}${id}`);
            if (!existing) {
                return reply.code(404).send({ error: 'Channel not found' });
            }

            const channel = parseChannel(existing.value);
            if (!channel) {
                return reply.code(404).send({ error: 'Channel not found' });
            }

            // Decrypt API key for validation
            const apiKey = decryptString(['channels', userId, id], channel.encryptedKey);

            // Validate connection based on provider
            let valid = false;
            let message = '';
            const models: string[] = [];

            try {
                const providerBaseUrls: Record<string, string | undefined> = {
                    anthropic: 'https://api.anthropic.com',
                    openai: 'https://api.openai.com',
                    google: 'https://generativelanguage.googleapis.com',
                    deepseek: 'https://api.deepseek.com',
                    custom: undefined, // Custom requires explicit baseUrl
                };
                const baseUrl = channel.baseUrl || providerBaseUrls[channel.provider];

                if (!baseUrl) {
                    message = 'No base URL configured for custom provider';
                } else {
                    // For now, just check if the key looks valid (basic format check)
                    // Real validation would make an API call
                    if (apiKey.length < 10) {
                        message = 'API key appears too short';
                    } else {
                        valid = true;
                        message = 'API key format looks valid';
                        models.push(...(channel.models?.map(m => m.id) || []));
                    }
                }
            } catch (validationError) {
                message = `Validation failed: ${validationError instanceof Error ? validationError.message : 'Unknown error'}`;
            }

            return reply.send({
                success: true,
                valid,
                message,
                models: valid ? models : undefined
            });
        } catch (error) {
            log({ module: 'channel-routes', level: 'error' }, `Failed to validate channel: ${error}`);
            return reply.code(500).send({ error: 'Failed to validate channel' });
        }
    });

    // GET /v1/channels/providers/list - List supported providers
    app.get('/v1/channels/providers/list', {
        preHandler: app.authenticate,
        schema: {
            response: {
                200: z.object({
                    providers: z.array(z.object({
                        id: z.string(),
                        name: z.string(),
                        defaultBaseUrl: z.string().optional(),
                        defaultModels: z.array(z.object({
                            id: z.string(),
                            label: z.string(),
                            tier: z.string().optional()
                        }))
                    }))
                })
            }
        }
    }, async (request, reply) => {
        const providers = [
            {
                id: 'anthropic',
                name: 'Anthropic',
                defaultBaseUrl: 'https://api.anthropic.com',
                defaultModels: DEFAULT_MODELS.anthropic
            },
            {
                id: 'openai',
                name: 'OpenAI',
                defaultBaseUrl: 'https://api.openai.com',
                defaultModels: DEFAULT_MODELS.openai
            },
            {
                id: 'google',
                name: 'Google AI',
                defaultBaseUrl: 'https://generativelanguage.googleapis.com',
                defaultModels: DEFAULT_MODELS.google
            },
            {
                id: 'deepseek',
                name: 'DeepSeek',
                defaultBaseUrl: 'https://api.deepseek.com',
                defaultModels: DEFAULT_MODELS.deepseek
            },
            {
                id: 'custom',
                name: 'Custom Endpoint',
                defaultModels: []
            }
        ];

        return reply.send({ providers });
    });
}
