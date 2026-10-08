import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  MarkdownFileError,
  type MarkdownFileResult,
  type MarkdownFileSnapshot,
  MAX_EDITABLE_MARKDOWN_BYTES,
  type SaveMarkdownFileRequest,
} from '../../shared/artifactPreview/markdownEditing';

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const saveQueues = new Map<string, Promise<MarkdownFileResult>>();

class MarkdownReadError extends Error {
  constructor(readonly code: MarkdownFileError, message: string) {
    super(message);
  }
}

const failure = (error: unknown): MarkdownFileResult => ({
  success: false,
  code: error instanceof MarkdownReadError ? error.code : MarkdownFileError.Io,
  error: error instanceof Error ? error.message : 'Could not access Markdown file',
});

async function resolveMarkdownPath(filePath: string): Promise<string> {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)
    || !MARKDOWN_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    throw new MarkdownReadError(MarkdownFileError.InvalidFile, 'Expected an absolute Markdown file path');
  }
  const resolved = await fs.realpath(filePath);
  if (!MARKDOWN_EXTENSIONS.has(path.extname(resolved).toLowerCase())) {
    throw new MarkdownReadError(MarkdownFileError.InvalidFile, 'Target is not a Markdown file');
  }
  return resolved;
}

async function readSnapshot(filePath: string): Promise<MarkdownFileSnapshot> {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new MarkdownReadError(MarkdownFileError.InvalidFile, 'Target is not a regular file');
    }
    if (stat.size > MAX_EDITABLE_MARKDOWN_BYTES) {
      throw new MarkdownReadError(MarkdownFileError.TooLarge, 'Markdown file exceeds the editing limit');
    }
    // Read one extra byte to detect growth instead of ever editing a truncated file.
    const buffer = Buffer.alloc(MAX_EDITABLE_MARKDOWN_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_EDITABLE_MARKDOWN_BYTES) {
      throw new MarkdownReadError(MarkdownFileError.TooLarge, 'Markdown file exceeds the editing limit');
    }
    const bytes = buffer.subarray(0, length);
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw new MarkdownReadError(MarkdownFileError.InvalidEncoding, 'Only UTF-8 Markdown files can be edited');
    }
    if (content.includes('\0')) {
      throw new MarkdownReadError(MarkdownFileError.InvalidEncoding, 'Binary files cannot be edited as Markdown');
    }
    return { filePath, content, version: createHash('sha256').update(bytes).digest('hex') };
  } finally {
    await handle.close();
  }
}

export async function readMarkdownFile(filePath: string): Promise<MarkdownFileResult> {
  try {
    return { success: true, file: await readSnapshot(await resolveMarkdownPath(filePath)) };
  } catch (error) {
    return failure(error);
  }
}

async function saveSnapshot(request: SaveMarkdownFileRequest, filePath: string): Promise<MarkdownFileResult> {
  let temporaryPath: string | undefined;
  try {
    const current = await readSnapshot(filePath);
    // A retry after a lost IPC reply must also be safe.
    if (current.content === request.content) return { success: true, file: current };
    if (current.version !== request.expectedVersion) {
      throw new MarkdownReadError(MarkdownFileError.Conflict, 'Markdown file changed on disk');
    }
    const stat = await fs.stat(filePath);
    await fs.access(filePath, fsConstants.W_OK);
    temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
    const handle = await fs.open(temporaryPath, 'wx', stat.mode & 0o777);
    try {
      await handle.chmod(stat.mode & 0o777);
      await handle.writeFile(request.content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Check again after writing the temporary file; never knowingly replace an external edit.
    if (await resolveMarkdownPath(request.filePath) !== filePath
      || (await readSnapshot(filePath)).version !== request.expectedVersion) {
      throw new MarkdownReadError(MarkdownFileError.Conflict, 'Markdown file changed while saving');
    }
    await fs.rename(temporaryPath, filePath);
    temporaryPath = undefined;
    return {
      success: true,
      file: {
        filePath,
        content: request.content,
        version: createHash('sha256').update(request.content, 'utf8').digest('hex'),
      },
    };
  } catch (error) {
    return failure(error);
  } finally {
    if (temporaryPath) await fs.unlink(temporaryPath).catch((): void => undefined);
  }
}

export async function saveMarkdownFile(request: SaveMarkdownFileRequest): Promise<MarkdownFileResult> {
  try {
    if (!request || typeof request.content !== 'string' || typeof request.expectedVersion !== 'string'
      || !/^[a-f0-9]{64}$/.test(request.expectedVersion) || request.content.includes('\0')) {
      throw new MarkdownReadError(MarkdownFileError.InvalidFile, 'Invalid Markdown save request');
    }
    if (Buffer.byteLength(request.content, 'utf8') > MAX_EDITABLE_MARKDOWN_BYTES) {
      throw new MarkdownReadError(MarkdownFileError.TooLarge, 'Markdown content exceeds the editing limit');
    }
    const filePath = await resolveMarkdownPath(request.filePath);
    const previous = saveQueues.get(filePath);
    const save = (previous ?? Promise.resolve()).then(() => saveSnapshot(request, filePath));
    saveQueues.set(filePath, save);
    try {
      return await save;
    } finally {
      if (saveQueues.get(filePath) === save) saveQueues.delete(filePath);
    }
  } catch (error) {
    return failure(error);
  }
}
