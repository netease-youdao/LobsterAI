/**
 * Discord Media Download Utilities
 * Discord 媒体下载工具函数（接收端）
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { fetchWithSystemProxy } from './http';
import type { IMMediaType } from './types';

const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB
const INBOUND_DIR = 'discord-inbound';

/**
 * 获取 Discord 媒体存储目录
 */
export function getDiscordMediaDir(): string {
  const userDataPath = app.getPath('userData');
  const mediaDir = path.join(userDataPath, INBOUND_DIR);

  if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
  }

  return mediaDir;
}

/**
 * 生成唯一文件名
 */
function generateFileName(extension: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}_${random}${extension}`;
}

/**
 * 根据 MIME 类型获取文件扩展名
 */
function getExtensionFromMime(mimeType: string): string {
  const mimeMap: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/wav': '.wav',
    'application/pdf': '.pdf',
    'application/zip': '.zip',
  };
  return mimeMap[mimeType] || '.bin';
}

/**
 * 将 Discord contentType 映射为 IMMediaType
 */
export function mapDiscordContentType(contentType: string | null): IMMediaType {
  if (!contentType) return 'document';
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  return 'document';
}

/**
 * 下载 Discord 附件
 *
 * @param url Discord CDN 下载 URL
 * @param mimeType MIME 类型
 * @param fileName 原始文件名（可选）
 */
export async function downloadDiscordAttachment(
  url: string,
  mimeType: string,
  fileName?: string
): Promise<{ localPath: string; fileSize: number } | null> {
  try {
    console.log(`[Discord Media] 下载附件:`, JSON.stringify({
      mimeType,
      fileName,
    }));

    const response = await fetchWithSystemProxy(url);
    if (!response.ok) {
      console.error(`[Discord Media] 下载失败: HTTP ${response.status}`);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length > MAX_FILE_SIZE) {
      console.warn(`[Discord Media] 文件过大: ${(buffer.length / 1024 / 1024).toFixed(1)}MB (限制: 25MB)`);
      return null;
    }

    // 确定文件扩展名
    let extension = getExtensionFromMime(mimeType);
    if (fileName) {
      const ext = path.extname(fileName);
      if (ext) extension = ext;
    }

    const localFileName = generateFileName(extension);
    const mediaDir = getDiscordMediaDir();
    const localPath = path.join(mediaDir, localFileName);

    fs.writeFileSync(localPath, buffer);

    console.log(`[Discord Media] 下载成功: ${localFileName} (${(buffer.length / 1024).toFixed(1)} KB)`);

    return {
      localPath,
      fileSize: buffer.length,
    };
  } catch (error: any) {
    console.error(`[Discord Media] 下载失败: ${error.message}`);
    return null;
  }
}

/**
 * 清理过期的媒体文件
 * @param maxAgeDays 最大保留天数，默认 7 天
 */
export function cleanupOldDiscordMediaFiles(maxAgeDays: number = 7): void {
  const mediaDir = getDiscordMediaDir();
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  try {
    if (!fs.existsSync(mediaDir)) {
      return;
    }

    const files = fs.readdirSync(mediaDir);
    let cleanedCount = 0;

    for (const file of files) {
      const filePath = path.join(mediaDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > maxAgeMs) {
          fs.unlinkSync(filePath);
          cleanedCount++;
        }
      } catch (err: any) {
        console.warn(`[Discord Media] 清理文件失败 ${file}: ${err.message}`);
      }
    }

    if (cleanedCount > 0) {
      console.log(`[Discord Media] 清理了 ${cleanedCount} 个过期文件`);
    }
  } catch (error: any) {
    console.warn(`[Discord Media] 清理错误: ${error.message}`);
  }
}
