/**
 * Display-side transformation for user messages from IM channels.
 * Strips IM-specific media metadata and replaces it with renderable markdown image syntax.
 * DISPLAY ONLY — does not affect what is sent to the AI model.
 *
 * NOTE: Some stripping (e.g. stripFeishuSystemHeader) already happens server-side
 * in openclawRuntimeAdapter.ts before the message is stored. This means some messages
 * arrive here already partially stripped (e.g. Feishu messages may be just a bare path).
 */

import { stripGoalCommandPrefixForDisplay } from '../../common/sessionTitle';

// --------------- Pattern A: NIM/DingTalk ---------------

// Placeholder line — e.g. "[图片] https://nos.netease.com/..."
// Capture the URL (group 2) so we can preserve it as plain text instead of stripping it.
const NIM_PLACEHOLDER_RE = /^\[(图片|语音消息|视频|文件|多媒体消息)\](?:\s+(https?:\/\/\S+))?\s*$/m;

// [附件信息] block — header line followed by "- ..." lines
const ATTACHMENT_INFO_BLOCK_RE = /\n?\[附件信息\]\n(?:- .+(?:\n|$))+/;

// --------------- Pattern B: OpenClaw gateway ---------------

// [media attached: <path> (<mime>)] or [media attached: <path> (<mime>) | <path>]
const OPENCLAW_MEDIA_RE = /\[media attached:\s*(.+?)\s*\(([^)]+)\)(?:\s*\|\s*(.+?))?\s*\]/g;

// Instructional text from openclaw plugins (spans to next blank line or end)
const OPENCLAW_INSTRUCTION_RE = /To send an image back, prefer the message tool[^\n]*(?:\n(?!\n)[^\n]*)*/gi;

// "media:image" or "media:<type>" on its own line
const MEDIA_TAG_RE = /^\s*media:\w+\s*$/gm;

// --------------- Shared patterns ---------------

// System: [timestamp ...] metadata lines — injected by various openclaw plugins
// (feishu, nim, popo, etc.) Matches timestamps like [2026-04-28 11:53:25 GMT+8]
const SYSTEM_TIMESTAMP_LINE_RE = /^System:\s*\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+[^\]]*\].*$/gm;

// Bare path in the openclaw inbound media directory — highly specific, safe to match
const OPENCLAW_INBOUND_IMAGE_RE = /^((?:[A-Za-z]:\\|\/)[^\n]*[/\\]openclaw[/\\]state[/\\]media[/\\]inbound[/\\][^\n]+\.(?:jpg|jpeg|png|gif|bmp|webp))\s*$/gm;

const IMAGE_EXTENSIONS = /\.(?:jpg|jpeg|png|gif|bmp|webp)$/i;

export interface UserMessageLocalMediaAttachment {
  localPath: string;
  mimeType?: string;
  name?: string;
}

export interface ParseUserMessageForDisplayOptions {
  localMediaAttachments?: UserMessageLocalMediaAttachment[];
}

function normalizeImagePathKey(filePath: string): string {
  return filePath.trim().replace(/\\/g, '/').toLowerCase();
}

function encodeFilePathAsMarkdownImage(filePath: string): string {
  const trimmed = filePath.trim();
  const normalized = trimmed.replace(/\\/g, '/');
  // Ensure correct file:// URL: file:///C:/... or file:///Users/...
  const urlPath = normalized.startsWith('/') ? normalized : `/${normalized}`;
  const encoded = encodeURI(urlPath);
  return `![](file://${encoded})`;
}

export function parseUserMessageForDisplay(
  content: string,
  options: ParseUserMessageForDisplayOptions = {},
): string {
  if (!content && !options.localMediaAttachments?.length) return content;

  // Normalize \r\n to \n so all line-anchored regexes work correctly
  let result = (content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // LobsterAI sends goal-mode submissions to OpenClaw as local /goal commands.
  // The command is transport/control syntax, not user-facing message text.
  result = stripGoalCommandPrefixForDisplay(result);

  const imagePaths: string[] = [];
  const imagePathKeys = new Set<string>();
  const addImagePath = (filePath: string, allowUnknownExtension = false) => {
    const p = filePath.trim();
    if (!p || (!allowUnknownExtension && !IMAGE_EXTENSIONS.test(p))) return;
    const key = normalizeImagePathKey(p);
    if (imagePathKeys.has(key)) return;
    imagePathKeys.add(key);
    imagePaths.push(p);
  };

  for (const attachment of options.localMediaAttachments ?? []) {
    const mimeType = attachment.mimeType?.trim().toLowerCase() ?? '';
    if (mimeType && !mimeType.startsWith('image/') && mimeType !== 'image/*') {
      continue;
    }
    addImagePath(attachment.localPath, mimeType.startsWith('image/') || mimeType === 'image/*');
  }

  // --- Pattern A: NIM/DingTalk ---

  if (result.includes('[图片]') || result.includes('[语音消息]') || result.includes('[视频]')
    || result.includes('[文件]') || result.includes('[多媒体消息]') || result.includes('[附件信息]')) {

    // Strip [图片] etc. but preserve the URL as plain text
    result = result.replace(NIM_PLACEHOLDER_RE, (_match, _type, url) => url || '');
    result = result.replace(ATTACHMENT_INFO_BLOCK_RE, '');
  }

  // --- Pattern B: OpenClaw gateway (微信/飞书/企微) ---

  if (result.includes('[media attached:')) {
    // Extract image paths
    let om: RegExpExecArray | null;
    const openclawRe = new RegExp(OPENCLAW_MEDIA_RE.source, OPENCLAW_MEDIA_RE.flags);
    while ((om = openclawRe.exec(result)) !== null) {
      const firstPath = om[1].trim();
      const mime = om[2].trim();
      const secondPath = om[3]?.trim();
      const filePath = secondPath || firstPath;
      if ((mime.startsWith('image/') || mime === 'image/*') && filePath) {
        addImagePath(filePath);
      }
    }

    // Strip markers
    result = result.replace(new RegExp(OPENCLAW_MEDIA_RE.source, OPENCLAW_MEDIA_RE.flags), '');
    result = result.replace(OPENCLAW_INSTRUCTION_RE, '');
    result = result.replace(MEDIA_TAG_RE, '');
  }

  // --- Always: strip System: [timestamp] metadata lines ---
  // These are injected by openclaw plugins (feishu, nim, popo, etc.)
  // and are never user-typed content. The timestamp format is specific enough
  // to avoid false positives.
  result = result.replace(SYSTEM_TIMESTAMP_LINE_RE, '');

  // --- Always: detect bare inbound image paths ---
  // After server-side stripping (e.g. stripFeishuSystemHeader), the message may
  // be reduced to just a bare path like "C:\...\openclaw\state\media\inbound\xxx.jpg".
  // Only match paths in the openclaw inbound directory to avoid false positives.
  result = result.replace(OPENCLAW_INBOUND_IMAGE_RE, (_match, path) => {
    const p = path.trim();
    if (IMAGE_EXTENSIONS.test(p)) {
      addImagePath(p);
    }
    return '';
  });

  // Collapse excessive blank lines and trim
  result = result.replace(/\n{3,}/g, '\n\n').trim();

  // Append extracted images as markdown
  if (imagePaths.length > 0) {
    const imageMarkdown = imagePaths.map(encodeFilePathAsMarkdownImage).join('\n');
    result = result ? `${result}\n\n${imageMarkdown}` : imageMarkdown;
  }

  return result;
}
