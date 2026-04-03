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
    preferredModel?: string;
    modelScores?: Record<string, number>;

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
    contextInjections?: Array<{
        trigger: 'on_join' | 'per_tool_call' | 'on_context_threshold' | 'on_resume';
        threshold?: number;
        content: string;
    }>;

    // Tier 6 — team routing
    teamRole?: string;
    capabilities?: string[];
    handoffProtocol?: string[];

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
        lifecycle?: 'single-shot' | 'persistent' | 'on-demand';
        autoRetireAfterComplete?: boolean;
    };

    // Tier 7.5 — memory / operations / governance
    memory?: {
        type?: 'session' | 'persistent' | 'shared';
        learnings?: string[];
        iterationGuide?: Record<string, unknown>;
        knowledgeBase?: string[];
    };
    scopeOfResponsibility?: {
        ownedPaths?: string[];
        forbiddenPaths?: string[];
        outOfScope?: string[];
    };
    resume?: Record<string, unknown>;
    operations?: {
        commonPatterns?: string[];
        recentChanges?: string[];
        runtimeConfig?: string;
    };
    compatibility?: {
        worksWellWith?: string[];
        requiredMcpServers?: string[];
        requiredEnvVars?: string[];
        minContextTokens?: number;
    };
    validation?: {
        smokeTest?: {
            requiredTools?: string[];
            requiredFiles?: string[];
            healthChecks?: string[];
        };
        minVerifiedScore?: number;
        minEvaluations?: number;
    };
    resourceBudget?: {
        estimatedTokensPerTask?: number;
        contextWindowSize?: 'small' | 'medium' | 'large';
        concurrencyCapable?: boolean;
    };
    costProfile?: {
        typicalTokens?: number;
        contextWindowReq?: number;
    };

    // Tier 10 — lifecycle
    lifecycle?: 'experimental' | 'active' | 'deprecated';
    runtimeType?: 'claude' | 'codex' | 'open-code';
    trigger?: {
        mode?: 'mention' | 'task-assign' | 'scheduled' | 'event';
        conditions?: string[];
    };
    provenance?: {
        parentId?: string;
        mutationNote?: string;
        origin?: 'original' | 'forked' | 'mutated';
    };
    evalCriteria?: string[];
    schedule?: {
        interval?: string;
        maxConcurrent?: number;
        enabled?: boolean;
    };
    onMessage?: {
        patterns?: string[];
        senderRoles?: string[];
        priority?: 'normal' | 'high' | 'urgent';
    };
    onTaskChange?: {
        events?: Array<'created' | 'assigned' | 'blocked' | 'review' | 'completed'>;
        assignedOnly?: boolean;
    };
    hooks?: {
        preToolUse?: Array<{ matcher: string; command: string; description?: string }>;
        postToolUse?: Array<{ matcher: string; command: string; description?: string }>;
        stop?: Array<{ command: string; description?: string }>;
    };
    skills?: string[];

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
