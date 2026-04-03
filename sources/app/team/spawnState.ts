import { z } from 'zod';

export const SpawnRunStatusSchema = z.enum(['pending', 'active', 'failed']);

export type SpawnRunStatus = z.infer<typeof SpawnRunStatusSchema>;

export const AgentArtifactStatusSchema = z.enum(['active', 'paused', 'archived', 'pending', 'failed']);

export type AgentArtifactStatus = z.infer<typeof AgentArtifactStatusSchema>;

export const AgentLifecycleSchema = z.object({
    runStatus: SpawnRunStatusSchema.optional(),
    spawnRequestedAt: z.number().int().optional(),
    spawnedAt: z.number().int().optional(),
    processStartedAt: z.number().int().optional(),
    handshakeReadyAt: z.number().int().optional(),
    taskAckedAt: z.number().int().optional(),
    taskAckedTaskId: z.string().optional(),
}).passthrough();

export type AgentLifecycle = z.infer<typeof AgentLifecycleSchema>;

export function normalizeAgentLifecycle(input: unknown): AgentLifecycle | null {
    if (!input || typeof input !== 'object') {
        return null;
    }
    const parsed = AgentLifecycleSchema.safeParse(input);
    return parsed.success ? parsed.data : null;
}

export function getLifecycleRunStatus(lifecycle: AgentLifecycle | null | undefined): SpawnRunStatus | null {
    return lifecycle?.runStatus ?? null;
}

export function buildPendingAgentLifecycle(current?: AgentLifecycle | null, now = Date.now()): AgentLifecycle {
    return {
        ...(current ?? {}),
        spawnRequestedAt: current?.spawnRequestedAt ?? now,
        runStatus: 'pending',
    };
}

export function buildActiveAgentLifecycle(current?: AgentLifecycle | null, now = Date.now()): AgentLifecycle {
    return {
        ...(current ?? {}),
        spawnRequestedAt: current?.spawnRequestedAt ?? now,
        spawnedAt: current?.spawnedAt ?? now,
        runStatus: 'active',
    };
}

export function buildFailedAgentLifecycle(current?: AgentLifecycle | null, now = Date.now()): AgentLifecycle {
    return {
        ...(current ?? {}),
        spawnRequestedAt: current?.spawnRequestedAt ?? now,
        runStatus: 'failed',
    };
}
