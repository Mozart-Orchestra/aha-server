import * as privacyKit from "privacy-kit";
import { log } from "@/utils/log";

interface TokenCacheEntry {
    userId: string;
    extras?: any;
    cachedAt: number;
    lastAccessedAt: number;
}

interface AuthTokens {
    generator: Awaited<ReturnType<typeof privacyKit.createPersistentTokenGenerator>>;
    verifier: Awaited<ReturnType<typeof privacyKit.createPersistentTokenVerifier>>;
    githubVerifier: Awaited<ReturnType<typeof privacyKit.createEphemeralTokenVerifier>>;
    githubGenerator: Awaited<ReturnType<typeof privacyKit.createEphemeralTokenGenerator>>;
    genomeGenerator: Awaited<ReturnType<typeof privacyKit.createEphemeralTokenGenerator>>;
}

// Security: Token cache configuration
const TOKEN_CACHE_MAX_SIZE = 10000; // Maximum number of cached tokens
const TOKEN_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours expiration
const TOKEN_CACHE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // Cleanup every hour

class AuthModule {
    private tokenCache = new Map<string, TokenCacheEntry>();
    private tokens: AuthTokens | null = null;
    private cleanupInterval: NodeJS.Timeout | null = null;
    
    async init(): Promise<void> {
        if (this.tokens) {
            return; // Already initialized
        }
        
        log({ module: 'auth' }, 'Initializing auth module...');

        const handyMasterSecret = process.env.HANDY_MASTER_SECRET;
        if (!handyMasterSecret) {
            throw new Error('HANDY_MASTER_SECRET environment variable is required');
        }

        const generator = await privacyKit.createPersistentTokenGenerator({
            service: 'handy',
            seed: handyMasterSecret
        });


        const verifier = await privacyKit.createPersistentTokenVerifier({
            service: 'handy',
            publicKey: generator.publicKey
        });

        const githubGenerator = await privacyKit.createEphemeralTokenGenerator({
            service: 'github-aha',
            seed: handyMasterSecret,
            ttl: 5 * 60 * 1000 // 5 minutes
        });

        const githubVerifier = await privacyKit.createEphemeralTokenVerifier({
            service: 'github-aha',
            publicKey: githubGenerator.publicKey,
        });

        // Genome-hub token generator — signs user-scoped tokens that genome-hub
        // verifies using only the public key (supports cross-network deployment).
        const genomeGenerator = await privacyKit.createEphemeralTokenGenerator({
            service: 'genome-hub',
            seed: handyMasterSecret,
            ttl: 60 * 60 * 1000 // 1 hour
        });

        this.tokens = { generator, verifier, githubVerifier, githubGenerator, genomeGenerator };

        // Start periodic cleanup to prevent memory leaks
        this.startCleanupInterval();

        log({ module: 'auth' }, 'Auth module initialized');
    }

    private startCleanupInterval(): void {
        if (this.cleanupInterval) {
            return;
        }
        this.cleanupInterval = setInterval(() => {
            this.cleanupExpiredTokens();
        }, TOKEN_CACHE_CLEANUP_INTERVAL_MS);
        // Don't prevent process exit
        this.cleanupInterval.unref();
    }

    private cleanupExpiredTokens(): void {
        const now = Date.now();
        let expiredCount = 0;

        for (const [token, entry] of this.tokenCache.entries()) {
            if (now - entry.cachedAt > TOKEN_CACHE_TTL_MS) {
                this.tokenCache.delete(token);
                expiredCount++;
            }
        }

        if (expiredCount > 0) {
            log({ module: 'auth' }, `Cleaned up ${expiredCount} expired tokens. Cache size: ${this.tokenCache.size}`);
        }
    }

    private evictLRUIfNeeded(): void {
        if (this.tokenCache.size < TOKEN_CACHE_MAX_SIZE) {
            return;
        }

        // Find and remove the least recently accessed token
        let oldestToken: string | null = null;
        let oldestAccess = Date.now();

        for (const [token, entry] of this.tokenCache.entries()) {
            if (entry.lastAccessedAt < oldestAccess) {
                oldestAccess = entry.lastAccessedAt;
                oldestToken = token;
            }
        }

        if (oldestToken) {
            this.tokenCache.delete(oldestToken);
            log({ module: 'auth' }, `Evicted LRU token. Cache size: ${this.tokenCache.size}`);
        }
    }
    
