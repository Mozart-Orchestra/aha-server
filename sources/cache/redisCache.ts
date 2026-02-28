/**
 * Redis Cache Service
 * V5-PERF-002: Redis Caching System
 *
 * Provides Redis-based caching with:
 * - TTL (Time-To-Live) support
 * - Cache-aside pattern
 * - Fallback to in-memory cache if Redis unavailable
 */

import Redis from 'ioredis';

// Redis connection configuration
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Cache TTL configurations (in seconds)
export const CACHE_TTL = {
  // Rating data - 5 minutes
  ratings_analytics: 300,
  ratings_summary: 300,
  team_ratings: 300,

  // Role data - 10 minutes
  roles_public: 600,
  roles_list: 600,
  role_detail: 600,

  // User data - 15 minutes
  user_profile: 900,
  user_settings: 900,

  // Default TTL
  default: 60
} as const;

// Cache key prefixes
export const CACHE_PREFIX = {
  ratings: 'ratings',
  roles: 'roles',
  user: 'user',
  analytics: 'analytics',
  team: 'team'
} as const;

// Redis client (lazy initialized)
let redisClient: Redis | null = null;
let isRedisAvailable = false;

// In-memory fallback cache
const memoryCache = new Map<string, { value: string; expiresAt: number }>();

/**
 * Initialize Redis connection
 */
export async function initRedis(): Promise<boolean> {
  try {
    if (!redisClient) {
      redisClient = new Redis(REDIS_URL, {
        maxRetriesPerRequest: 3,
        lazyConnect: true,
        connectTimeout: 5000,
      });

      redisClient.on('error', (err: Error) => {
        console.error('Redis connection error:', err.message);
        isRedisAvailable = false;
      });

      redisClient.on('connect', () => {
        console.log('Redis connected successfully');
        isRedisAvailable = true;
      });
    }

    await redisClient.connect();
    return isRedisAvailable;
  } catch (error) {
    console.error('Failed to connect to Redis:', error);
    isRedisAvailable = false;
    return false;
  }
}

/**
 * Check if Redis is available
 */
export function isRedisConnected(): boolean {
  return isRedisAvailable && redisClient !== null;
}

/**
 * Get value from cache (Redis or memory fallback)
 */
export async function getFromCache<T>(key: string): Promise<T | null> {
  // Try Redis first
  if (isRedisAvailable && redisClient) {
    try {
      const value = await redisClient.get(key);
      if (value) {
        return JSON.parse(value) as T;
      }
    } catch (error) {
      console.error('Redis get error:', error);
    }
  }

  // Fallback to memory cache
  const item = memoryCache.get(key);
  if (item && item.expiresAt > Date.now()) {
    return JSON.parse(item.value) as T;
  }

  // Remove expired item
  if (item) {
    memoryCache.delete(key);
  }

  return null;
}

/**
 * Set value in cache (Redis or memory fallback)
 */
export async function setToCache<T>(
  key: string,
  value: T,
  ttlSeconds: number = CACHE_TTL.default
): Promise<void> {
  const serialized = JSON.stringify(value);

  // Try Redis first
  if (isRedisAvailable && redisClient) {
    try {
      await redisClient.setex(key, ttlSeconds, serialized);
      return;
    } catch (error) {
      console.error('Redis set error:', error);
    }
  }

  // Fallback to memory cache
  memoryCache.set(key, {
    value: serialized,
    expiresAt: Date.now() + ttlSeconds * 1000
  });
}

/**
 * Delete value from cache
 */
export async function deleteFromCache(key: string): Promise<void> {
  // Try Redis first
  if (isRedisAvailable && redisClient) {
    try {
      await redisClient.del(key);
    } catch (error) {
      console.error('Redis delete error:', error);
    }
  }

  // Also delete from memory cache
  memoryCache.delete(key);
}

/**
 * Delete keys by pattern
 */
export async function deleteByPattern(pattern: string): Promise<number> {
  let deletedCount = 0;

  if (isRedisAvailable && redisClient) {
    try {
      const keys = await redisClient.keys(pattern);
      if (keys.length > 0) {
        deletedCount = await redisClient.del(...keys);
      }
    } catch (error) {
      console.error('Redis pattern delete error:', error);
    }
  }

  // Also clean memory cache
  const regex = new RegExp(pattern.replace('*', '.*'));
  for (const key of memoryCache.keys()) {
    if (regex.test(key)) {
      memoryCache.delete(key);
      deletedCount++;
    }
  }

  return deletedCount;
}

/**
 * Build cache key
 */
export function buildCacheKey(prefix: string, ...parts: string[]): string {
  return `${prefix}:${parts.join(':')}`;
}

/**
 * Cache-aside pattern helper
 * Gets from cache, or executes function and caches result
 */
export async function cacheAside<T>(
  key: string,
  execute: () => Promise<T>,
  ttlSeconds: number = CACHE_TTL.default
): Promise<T> {
  // Try to get from cache first
  const cached = await getFromCache<T>(key);
  if (cached !== null) {
    return cached;
  }

  // Execute function
  const result = await execute();

  // Store in cache
  await setToCache(key, result, ttlSeconds);

  return result;
}

/**
 * Invalidate cache on data update
 * Call this when ratings, roles, or user data is modified
 */
export async function invalidateCache(
  prefix: keyof typeof CACHE_PREFIX,
  id?: string
): Promise<void> {
  if (id) {
    // Delete specific key
    await deleteFromCache(buildCacheKey(prefix, id));
  } else {
    // Delete all keys with prefix
    await deleteByPattern(`${prefix}:*`);
  }

  // Also invalidate analytics when related data changes
  if (prefix === CACHE_PREFIX.ratings || prefix === CACHE_PREFIX.team) {
    await deleteByPattern(`${CACHE_PREFIX.analytics}:*`);
  }
}

/**
 * Close Redis connection
 */
export async function closeRedis(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
    isRedisAvailable = false;
  }
}

/**
 * Get cache statistics
 */
export function getCacheStats(): {
  redisConnected: boolean;
  memoryCacheSize: number;
} {
  return {
    redisConnected: isRedisAvailable,
    memoryCacheSize: memoryCache.size
  };
}
