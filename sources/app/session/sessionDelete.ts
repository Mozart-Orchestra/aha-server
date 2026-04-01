import { Context } from "@/context";
import { inTx, afterTx } from "@/storage/inTx";
import { eventRouter, buildDeleteSessionUpdate } from "@/app/events/eventRouter";
import { allocateUserSeq } from "@/storage/seq";
import { randomKeyNaked } from "@/utils/randomKeyNaked";
import { log } from "@/utils/log";

/**
 * Soft-delete a session by setting deletedAt + active=false.
 * Related data (messages, usage reports, access keys) is preserved
 * so historical message traces remain valid and agents that still
 * reference this sessionId receive a 410 (Gone) instead of 403.
 *
 * @param ctx - Context with user information
 * @param sessionId - ID of the session to delete
 * @returns true if deletion was successful, false if session not found or not owned by user
 */
export async function sessionDelete(ctx: Context, sessionId: string): Promise<boolean> {
    return await inTx(async (tx) => {
        // Verify session exists and belongs to the user
        const session = await tx.session.findFirst({
            where: {
                id: sessionId,
                accountId: ctx.uid,
                deletedAt: null
            }
        });

        if (!session) {
            log({
                module: 'session-delete',
                userId: ctx.uid,
                sessionId
            }, `Session not found, not owned by user, or already deleted`);
            return false;
        }

        // Soft-delete: mark as deleted, keep all related data
        await tx.session.update({
            where: { id: sessionId },
            data: {
                active: false,
                deletedAt: new Date()
            }
        });
        log({
            module: 'session-delete',
            userId: ctx.uid,
            sessionId
        }, `Session soft-deleted successfully`);

        // Send notification after transaction commits
        afterTx(tx, async () => {
            const updSeq = await allocateUserSeq(ctx.uid);
            const updatePayload = buildDeleteSessionUpdate(sessionId, updSeq, randomKeyNaked(12));

            log({
                module: 'session-delete',
                userId: ctx.uid,
                sessionId,
                updateType: 'delete-session',
                updatePayload: JSON.stringify(updatePayload)
            }, `Emitting delete-session update to user-scoped connections`);

            eventRouter.emitUpdate({
                userId: ctx.uid,
                payload: updatePayload,
                recipientFilter: { type: 'user-scoped-only' }
            });
        });

        return true;
    });
}