    async createToken(userId: string, extras?: any): Promise<string> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }
        
        const payload: any = { user: userId };
        if (extras) {
            payload.extras = extras;
        }
        
        const token = await this.tokens.generator.new(payload);

        // Evict LRU token if cache is full
        this.evictLRUIfNeeded();

        const now = Date.now();
        // Cache the token with expiration tracking
        this.tokenCache.set(token, {
            userId,
            extras,
            cachedAt: now,
            lastAccessedAt: now
        });

        return token;
    }
    
    async verifyToken(token: string): Promise<{ userId: string; extras?: any } | null> {
        // Check cache first
        const cached = this.tokenCache.get(token);
        if (cached) {
            const now = Date.now();
            // Check if token has expired
            if (now - cached.cachedAt > TOKEN_CACHE_TTL_MS) {
                this.tokenCache.delete(token);
                // Token expired, need to re-verify
            } else {
                // Update last accessed time for LRU
                cached.lastAccessedAt = now;
                return {
                    userId: cached.userId,
                    extras: cached.extras
                };
            }
        }
        
        // Cache miss - verify token
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }
        
        try {
            const verified = await this.tokens.verifier.verify(token);
            if (!verified) {
                return null;
            }
            
            const userId = verified.user as string;
            const extras = verified.extras;

            // Evict LRU token if cache is full
            this.evictLRUIfNeeded();

            const now = Date.now();
            // Cache the result with expiration tracking
            this.tokenCache.set(token, {
                userId,
                extras,
                cachedAt: now,
                lastAccessedAt: now
            });

            return { userId, extras };
            
        } catch (error) {
            log({ module: 'auth', level: 'error' }, `Token verification failed: ${error}`);
            return null;
        }
    }
    
    invalidateUserTokens(userId: string): void {
        // Remove all tokens for a specific user
        // This is expensive but rarely needed
        for (const [token, entry] of this.tokenCache.entries()) {
            if (entry.userId === userId) {
                this.tokenCache.delete(token);
            }
        }
        
        log({ module: 'auth' }, `Invalidated tokens for user: ${userId}`);
    }
    
    invalidateToken(token: string): void {
        this.tokenCache.delete(token);
    }
    
    getCacheStats(): { size: number; oldestEntry: number | null } {
        if (this.tokenCache.size === 0) {
            return { size: 0, oldestEntry: null };
        }
        
        let oldest = Date.now();
        for (const entry of this.tokenCache.values()) {
            if (entry.cachedAt < oldest) {
                oldest = entry.cachedAt;
            }
        }
        
        return {
            size: this.tokenCache.size,
            oldestEntry: oldest
        };
    }
    
    async createGithubToken(userId: string): Promise<string> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }
        
        const payload = { user: userId, purpose: 'github-oauth' };
        const token = await this.tokens.githubGenerator.new(payload);
        
        return token;
    }

    async verifyGithubToken(token: string): Promise<{ userId: string } | null> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }

        try {
            const verified = await this.tokens.githubVerifier.verify(token);
            if (!verified) {
                return null;
            }

            return { userId: verified.user as string };
        } catch (error) {
            log({ module: 'auth', level: 'error' }, `GitHub token verification failed: ${error}`);
            return null;
        }
    }

    /**
     * Create a genome-hub scoped token for a user.
     * The token is signed with an ephemeral key; genome-hub verifies it
     * using only the public key — no shared secret required.
     */
    async createGenomeToken(userId: string, scope: string[] = ['genome:read', 'genome:write', 'feedback:write']): Promise<string> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }

        return this.tokens.genomeGenerator.new({
            user: userId,
            extras: { scope },
        });
    }

    /** Expose the public key so genome-hub (or deploy scripts) can verify tokens.
     *  Returned as base64 so it round-trips safely through JSON. */
    getGenomePublicKey(): string {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }
        return privacyKit.encodeBase64(this.tokens.genomeGenerator.publicKey);
    }

    // Force cleanup of expired tokens (can be called manually)
    cleanup(): void {
        this.cleanupExpiredTokens();
        const stats = this.getCacheStats();
        log({ module: 'auth' }, `Token cache size: ${stats.size} entries`);
    }

    // Stop cleanup interval (for graceful shutdown)
    shutdown(): void {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        log({ module: 'auth' }, 'Auth module shutdown');
    }
}

// Global instance
export const auth = new AuthModule();