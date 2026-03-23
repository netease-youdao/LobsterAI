/**
 * File Utility Functions
 * 
 * Common file and path manipulation utilities used across the main process.
 */

import path from 'path';
import fs from 'fs';
import { app } from 'electron';

// Invalid characters for file names on Windows
const INVALID_FILE_NAME_PATTERN = /[<>:"/\\|?*\u0000-\u001F]/g;

// MIME type to file extension mapping
export const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/json': '.json',
  'text/csv': '.csv',
};

/**
 * Sanitize a file name for export operations.
 * Removes invalid characters and normalizes whitespace.
 */
export const sanitizeExportFileName = (value: string): string => {
  const sanitized = value
    .replace(INVALID_FILE_NAME_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized || 'cowork-session';
};

/**
 * Sanitize an attachment file name.
 * Handles empty values and removes invalid characters.
 */
export const sanitizeAttachmentFileName = (value?: string): string => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return 'attachment';
  const fileName = path.basename(raw);
  const sanitized = fileName
    .replace(INVALID_FILE_NAME_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return sanitized || 'attachment';
};

/**
 * Infer file extension from file name or MIME type.
 */
export const inferAttachmentExtension = (
  fileName: string,
  mimeType?: string
): string => {
  const fromName = path.extname(fileName).toLowerCase();
  if (fromName) {
    return fromName;
  }
  if (typeof mimeType === 'string') {
    const normalized = mimeType.toLowerCase().split(';')[0].trim();
    return MIME_EXTENSION_MAP[normalized] ?? '';
  }
  return '';
};

/**
 * Resolve the directory for inline attachments.
 * Uses workspace .cowork-temp if valid, otherwise falls back to system temp.
 */
export const resolveInlineAttachmentDir = (cwd?: string): string => {
  const trimmed = typeof cwd === 'string' ? cwd.trim() : '';
  if (trimmed) {
    const resolved = path.resolve(trimmed);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
      return path.join(resolved, '.cowork-temp', 'attachments', 'manual');
    }
  }
  return path.join(app.getPath('temp'), 'lobsterai', 'attachments');
};

/**
 * Ensure a file name has .png extension.
 */
export const ensurePngFileName = (value: string): string => {
  return value.toLowerCase().endsWith('.png') ? value : `${value}.png`;
};

/**
 * Ensure a file name has .zip extension.
 */
export const ensureZipFileName = (value: string): string => {
  return value.toLowerCase().endsWith('.zip') ? value : `${value}.zip`;
};

/**
 * Pad a number to two digits.
 */
export const padTwoDigits = (value: number): string =>
  value.toString().padStart(2, '0');

/**
 * Build a timestamped log export file name.
 */
export const buildLogExportFileName = (): string => {
  const now = new Date();
  const datePart = `${now.getFullYear()}${padTwoDigits(now.getMonth() + 1)}${padTwoDigits(now.getDate())}`;
  const timePart = `${padTwoDigits(now.getHours())}${padTwoDigits(now.getMinutes())}${padTwoDigits(now.getSeconds())}`;
  return `lobsterai-logs-${datePart}-${timePart}.zip`;
};

/**
 * Get the default export image file name.
 */
export const getDefaultExportImageName = (defaultFileName?: string): string => {
  if (defaultFileName && typeof defaultFileName === 'string') {
    return sanitizeExportFileName(defaultFileName);
  }
  const now = new Date();
  const timestamp = `${now.getFullYear()}${padTwoDigits(now.getMonth() + 1)}${padTwoDigits(now.getDate())}-${padTwoDigits(now.getHours())}${padTwoDigits(now.getMinutes())}${padTwoDigits(now.getSeconds())}`;
  return `cowork-result-${timestamp}`;
};

/**
 * Safely decode a URI component, returning the original value on failure.
 */
export const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * Normalize a Windows shell path.
 * Handles PowerShell and WSL path formats.
 */
export const normalizeWindowsShellPath = (inputPath: string): string => {
  let normalized = inputPath.trim();

  // Handle WSL paths (/mnt/c/...)
  const wslMatch = normalized.match(/^\/mnt\/([a-zA-Z])\/(.*)/);
  if (wslMatch) {
    const [, drive, rest] = wslMatch;
    return `${drive.toUpperCase()}:\\${rest.replace(/\//g, '\\')}`;
  }

  // Handle URI encoded paths
  if (normalized.includes('%')) {
    normalized = safeDecodeURIComponent(normalized);
  }

  // Handle quoted paths
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1);
  }

  // Handle PowerShell literal paths (Microsoft.PowerShell.Core\FileSystem::...)
  const psLiteralMatch = normalized.match(
    /Microsoft\.PowerShell\.Core\\FileSystem::(.+)/i
  );
  if (psLiteralMatch) {
    normalized = psLiteralMatch[1];
  }

  // Normalize slashes
  normalized = normalized.replace(/\//g, '\\');

  // Remove trailing backslash unless it's a root path
  if (normalized.endsWith('\\') && !normalized.match(/^[a-zA-Z]:\\$/)) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
};

/**
 * Resolve the working directory for a scheduled task.
 */
export const resolveTaskWorkingDirectory = (workspaceRoot: string): string => {
  const trimmed =
    typeof workspaceRoot === 'string' ? workspaceRoot.trim() : '';
  if (trimmed && fs.existsSync(trimmed)) {
    return trimmed;
  }
  return path.join(app.getPath('home'), 'lobsterai', 'project');
};
