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
 * Returns an empty object on malformed input (same defensive behaviour as aha-cli).
 */
export function parseGenomeSpec(specString: string): GenomeSpec {
    try {
        const parsed = JSON.parse(specString);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }
        return parsed as GenomeSpec;
    } catch {
        return {};
    }
}
