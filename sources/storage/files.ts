/**
 * MinIO 替换为文件系统存储
 * 兼容原 MinIO 接口
 */

import fs from 'fs/promises'
import path from 'path'
import { existsSync } from 'fs'

// 兼容性导出
export const s3host = process.env.S3_HOST || 'localhost'
export const s3bucket = process.env.S3_BUCKET || 'local-storage'
export const s3public = process.env.S3_PUBLIC_URL || 'file://'

/**
 * 文件系统存储客户端
 */
class FileSystemClient {
  private uploadDir: string

  constructor() {
    const basePath = process.env.LOCAL_STORAGE_PATH || process.env.HOME || '.'
    this.uploadDir = path.join(basePath, 'localCoworker', 'uploads')
  }

  /**
   * 上传文件
   */
  async putObject(bucket: string, key: string, buffer: Buffer): Promise<void> {
    const filePath = path.join(this.uploadDir, bucket, key)
    const dir = path.dirname(filePath)

    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(filePath, new Uint8Array(buffer))
  }

  /**
   * 读取文件
   */
  async getObject(bucket: string, key: string): Promise<Buffer> {
    const filePath = path.join(this.uploadDir, bucket, key)
    return await fs.readFile(filePath)
  }

  /**
   * 删除文件
   */
  async removeObject(bucket: string, key: string): Promise<void> {
    const filePath = path.join(this.uploadDir, bucket, key)
    try {
      await fs.unlink(filePath)
    } catch {
      // 忽略文件不存在的错误
    }
  }

  /**
   * 检查桶是否存在 (检查目录)
   */
  async bucketExists(bucket: string): Promise<boolean> {
    const bucketPath = path.join(this.uploadDir, bucket)
    return existsSync(bucketPath)
  }
}

export const s3client = new FileSystemClient()

export async function loadFiles() {
  // 确保上传目录存在
  await fs.mkdir(s3client['uploadDir'], { recursive: true })
  console.log('File system storage initialized at:', s3client['uploadDir'])
}

export function getPublicUrl(path: string) {
  return `${s3public}${path}`
}

export type ImageRef = {
  width: number
  height: number
  thumbhash: string
  path: string
}
