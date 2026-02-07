/**
 * 本地文件系统存储,替代 MinIO
 * 使用 Node.js fs 模块直接读写文件
 */

import fs from 'fs/promises'
import path from 'path'
import { existsSync } from 'fs'

interface UploadResult {
  path: string
  url: string
  etag?: string
}

class FileSystemStorage {
  private uploadDir: string
  private publicUrl: string

  constructor() {
    // 使用环境变量或默认路径
    const basePath = process.env.LOCAL_STORAGE_PATH || process.env.HOME || '.'
    this.uploadDir = path.join(basePath, 'localCoworker', 'uploads')
    this.publicUrl = process.env.LOCAL_STORAGE_PUBLIC_URL || 'file://'
    this.ensureDir()
  }

  /**
   * 确保上传目录存在
   */
  private async ensureDir(): Promise<void> {
    try {
      await fs.mkdir(this.uploadDir, { recursive: true })
    } catch (error) {
      console.error('Failed to create upload directory:', error)
    }
  }

  /**
   * 上传文件
   * @param bucket 桶名 (兼容 MinIO,实际创建子目录)
   * @param key 文件路径
   * @param buffer 文件内容
   */
  async putObject(bucket: string, key: string, buffer: Buffer): Promise<void> {
    const filePath = this.getFilePath(bucket, key)

    // 确保目录存在
    const dir = path.dirname(filePath)
    await fs.mkdir(dir, { recursive: true })

    // 写入文件
    await fs.writeFile(filePath, buffer)
  }

  /**
   * 读取文件
   * @param bucket 桶名
   * @param key 文件路径
   * @returns 文件内容
   */
  async getObject(bucket: string, key: string): Promise<Buffer> {
    const filePath = this.getFilePath(bucket, key)
    return await fs.readFile(filePath)
  }

  /**
   * 删除文件
   * @param bucket 桶名
   * @param key 文件路径
   */
  async removeObject(bucket: string, key: string): Promise<void> {
    const filePath = this.getFilePath(bucket, key)
    try {
      await fs.unlink(filePath)
    } catch (error) {
      // 忽略文件不存在的错误
      console.warn('Failed to remove file:', filePath)
    }
  }

  /**
   * 检查文件是否存在
   * @param bucket 桶名
   * @param key 文件路径
   */
  async exists(bucket: string, key: string): Promise<boolean> {
    const filePath = this.getFilePath(bucket, key)
    return existsSync(filePath)
  }

  /**
   * 获取文件 URL
   * @param path 文件路径
   * @returns 文件 URL
   */
  getPublicUrl(path: string): string {
    return `${this.publicUrl}${path}`
  }

  /**
   * 获取文件完整路径
   * @param bucket 桶名
   * @param key 文件路径
   * @returns 完整文件路径
   */
  private getFilePath(bucket: string, key: string): string {
    return path.join(this.uploadDir, bucket, key)
  }

  /**
   * 列出文件
   * @param bucket 桶名
   * @param prefix 前缀
   * @returns 文件列表
   */
  async listObjects(bucket: string, prefix?: string): Promise<string[]> {
    const bucketDir = path.join(this.uploadDir, bucket)
    const files: string[] = []

    try {
      const items = await fs.readdir(bucketDir, { recursive: true })

      for (const item of items) {
        if (prefix && !item.startsWith(prefix)) continue
        files.push(item)
      }
    } catch (error) {
      console.warn('Failed to list objects:', error)
    }

    return files
  }

  /**
   * 获取文件统计信息
   * @param bucket 桶名
   * @param key 文件路径
   * @returns 文件统计信息
   */
  async statObject(bucket: string, key: string): Promise<{ size: number; modifiedTime: Date } | null> {
    const filePath = this.getFilePath(bucket, key)

    try {
      const stats = await fs.stat(filePath)
      return {
        size: stats.size,
        modifiedTime: stats.mtime
      }
    } catch (error) {
      return null
    }
  }
}

// 导出单例
export const fileStorage = new FileSystemStorage()

// 兼容 MinIO 客户端接口的导出
export const s3client = fileStorage
export const s3bucket = process.env.S3_BUCKET || 'local-storage'
export const s3host = process.env.S3_HOST || 'localhost'
export const s3public = process.env.S3_PUBLIC_URL || 'file://'

// 初始化函数 (兼容)
export async function loadFiles(): Promise<void> {
  // 确保上传目录存在
  await fileStorage['ensureDir']()
  console.log('File system storage initialized at:', fileStorage['uploadDir'])
}

export default fileStorage
