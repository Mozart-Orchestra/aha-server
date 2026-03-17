export interface DuplicateExecutionLink {
    sessionId: string;
    status: string;
}

export interface DuplicateComparableTask {
    id: string;
    title: string;
    description?: string;
    sourceMessageId?: string;
    relatedMessageIds?: string[];
    attachments?: Array<{
        name?: string;
        path?: string;
        url?: string;
        content?: string;
    }>;
    executionLinks?: DuplicateExecutionLink[];
}

export interface DuplicateExecutionConflict {
    conflictingTaskId: string;
    conflictingSessionId: string;
    reason: 'source-message' | 'file' | 'goal';
    overlap: string;
}

const FILE_REFERENCE_REGEX = /(?:^|[\s`'"])((?:[A-Za-z0-9._()[\]\/-]+\/)+[A-Za-z0-9._()[\]-]+\.[A-Za-z0-9._-]+|[A-Za-z0-9._()[\]-]+\.[A-Za-z0-9._-]+)(?=$|[\s`'":,.;)])/g;
const BACKTICK_REFERENCE_REGEX = /`([^`\n]+)`/g;

function normalizeGoal(value: string | undefined): string {
    if (!value) {
        return '';
    }

    return value
        .toLowerCase()
        .replace(/[`*_#:[\](){}]/g, ' ')
        .replace(/[^a-z0-9./_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function addPathCandidate(target: Set<string>, candidate: string | undefined): void {
    if (!candidate) {
        return;
    }

    const normalized = candidate
        .trim()
        .replace(/^['"`]+|['"`]+$/g, '')
        .replace(/^[./]+/, '')
        .replace(/\/+$/, '')
        .toLowerCase();

    if (!normalized || !normalized.includes('.')) {
        return;
    }

    target.add(normalized);
}

export function extractTaskFileReferences(task: DuplicateComparableTask): string[] {
    const references = new Set<string>();
    const text = [task.title, task.description].filter(Boolean).join('\n');

    for (const match of text.matchAll(BACKTICK_REFERENCE_REGEX)) {
        addPathCandidate(references, match[1]);
    }

    for (const match of text.matchAll(FILE_REFERENCE_REGEX)) {
        addPathCandidate(references, match[1]);
    }

    for (const attachment of task.attachments || []) {
        addPathCandidate(references, attachment.name);
        addPathCandidate(references, attachment.path);
        addPathCandidate(references, attachment.url);
        addPathCandidate(references, attachment.content);
    }

    return Array.from(references);
}

function findActiveOwner(task: DuplicateComparableTask, claimingSessionId: string): string | null {
    const activeLink = task.executionLinks?.find(link => link.status === 'active' && link.sessionId !== claimingSessionId);
    return activeLink?.sessionId ?? null;
}

export function findDuplicateExecutionConflict(
    tasks: DuplicateComparableTask[],
    candidateTask: DuplicateComparableTask,
    claimingSessionId: string
): DuplicateExecutionConflict | null {
    const candidateSourceMessageId = candidateTask.sourceMessageId?.trim();
    const candidatePaths = extractTaskFileReferences(candidateTask);
    const candidateGoal = normalizeGoal(candidateTask.title);

    for (const task of tasks) {
        if (task.id === candidateTask.id) {
            continue;
        }

        const activeOwner = findActiveOwner(task, claimingSessionId);
        if (!activeOwner) {
            continue;
        }

        if (candidateSourceMessageId && task.sourceMessageId?.trim() === candidateSourceMessageId) {
            return {
                conflictingTaskId: task.id,
                conflictingSessionId: activeOwner,
                reason: 'source-message',
                overlap: candidateSourceMessageId,
            };
        }

        const taskPaths = extractTaskFileReferences(task);
        const overlappingPath = candidatePaths.find(path => taskPaths.includes(path));
        if (overlappingPath) {
            return {
                conflictingTaskId: task.id,
                conflictingSessionId: activeOwner,
                reason: 'file',
                overlap: overlappingPath,
            };
        }

        const taskGoal = normalizeGoal(task.title);
        if (
            candidateGoal.length >= 12 &&
            taskGoal.length >= 12 &&
            candidateGoal === taskGoal
        ) {
            return {
                conflictingTaskId: task.id,
                conflictingSessionId: activeOwner,
                reason: 'goal',
                overlap: candidateTask.title.trim(),
            };
        }
    }

    return null;
}
