/**
 * DingTalk Media Marker Parser
 * 解析文本中的媒体标记
 */
import type { MediaMarker } from './types';

// 文件扩展名分类
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'];
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'amr', 'm4a', 'aac'];
const VIDEO_EXTENSIONS = ['mp4', 'mov'];
// 文档/文件扩展名（非媒体类型，但需要作为文件发送）
const FILE_EXTENSIONS = [
  'txt', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'zip', 'rar', '7z', 'tar', 'gz',
  'json', 'xml', 'csv', 'md', 'html', 'htm',
  'js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'rb', 'php', 'sh',
];

// 正则表达式模式
// Markdown 图片: ![alt](path) - 匹配本地路径
// 支持: file:/// 协议, 常见系统路径, 以及 ~/.lobsterai 等用户目录路径
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(((?:file:\/\/\/|\/(?:tmp|var|private|Users|home|root)|~\/|[A-Za-z]:)[^)]+)\)/g;

// Markdown 链接: [text](path) - 匹配本地媒体文件路径
// 用于识别普通链接中的音视频文件
const MARKDOWN_LINK_RE = /\[([^\]]*)\]\(((?:file:\/\/\/|\/(?:tmp|var|private|Users|home|root)|~\/|[A-Za-z]:)[^)]+)\)/g;

