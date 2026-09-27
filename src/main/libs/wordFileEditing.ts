import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  WORD_MAX_FILE_BYTES, type WordCheckpoint, WordFileError,
  type WordFileSnapshot, type WordOpenResult, type WordResult, type WordWriteRequest,
} from '../../shared/artifactPreview/wordEditing';
import { inspectWordPackage, WordFileException } from './wordPackage';

const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const isVersion = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const MAX_DRAFT_HEADER_BYTES = 16384;
const DRAFT_FORMAT_VERSION = 1;

interface FileSession {
  owner: number;
  requestedPath: string;
  filePath: string;
  latestRevision: number;
  /** Review, protected or embedded content opens read only and is never written back. */
  editable: boolean;
  originalCopyPath?: string;
}

interface DraftHeader {
  formatVersion: number;
  filePath: string;
  baseVersion: string;
  revision: number;
  digest: string;
}

async function resultOf<T>(operation: () => Promise<T>): Promise<WordResult<T>> {
  try {
    return { success: true, value: await operation() };
  } catch (error) {
    const code = error instanceof WordFileException ? error.code : WordFileError.Io;
    if (code === WordFileError.Io) console.error('[WordFiles] File operation failed:', error);
    return { success: false, code };
  }
}

async function resolveWordPath(filePath: string): Promise<string> {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== '.docx') {
    throw new WordFileException(WordFileError.InvalidFile, 'Expected an absolute DOCX path');
  }
  const resolved = await fs.realpath(filePath);
  if (path.extname(resolved).toLowerCase() !== '.docx') {
    throw new WordFileException(WordFileError.InvalidFile, 'Target is not a DOCX file');
  }
  return resolved;
}

async function readBounded(filePath: string, maximum: number): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new WordFileException(WordFileError.InvalidFile, 'Not a regular file');
    if (stat.size > maximum) throw new WordFileException(WordFileError.TooLarge, 'File exceeds editing limit');
    const bytes = Buffer.alloc(Math.min(maximum + 1, stat.size + 1));
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    // Treat growth as a conflict rather than returning a truncated package.
    if (length > stat.size) throw new WordFileException(WordFileError.Conflict, 'File changed while reading');
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

async function readSnapshot(filePath: string): Promise<WordFileSnapshot> {
  const bytes = await readBounded(filePath, WORD_MAX_FILE_BYTES);
  return { filePath, bytes, version: hash(bytes), ...inspectWordPackage(bytes) };
}

/** Sync a complete temporary file, then replace it on the same filesystem. */
async function replaceFile(filePath: string, bytes: Uint8Array, mode: number, beforeReplace?: () => Promise<void>): Promise<void> {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, 'wx', mode);
    try {
      await handle.chmod(mode);
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await beforeReplace?.();
    await fs.rename(temporary, filePath);
  } finally {
    await fs.unlink(temporary).catch((): void => undefined);
  }
}

/** Owns handles and serializes all writers, including recovery, by canonical path. */
export class WordFileStore {
  private sessions = new Map<string, FileSession>();
  private queues = new Map<string, Promise<unknown>>();

  constructor(private readonly draftDirectory: string) {}

  private session(owner: number, sessionId: string): FileSession {
    const session = this.sessions.get(sessionId);
    if (!session || session.owner !== owner) throw new WordFileException(WordFileError.Forbidden, 'Unknown document handle');
    return session;
  }

