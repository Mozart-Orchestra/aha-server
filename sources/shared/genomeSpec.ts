/**
 * AgentImage — server-side compatibility projection for stored agent specs.
 *
 * happy-server still persists `Genome.spec` as a JSON string, but the current
 * design vocabulary is `AgentImage`. Keep `GenomeSpec` as a backward-compatible
 * alias so existing imports continue to compile while the stack converges on
 * the newer naming.
 *
 * Reference: aha-cli/src/api/types/genome.ts (canonical compatibility schema)
 * Coverage: server-relevant identity / routing / execution / behavior fields,
 * plus opaque blocks for canonical agent.json content that the server should
 * preserve without interpreting.
 */
export interface AgentImage {
    // Tier 0 — identity
    displayName?: string;
    description?: string;
    baseRoleId?: string;
    namespace?: string;
    version?: number;
    tags?: string[];
    category?: string;

    // Tier 1 — prompt
    systemPrompt?: string;
    systemPromptSuffix?: string;
    responsibilities?: string[];
    protocol?: string[];

    // Tier 2 — model
    modelId?: string;
    fallbackModelId?: string;
    modelProvider?: 'anthropic' | 'zhipu' | 'openai' | 'local';

    // Tier 3 — tool access
    allowedTools?: string[];
    disallowedTools?: string[];
    mcpServers?: string[];

    // Tier 4 — permissions / execution
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions';
    accessLevel?: 'read-only' | 'full-access';
    executionPlane?: 'mainline' | 'bypass';
    maxTurns?: number;
    authorities?: string[];

    // Tier 6 — team routing
    teamRole?: string;
    capabilities?: string[];

    // Tier 7 — messaging / behavior DNA
    messaging?: {
        listenFrom?: string[] | '*';
        receiveUserMessages?: boolean;
        replyMode?: 'proactive' | 'responsive' | 'passive';
    };
    behavior?: {
        onIdle?: 'wait' | 'self-assign' | 'ask';
        onBlocked?: 'report' | 'escalate' | 'retry';
        canSpawnAgents?: boolean;
        requireExplicitAssignment?: boolean;
    };

    // Tier 10 — lifecycle
    lifecycle?: 'experimental' | 'active' | 'deprecated';

    // Canonical agent.json payload blocks that happy-server passes through.
    workspace?: Record<string, unknown>;
    env?: Record<string, unknown>;
    evaluation?: Record<string, unknown>;
    evolution?: Record<string, unknown>;
    market?: Record<string, unknown>;
    package?: Record<string, unknown>;
    files?: Record<string, string>;

    // escape hatch
    meta?: Record<string, unknown>;
}

export type GenomeSpec = AgentImage;

/**
 * Parse a stored spec JSON string into a typed AgentImage object.
 * Throws when the payload is malformed or not a JSON object.
 */
export function parseGenomeSpec(specString: string): AgentImage {
    try {
        const parsed = JSON.parse(specString);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Genome spec must be a JSON object');
        }
        return parsed as AgentImage;
    } catch (error) {
        if (error instanceof Error && error.message === 'Genome spec must be a JSON object') {
            throw error;
        }

        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to parse genome spec: ${message}`);
    }
}

export const parseAgentImage = parseGenomeSpec;

/**
 * Sync the embedded `spec.version` field with the canonical Genome.version.
 * Throws when the payload is malformed or not a JSON object.
 */
export function syncGenomeSpecVersion(specString: string, version?: number | null): string {
    if (!Number.isInteger(version) || (version ?? 0) < 1) {
        throw new Error(`Genome spec version sync requires a positive integer version, received: ${String(version)}`);
    }

    try {
        const parsed = JSON.parse(specString);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Genome spec version sync requires a JSON object payload');
        }

        if ((parsed as AgentImage).version === version) {
            return specString;
        }

        return JSON.stringify({
            ...parsed,
            version,
        });
    } catch (error) {
        if (error instanceof Error && error.message === 'Genome spec version sync requires a JSON object payload') {
            throw error;
        }

        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Genome spec version sync failed: ${message}`);
    }
}