// 裸路径图片: /path/to/image.png
const BARE_IMAGE_PATH_RE = /(?:^|\s)((?:\/(?:tmp|var|private|Users|home|root)\/[^\s`'",)]+|~\/[^\s`'",)]+|[A-Za-z]:[\\/][^\s`'",)]+)\.(?:png|jpg|jpeg|gif|bmp|webp))(?:\s|$|[,.])/gi;

// 裸路径音视频: /path/to/audio.mp3 或 /path/to/video.mp4
const BARE_MEDIA_PATH_RE = /(?:^|\s)((?:\/(?:tmp|var|private|Users|home|root)\/[^\s`'",)]+|~\/[^\s`'",)]+|[A-Za-z]:[\\/][^\s`'",)]+)\.(?:mp3|wav|ogg|amr|m4a|aac|mp4|mov))(?:\s|$|[,.])/gi;

// 裸路径文件: /path/to/file.txt, /path/to/file.pdf 等
const BARE_FILE_PATH_RE = /(?:^|\s)((?:\/(?:tmp|var|private|Users|home|root)\/[^\s`'",)]+|~\/[^\s`'",)]+|[A-Za-z]:[\\/][^\s`'",)]+)\.(?:txt|pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar|7z|tar|gz|json|xml|csv|md|html|htm|js|ts|py|java|c|cpp|h|cs|go|rs|rb|php|sh))(?:\s|$|[,.])/gi;

// 视频标记: [DINGTALK_VIDEO]{"path":"..."}[/DINGTALK_VIDEO]
const VIDEO_MARKER_RE = /\[DINGTALK_VIDEO\](\{[\s\S]*?\})\[\/DINGTALK_VIDEO\]/g;

// 音频标记: [DINGTALK_AUDIO]{"path":"..."}[/DINGTALK_AUDIO]
const AUDIO_MARKER_RE = /\[DINGTALK_AUDIO\](\{[\s\S]*?\})\[\/DINGTALK_AUDIO\]/g;

// 文件标记: [DINGTALK_FILE]{"path":"...","name":"..."}[/DINGTALK_FILE]
const FILE_MARKER_RE = /\[DINGTALK_FILE\](\{[\s\S]*?\})\[\/DINGTALK_FILE\]/g;

/**
 * 根据文件扩展名判断媒体类型
 */
function getMediaTypeByExtension(filePath: string): 'image' | 'audio' | 'video' | 'file' | null {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (!ext) return null;
  if (IMAGE_EXTENSIONS.includes(ext)) return 'image';
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  if (VIDEO_EXTENSIONS.includes(ext)) return 'video';
  if (FILE_EXTENSIONS.includes(ext)) return 'file';
  return null;
}

/**
 * 清理路径（移除 file:// 协议，处理转义空格）
 */
function cleanPath(rawPath: string): string {
  let path = rawPath.replace(/\\ /g, ' ');
  if (path.startsWith('file:///')) {
    path = decodeURIComponent(path.replace('file://', ''));
  }
  return path;
}

/**
 * 解析文本中的所有媒体标记
 */
export function parseMediaMarkers(text: string): MediaMarker[] {
  const markers: MediaMarker[] = [];
  const processedPaths = new Set<string>();

  // 1. 解析 Markdown 图片 ![alt](path)
  for (const match of text.matchAll(MARKDOWN_IMAGE_RE)) {
    const [fullMatch, altText, rawPath] = match;
    const path = cleanPath(rawPath);
    const name = altText?.trim() || undefined;
    if (!processedPaths.has(path)) {
      processedPaths.add(path);
      markers.push({
        type: 'image',
        path,
        name,
        originalMarker: fullMatch,
      });
    }
  }

  // 2. 解析普通 Markdown 链接 [text](path) 中的媒体文件
  for (const match of text.matchAll(MARKDOWN_LINK_RE)) {
    const [fullMatch, linkText, rawPath] = match;
    const path = cleanPath(rawPath);
    const mediaType = getMediaTypeByExtension(path);
    const name = linkText?.trim() || undefined;
    if (mediaType && !processedPaths.has(path)) {
      processedPaths.add(path);
      markers.push({
        type: mediaType,
        path,
        name,
        originalMarker: fullMatch,
      });
    }
  }

  // 3. 解析裸图片路径
  for (const match of text.matchAll(BARE_IMAGE_PATH_RE)) {
    const [fullMatch, rawPath] = match;
    const path = cleanPath(rawPath.trim());
    if (!processedPaths.has(path)) {
      processedPaths.add(path);
      markers.push({
        type: 'image',
        path,
        originalMarker: fullMatch.trim(),
      });
    }
  }

  // 4. 解析裸音视频路径
  for (const match of text.matchAll(BARE_MEDIA_PATH_RE)) {
    const [fullMatch, rawPath] = match;
    const path = cleanPath(rawPath.trim());
    const mediaType = getMediaTypeByExtension(path);
    if (mediaType && !processedPaths.has(path)) {
      processedPaths.add(path);
      markers.push({
        type: mediaType,
        path,
        originalMarker: fullMatch.trim(),
      });
    }
  }

  // 5. 解析裸文件路径 (txt, pdf, doc, etc.)
  for (const match of text.matchAll(BARE_FILE_PATH_RE)) {
    const [fullMatch, rawPath] = match;
    const path = cleanPath(rawPath.trim());
    if (!processedPaths.has(path)) {
      processedPaths.add(path);
      markers.push({
        type: 'file',
        path,
        originalMarker: fullMatch.trim(),
      });
    }
  }

  // 6. 解析视频标记 [DINGTALK_VIDEO]
  for (const match of text.matchAll(VIDEO_MARKER_RE)) {
    try {
      const info = JSON.parse(match[1]);
      if (info.path && !processedPaths.has(info.path)) {
        processedPaths.add(info.path);
        markers.push({
          type: 'video',
          path: info.path,
          name: info.title || info.name,
          originalMarker: match[0],
        });
      }
    } catch (e) {
      console.warn('[DingTalkMediaParser] failed to parse video marker:', e);
    }
  }

  // 7. 解析音频标记 [DINGTALK_AUDIO]
  for (const match of text.matchAll(AUDIO_MARKER_RE)) {
    try {
      const info = JSON.parse(match[1]);
      if (info.path && !processedPaths.has(info.path)) {
        processedPaths.add(info.path);
        markers.push({
          type: 'audio',
          path: info.path,
          originalMarker: match[0],
        });
      }
    } catch (e) {
      console.warn('[DingTalkMediaParser] failed to parse audio marker:', e);
    }
  }

  // 8. 解析文件标记 [DINGTALK_FILE]
  for (const match of text.matchAll(FILE_MARKER_RE)) {
    try {
      const info = JSON.parse(match[1]);
      if (info.path && !processedPaths.has(info.path)) {
        processedPaths.add(info.path);
        markers.push({
          type: 'file',
          path: info.path,
          name: info.name || info.fileName,
          originalMarker: match[0],
        });
      }
    } catch (e) {
      console.warn('[DingTalkMediaParser] failed to parse file marker:', e);
    }
  }

  if (markers.length > 0) {
    console.debug(`[DingTalkMediaParser] parsed ${markers.length} media marker(s) from ${text.length} chars`);
  }

  return markers;
}

/**
 * 从文本中移除已处理的媒体标记
 */
export function stripMediaMarkers(text: string, markers: MediaMarker[]): string {
  let result = text;
  for (const marker of markers) {
    result = result.replace(marker.originalMarker, '');
  }
  // 清理多余空行
  return result.replace(/\n{3,}/g, '\n\n').trim();
}
