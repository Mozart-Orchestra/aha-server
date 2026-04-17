import { auth } from "@/app/auth/auth";
import { log } from "@/utils/log";
import { Fastify } from "../types";

const GENOME_TOKEN_TTL_SECONDS = 60 * 60; // aligned with createEphemeralTokenGenerator ttl=1h

export function genomeTokenRoutes(app: Fastify) {
    // POST /v1/genome/token — mint a short-lived token the client uses to talk to genome-hub
    app.post('/v1/genome/token', {
        preHandler: app.authenticate,
    }, async (request, reply) => {
        const userId = request.userId;
        try {
            const token = await auth.createGenomeToken(userId);
            return reply.send({
                token,
                expiresIn: GENOME_TOKEN_TTL_SECONDS,
            });
        } catch (error) {
            log({ module: 'genome-token' }, `Mint failed for ${userId}: ${error instanceof Error ? error.message : String(error)}`);
            return reply.code(500).send({ error: 'token_mint_failed' });
        }
    });

    // GET /v1/genome/public-key — public key genome-hub uses to verify tokens locally
    app.get('/v1/genome/public-key', async (_request, reply) => {
        try {
            const publicKey = auth.getGenomePublicKey();
            return reply.send({ publicKey });
        } catch (error) {
            log({ module: 'genome-token' }, `Public-key fetch failed: ${error instanceof Error ? error.message : String(error)}`);
            return reply.code(503).send({ error: 'not_ready' });
        }
    });
}
