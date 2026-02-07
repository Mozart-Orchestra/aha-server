/**
 * 内存缓存,替代 Redis
 * 注意: 数据存储在内存中,应用重启后丢失
 */

interface CacheItem {
  value: string
  expiresAt?: number
}

class MemoryCache {
  private cache = new Map<string, CacheItem>()
  private cleanupInterval: NodeJS.Timeout

  constructor() {
    // 定时清理过期数据 (每分钟)
    this.cleanupInterval = setInterval(() => {
      this.cleanup()
    }, 60 * 1000)
  }

  /**
   * 设置缓存
   * @param key 键
   * @param value 值
   * @param ttl 过期时间(秒),可选
   */
  set(key: string, value: string, ttl?: number): void {
    const expiresAt = ttl ? Date.now() + ttl * 1000 : undefined
    this.cache.set(key, { value, expiresAt })
  }

  /**
   * 获取缓存
   * @param key 键
   * @returns 值或null
   */
  get(key: string): string | null {
    const item = this.cache.get(key)
    if (!item) return null

    // 检查是否过期
    if (item.expiresAt && item.expiresAt < Date.now()) {
      this.cache.delete(key)
      return null
    }

    return item.value
  }

  /**
   * 删除缓存
   * @param key 键
   */
  del(key: string): void {
    this.cache.delete(key)
  }

  /**
   * 批量删除
   * @param keys 键数组
   */
  delBatch(...keys: string[]): void {
    keys.forEach(key => this.cache.delete(key))
  }

  /**
   * 检查键是否存在
   * @param key 键
   * @returns 1存在, 0不存在
   */
  exists(key: string): number {
    const item = this.cache.get(key)
    if (!item) return 0

    // 检查是否过期
    if (item.expiresAt && item.expiresAt < Date.now()) {
      this.cache.delete(key)
      return 0
    }

    return 1
  }

  /**
   * 获取所有匹配的键
   * @param pattern 模式 (支持 * 通配符)
   * @returns 键数组
   */
  keys(pattern: string): string[] {
    // 简单实现,支持 * 通配符
    const regex = new RegExp(pattern.replace(/\*/g, '.*'))
    return Array.from(this.cache.keys()).filter(key => regex.test(key))
  }

  /**
   * 设置带过期时间的键
   * @param key 键
   * @param seconds 秒数
   */
  expire(key: string, seconds: number): void {
    const item = this.cache.get(key)
    if (item) {
      item.expiresAt = Date.now() + seconds * 1000
    }
  }

  /**
   * 获取剩余过期时间
   * @param key 键
   * @returns 剩余秒数,-1表示永不过期,-2表示键不存在
   */
  ttl(key: string): number {
    const item = this.cache.get(key)
    if (!item) return -2

    if (!item.expiresAt) return -1

    const remaining = Math.floor((item.expiresAt - Date.now()) / 1000)
    return remaining > 0 ? remaining : -2
  }

  /**
   * 增加数值
   * @param key 键
   * @param increment 增量,默认1
   * @returns 增加后的值
   */
  incr(key: string, increment: number = 1): number {
    const current = this.get(key)
    const value = current ? parseInt(current, 10) + increment : increment
    this.set(key, value.toString())
    return value
  }

  /**
   * 减少数值
   * @param key 键
   * @param decrement 减量,默认1
   * @returns 减少后的值
   */
  decr(key: string, decrement: number = 1): number {
    return this.incr(key, -decrement)
  }

  /**
   * 清理过期数据
   */
  private cleanup(): void {
    const now = Date.now()
    for (const [key, item] of this.cache.entries()) {
      if (item.expiresAt && item.expiresAt < now) {
        this.cache.delete(key)
      }
    }
  }

  /**
   * 清空所有缓存
   */
  flushall(): void {
    this.cache.clear()
  }

  /**
   * 获取缓存大小
   */
  get size(): number {
    return this.cache.size
  }

  /**
   * Ping 检查 (兼容 Redis)
   * @returns 'PONG'
   */
  async ping(): Promise<string> {
    return 'PONG'
  }

  /**
   * 销毁定时器
   */
  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
    }
  }
}

// 导出单例
export const memoryCache = new MemoryCache()

// 兼容 Redis 接口的重导出
export { memoryCache as redis }

// 类型兼容
export default memoryCache
