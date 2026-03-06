import { randomUUID } from 'node:crypto';
import { taskOrchestrator, type KanbanTask } from '@/app/task/taskOrchestrator';
import { db } from '@/storage/db';
import { generateEvolutionSuggestions, type EvolutionSignals, type EvolutionSuggestion } from '@/services/evolutionService';

export type EvolutionEvidenceCategory = 'runtime' | 'code' | 'rating' | 'review' | 'collaboration';

export interface EvolutionEvidenceRecord {
    id: string;
    teamId: string;
    category: EvolutionEvidenceCategory;
    source: string;
    title: string;
    summary: string;
    timestamp: string;
    actor?: string;
    refs?: Array<{
        type: 'session' | 'task' | 'machine' | 'rating' | 'message';
        id: string;
    }>;
    metadata?: Record<string, unknown>;
}

export interface EvolutionScoreSummary {
    current: number;
    previous: number;
    delta: number;
    trend: 'up' | 'down' | 'flat';
}

export interface EvolutionRecommendation {
    id: string;
    type: string;
    title: string;
    summary: string;
    priority: 'high' | 'medium' | 'low';
    confidence: number;
    scoreDelta: number;
    why: string[];
    nextAction: string;
    evidence: EvolutionEvidenceRecord[];
}

export interface EvolutionMemoryDigest {
    summary: string;
    highlights: string[];
    nextActions: string[];
}

export interface EvolutionSummary {
    teamId: string;
    generatedAt: string;
    period: {
        start: string;
        end: string;
        days: number;
    };
    score: EvolutionScoreSummary;
    signals: EvolutionSignals;
    evidenceCounts: Record<EvolutionEvidenceCategory, number>;
    recommendations: EvolutionRecommendation[];
    memory: EvolutionMemoryDigest;
}

type RatingRecord = {
    id: string;
    teamId: string;
    roleId: string;
    taskId?: string;
    rating: number;
    codeLines?: number;
    commits?: number;
    bugsCount?: number;
    qualityScore?: number;
    source?: string;
    reviewerId?: string;
    comment?: string;
    createdAt: number;
};

type CodeMetricsRecord = {
    codeLines?: number;
    commits?: number;
    filesChanged?: number;
    insertions?: number;
    deletions?: number;
    bugsFixed?: number;
    reviewComments?: number;
    testCoverage?: number;
    periodStart?: string;
    periodEnd?: string;
    sessionId?: string;
    machineId?: string;
    submittedAt?: string;
};

const EVIDENCE_PREFIX = 'evidence:team:';
const CODE_METRICS_PREFIX = 'code-metrics:';
const TEAM_RATING_PREFIX = 'rating_record.';
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function safeJsonParse<T>(value: string | Uint8Array | null | undefined): T | null {
    if (value == null) {
        return null;
    }

    try {
        const serialized = value instanceof Uint8Array ? Buffer.from(value).toString('utf8') : value;
        return JSON.parse(serialized) as T;
    } catch {
        return null;
    }
}

function toIsoString(input?: string | number | Date | null): string {
    if (input instanceof Date) {
        return input.toISOString();
    }
    if (typeof input === 'number' && Number.isFinite(input)) {
        return new Date(input).toISOString();
    }
    if (typeof input === 'string') {
        const parsed = Date.parse(input);
        if (!Number.isNaN(parsed)) {
            return new Date(parsed).toISOString();
        }
    }
    return new Date().toISOString();
}

