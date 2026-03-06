export type RoleMarketSource = 'default' | 'custom' | 'public';
export type RoleMarketAccessKey = 'defaults' | 'workspace-private' | 'workspace-shared' | 'market-public';
export type RoleMarketVariantSource = 'server-template' | 'workspace-custom' | 'public-market';

export interface RoleMarketStats {
    reviewCount: number;
    completionCount: number;
    totalRating: number;
    averageRating: number;
    cumulativeCode: number;
    cumulativeQuality: number;
    sourceScoreTotals: {
        user: number;
        master: number;
        system: number;
    };
    lastReviewedAt?: number;
}

export interface RoleMarketCandidate {
    id: string;
    title: string;
    summary?: string;
    icon?: string;
    ownerId?: string;
    source: RoleMarketSource;
    visibility?: 'public' | 'private';
    templateSource?: string;
    assignedSkills?: string[];
    stats?: RoleMarketStats;
}

export interface RoleMarketVariantSnapshot {
    id: string;
    label: string;
    source: RoleMarketVariantSource;
    detail: string;
}

export interface RoleMarketAccess {
    key: RoleMarketAccessKey;
    label: string;
}

export interface RoleMarketRole {
    id: string;
    title: string;
    summary: string;
    icon?: string;
    ownerId?: string;
    source: RoleMarketSource;
    assignedSkills: string[];
    stats?: RoleMarketStats;
    score: number;
    why: string[];
    goalMatches: string[];
    variant: RoleMarketVariantSnapshot;
    access: RoleMarketAccess;
}

export interface BuildRoleMarketSnapshotInput {
    goal?: string;
    context?: string;
    inferredFocus?: string[];
    limit?: number;
    search?: string;
    candidates: RoleMarketCandidate[];
}

export interface RoleMarketSnapshot {
    inferredFocus: string[];
    recommendations: RoleMarketRole[];
    roles: RoleMarketRole[];
}

const SOURCE_PRIORITY: Record<RoleMarketSource, number> = {
    default: 0,
    custom: 1,
    public: 2,
};

const FOCUS_KEYWORDS: Record<string, string[]> = {
    deployment: ['deploy', 'release', 'ops', 'devops', 'infra', '发布', '部署', '上线', '运维'],
    backend: ['backend', 'server', 'api', 'route', 'db', 'database', 'prisma', 'redis', '后端'],
    frontend: ['frontend', 'ui', 'web', 'react', 'expo', 'kanban', '前端', '页面', '交互'],
    orchestration: ['team', 'role', 'agent', 'orchestrator', 'master', 'coordinator', 'lead', '协作', '角色', '调度', '编组'],
    research: ['research', 'analyst', 'investigate', 'analyze', '分析', '调研', '复盘'],
    quality: ['qa', 'review', 'reviewer', 'test', 'quality', 'bug', '验证', '质量', '回归'],
    delivery: ['build', 'implement', 'builder', 'ship', 'delivery', 'coding', '开发', '实现'],
};

