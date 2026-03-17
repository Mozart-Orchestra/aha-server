import { describe, expect, it } from 'vitest';

import { cleanupActiveExecutionLinks } from './executionLinks';

describe('cleanupActiveExecutionLinks', () => {
    it('marks non-owner active links as abandoned and owner link as completed', () => {
        const result = cleanupActiveExecutionLinks([
            { sessionId: 'owner', status: 'active' as const },
            { sessionId: 'other', status: 'active' as const },
            { sessionId: 'done', status: 'completed' as const },
        ], 'owner');

        expect(result).toEqual([
            { sessionId: 'owner', status: 'completed' },
            { sessionId: 'other', status: 'abandoned' },
            { sessionId: 'done', status: 'completed' },
        ]);
    });

    it('marks all active links as completed when there is no preferred owner', () => {
        const result = cleanupActiveExecutionLinks([
            { sessionId: 'a', status: 'active' as const },
            { sessionId: 'b', status: 'active' as const },
        ]);

        expect(result).toEqual([
            { sessionId: 'a', status: 'completed' },
            { sessionId: 'b', status: 'completed' },
        ]);
    });

    it('returns original reference when nothing needs cleanup', () => {
        const links = [
            { sessionId: 'a', status: 'completed' as const },
            { sessionId: 'b', status: 'abandoned' as const },
        ];

        const result = cleanupActiveExecutionLinks(links, 'a');

        expect(result).toBe(links);
    });
});
