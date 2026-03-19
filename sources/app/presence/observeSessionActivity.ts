import { buildSessionActivityEphemeral, eventRouter } from "@/app/events/eventRouter";
import { activityCache } from "@/app/presence/sessionCache";
import { db } from "@/storage/db";
import { log } from "@/utils/log";

function normalizeObservedAt(observedAt: number): number {
    if (!Number.isFinite(observedAt) || observedAt <= 0) {
        return Date.now();
    }

    const now = Date.now();
    if (observedAt > now) {
        return now;
    }

    return observedAt;
}

/**
 * Marks a session as alive when the server observes authenticated session-scoped
 * control-plane activity outside the websocket heartbeat channel.
 *
 * This closes a blind spot where a live agent can still post team messages or
 * mutate tasks over HTTP after its websocket heartbeat has stopped, causing the
 * UI to show the agent as dead even though it is actively working.
 */
export async function observeSessionActivity(
    userId: string,
    sessionId: string,
    observedAt = Date.now(),
): Promise<boolean> {
    if (!sessionId) {
        return false;
    }

    const effectiveObservedAt = normalizeObservedAt(observedAt);

    try {
        const updated = await db.session.updateManyAndReturn({
            where: {
                id: sessionId,
                accountId: userId,
            },
            data: {
                active: true,
                lastActiveAt: new Date(effectiveObservedAt),
            },
        });

        if (updated.length === 0) {
            return false;
        }

        activityCache.invalidateSession(sessionId);
        eventRouter.emitEphemeral({
            userId,
            payload: buildSessionActivityEphemeral(sessionId, true, effectiveObservedAt, false),
            recipientFilter: { type: 'user-scoped-only' },
        });

        return true;
    } catch (error) {
        log(
            { module: 'session-observer', level: 'warn', userId, sessionId },
            `Failed to observe session activity: ${error}`,
        );
        return false;
    }
}
