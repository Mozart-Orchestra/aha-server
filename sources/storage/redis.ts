/**
 * Redis connection with memory fallback
 *
 * Uses real Redis when REDIS_URL is available,
 * falls back to in-memory cache for local dev without Redis.
 */

import Redis from 'ioredis';
import { log } from '@/utils/log';

const REDIS_URL = process.env.REDIS_URL || '';

let redisClient: Redis | null = null;
let isRedisAvailable = false;

// In-memory fallback (compatible interface)
class MemoryCache {
    private cache = new Map<string, { value: string; expiresAt?: number }>();
    private cleanupInterval: NodeJS.Timeout;

    constructor() {
        this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    }

    async ping(): Promise<string> {
        return 'PONG';
    }

    get(key: string): string | null {
        const item = this.cache.get(key);
        if (!item) return null;
        if (item.expiresAt && item.expiresAt < Date.now()) {
            this.cache.delete(key);
            return null;
        }
        return item.value;
    }

    set(key: string, value: string, ttl?: number): void {
        this.cache.set(key, {
            value,
            expiresAt: ttl ? Date.now() + ttl * 1000 : undefined,
        });
    }

    del(key: string): void {
        this.cache.delete(key);
    }

    delBatch(...keys: string[]): void {
        for (const key of keys) this.cache.delete(key);
    }

    exists(key: string): number {
        const item = this.cache.get(key);
        if (!item) return 0;
        if (item.expiresAt && item.expiresAt < Date.now()) {
            this.cache.delete(key);
            return 0;
        }
        return 1;
    }

    keys(pattern: string): string[] {
        const regex = new RegExp(pattern.replace(/\*/g, '.*'));
        return Array.from(this.cache.keys()).filter(k => regex.test(k));
    }

    expire(key: string, seconds: number): void {
        const item = this.cache.get(key);
        if (item) item.expiresAt = Date.now() + seconds * 1000;
    }

    ttl(key: string): number {
        const item = this.cache.get(key);
        if (!item) return -2;
        if (!item.expiresAt) return -1;
        const remaining = Math.floor((item.expiresAt - Date.now()) / 1000);
        return remaining > 0 ? remaining : -2;
    }

    incr(key: string, increment: number = 1): number {
        const current = this.get(key);
        const value = current ? parseInt(current, 10) + increment : increment;
        this.set(key, value.toString());
        return value;
    }

    decr(key: string, decrement: number = 1): number {
        return this.incr(key, -decrement);
    }

    flushall(): void {
        this.cache.clear();
    }

    get size(): number {
        return this.cache.size;
    }

    destroy(): void {
        clearInterval(this.cleanupInterval);
    }

    private cleanup(): void {
        const now = Date.now();
        for (const [key, item] of this.cache.entries()) {
            if (item.expiresAt && item.expiresAt < now) {
                this.cache.delete(key);
            }
        }
    }
}

// Initialize: try Redis, fall back to memory
function createRedisOrFallback(): Redis | MemoryCache {
    if (!REDIS_URL) {
        log({ module: 'redis', level: 'info' }, 'No REDIS_URL set, using in-memory cache');
        return new MemoryCache();
    }

    try {
        const client = new Redis(REDIS_URL, {
            maxRetriesPerRequest: 3,
            lazyConnect: true,
            connectTimeout: 5000,
            retryStrategy: (times: number) => {
                if (times > 5) {
                    log({ module: 'redis', level: 'warn' }, 'Redis retry limit reached, giving up');
                    return null;
                }
                return Math.min(times * 200, 2000);
            },
        });

        client.on('connect', () => {
            isRedisAvailable = true;
            log({ module: 'redis', level: 'info' }, 'Redis connected');
        });

        client.on('error', (err: Error) => {
            isRedisAvailable = false;
            log({ module: 'redis', level: 'warn' }, `Redis error: ${err.message}`);
        });

        client.on('close', () => {
            isRedisAvailable = false;
        });

        // Attempt eager connect, but don't block startup
        client.connect().catch(() => {
            log({ module: 'redis', level: 'warn' }, 'Redis initial connect failed, will retry');
        });

        redisClient = client;
        return client;
    } catch {
        log({ module: 'redis', level: 'warn' }, 'Failed to create Redis client, using memory fallback');
        return new MemoryCache();
    }
}

export const redis = createRedisOrFallback();
export const memoryCache = redis instanceof MemoryCache ? redis : new MemoryCache();

export function isRedisConnected(): boolean {
    return isRedisAvailable;
}

export async function closeRedis(): Promise<void> {
    if (redisClient) {
        await redisClient.quit();
        redisClient = null;
        isRedisAvailable = false;
    }
}
