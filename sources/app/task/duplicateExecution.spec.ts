import { describe, expect, it } from 'vitest';

import {
    extractTaskFileReferences,
    findDuplicateExecutionConflict,
} from './duplicateExecution';

describe('duplicateExecution', () => {
    it('extracts file references from task title and description', () => {
        const refs = extractTaskFileReferences({
            id: 'task-1',
            title: 'Fix `sources/app/(app)/index.tsx` token chip',
            description: 'Also check sources/components/session/PreviewSessionCard.tsx',
        });

        expect(refs).toContain('sources/app/(app)/index.tsx');
        expect(refs).toContain('sources/components/session/previewsessioncard.tsx');
    });

    it('detects duplicate execution by overlapping file reference', () => {
        const conflict = findDuplicateExecutionConflict([
            {
                id: 'task-a',
                title: 'Implement token chip in sources/app/(app)/index.tsx',
                executionLinks: [{ sessionId: 'agent-a', status: 'active' }],
            },
        ], {
            id: 'task-b',
            title: 'Polish sources/app/(app)/index.tsx landing preview',
        }, 'agent-b');

        expect(conflict).toMatchObject({
            conflictingTaskId: 'task-a',
            conflictingSessionId: 'agent-a',
            reason: 'file',
            overlap: 'sources/app/(app)/index.tsx',
        });
    });

    it('detects duplicate execution by shared source message', () => {
        const conflict = findDuplicateExecutionConflict([
            {
                id: 'task-a',
                title: 'PreviewSessionCard token chip',
                sourceMessageId: 'msg-123',
                executionLinks: [{ sessionId: 'agent-a', status: 'active' }],
            },
        ], {
            id: 'task-b',
            title: 'Landing preview token chip',
            sourceMessageId: 'msg-123',
        }, 'agent-b');

        expect(conflict?.reason).toBe('source-message');
    });

    it('detects duplicate execution by normalized goal title', () => {
        const conflict = findDuplicateExecutionConflict([
            {
                id: 'task-a',
                title: 'Implement persistedMessageCount for session list',
                executionLinks: [{ sessionId: 'agent-a', status: 'active' }],
            },
        ], {
            id: 'task-b',
            title: 'implement persistedmessagecount for session list',
        }, 'agent-b');

        expect(conflict).toMatchObject({
            conflictingTaskId: 'task-a',
            reason: 'goal',
        });
    });

    it('ignores active tasks owned by the same session', () => {
        const conflict = findDuplicateExecutionConflict([
            {
                id: 'task-a',
                title: 'Implement persistedMessageCount for session list',
                executionLinks: [{ sessionId: 'agent-a', status: 'active' }],
            },
        ], {
            id: 'task-b',
            title: 'implement persistedmessagecount for session list',
        }, 'agent-a');

        expect(conflict).toBeNull();
    });

    it('does not flag tasks with different file scope, goal, and source message', () => {
        const conflict = findDuplicateExecutionConflict([
            {
                id: 'task-a',
                title: 'Implement persistedMessageCount for session list',
                description: 'Touch happy-server/sources/app/api/routes/sessionRoutes.ts',
                sourceMessageId: 'msg-session-count',
                executionLinks: [{ sessionId: 'agent-a', status: 'active' }],
            },
        ], {
            id: 'task-b',
            title: 'Show context window utilization progress in sidebar',
            description: 'Touch kanban/sources/components/layout/FloatingIslandSidebar.tsx',
            sourceMessageId: 'msg-context-progress',
        }, 'agent-b');

        expect(conflict).toBeNull();
    });
});
