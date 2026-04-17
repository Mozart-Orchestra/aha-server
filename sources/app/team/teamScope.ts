import path from 'node:path';

export type TeamScopeVisibility = 'scoped' | 'global';

export interface TeamScope {
    scopePath: string;
    scopeLabel?: string;
    repoName?: string;
    visibility?: TeamScopeVisibility;
}

export interface TeamScopeFilter {
    scopePath?: string;
    repoName?: string;
    includeGlobal?: boolean;
}

const KNOWN_REPO_PREFIXES = ['aha-cli', 'genome-hub', 'happy-server', 'kanban'] as const;

function normalizeString(value: unknown): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeVisibility(value: unknown): TeamScopeVisibility | undefined {
    return value === 'global' || value === 'scoped' ? value : undefined;
}

function deriveRepoNameFromLabel(label: string): string {
    for (const prefix of KNOWN_REPO_PREFIXES) {
        if (label === prefix || label.startsWith(`${prefix}-`)) {
            return prefix;
        }
    }

    const parts = label.split('-');
    if (parts.length >= 2) {
        return `${parts[0]}-${parts[1]}`;
    }
    return label;
}

export function normalizeTeamScope(value: unknown): TeamScope | null {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const raw = value as Record<string, unknown>;
    const scopePath = normalizeString(raw.scopePath);
    if (!scopePath) {
        return null;
    }

    const scopeLabel = normalizeString(raw.scopeLabel);
    const repoName = normalizeString(raw.repoName)
        ?? (scopeLabel ? deriveRepoNameFromLabel(scopeLabel) : deriveRepoNameFromLabel(path.basename(scopePath)));
    const visibility = normalizeVisibility(raw.visibility) ?? 'scoped';

    return {
        scopePath,
        ...(scopeLabel ? { scopeLabel } : {}),
        ...(repoName ? { repoName } : {}),
        visibility,
    };
}

export function buildTeamScopeFromMetadata(value: unknown): TeamScope | null {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const raw = value as Record<string, unknown>;
    const scopePath = normalizeString(raw.path);
    if (!scopePath) {
        return null;
    }

    const runtimeBuild = raw.runtimeBuild && typeof raw.runtimeBuild === 'object'
        ? raw.runtimeBuild as Record<string, unknown>
        : null;
    const scopeLabel = normalizeString(runtimeBuild?.worktreeName) ?? path.basename(scopePath);
    const repoName = deriveRepoNameFromLabel(scopeLabel);

    return {
        scopePath,
        scopeLabel,
        repoName,
        visibility: 'scoped',
    };
}

export function matchesTeamScopeFilter(scope: unknown, filter?: TeamScopeFilter): boolean {
    if (!filter?.scopePath && !filter?.repoName) {
        return true;
    }

    const includeGlobal = filter.includeGlobal !== false;
    const normalized = normalizeTeamScope(scope);
    if (!normalized) {
        return includeGlobal;
    }

    if (normalized.visibility === 'global') {
        return includeGlobal;
    }

    if (filter.scopePath && normalized.scopePath === filter.scopePath) {
        return true;
    }

    if (filter.repoName && normalized.repoName === filter.repoName) {
        return true;
    }

    return false;
}
