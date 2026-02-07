/**
 * Redis 替换为内存缓存
 * 为了保持兼容性,导出 memoryCache 作为 redis
 */

export { redis, memoryCache } from '../cache/memory'
