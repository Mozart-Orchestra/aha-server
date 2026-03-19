import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/storage/db', () => ({
    db: {
        session: {
            updateManyAndReturn: vi.fn(),
        },
    },
}));

vi.mock('@/app/presence/sessionCache', () => ({
    activityCache: {
        invalidateSession: vi.fn(),
    },
}));

vi.mock('@/app/events/eventRouter', () => ({
    eventRouter: {
        emitEphemeral: vi.fn(),
    },
    buildSessionActivityEphemeral: vi.fn((sessionId: string, active: boolean, activeAt: number, thinking: boolean) => ({
        type: 'activity',
        id: sessionId,
        active,
        activeAt,
        thinking,
    })),
}));

import { eventRouter } from '@/app/events/eventRouter';
import { activityCache } from '@/app/presence/sessionCache';
import { db } from '@/storage/db';
import { observeSessionActivity } from './observeSessionActivity';

describe('observeSessionActivity', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('marks the session active and emits an activity update when the session exists', async () => {
        vi.mocked(db.session.updateManyAndReturn).mockResolvedValue([
            { id: 'session-1' },
        ] as never);

        const observedAt = Date.now() - 1_000;
        const result = await observeSessionActivity('user-1', 'session-1', observedAt);

        expect(result).toBe(true);
        expect(vi.mocked(db.session.updateManyAndReturn)).toHaveBeenCalledWith({
            where: {
                id: 'session-1',
                accountId: 'user-1',
            },
            data: {
                active: true,
                lastActiveAt: new Date(observedAt),
            },
        });
        expect(vi.mocked(activityCache.invalidateSession)).toHaveBeenCalledWith('session-1');
        expect(vi.mocked(eventRouter.emitEphemeral)).toHaveBeenCalledWith({
            userId: 'user-1',
            payload: {
                type: 'activity',
                id: 'session-1',
                active: true,
                activeAt: observedAt,
                thinking: false,
            },
            recipientFilter: { type: 'user-scoped-only' },
        });
    });

    it('returns false and skips cache/event updates when the session is missing', async () => {
        vi.mocked(db.session.updateManyAndReturn).mockResolvedValue([] as never);

        const result = await observeSessionActivity('user-1', 'missing-session');

        expect(result).toBe(false);
        expect(vi.mocked(activityCache.invalidateSession)).not.toHaveBeenCalled();
        expect(vi.mocked(eventRouter.emitEphemeral)).not.toHaveBeenCalled();
    });
});
