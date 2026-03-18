import { Fastify } from "../types";
import { log } from "@/utils/log";
import { auth } from "@/app/auth/auth";
import { db } from "@/storage/db";

export function enableAuthentication(app: Fastify) {
    app.decorate('authenticate', async function (request: any, reply: any) {
        try {
            const authHeader = request.headers.authorization;
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return reply.code(401).send({ error: 'Missing authorization header' });
            }

            const token = authHeader.substring(7);
            const verified = await auth.verifyToken(token);
            if (!verified) {
                return reply.code(401).send({ error: 'Invalid token' });
            }

            const account = await db.account.findUnique({
                where: { id: verified.userId },
                select: { id: true },
            });
            if (!account) {
                log({ module: 'auth-decorator' }, `Auth failed - missing account: ${verified.userId}`);
                return reply.code(401).send({ error: 'Account not found for token' });
            }

            request.userId = verified.userId;
        } catch (error) {
            log({ module: 'auth-decorator' }, `Auth error: ${error instanceof Error ? error.message : String(error)}`);
            return reply.code(401).send({ error: 'Authentication failed' });
        }
    });
}
