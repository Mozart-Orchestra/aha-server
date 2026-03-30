/**
 * GenomeSpec — agent configuration schema (TypeScript interface).
 *
 * happy-server stores GenomeSpec as a JSON string in the Genome.spec column.
 * This file provides a typed interface for accessing parsed spec content,
 * eliminating bare `JSON.parse` calls with `unknown` return types.
 *
 * Reference: aha-cli/src/api/types/genome.ts (canonical definition)
 * Tier coverage: Tier 0 (identity) through Tier 7 (messaging/behavior)
 */

/** Tier 0 + 1 + 2 + 3 + 4 + 6 + 7 fields most relevant to the server layer */
export interface GenomeSpec {
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

    // escape hatch
    meta?: Record<string, unknown>;
}

/**
 * Parse a stored spec JSON string into a typed GenomeSpec object.
 * Throws when the payload is malformed or not a JSON object.
 */
export function parseGenomeSpec(specString: string): GenomeSpec {
    try {
        const parsed = JSON.parse(specString);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('Genome spec must be a JSON object');
        }
        return parsed as GenomeSpec;
    } catch (error) {
        if (error instanceof Error && error.message === 'Genome spec must be a JSON object') {
            throw error;
        }

        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to parse genome spec: ${message}`);
    }
}

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

        if ((parsed as GenomeSpec).version === version) {
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
