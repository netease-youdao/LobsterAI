import fs from 'node:fs/promises';
import path from 'node:path';

import type { RenameArtifactFileResponse } from '../../../shared/artifactPreview/blankDocument';

const ILLEGAL_FILENAME_CHARS_RE = /[\\/:*?"<>|\u0000-\u001f]/g;

export function sanitizeRenamedBaseName(rawBaseName: string, originalExtension: string): string {
  let cleaned = rawBaseName
    .replace(ILLEGAL_FILENAME_CHARS_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (
    originalExtension
    && cleaned.toLowerCase().endsWith(originalExtension.toLowerCase())
    && cleaned.length > originalExtension.length
  ) {
    cleaned = cleaned.slice(0, -originalExtension.length).trim();
  }

  return cleaned.replace(/\.+$/, '').trim();
}

export async function renameLocalFileInPlace(
  filePath: string,
  newBaseName: string,
): Promise<RenameArtifactFileResponse> {
  const sourcePath = filePath.trim();
  if (!sourcePath || !path.isAbsolute(sourcePath)) {
    return { success: false, error: 'File path must be an absolute path' };
  }

  let sourceStat;
  try {
    sourceStat = await fs.lstat(sourcePath);
  } catch {
    return { success: false, error: 'Source file does not exist' };
  }
  if (!sourceStat.isFile()) {
    return { success: false, error: 'Only regular files can be renamed' };
  }

  const directory = path.dirname(sourcePath);
  const extension = path.extname(sourcePath);
  const stem = sanitizeRenamedBaseName(newBaseName, extension);
  if (!stem) {
    return { success: false, error: 'File name cannot be empty' };
  }

  const nextFileName = `${stem}${extension}`;
  const nextFilePath = path.join(directory, nextFileName);

  if (nextFilePath === sourcePath) {
    return { success: true, filePath: sourcePath, fileName: nextFileName };
  }

  const isCaseOnlyRename = nextFilePath.toLowerCase() === sourcePath.toLowerCase();
  if (!isCaseOnlyRename) {
    try {
      await fs.lstat(nextFilePath);
      return { success: false, error: 'A file with this name already exists' };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT') {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unable to check target file path',
        };
      }
    }
  }

  try {
    await fs.rename(sourcePath, nextFilePath);
    return { success: true, filePath: nextFilePath, fileName: nextFileName };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to rename file',
    };
  }
}
