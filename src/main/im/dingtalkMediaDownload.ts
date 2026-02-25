/**
 * DingTalk Media Download Utilities
 * 钉钉媒体下载工具函数（接收端）
 */
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { fetchWithSystemProxy } from './http';
import type { IMMediaType } from './types';

const DINGTALK_API = 'https://api.dingtalk.com';
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const INBOUND_DIR = 'dingtalk-inbound';

/**
 * 获取钉钉媒体存储目录
 */
export function getDingtalkMediaDir(): string {
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
function generateFileName(prefix: string, extension: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}_${random}${extension}`;
}

/**
 * 根据媒体类型获取默认扩展名
 */
function getDefaultExtension(mediaType: string): string {
  switch (mediaType) {
    case 'image': return '.jpg';
    case 'video': return '.mp4';
    case 'audio': return '.ogg';
    case 'voice': return '.ogg';
    case 'file': return '.bin';
    default: return '.bin';
  }
}

/**
 * 根据媒体类型获取默认 MIME 类型
 */
export function getDefaultMimeType(mediaType: string): string {
  switch (mediaType) {
    case 'image': return 'image/jpeg';
    case 'video': return 'video/mp4';
    case 'audio': return 'audio/ogg';
    case 'voice': return 'audio/ogg';
    case 'file': return 'application/octet-stream';
    default: return 'application/octet-stream';
  }
}

/**
 * 将钉钉消息类型映射为 IMMediaType
 */
export function mapDingtalkMediaType(mediaType: string): IMMediaType {
  switch (mediaType) {
    case 'image': return 'image';
    case 'video': return 'video';
    case 'audio': return 'audio';
    case 'voice': return 'voice';
    case 'file': return 'document';
    default: return 'document';
  }
}

/**
 * 下载钉钉媒体文件
 *
 * 使用钉钉机器人消息文件下载 API:
 * POST /v1.0/robot/messageFiles/download
 *
 * @param accessToken 钉钉 access_token
 * @param downloadCode 消息中的 downloadCode
 * @param robotCode 机器人 robotCode (即 clientId)
 * @param mediaType 媒体类型 (image/video/audio/file)
 * @param fileName 原始文件名（可选）
 */
export async function downloadDingtalkFile(
  accessToken: string,
  downloadCode: string,
  robotCode: string,
  mediaType: string,
  fileName?: string
): Promise<{ localPath: string; fileSize: number } | null> {
  try {
    console.log(`[DingTalk Media] 下载媒体文件:`, JSON.stringify({
      mediaType,
      fileName,
      downloadCodeLength: downloadCode.length,
    }));

    // Step 1: Get temporary download URL from DingTalk API
    const apiResponse = await fetchWithSystemProxy(
      `${DINGTALK_API}/v1.0/robot/messageFiles/download`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-acs-dingtalk-access-token': accessToken,
        },
        body: JSON.stringify({ downloadCode, robotCode }),
      }
    );

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      console.error(`[DingTalk Media] 获取下载URL失败: HTTP ${apiResponse.status}`, errorText);
      return null;
    }

    const apiResult = await apiResponse.json() as { downloadUrl?: string };
    if (!apiResult.downloadUrl) {
      console.error(`[DingTalk Media] API未返回downloadUrl:`, JSON.stringify(apiResult));
      return null;
    }

    console.log(`[DingTalk Media] 获取下载URL成功`);

    // Step 2: Download actual file from the temporary URL
    const fileResponse = await fetchWithSystemProxy(apiResult.downloadUrl);
    if (!fileResponse.ok) {
      console.error(`[DingTalk Media] 文件下载失败: HTTP ${fileResponse.status}`);
      return null;
    }

    const buffer = Buffer.from(await fileResponse.arrayBuffer());

    if (buffer.length > MAX_FILE_SIZE) {
      console.warn(`[DingTalk Media] 文件过大: ${(buffer.length / 1024 / 1024).toFixed(1)}MB (限制: 20MB)`);
      return null;
    }

    // 确定文件扩展名
    let extension = getDefaultExtension(mediaType);
    if (fileName) {
      const ext = path.extname(fileName);
      if (ext) extension = ext;
    }

    const localFileName = generateFileName(mediaType, extension);
    const mediaDir = getDingtalkMediaDir();
    const localPath = path.join(mediaDir, localFileName);

    fs.writeFileSync(localPath, buffer);

    console.log(`[DingTalk Media] 下载成功: ${localFileName} (${(buffer.length / 1024).toFixed(1)} KB)`);

    return {
      localPath,
      fileSize: buffer.length,
    };
  } catch (error: any) {
    console.error(`[DingTalk Media] 下载失败: ${error.message}`);
    return null;
  }
}

/**
 * 清理过期的媒体文件
 * @param maxAgeDays 最大保留天数，默认 7 天
 */
export function cleanupOldDingtalkMediaFiles(maxAgeDays: number = 7): void {
  const mediaDir = getDingtalkMediaDir();
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
        console.warn(`[DingTalk Media] 清理文件失败 ${file}: ${err.message}`);
      }
    }

    if (cleanedCount > 0) {
      console.log(`[DingTalk Media] 清理了 ${cleanedCount} 个过期文件`);
    }
  } catch (error: any) {
    console.warn(`[DingTalk Media] 清理错误: ${error.message}`);
  }
}