  private async serial<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(filePath) ?? Promise.resolve();
    const current = previous.catch((): void => undefined).then(operation);
    this.queues.set(filePath, current);
    try {
      return await current;
    } finally {
      if (this.queues.get(filePath) === current) this.queues.delete(filePath);
    }
  }

  private draftPath(filePath: string): string {
    return path.join(this.draftDirectory, `${hash(filePath)}.draft`);
  }

  private async readDraft(filePath: string): Promise<WordCheckpoint | undefined> {
    let data: Buffer;
    try {
      data = await readBounded(this.draftPath(filePath), WORD_MAX_FILE_BYTES + MAX_DRAFT_HEADER_BYTES + 4);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (data.length < 4) throw new WordFileException(WordFileError.InvalidFile, 'Invalid recovery header');
    const size = data.readUInt32LE(0);
    if (size > MAX_DRAFT_HEADER_BYTES || size + 4 > data.length) {
      throw new WordFileException(WordFileError.InvalidFile, 'Invalid recovery bounds');
    }
    const header = JSON.parse(data.subarray(4, 4 + size).toString('utf8')) as DraftHeader;
    const bytes = data.subarray(4 + size);
    if (header.formatVersion !== DRAFT_FORMAT_VERSION || header.filePath !== filePath
      || !isVersion(header.baseVersion) || !Number.isSafeInteger(header.revision) || header.revision < 1
      || header.digest !== hash(bytes)) throw new WordFileException(WordFileError.InvalidFile, 'Invalid recovery contents');
    inspectWordPackage(bytes);
    return { bytes, baseVersion: header.baseVersion, revision: header.revision };
  }

  private async writeDraft(session: FileSession, checkpoint: WordCheckpoint): Promise<void> {
    await fs.mkdir(this.draftDirectory, { recursive: true, mode: 0o700 });
    const header = Buffer.from(JSON.stringify({
      formatVersion: DRAFT_FORMAT_VERSION, filePath: session.filePath, baseVersion: checkpoint.baseVersion,
      revision: checkpoint.revision, digest: hash(checkpoint.bytes),
    } satisfies DraftHeader), 'utf8');
    if (header.length > MAX_DRAFT_HEADER_BYTES) throw new WordFileException(WordFileError.InvalidFile, 'Recovery path too long');
    const length = Buffer.alloc(4);
    length.writeUInt32LE(header.length);
    await replaceFile(this.draftPath(session.filePath), Buffer.concat([length, header, checkpoint.bytes]), 0o600);
    session.latestRevision = checkpoint.revision;
  }

  open(owner: number, requestedPath: string): Promise<WordResult<WordOpenResult>> {
    return resultOf(async (): Promise<WordOpenResult> => {
      const filePath = await resolveWordPath(requestedPath);
      return this.serial(filePath, async () => {
        const file = await readSnapshot(filePath);
        const recovery = await this.readDraft(filePath);
        const existing = [...this.sessions].find(([, session]) => session.owner === owner && session.filePath === filePath);
        const sessionId = existing?.[0] ?? randomUUID();
        if (!existing) {
          this.sessions.set(sessionId, {
            owner, requestedPath, filePath, latestRevision: recovery?.revision ?? 0, editable: file.readOnly.length === 0,
          });
        }
        // A crash after replacement but before draft cleanup must not restore already-saved edits.
        if (recovery && hash(recovery.bytes) === file.version) {
          await fs.unlink(this.draftPath(filePath));
          return { ...file, sessionId };
        }
        return { ...file, sessionId, recovery };
      });
    });
  }

  read(owner: number, sessionId: string): Promise<WordResult<WordFileSnapshot>> {
    return resultOf(() => {
      const session = this.session(owner, sessionId);
      return this.serial(session.filePath, async () => {
        if (await resolveWordPath(session.requestedPath) !== session.filePath) {
          throw new WordFileException(WordFileError.Conflict, 'File link target changed');
        }
        const snapshot = await readSnapshot(session.filePath);
        // The renderer shows exactly these bytes next, so writes follow their admission.
        session.editable = snapshot.readOnly.length === 0;
        return snapshot;
      });
    });
  }

  private checkWrite(owner: number, request: WordWriteRequest): FileSession {
    if (!request || !(request.bytes instanceof Uint8Array) || !isVersion(request.baseVersion)
      || !Number.isSafeInteger(request.revision) || request.revision < 1) {
      throw new WordFileException(WordFileError.InvalidFile, 'Invalid snapshot');
    }
    const session = this.session(owner, request.sessionId);
    if (!session.editable) throw new WordFileException(WordFileError.Forbidden, 'Document opened read only');
    if (request.revision < session.latestRevision) throw new WordFileException(WordFileError.Conflict, 'Stale revision');
    inspectWordPackage(request.bytes);
    return session;
  }

  checkpoint(owner: number, request: WordWriteRequest): Promise<WordResult<null>> {
    return resultOf(async () => {
      const session = this.session(owner, request?.sessionId);
      return this.serial(session.filePath, async (): Promise<null> => {
        this.checkWrite(owner, request);
        await this.writeDraft(session, request);
        return null;
      });
    });
  }

  save(owner: number, request: WordWriteRequest): Promise<WordResult<{ version: string; originalCopyPath?: string }>> {
    return resultOf(async () => {
      const session = this.session(owner, request?.sessionId);
      return this.serial(session.filePath, async () => {
        this.checkWrite(owner, request);
        // Durably retain the frozen revision even if a conflict or I/O error follows.
        await this.writeDraft(session, request);
        const version = hash(request.bytes);
        const current = await readSnapshot(session.filePath);
        if (await resolveWordPath(session.requestedPath) !== session.filePath) {
          throw new WordFileException(WordFileError.Conflict, 'File link target changed');
        }
        if (current.version !== version) {
          if (current.version !== request.baseVersion) throw new WordFileException(WordFileError.Conflict, 'DOCX changed on disk');
          if (!session.originalCopyPath) {
            const originalDirectory = path.join(this.draftDirectory, 'originals');
            await fs.mkdir(originalDirectory, { recursive: true, mode: 0o700 });
            const originalCopyPath = path.join(originalDirectory, `${hash(session.filePath)}.docx`);
            await replaceFile(originalCopyPath, current.bytes, 0o600);
            session.originalCopyPath = originalCopyPath;
          }
          const stat = await fs.stat(session.filePath);
          await fs.access(session.filePath, fsConstants.W_OK);
          await replaceFile(session.filePath, request.bytes, stat.mode & 0o777, async () => {
            if (await resolveWordPath(session.requestedPath) !== session.filePath
              || hash(await readBounded(session.filePath, WORD_MAX_FILE_BYTES)) !== request.baseVersion) {
              throw new WordFileException(WordFileError.Conflict, 'DOCX changed while saving');
            }
          });
        }
        // This operation still owns the path queue; a later checkpoint cannot be deleted here.
        await fs.unlink(this.draftPath(session.filePath)).catch(error => {
          console.warn('[WordFiles] Saved file but could not remove recovery checkpoint:', error);
        });
        return { version, originalCopyPath: session.originalCopyPath };
      });
    });
  }

  discardDraft(owner: number, sessionId: string): Promise<WordResult<null>> {
    return resultOf(async () => {
      const session = this.session(owner, sessionId);
      return this.serial(session.filePath, async (): Promise<null> => {
        await fs.unlink(this.draftPath(session.filePath)).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
        return null;
      });
    });
  }

  release(owner: number, sessionId: string): void {
    if (this.sessions.get(sessionId)?.owner === owner) this.sessions.delete(sessionId);
  }

  releaseOwner(owner: number): void {
    for (const [id, session] of this.sessions) if (session.owner === owner) this.sessions.delete(id);
  }
}
