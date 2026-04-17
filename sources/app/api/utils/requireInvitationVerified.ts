import { db } from "@/storage/db";
import { log } from "@/utils/log";

/**
 * Fastify preHandler that 403s unless the authenticated account has
 * completed invitation-code verification. Assumes `app.authenticate` has
 * already run and populated `request.userId`.
 */
export async function requireInvitationVerified(request: any, reply: any) {
    const userId = request.userId as string | undefined;
    if (!userId) {
        // authenticate preHandler must run before this
        return reply.code(401).send({ error: 'Authentication required' });
    }

    const account = await db.account.findUnique({
        where: { id: userId },
        select: { invitationVerifiedAt: true },
    });

    if (!account) {
        log({ module: 'invitation' }, `Account not found for userId=${userId}`);
        return reply.code(401).send({ error: 'Account not found' });
    }

    if (!account.invitationVerifiedAt) {
        return reply.code(403).send({ error: 'invitation_required' });
    }
}
