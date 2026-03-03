/**
 * NIM Media Utilities
 * 云信媒体消息处理：下载、发送、类型推断、清理
 * 
 * 参考 openclaw-nim/src/media.ts 实现，适配 LobsterAI Gateway 架构
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { app } from 'electron';
import type { IMMediaAttachment, IMMediaType } from './types';

// ==================== 常量 ====================

/** 最大下载文件大小：30MB（与 openclaw-nim 一致） */
const MAX_FILE_SIZE = 30 * 1024 * 1024;

/** 下载文件存储子目录 */
const INBOUND_DIR = 'nim-inbound';

// ==================== 目录管理 ====================

/**
 * 获取 NIM 媒体文件存储目录
 */
export function getNimMediaDir(): string {
  const userDataPath = app.getPath('userData');
  const mediaDir = path.join(userDataPath, INBOUND_DIR);

  if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
  }

  return mediaDir;
}

// ==================== 文件名与类型推断 ====================

/**
 * 生成唯一文件名
 */
function generateFileName(prefix: string, extension: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}_${prefix}_${random}${extension}`;
}

/**
 * 根据文件扩展名推断 NIM 消息类型（用于发送时决定调用哪个 SDK 方法）
 * 与 openclaw-nim/src/media.ts 的 inferMessageType 一致
 */
export function inferMediaType(filePath: string): 'image' | 'audio' | 'video' | 'file' {
  const ext = path.extname(filePath).toLowerCase();

  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
  const audioExts = ['.mp3', '.wav', '.aac', '.m4a', '.ogg', '.amr'];
  const videoExts = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv'];

  if (imageExts.includes(ext)) return 'image';
  if (audioExts.includes(ext)) return 'audio';
  if (videoExts.includes(ext)) return 'video';
  return 'file';
}

/**
 * 根据文件扩展名推断 MIME 类型（用于填充 IMMediaAttachment.mimeType）
 */
export function inferMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();

  const mimeMap: Record<string, string> = {
    // 图片
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    // 音频
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.aac': 'audio/aac',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.amr': 'audio/amr',
    // 视频
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.flv': 'video/x-flv',
    // 文档
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.rar': 'application/x-rar-compressed',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.txt': 'text/plain',
  };

  return mimeMap[ext] || 'application/octet-stream';
}

/**
 * 将 inferMediaType 的结果转为 IMMediaType
 */
function toIMMediaType(mediaType: 'image' | 'audio' | 'video' | 'file'): IMMediaType {
  if (mediaType === 'file') return 'document';
  return mediaType;
}

/**
 * 推断消息的媒体类型占位符文本
 * 与 openclaw-nim/src/media.ts 的 inferMediaPlaceholder 一致
 */
export function inferMediaPlaceholder(messageType: string): string {
  switch (messageType) {
    case 'image':
      return '[图片]';
    case 'audio':
      return '[语音消息]';
    case 'video':
      return '[视频]';
    case 'file':
      return '[文件]';
    default:
      return '[多媒体消息]';
  }
}

// ==================== 下载 ====================

/**
 * 流式下载文件（支持重定向和大小限制）
 * 与 openclaw-nim/src/media.ts 的 downloadFile 一致
 */
function downloadFile(url: string, destPath: string, maxBytes: number = MAX_FILE_SIZE): Promise<void> {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    let downloadedBytes = 0;

    protocol.get(url, (response) => {
      // 处理重定向
      if (response.statusCode === 301 || response.statusCode === 302) {
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          file.close();
          try { fs.unlinkSync(destPath); } catch { /* ignore */ }
          downloadFile(redirectUrl, destPath, maxBytes).then(resolve).catch(reject);
          return;
        }
      }

      if (response.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(destPath); } catch { /* ignore */ }
        reject(new Error(`Download failed with status ${response.statusCode}`));
        return;
      }

      response.on('data', (chunk: Buffer) => {
        downloadedBytes += chunk.length;
        if (downloadedBytes > maxBytes) {
          response.destroy();
          file.close();
          try { fs.unlinkSync(destPath); } catch { /* ignore */ }
          reject(new Error(`File too large (>${(maxBytes / 1024 / 1024).toFixed(0)}MB)`));
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        resolve();
      });

      file.on('error', (err) => {
        file.close();
        try { fs.unlinkSync(destPath); } catch { /* ignore */ }
        reject(err);
      });
    }).on('error', (err) => {
      file.close();
      try { fs.unlinkSync(destPath); } catch { /* ignore */ }
      reject(err);
    });
  });
}

/**
 * 下载 NIM 媒体文件并返回 IMMediaAttachment
 * 
 * @param url NOS 媒体 URL
 * @param attachment V2 消息的 attachment 对象
 * @param mediaType 消息类型 (image/audio/video/file)
 * @param log 日志函数
 */
export async function downloadNimMedia(
  url: string,
  attachment: {
    name?: string;
    size?: number;
    width?: number;
    height?: number;
    duration?: number;
  },
  mediaType: 'image' | 'audio' | 'video' | 'file',
  log: (...args: any[]) => void = console.log,
): Promise<IMMediaAttachment | null> {
  if (!url) {
    return null;
  }

  try {
    // 从 URL 提取扩展名
    const urlPath = url.split('?')[0];
    const ext = path.extname(urlPath) || '.bin';
    const fileName = attachment.name || `nim_${Date.now()}${ext}`;
    const localFileName = generateFileName('nim', ext);

    const mediaDir = getNimMediaDir();
    const localPath = path.join(mediaDir, localFileName);

    log(`[NIM Media] Downloading: ${url.substring(0, 80)}...`);

    // 流式下载
    await downloadFile(url, localPath, MAX_FILE_SIZE);

    // 获取实际文件大小
    const stats = fs.statSync(localPath);
    const mimeType = inferMimeType(localPath);

    log(`[NIM Media] Downloaded: ${localFileName} (${(stats.size / 1024).toFixed(1)} KB)`);

    return {
      type: toIMMediaType(mediaType),
      localPath,
      mimeType,
      fileName,
      fileSize: stats.size,
      width: attachment.width,
      height: attachment.height,
      duration: attachment.duration,
    };
  } catch (error: any) {
    log(`[NIM Media] Download failed: ${error.message}`);
    return null;
  }
}

// ==================== 发送 ====================

/**
 * 通过 NIM SDK 发送媒体消息
 * 
 * @param messageService V2NIMMessageService 实例
 * @param messageCreator V2NIMMessageCreator 实例
 * @param conversationId 目标会话 ID
 * @param filePath 本地文件路径
 * @param log 日志函数
 */
export async function sendNimMediaMessage(
  messageService: any,
  messageCreator: any,
  conversationId: string,
  filePath: string,
  log: (...args: any[]) => void = console.log,
): Promise<void> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const mediaType = inferMediaType(filePath);
  const baseName = path.basename(filePath);
  let message: any;

  switch (mediaType) {
    case 'image':
      // createImageMessage(filePath, name, sceneName, width, height)
      message = messageCreator.createImageMessage(filePath, baseName, '', 0, 0);
      break;

    case 'audio':
      // createAudioMessage(filePath, name, sceneName, duration)
      message = messageCreator.createAudioMessage?.(filePath, baseName, '', 0);
      break;

    case 'video':
      // createVideoMessage(filePath, name, sceneName, duration, width, height)
      // 默认 1920x1080，与 openclaw-nim/src/outbound.ts 一致
      message = messageCreator.createVideoMessage?.(filePath, baseName, '', 0, 1920, 1080);
      break;

    case 'file':
    default:
      // createFileMessage(filePath, name, sceneName)
      message = messageCreator.createFileMessage(filePath, baseName, '');
      break;
  }

  if (!message) {
    throw new Error(`Failed to create ${mediaType} message for: ${baseName}`);
  }

  log(`[NIM Media] Sending ${mediaType}: ${baseName} to ${conversationId}`);
  const result = await messageService.sendMessage(message, conversationId, {}, () => {});
  log(`[NIM Media] Send result:`, result);
}

// ==================== 清理 ====================

/**
 * 清理过期的 NIM 媒体文件
 * @param maxAgeDays 最大保留天数，默认 7 天
 */
export function cleanupOldNimMediaFiles(maxAgeDays: number = 7): void {
  const mediaDir = getNimMediaDir();
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
        console.warn(`[NIM Media] Failed to check/delete file ${file}: ${err.message}`);
      }
    }

    if (cleanedCount > 0) {
      console.log(`[NIM Media] Cleaned up ${cleanedCount} old files`);
    }
  } catch (error: any) {
    console.warn(`[NIM Media] Cleanup error: ${error.message}`);
  }
}
