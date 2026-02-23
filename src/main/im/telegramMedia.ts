/**
 * Telegram Media Download Utilities
 * Telegram 媒体下载工具函数
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { Context } from 'grammy';
import type { IMMediaAttachment } from './types';
import { fetchWithSystemProxy } from './http';

// 常量
const MAX_FILE_SIZE = 20 * 1024 * 1024;  // Telegram Bot API 限制 20MB
const INBOUND_DIR = 'telegram-inbound';

/**
 * 获取媒体存储目录
 */
export function getTelegramMediaDir(): string {
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
function generateFileName(fileId: string, extension: string): string {
  const timestamp = Date.now();
  const shortId = fileId.slice(-8);  // 取 file_id 后 8 位
  return `${timestamp}_${shortId}${extension}`;
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
    'image/bmp': '.bmp',
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/webm': '.webm',
    'video/x-msvideo': '.avi',
    'audio/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp4': '.m4a',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'application/pdf': '.pdf',
    'application/zip': '.zip',
    'application/x-rar-compressed': '.rar',
    'application/octet-stream': '.bin',
  };
  return mimeMap[mimeType] || '.bin';
}

/**
 * 下载 Telegram 文件
 * @param ctx Grammy Context
 * @param fileId Telegram file_id
 * @param mimeType MIME 类型
 * @param originalFileName 原始文件名（可选）
 */
export async function downloadTelegramFile(
  ctx: Context,
  fileId: string,
  mimeType: string,
  originalFileName?: string
): Promise<{ localPath: string; fileSize: number } | null> {
  try {
    // 1. 获取文件信息
    const file = await ctx.api.getFile(fileId);

    if (!file.file_path) {
      console.warn('[Telegram Media] No file_path returned');
      return null;
    }

    // 2. 检查文件大小
    if (file.file_size && file.file_size > MAX_FILE_SIZE) {
      console.warn(`[Telegram Media] File too large: ${(file.file_size / 1024 / 1024).toFixed(1)}MB (limit: 20MB)`);
      return null;
    }

    // 3. 构建下载 URL
    const botToken = ctx.api.token;
    const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;

    // 4. 确定文件名
    let extension = path.extname(file.file_path) || getExtensionFromMime(mimeType);
    if (originalFileName) {
      extension = path.extname(originalFileName) || extension;
    }
    const fileName = generateFileName(fileId, extension);

    // 5. 下载文件
    const mediaDir = getTelegramMediaDir();
    const localPath = path.join(mediaDir, fileName);

    const response = await fetchWithSystemProxy(downloadUrl);
    if (!response.ok) {
      throw new Error(`Download failed: HTTP ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(localPath, buffer);

    console.log(`[Telegram Media] Downloaded: ${fileName} (${(buffer.length / 1024).toFixed(1)} KB)`);

    return {
      localPath,
      fileSize: buffer.length,
    };
  } catch (error: any) {
    console.error(`[Telegram Media] Download failed: ${error.message}`);
    return null;
  }
}

/**
 * 从 Telegram 消息提取媒体附件
 */
export async function extractMediaFromMessage(
  ctx: Context
): Promise<IMMediaAttachment[]> {
  const msg = ctx.message;
  if (!msg) return [];

  const attachments: IMMediaAttachment[] = [];

  // 1. 照片 - 取最高分辨率
  if (msg.photo && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1];  // 最后一个是最大的
    const result = await downloadTelegramFile(ctx, photo.file_id, 'image/jpeg');
    if (result) {
      attachments.push({
        type: 'image',
        localPath: result.localPath,
        mimeType: 'image/jpeg',
        fileSize: result.fileSize,
        width: photo.width,
        height: photo.height,
      });
    }
  }

  // 2. 视频
  if (msg.video) {
    const video = msg.video;
    const mimeType = video.mime_type || 'video/mp4';
    const result = await downloadTelegramFile(ctx, video.file_id, mimeType, video.file_name);
    if (result) {
      attachments.push({
        type: 'video',
        localPath: result.localPath,
        mimeType,
        fileName: video.file_name,
        fileSize: result.fileSize,
        width: video.width,
        height: video.height,
        duration: video.duration,
      });
    }
  }

  // 3. 圆形视频 (video_note)
  if (msg.video_note) {
    const videoNote = msg.video_note;
    const result = await downloadTelegramFile(ctx, videoNote.file_id, 'video/mp4');
    if (result) {
      attachments.push({
        type: 'video',
        localPath: result.localPath,
        mimeType: 'video/mp4',
        fileSize: result.fileSize,
        width: videoNote.length,
        height: videoNote.length,
        duration: videoNote.duration,
      });
    }
  }

  // 4. 音频文件
  if (msg.audio) {
    const audio = msg.audio;
    const mimeType = audio.mime_type || 'audio/mpeg';
    const result = await downloadTelegramFile(ctx, audio.file_id, mimeType, audio.file_name);
    if (result) {
      attachments.push({
        type: 'audio',
        localPath: result.localPath,
        mimeType,
        fileName: audio.file_name,
        fileSize: result.fileSize,
        duration: audio.duration,
      });
    }
  }

  // 5. 语音消息
  if (msg.voice) {
    const voice = msg.voice;
    const mimeType = voice.mime_type || 'audio/ogg';
    const result = await downloadTelegramFile(ctx, voice.file_id, mimeType);
    if (result) {
      attachments.push({
        type: 'voice',
        localPath: result.localPath,
        mimeType,
        fileSize: result.fileSize,
        duration: voice.duration,
      });
    }
  }

  // 6. 文档/文件
  if (msg.document) {
    const doc = msg.document;
    const mimeType = doc.mime_type || 'application/octet-stream';
    const result = await downloadTelegramFile(ctx, doc.file_id, mimeType, doc.file_name);
    if (result) {
      attachments.push({
        type: 'document',
        localPath: result.localPath,
        mimeType,
        fileName: doc.file_name,
        fileSize: result.fileSize,
      });
    }
  }

  // 7. 贴纸 (仅静态 WEBP)
  if (msg.sticker) {
    const sticker = msg.sticker;
    // 只处理静态贴纸，跳过动画贴纸 (TGS) 和视频贴纸 (WEBM)
    if (!sticker.is_animated && !sticker.is_video) {
      const result = await downloadTelegramFile(ctx, sticker.file_id, 'image/webp');
      if (result) {
        attachments.push({
          type: 'sticker',
          localPath: result.localPath,
          mimeType: 'image/webp',
          fileSize: result.fileSize,
          width: sticker.width,
          height: sticker.height,
        });
      }
    } else {
      console.log('[Telegram Media] Skipping animated/video sticker');
    }
  }

  return attachments;
}

/**
 * 清理过期的媒体文件
 * @param maxAgeDays 最大保留天数，默认 7 天
 */
export function cleanupOldMediaFiles(maxAgeDays: number = 7): void {
  const mediaDir = getTelegramMediaDir();
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
        console.warn(`[Telegram Media] Failed to check/delete file ${file}: ${err.message}`);
      }
    }

    if (cleanedCount > 0) {
      console.log(`[Telegram Media] Cleaned up ${cleanedCount} old files`);
    }
  } catch (error: any) {
    console.warn(`[Telegram Media] Cleanup error: ${error.message}`);
  }
}