function truncate(value: string | undefined, max = 160): string {
    const normalized = (value || '').trim();
    if (normalized.length <= max) {
        return normalized;
    }
    return `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function priorityFromConfidence(confidence: number): 'high' | 'medium' | 'low' {
    if (confidence >= 80) {
        return 'high';
    }
    if (confidence >= 60) {
        return 'medium';
    }
    return 'low';
}

function recommendationTitle(type: string): string {
    switch (type) {
        case 'add-role':
            return 'Add capacity where delivery is constrained';
        case 'remove-role':
            return 'Trim idle capacity and refocus the team';
        case 'adjust-count':
            return 'Rebalance role coverage';
        case 'change-model':
            return 'Upgrade model quality for critical paths';
        case 'recompose':
            return 'Recompose the team around the current bottleneck';
        case 'review-backlog':
            return 'Clear the review backlog before new work';
        default:
            return 'Stabilize the evolution loop';
    }
}

function recommendationNextAction(type: string): string {
    switch (type) {
        case 'add-role':
            return 'Open the role market and add coverage for the stressed role.';
        case 'remove-role':
            return 'Archive or reassign the least active role after confirming ownership gaps.';
        case 'adjust-count':
            return 'Revisit the team composition and shift headcount toward the overloaded role.';
        case 'change-model':
            return 'Promote the critical role to a stronger model and rerun the next review window.';
        case 'review-backlog':
            return 'Resolve pending review and blocker items before queuing more tasks.';
        default:
            return 'Open the evolution workspace and inspect the linked evidence before changing composition.';
    }
}

function trendFromDelta(delta: number): 'up' | 'down' | 'flat' {
    if (delta > 0.05) {
        return 'up';
    }
    if (delta < -0.05) {
        return 'down';
    }
    return 'flat';
}

function ratingTrendFromDelta(delta: number): EvolutionSignals['ratingTrend'] {
    if (delta > 0.25) {
        return 'improving';
    }
    if (delta < -0.25) {
        return 'declining';
    }
    return 'stable';
}

function dedupeEvidence(records: EvolutionEvidenceRecord[]): EvolutionEvidenceRecord[] {
    const seen = new Set<string>();
    const output: EvolutionEvidenceRecord[] = [];
    for (const record of records) {
        const signature = `${record.category}:${record.source}:${record.title}:${record.summary}:${record.timestamp}`;
        if (seen.has(signature)) {
            continue;
        }
        seen.add(signature);
        output.push(record);
    }
    return output.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

export async function appendTeamEvidence(input: Omit<EvolutionEvidenceRecord, 'id' | 'timestamp'> & {
    id?: string;
    timestamp?: string | number | Date;
}): Promise<void> {
    const timestamp = toIsoString(input.timestamp);
    const createdAt = Date.parse(timestamp);
    const id = input.id || `ev-${randomUUID().slice(0, 8)}`;
    const record: EvolutionEvidenceRecord = {
        id,
        teamId: input.teamId,
        category: input.category,
        source: input.source,
        title: input.title,
        summary: truncate(input.summary, 220),
        timestamp,
        ...(input.actor ? { actor: input.actor } : {}),
        ...(input.refs ? { refs: input.refs } : {}),
        ...(input.metadata ? { metadata: input.metadata } : {}),
    };

    await db.simpleCache.create({
        data: {
            key: `${EVIDENCE_PREFIX}${input.teamId}:${createdAt}:${id}`,
            value: JSON.stringify(record),
        },
    });
}

async function loadEvidenceCache(teamId: string, periodStart: Date): Promise<EvolutionEvidenceRecord[]> {
    const rows = await db.simpleCache.findMany({
        where: {
            key: { startsWith: `${EVIDENCE_PREFIX}${teamId}:` },
            updatedAt: { gte: periodStart },
        },
        orderBy: { updatedAt: 'desc' },
        take: 200,
    });

    return rows
        .map((row) => safeJsonParse<EvolutionEvidenceRecord>(row.value as string))
        .filter((row): row is EvolutionEvidenceRecord => Boolean(row));
}

async function loadRatingRecords(teamId: string, periodStart: Date): Promise<RatingRecord[]> {
    const rows = await db.simpleCache.findMany({
        where: {
            key: { startsWith: `${TEAM_RATING_PREFIX}${teamId}.` },
            updatedAt: { gte: periodStart },
        },
        orderBy: { updatedAt: 'desc' },
        take: 500,
    });

    return rows
        .map((row) => safeJsonParse<RatingRecord>(row.value as string))
        .filter((row): row is RatingRecord => Boolean(row));
}

async function loadCodeMetrics(
    userId: string,
    teamId: string,
    sessionIds: string[],
    periodStart: Date,
): Promise<CodeMetricsRecord[]> {
    const records = await db.simpleCache.findMany({
        where: {
            key: { startsWith: `${CODE_METRICS_PREFIX}${teamId}:` },
            updatedAt: { gte: periodStart },
        },
        orderBy: { updatedAt: 'desc' },
        take: 200,
    });

    const parsed = records
        .map((row) => safeJsonParse<CodeMetricsRecord>(row.value as string))
        .filter((row): row is CodeMetricsRecord => Boolean(row));

    if (parsed.length > 0 || sessionIds.length === 0 || typeof (db as any).userKVStore?.findMany !== 'function') {
        return parsed;
    }

    const fallback: CodeMetricsRecord[] = [];
    for (const sessionId of sessionIds) {
        const rows = await (db as any).userKVStore.findMany({
            where: {
                accountId: userId,
                key: `metrics:${sessionId}`,
                updatedAt: { gte: periodStart },
            },
            take: 1,
        });

        const row = Array.isArray(rows) ? rows[0] : null;
        const parsedRow = safeJsonParse<CodeMetricsRecord>(row?.value as Uint8Array | undefined);
        if (parsedRow) {
            fallback.push({
                ...parsedRow,
                sessionId,
                submittedAt: toIsoString(row?.updatedAt),
            });
        }
    }

    return fallback;
}

function scoreFromRatings(ratings: RatingRecord[], periodStart: Date, now: Date): EvolutionScoreSummary {
    if (ratings.length === 0) {
        return { current: 0, previous: 0, delta: 0, trend: 'flat' };
    }

    const midpoint = periodStart.getTime() + ((now.getTime() - periodStart.getTime()) / 2);
    const currentWindow = ratings.filter((record) => record.createdAt >= midpoint);
    const previousWindow = ratings.filter((record) => record.createdAt < midpoint);
    const allCurrent = currentWindow.length > 0 ? currentWindow : ratings.slice(0, Math.min(ratings.length, 3));
    const allPrevious = previousWindow.length > 0 ? previousWindow : ratings.slice(Math.max(0, ratings.length - 3));
    const current = Number((allCurrent.reduce((sum, item) => sum + item.rating, 0) / Math.max(allCurrent.length, 1)).toFixed(2));
    const previous = Number((allPrevious.reduce((sum, item) => sum + item.rating, 0) / Math.max(allPrevious.length, 1)).toFixed(2));
    const delta = Number((current - previous).toFixed(2));
    return { current, previous, delta, trend: trendFromDelta(delta) };
}

function reviewEvidenceFromTasks(teamId: string, tasks: KanbanTask[], periodStartMs: number): EvolutionEvidenceRecord[] {
    const evidence: EvolutionEvidenceRecord[] = [];
    const pendingReviews = tasks.filter((task) => task.status === 'review' || task.approvalStatus === 'pending');
    const blockedTasks = tasks.filter((task) => task.status === 'blocked' || (task.blockers || []).some((blocker) => !blocker.resolvedAt));
    const completedTasks = tasks.filter((task) => task.status === 'done' && task.updatedAt >= periodStartMs);

    for (const task of pendingReviews.slice(0, 4)) {
        evidence.push({
            id: `review-${task.id}`,
            teamId,
            category: 'review',
            source: 'task-board',
            title: `Pending review: ${task.title}`,
            summary: truncate(task.description || 'Task is waiting for review sign-off.', 160),
            timestamp: toIsoString(task.updatedAt),
            refs: [{ type: 'task', id: task.id }],
            metadata: {
                status: task.status,
                approvalStatus: task.approvalStatus,
            },
        });
    }

    for (const task of blockedTasks.slice(0, 4)) {
        const blockerSummary = (task.blockers || [])
            .filter((blocker) => !blocker.resolvedAt)
            .map((blocker) => blocker.description)
            .filter(Boolean)
            .join(' · ');
        evidence.push({
            id: `blocked-${task.id}`,
            teamId,
            category: 'review',
            source: 'task-board',
            title: `Blocked task: ${task.title}`,
            summary: truncate(blockerSummary || task.description || 'Task is blocked and needs follow-up.', 160),
            timestamp: toIsoString(task.updatedAt),
            refs: [{ type: 'task', id: task.id }],
        });
    }

    for (const task of completedTasks.slice(0, 3)) {
        const hours = Math.max(0, Number((((task.updatedAt - task.createdAt) / (60 * 60 * 1000))).toFixed(1)));
        evidence.push({
            id: `done-${task.id}`,
            teamId,
            category: 'review',
            source: 'task-board',
            title: `Completed task: ${task.title}`,
            summary: `Finished in ${hours}h${task.assigneeId ? ` by ${task.assigneeId}` : ''}.`,
            timestamp: toIsoString(task.updatedAt),
            refs: [{ type: 'task', id: task.id }],
        });
    }

    return evidence;
}

function ratingEvidenceFromRecords(teamId: string, ratings: RatingRecord[]): EvolutionEvidenceRecord[] {
    return ratings.slice(0, 6).map((record) => ({
        id: record.id,
        teamId,
        category: 'rating',
        source: record.source || 'rating-record',
        title: `Rating ${record.rating.toFixed(1)} for ${record.roleId}`,
        summary: truncate(
            record.comment || `Quality ${record.qualityScore || 0}, code ${record.codeLines || 0} lines, commits ${record.commits || 0}.`,
            180,
        ),
        timestamp: toIsoString(record.createdAt),
        actor: record.reviewerId,
        refs: [
            { type: 'rating', id: record.id },
            { type: 'task', id: record.taskId || record.roleId },
        ],
        metadata: {
            roleId: record.roleId,
            qualityScore: record.qualityScore || 0,
            codeLines: record.codeLines || 0,
            commits: record.commits || 0,
            bugsCount: record.bugsCount || 0,
        },
    }));
}

function codeEvidenceFromMetrics(teamId: string, metrics: CodeMetricsRecord[]): EvolutionEvidenceRecord[] {
    return metrics.slice(0, 6).map((record, index) => {
        const timestamp = toIsoString(record.submittedAt || record.periodEnd || record.periodStart);
        const linesChanged = (record.insertions || 0) + (record.deletions || 0);
        return {
            id: `code-${record.sessionId || index}-${Date.parse(timestamp)}`,
            teamId,
            category: 'code',
            source: 'agent-metrics',
            title: `Code metrics${record.sessionId ? ` from ${record.sessionId}` : ''}`,
            summary: `${record.commits || 0} commits · ${linesChanged} changed lines · ${record.filesChanged || 0} files · ${record.bugsFixed || 0} bug-fix commits.`,
            timestamp,
            refs: record.sessionId ? [{ type: 'session', id: record.sessionId }] : undefined,
            metadata: {
                testCoverage: record.testCoverage || 0,
                reviewComments: record.reviewComments || 0,
            },
        };
    });
}

function runtimeEvidenceFromSessions(
    teamId: string,
    sessions: Array<{ id: string; active: boolean; lastActiveAt: Date; roleId?: string | null; machineId?: string | null; displayName?: string | null }>,
    memberCount: number,
): EvolutionEvidenceRecord[] {
    if (memberCount === 0) {
        return [];
    }

    const now = Date.now();
    const activeSessions = sessions.filter((session) => now - session.lastActiveAt.getTime() <= FIFTEEN_MINUTES_MS);
    const staleSessions = sessions.filter((session) => now - session.lastActiveAt.getTime() > DAY_MS);
    const evidence: EvolutionEvidenceRecord[] = [
        {
            id: `runtime-summary-${teamId}`,
            teamId,
            category: 'runtime',
            source: 'session-state',
            title: 'Runtime heartbeat coverage',
            summary: `${activeSessions.length}/${memberCount} members have recent activity in the last 15 minutes.`,
            timestamp: new Date(now).toISOString(),
            metadata: {
                activeSessions: activeSessions.length,
                memberCount,
            },
        },
    ];

    for (const session of staleSessions.slice(0, 3)) {
        evidence.push({
            id: `runtime-stale-${session.id}`,
            teamId,
            category: 'runtime',
            source: 'session-state',
            title: `Stale session: ${session.displayName || session.roleId || session.id}`,
            summary: `No recent heartbeat for ${(Math.max(1, Math.round((now - session.lastActiveAt.getTime()) / DAY_MS)))} day(s).`,
            timestamp: session.lastActiveAt.toISOString(),
            refs: [{ type: 'session', id: session.id }],
            metadata: {
                machineId: session.machineId || null,
                roleId: session.roleId || null,
            },
        });
    }

    return evidence;
}

function collaborationEvidenceFromCache(records: EvolutionEvidenceRecord[]): EvolutionEvidenceRecord[] {
    return records.filter((record) => record.category === 'collaboration').slice(0, 6);
}

function calculateSignalsFromData(input: {
    tasks: KanbanTask[];
    memberCount: number;
    sessions: Array<{ id: string; active: boolean; lastActiveAt: Date; roleId?: string | null }>;
    score: EvolutionScoreSummary;
    collaborationEvidence: EvolutionEvidenceRecord[];
}): EvolutionSignals {
    const blockedTasks = input.tasks.filter((task) => task.status === 'blocked' || (task.blockers || []).some((blocker) => !blocker.resolvedAt));
    const completedTasks = input.tasks.filter((task) => task.status === 'done');
    const avgCompletionTime = completedTasks.length > 0
        ? Number((completedTasks.reduce((sum, task) => sum + Math.max(0, task.updatedAt - task.createdAt), 0) / completedTasks.length / (60 * 60 * 1000)).toFixed(1))
        : 0;
    const blockingRate = input.tasks.length > 0
        ? Number(((blockedTasks.length / input.tasks.length) * 100).toFixed(1))
        : 0;

    const now = Date.now();
    const readySessions = input.sessions.filter((session) => now - session.lastActiveAt.getTime() <= FIFTEEN_MINUTES_MS).length;
    const staleSessions = input.memberCount > 0
        ? input.sessions.filter((session) => now - session.lastActiveAt.getTime() > DAY_MS).length
        : 0;
    const idleRate = input.memberCount > 0
        ? Number(((staleSessions / input.memberCount) * 100).toFixed(1))
        : 0;
    const readyPingRatio = input.memberCount > 0
        ? Number(((readySessions / input.memberCount) * 100).toFixed(1))
        : 0;
    const coordinatorCount = input.collaborationEvidence.filter((record) => record.metadata?.fromRole === 'coordinator').length;
    const coordinatorMessageRatio = input.collaborationEvidence.length > 0
        ? Number(((coordinatorCount / input.collaborationEvidence.length) * 100).toFixed(1))
        : 0;

    return {
        ratingTrend: ratingTrendFromDelta(input.score.delta),
        blockingRate,
        avgCompletionTime,
        idleRate,
        coordinatorMessageRatio,
        readyPingRatio,
    };
}

function pickEvidenceForSuggestion(
    suggestion: EvolutionSuggestion,
    buckets: Record<EvolutionEvidenceCategory, EvolutionEvidenceRecord[]>,
): EvolutionEvidenceRecord[] {
    switch (suggestion.type) {
        case 'add-role':
        case 'adjust-count':
        case 'change-model':
            return dedupeEvidence([...buckets.rating, ...buckets.code, ...buckets.review]).slice(0, 3);
        case 'remove-role':
            return dedupeEvidence([...buckets.runtime, ...buckets.rating]).slice(0, 3);
        case 'recompose':
        default:
            return dedupeEvidence([...buckets.runtime, ...buckets.review, ...buckets.collaboration]).slice(0, 3);
    }
}

function buildRecommendations(input: {
    suggestions: EvolutionSuggestion[];
    score: EvolutionScoreSummary;
    signals: EvolutionSignals;
    buckets: Record<EvolutionEvidenceCategory, EvolutionEvidenceRecord[]>;
}): EvolutionRecommendation[] {
    const recommendations: EvolutionRecommendation[] = input.suggestions.map((suggestion, index) => ({
        id: `rec-${index}-${suggestion.type}`,
        type: suggestion.type,
        title: recommendationTitle(suggestion.type),
        summary: suggestion.description,
        priority: priorityFromConfidence(suggestion.confidence),
        confidence: suggestion.confidence,
        scoreDelta: input.score.delta,
        why: suggestion.basedOn.length > 0 ? suggestion.basedOn : [
            `Rating trend is ${input.signals.ratingTrend}.`,
            `Blocking rate is ${input.signals.blockingRate}%.`,
        ],
        nextAction: recommendationNextAction(suggestion.type),
        evidence: pickEvidenceForSuggestion(suggestion, input.buckets),
    }));

    const backlogEvidence = dedupeEvidence([...input.buckets.review, ...input.buckets.collaboration]).slice(0, 3);
    const shouldAddBacklogRecommendation = backlogEvidence.length > 0
        && (input.signals.blockingRate >= 20 || input.buckets.review.length >= 2);
    if (shouldAddBacklogRecommendation) {
        recommendations.unshift({
            id: 'rec-review-backlog',
            type: 'review-backlog',
            title: recommendationTitle('review-backlog'),
            summary: 'Pending review and blocker items are suppressing the latest score delta.',
            priority: input.signals.blockingRate >= 40 ? 'high' : 'medium',
            confidence: Math.min(95, Math.max(65, Math.round(input.signals.blockingRate + backlogEvidence.length * 10))),
            scoreDelta: input.score.delta,
            why: [
                `${input.buckets.review.length} review-oriented evidence items remain unresolved.`,
                `${input.buckets.collaboration.length} collaboration signal(s) were captured in the same window.`,
            ],
            nextAction: recommendationNextAction('review-backlog'),
            evidence: backlogEvidence,
        });
    }

    if (recommendations.length === 0) {
        recommendations.push({
            id: 'rec-stable-loop',
            type: 'recompose',
            title: 'Keep the current loop and watch the next evidence window',
            summary: 'Signals are stable, so the best next step is to keep feeding the evidence layer and recheck after the next review window.',
            priority: 'low',
            confidence: 60,
            scoreDelta: input.score.delta,
            why: [
                `Current score delta is ${input.score.delta >= 0 ? '+' : ''}${input.score.delta.toFixed(2)}.`,
                'No blocker or idle signal crossed the intervention threshold.',
            ],
            nextAction: 'Run another 10-20 turn window and inspect whether the same evidence mix holds.',
            evidence: dedupeEvidence([
                ...input.buckets.rating,
                ...input.buckets.code,
                ...input.buckets.runtime,
            ]).slice(0, 3),
        });
    }

    return recommendations.slice(0, 4);
}

function buildMemoryDigest(input: {
    score: EvolutionScoreSummary;
    recommendations: EvolutionRecommendation[];
    evidenceCounts: Record<EvolutionEvidenceCategory, number>;
    highlights: EvolutionEvidenceRecord[];
}): EvolutionMemoryDigest {
    const summary = `Score ${input.score.delta >= 0 ? 'improved' : 'slipped'} by ${Math.abs(input.score.delta).toFixed(2)} over the current window. Evidence mix: runtime ${input.evidenceCounts.runtime}, code ${input.evidenceCounts.code}, rating ${input.evidenceCounts.rating}, review ${input.evidenceCounts.review}, collaboration ${input.evidenceCounts.collaboration}.`;
    return {
        summary,
        highlights: input.highlights.slice(0, 3).map((item) => `${item.title}: ${item.summary}`),
        nextActions: input.recommendations.slice(0, 3).map((item) => item.nextAction),
    };
}

export async function buildEvolutionSummary(userId: string, teamId: string, periodDays = 7): Promise<EvolutionSummary> {
    const now = new Date();
    const periodStart = new Date(now.getTime() - periodDays * DAY_MS);
    const board = await taskOrchestrator.getBoard(userId, teamId);
    const tasks = board?.tasks || [];
    const memberSessionIds: string[] = Array.from(new Set(
        (Array.isArray((board as any)?.team?.members) ? (board as any).team.members : [])
            .map((member: any) => member?.sessionId)
            .filter((sessionId: unknown): sessionId is string => typeof sessionId === 'string' && sessionId.length > 0),
    ));
    const sessions = memberSessionIds.length > 0
        ? await db.session.findMany({
            where: {
                accountId: userId,
                id: { in: memberSessionIds },
            },
            select: {
                id: true,
                active: true,
                lastActiveAt: true,
                roleId: true,
                machineId: true,
                displayName: true,
            },
        })
        : [];

    const [cachedEvidence, ratingRecords, codeMetricRecords] = await Promise.all([
        loadEvidenceCache(teamId, periodStart),
        loadRatingRecords(teamId, periodStart),
        loadCodeMetrics(userId, teamId, memberSessionIds, periodStart),
    ]);

    const reviewEvidence = reviewEvidenceFromTasks(teamId, tasks, periodStart.getTime());
    const ratingEvidence = ratingEvidenceFromRecords(teamId, ratingRecords);
    const codeEvidence = codeEvidenceFromMetrics(teamId, codeMetricRecords);
    const cachedBuckets: Record<EvolutionEvidenceCategory, EvolutionEvidenceRecord[]> = {
        runtime: cachedEvidence.filter((record) => record.category === 'runtime'),
        code: cachedEvidence.filter((record) => record.category === 'code'),
        rating: cachedEvidence.filter((record) => record.category === 'rating'),
        review: cachedEvidence.filter((record) => record.category === 'review'),
        collaboration: collaborationEvidenceFromCache(cachedEvidence),
    };
    const runtimeEvidence = dedupeEvidence([
        ...cachedBuckets.runtime,
        ...runtimeEvidenceFromSessions(teamId, sessions, memberSessionIds.length),
    ]);
    const reviewBucket = dedupeEvidence([...cachedBuckets.review, ...reviewEvidence]);
    const ratingBucket = dedupeEvidence([...cachedBuckets.rating, ...ratingEvidence]);
    const codeBucket = dedupeEvidence([...cachedBuckets.code, ...codeEvidence]);
    const collaborationBucket = dedupeEvidence(cachedBuckets.collaboration);

    const score = scoreFromRatings(ratingRecords, periodStart, now);
    const signals = calculateSignalsFromData({
        tasks,
        memberCount: memberSessionIds.length,
        sessions,
        score,
        collaborationEvidence: collaborationBucket,
    });
    const suggestions = await generateEvolutionSuggestions(teamId, signals);
    const buckets: Record<EvolutionEvidenceCategory, EvolutionEvidenceRecord[]> = {
        runtime: runtimeEvidence,
        code: codeBucket,
        rating: ratingBucket,
        review: reviewBucket,
        collaboration: collaborationBucket,
    };
    const evidenceCounts: Record<EvolutionEvidenceCategory, number> = {
        runtime: runtimeEvidence.length,
        code: codeBucket.length,
        rating: ratingBucket.length,
        review: reviewBucket.length,
        collaboration: collaborationBucket.length,
    };
    const recommendations = buildRecommendations({
        suggestions,
        score,
        signals,
        buckets,
    });
    const highlights = dedupeEvidence([
        ...runtimeEvidence,
        ...codeBucket,
        ...ratingBucket,
        ...reviewBucket,
        ...collaborationBucket,
    ]);

    return {
        teamId,
        generatedAt: now.toISOString(),
        period: {
            start: periodStart.toISOString(),
            end: now.toISOString(),
            days: periodDays,
        },
        score,
        signals,
        evidenceCounts,
        recommendations,
        memory: buildMemoryDigest({
            score,
            recommendations,
            evidenceCounts,
            highlights,
        }),
    };
}

export async function calculateEvolutionSignalsForUser(userId: string, teamId: string, periodDays = 7): Promise<EvolutionSignals> {
    const summary = await buildEvolutionSummary(userId, teamId, periodDays);
    return summary.signals;
}