function normalizeKeyword(value: string): string {
    return value.trim().toLowerCase();
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function matchesSearch(role: RoleMarketRole, search?: string): boolean {
    const normalizedSearch = normalizeKeyword(search || '');
    if (!normalizedSearch) {
        return true;
    }

    const normalizedSkillSearch = normalizedSearch.startsWith('#')
        ? normalizedSearch.slice(1)
        : normalizedSearch;

    const haystacks = [
        role.id,
        role.title,
        role.summary,
        role.source,
        role.access.label,
        role.variant.label,
        role.variant.detail,
        role.score.toString(),
        role.stats?.averageRating?.toString() || '',
        role.stats?.reviewCount?.toString() || '',
        ...role.goalMatches,
        ...role.why,
        ...role.assignedSkills,
    ].map((value) => normalizeKeyword(value));

    return haystacks.some((value) => value.includes(normalizedSearch) || value.includes(normalizedSkillSearch));
}

function deriveRoleFocus(candidate: RoleMarketCandidate): string[] {
    const text = normalizeKeyword([
        candidate.id,
        candidate.title,
        candidate.summary || '',
        ...(candidate.assignedSkills || []),
    ].join(' '));

    const focus = Object.entries(FOCUS_KEYWORDS)
        .filter(([, keywords]) => keywords.some((keyword) => text.includes(keyword)))
        .map(([key]) => key);

    return focus.length > 0 ? focus : ['delivery'];
}

function formatFocusLabel(focus: string): string {
    if (focus === 'backend') return 'backend';
    if (focus === 'frontend') return 'frontend';
    if (focus === 'deployment') return 'deployment';
    if (focus === 'orchestration') return 'team orchestration';
    if (focus === 'research') return 'research';
    if (focus === 'quality') return 'quality';
    return 'delivery';
}

function buildAccess(candidate: RoleMarketCandidate): RoleMarketAccess {
    if (candidate.source === 'default') {
        return {
            key: 'defaults',
            label: 'Server default',
        };
    }

    if (candidate.source === 'custom') {
        if (candidate.visibility === 'private') {
            return {
                key: 'workspace-private',
                label: 'Private workspace',
            };
        }

        return {
            key: 'workspace-shared',
            label: 'My published role',
        };
    }

    return {
        key: 'market-public',
        label: 'Public market',
    };
}

function buildVariant(candidate: RoleMarketCandidate): RoleMarketVariantSnapshot {
    if (candidate.source === 'default') {
        return {
            id: `default:${candidate.id}`,
            label: 'Template variant',
            source: 'server-template',
            detail: candidate.templateSource
                ? `Seeded from ${candidate.templateSource}`
                : 'Seeded from the canonical server role template library.',
        };
    }

    if (candidate.source === 'custom') {
        return {
            id: `custom:${candidate.id}`,
            label: candidate.visibility === 'private' ? 'Private variant' : 'Workspace variant',
            source: 'workspace-custom',
            detail: candidate.visibility === 'private'
                ? 'Scoped to your workspace until you publish or share it.'
                : 'Published from your workspace and ready for reuse.',
        };
    }

    return {
        id: `public:${candidate.id}`,
        label: 'Market snapshot',
        source: 'public-market',
        detail: 'Evidence-backed snapshot from the public role market.',
    };
}

function buildScore(candidate: RoleMarketCandidate, inferredFocus: string[], roleFocus: string[]): number {
    const stats = candidate.stats;
    const reviewScore = stats ? (stats.averageRating / 5) * 34 : 0;
    const reviewVolumeScore = stats ? Math.min(stats.reviewCount, 24) * 1.1 : 0;
    const completionScore = stats ? Math.min(stats.completionCount, 20) * 0.6 : 0;
    const evidenceScore = stats ? Math.min(stats.cumulativeQuality + stats.cumulativeCode, 160) / 16 : 0;
    const focusScore = inferredFocus.reduce((sum, focus) => sum + (roleFocus.includes(focus) ? 10 : 0), 0);
    const sourceScore = candidate.source === 'default' ? 12 : candidate.source === 'custom' ? 10 : 8;
    const freshnessScore = stats?.lastReviewedAt ? 4 : 0;

    return Number(clamp(reviewScore + reviewVolumeScore + completionScore + evidenceScore + focusScore + sourceScore + freshnessScore, 0, 100).toFixed(1));
}

function buildReasons(candidate: RoleMarketCandidate, inferredFocus: string[], roleFocus: string[]): string[] {
    const reasons: string[] = [];
    const matchedFocus = inferredFocus.filter((focus) => roleFocus.includes(focus));
    const stats = candidate.stats;

    if (matchedFocus.length > 0) {
        reasons.push(`Matches ${matchedFocus.map(formatFocusLabel).join(' + ')} goals from your brief.`);
    }

    if (stats && stats.reviewCount > 0) {
        reasons.push(`${stats.averageRating.toFixed(1)}★ from ${stats.reviewCount} review${stats.reviewCount === 1 ? '' : 's'} in the shared registry.`);
    }

    if (stats && stats.completionCount > 0) {
        reasons.push(`${stats.completionCount} recorded completion${stats.completionCount === 1 ? '' : 's'} strengthen this recommendation.`);
    }

    if (candidate.assignedSkills && candidate.assignedSkills.length > 0) {
        reasons.push(`Key skills: ${candidate.assignedSkills.slice(0, 3).join(', ')}.`);
    }

    if (candidate.source === 'default') {
        reasons.push('Available immediately as a server-managed default template.');
    } else if (candidate.source === 'custom') {
        reasons.push(candidate.visibility === 'private'
            ? 'Already available in your private workspace for this team.'
            : 'Already published from your workspace with reusable market metadata.');
    } else {
        reasons.push('Pulled from the public market pool with portable evidence attached.');
    }

    return reasons.slice(0, 4);
}

function uniqueCandidatesByPreferredSource(candidates: RoleMarketCandidate[]): RoleMarketCandidate[] {
    const deduped = new Map<string, RoleMarketCandidate>();

    for (const candidate of candidates) {
        const existing = deduped.get(candidate.id);
        if (!existing || SOURCE_PRIORITY[candidate.source] < SOURCE_PRIORITY[existing.source]) {
            deduped.set(candidate.id, candidate);
        }
    }

    return Array.from(deduped.values());
}

export function buildRoleMarketSnapshot({
    goal,
    context,
    inferredFocus = [],
    limit = 4,
    search,
    candidates,
}: BuildRoleMarketSnapshotInput): RoleMarketSnapshot {
    const normalizedFocus = inferredFocus.length > 0
        ? Array.from(new Set(inferredFocus))
        : [goal, context].filter(Boolean).length > 0
            ? ['delivery']
            : [];

    const roles = uniqueCandidatesByPreferredSource(candidates)
        .map((candidate) => {
            const roleFocus = deriveRoleFocus(candidate);
            return {
                id: candidate.id,
                title: candidate.title,
                summary: candidate.summary?.trim() || 'No role summary yet.',
                icon: candidate.icon,
                ownerId: candidate.ownerId,
                source: candidate.source,
                assignedSkills: candidate.assignedSkills || [],
                stats: candidate.stats,
                score: buildScore(candidate, normalizedFocus, roleFocus),
                why: buildReasons(candidate, normalizedFocus, roleFocus),
                goalMatches: normalizedFocus.filter((focus) => roleFocus.includes(focus)),
                variant: buildVariant(candidate),
                access: buildAccess(candidate),
            } satisfies RoleMarketRole;
        })
        .filter((role) => matchesSearch(role, search))
        .sort((left, right) => {
            if (right.score !== left.score) {
                return right.score - left.score;
            }

            const reviewDiff = (right.stats?.reviewCount || 0) - (left.stats?.reviewCount || 0);
            if (reviewDiff !== 0) {
                return reviewDiff;
            }

            return left.title.localeCompare(right.title);
        });

    return {
        inferredFocus: normalizedFocus,
        recommendations: roles.slice(0, Math.max(1, limit)),
        roles,
    };
}
