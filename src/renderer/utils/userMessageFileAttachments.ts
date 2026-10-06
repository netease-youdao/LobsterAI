/**
 * Display-side extraction of file/folder attachment lines from user messages.
 *
 * When a prompt is submitted with non-image attachments, prepareCoworkPromptPayload
 * appends machine-generated lines like "输入文件: /abs/path" to the prompt text.
 * This module parses those lines back out at render time so the UI can show
 * clickable attachment cards instead of raw path text.
 * DISPLAY ONLY — does not affect what was sent to the AI model.
 */

// Labels ever produced by the payload builder (i18n `inputFileLabel` /
// `inputFolderLabel`, plus the pre-i18n hardcoded value). Longest-first so
// "输入文件夹" wins over its prefix "输入文件".
const FOLDER_LABELS = ['输入文件夹', 'Input Folder'] as const;
const FILE_LABELS = ['输入文件', 'Input Files'] as const;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const LABEL_ALTERNATION = [...FOLDER_LABELS, ...FILE_LABELS].map(escapeRegExp).join('|');

// Absolute paths only: POSIX (/...), Windows drive (C:\... or C:/...), UNC (\\...).
// Paths may contain spaces, so the path part runs to end of line.
const ATTACHMENT_LINE_RE = new RegExp(
  `^[ \\t]*(${LABEL_ALTERNATION}): ((?:\\/|[A-Za-z]:[\\\\/]|\\\\\\\\)[^\\n]*?)[ \\t]*$`,
);

export interface UserMessageFileAttachment {
  path: string;
  name: string;
  isDirectory: boolean;
}

export interface ExtractedUserMessageFileAttachments {
  text: string;
  attachments: UserMessageFileAttachment[];
}

function deriveAttachmentName(rawPath: string): string {
  const trimmed = rawPath.replace(/[\\/]+$/, '');
  const lastSeparator = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const name = lastSeparator >= 0 ? trimmed.slice(lastSeparator + 1) : trimmed;
  return name || rawPath;
}

function normalizePathKey(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^(?:[A-Za-z]:\/|\/\/)/.test(normalized)
    ? normalized.toLowerCase()
    : normalized;
}

/**
 * Splits the machine-generated trailing attachment block out of a user
 * message. Attachment-looking text in the body is intentionally preserved.
 */
export function extractUserMessageFileAttachments(
  content: string,
): ExtractedUserMessageFileAttachments {
  if (!content) {
    return { text: content, attachments: [] };
  }

  const parsedLines: Array<{ label: string; path: string }> = [];
  const lines = content.split('\n');
  let attachmentStart = lines.length;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = ATTACHMENT_LINE_RE.exec(lines[index]);
    if (!match) break;
    parsedLines.push({ label: match[1], path: match[2].trim() });
    attachmentStart = index;
  }
  if (parsedLines.length === 0) {
    return { text: content, attachments: [] };
  }

  const attachments: UserMessageFileAttachment[] = [];
  const seenPathKeys = new Set<string>();
  for (const { label, path } of parsedLines.reverse()) {
    if (!path) continue;
    const key = normalizePathKey(path);
    if (seenPathKeys.has(key)) continue;
    seenPathKeys.add(key);
    attachments.push({
      path,
      name: deriveAttachmentName(path),
      isDirectory: (FOLDER_LABELS as readonly string[]).includes(label),
    });
  }

  return {
    text: lines.slice(0, attachmentStart).join('\n').trim(),
    attachments,
  };
}
