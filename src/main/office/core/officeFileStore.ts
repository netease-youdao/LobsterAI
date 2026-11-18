import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  type OfficeCheckpoint, OfficeFileError, type OfficeFileSnapshot, type OfficeOpenResult, type OfficePackageInfo,
  type OfficeResult, type OfficeSaveReceipt, type OfficeWriteRequest,
} from '../../../shared/office/core/officeFile';
import { OfficePackageException } from './officeZip';

/**
 * Same file protocol as the Word editor's WordFileStore, for any Office format: opaque handles
 * per owner, one serialized writer per canonical path, durable recovery drafts, a copy of the
 * file before a session first overwrites it, and version-checked atomic replacement.
 */

const hash = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const isVersion = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const MAX_DRAFT_HEADER_BYTES = 16384;
const DRAFT_FORMAT_VERSION = 1;
/** Pauses before retrying a replacement Windows refused; scanners and indexers let go within moments. */
const REPLACE_RETRY_DELAYS_MS = [100, 200, 400, 800];

/**
 * Windows refuses to open, write or replace a file another program holds open without sharing it:
 * Excel, Word, PowerPoint and WPS do so with every document they show, scanners and indexers for a
 * moment.
 */
function isHeldByAnotherProgram(error: unknown): boolean {
  if (process.platform !== 'win32' || !(error instanceof Error)) return false;
  const { code, syscall } = error as NodeJS.ErrnoException;
  return code === 'EBUSY' || (syscall === 'rename' && (code === 'EPERM' || code === 'EACCES'));
}

export interface OfficeFormat<TInfo extends OfficePackageInfo> {
  /** Lower-case extension including the dot, e.g. `.xlsx`. */
  extension: string;
  maxFileBytes: number;
  /** Validate a package and classify it; throws OfficePackageException. */
  inspect: (bytes: Uint8Array) => TInfo;
  /** Log tag such as `[SheetFiles]`. */
  logTag: string;
}

interface FileSession {
  owner: number;
  requestedPath: string;
  filePath: string;
  latestRevision: number;
  /** Read-only content is shown but never written back. */
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

export class OfficeFileStore<TInfo extends OfficePackageInfo> {
  private sessions = new Map<string, FileSession>();
  private queues = new Map<string, Promise<unknown>>();

  constructor(private readonly format: OfficeFormat<TInfo>, private readonly draftDirectory: string) {}

  private async result<T>(operation: () => Promise<T>): Promise<OfficeResult<T>> {
    try {
      return { success: true, value: await operation() };
    } catch (error) {
      if (error instanceof OfficePackageException) return { success: false, code: error.code };
      if (isHeldByAnotherProgram(error)) {
        console.warn(`${this.format.logTag} File is held open by another program:`, error);
        return { success: false, code: OfficeFileError.InUse };
      }
      console.error(`${this.format.logTag} File operation failed:`, error);
      return { success: false, code: OfficeFileError.Io };
    }
  }

  private async resolvePath(filePath: string): Promise<string> {
    const { extension } = this.format;
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.extname(filePath).toLowerCase() !== extension) {
      throw new OfficePackageException(OfficeFileError.InvalidFile, `Expected an absolute ${extension} path`);
    }
    const resolved = await fs.realpath(filePath);
    if (path.extname(resolved).toLowerCase() !== extension) {
      throw new OfficePackageException(OfficeFileError.InvalidFile, `Target is not a ${extension} file`);
    }
    return resolved;
  }

  private async readBounded(filePath: string, maximum: number): Promise<Buffer> {
    const handle = await fs.open(filePath, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new OfficePackageException(OfficeFileError.InvalidFile, 'Not a regular file');
      if (stat.size > maximum) throw new OfficePackageException(OfficeFileError.TooLarge, 'File exceeds editing limit');
      const bytes = Buffer.alloc(Math.min(maximum + 1, stat.size + 1));
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      // Treat growth as a conflict rather than returning a truncated package.
      if (length > stat.size) throw new OfficePackageException(OfficeFileError.Conflict, 'File changed while reading');
      return bytes.subarray(0, length);
    } finally {
      await handle.close();
    }
  }

  private async readSnapshot(filePath: string): Promise<OfficeFileSnapshot<TInfo>> {
    const bytes = await this.readBounded(filePath, this.format.maxFileBytes);
    return { ...this.format.inspect(bytes), filePath, bytes, version: hash(bytes) };
  }

  /** What the editor shows, and whether a save would wait for another program to close the file. */
  private async readForEditor(filePath: string): Promise<OfficeFileSnapshot<TInfo>> {
    const snapshot = await this.readSnapshot(filePath);
    return { ...snapshot, inUse: await isHeldOpen(filePath) };
  }

  private session(owner: number, sessionId: string): FileSession {
    const session = this.sessions.get(sessionId);
    if (!session || session.owner !== owner) throw new OfficePackageException(OfficeFileError.Forbidden, 'Unknown document handle');
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

  private async readDraft(filePath: string): Promise<OfficeCheckpoint | undefined> {
    let data: Buffer;
    try {
      data = await this.readBounded(this.draftPath(filePath), this.format.maxFileBytes + MAX_DRAFT_HEADER_BYTES + 4);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (data.length < 4) throw new OfficePackageException(OfficeFileError.InvalidFile, 'Invalid recovery header');
    const size = data.readUInt32LE(0);
    if (size > MAX_DRAFT_HEADER_BYTES || size + 4 > data.length) {
      throw new OfficePackageException(OfficeFileError.InvalidFile, 'Invalid recovery bounds');
    }
    const header = JSON.parse(data.subarray(4, 4 + size).toString('utf8')) as DraftHeader;
    const bytes = data.subarray(4 + size);
    if (header.formatVersion !== DRAFT_FORMAT_VERSION || header.filePath !== filePath
      || !isVersion(header.baseVersion) || !Number.isSafeInteger(header.revision) || header.revision < 1
      || header.digest !== hash(bytes)) throw new OfficePackageException(OfficeFileError.InvalidFile, 'Invalid recovery contents');
    this.format.inspect(bytes);
    return { bytes, baseVersion: header.baseVersion, revision: header.revision };
  }

  private async writeDraft(session: FileSession, checkpoint: OfficeCheckpoint): Promise<void> {
    await fs.mkdir(this.draftDirectory, { recursive: true, mode: 0o700 });
    const header = Buffer.from(JSON.stringify({
      formatVersion: DRAFT_FORMAT_VERSION, filePath: session.filePath, baseVersion: checkpoint.baseVersion,
      revision: checkpoint.revision, digest: hash(checkpoint.bytes),
    } satisfies DraftHeader), 'utf8');
    if (header.length > MAX_DRAFT_HEADER_BYTES) throw new OfficePackageException(OfficeFileError.InvalidFile, 'Recovery path too long');
    const length = Buffer.alloc(4);
    length.writeUInt32LE(header.length);
    await replaceFile(this.draftPath(session.filePath), Buffer.concat([length, header, checkpoint.bytes]), 0o600);
    session.latestRevision = checkpoint.revision;
  }

  open(owner: number, requestedPath: string): Promise<OfficeResult<OfficeOpenResult<TInfo>>> {
    return this.result(async (): Promise<OfficeOpenResult<TInfo>> => {
      const filePath = await this.resolvePath(requestedPath);
      return this.serial(filePath, async () => {
        const file = await this.readForEditor(filePath);
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

  read(owner: number, sessionId: string): Promise<OfficeResult<OfficeFileSnapshot<TInfo>>> {
    return this.result(() => {
      const session = this.session(owner, sessionId);
      return this.serial(session.filePath, async () => {
        if (await this.resolvePath(session.requestedPath) !== session.filePath) {
          throw new OfficePackageException(OfficeFileError.Conflict, 'File link target changed');
        }
        const snapshot = await this.readForEditor(session.filePath);
        // The renderer shows exactly these bytes next, so writes follow their admission.
        session.editable = snapshot.readOnly.length === 0;
        return snapshot;
      });
    });
  }

  private checkWrite(owner: number, request: OfficeWriteRequest): FileSession {
    if (!request || !(request.bytes instanceof Uint8Array) || !isVersion(request.baseVersion)
      || !Number.isSafeInteger(request.revision) || request.revision < 1) {
      throw new OfficePackageException(OfficeFileError.InvalidFile, 'Invalid snapshot');
    }
    const session = this.session(owner, request.sessionId);
    if (!session.editable) throw new OfficePackageException(OfficeFileError.Forbidden, 'Document opened read only');
    if (request.revision < session.latestRevision) throw new OfficePackageException(OfficeFileError.Conflict, 'Stale revision');
    const info = this.format.inspect(request.bytes);
    // An editor must never turn a writable file into one it would only open read only.
    if (info.readOnly.length) throw new OfficePackageException(OfficeFileError.Forbidden, 'Snapshot contains read-only content');
    return session;
  }

  checkpoint(owner: number, request: OfficeWriteRequest): Promise<OfficeResult<null>> {
    return this.result(async () => {
      const session = this.session(owner, request?.sessionId);
      return this.serial(session.filePath, async (): Promise<null> => {
        this.checkWrite(owner, request);
        await this.writeDraft(session, request);
        return null;
      });
    });
  }

  save(owner: number, request: OfficeWriteRequest): Promise<OfficeResult<OfficeSaveReceipt>> {
    return this.result(async () => {
      const session = this.session(owner, request?.sessionId);
      return this.serial(session.filePath, async () => {
        this.checkWrite(owner, request);
        // Durably retain the frozen revision even if a conflict or I/O error follows.
        await this.writeDraft(session, request);
        const version = hash(request.bytes);
        const current = await this.readSnapshot(session.filePath);
        if (await this.resolvePath(session.requestedPath) !== session.filePath) {
          throw new OfficePackageException(OfficeFileError.Conflict, 'File link target changed');
        }
        if (current.version !== version) {
          if (current.version !== request.baseVersion) throw new OfficePackageException(OfficeFileError.Conflict, 'File changed on disk');
          if (!session.originalCopyPath) {
            const originalDirectory = path.join(this.draftDirectory, 'originals');
            await fs.mkdir(originalDirectory, { recursive: true, mode: 0o700 });
            const originalCopyPath = path.join(originalDirectory, `${hash(session.filePath)}${this.format.extension}`);
            await replaceFile(originalCopyPath, current.bytes, 0o600);
            session.originalCopyPath = originalCopyPath;
          }
          const stat = await fs.stat(session.filePath);
          await fs.access(session.filePath, fsConstants.W_OK);
          if (await isHeldOpen(session.filePath)) {
            // Expected while Excel or WPS shows the file, and repeated with each edit until it closes it.
            console.debug(`${this.format.logTag} Save waits for another program to close the file`);
            throw new OfficePackageException(OfficeFileError.InUse, 'File is held open by another program');
          }
          await replaceFile(session.filePath, request.bytes, stat.mode & 0o777, async () => {
            if (await this.resolvePath(session.requestedPath) !== session.filePath
              || hash(await this.readBounded(session.filePath, this.format.maxFileBytes)) !== request.baseVersion) {
              throw new OfficePackageException(OfficeFileError.Conflict, 'File changed while saving');
            }
          });
        }
        // This operation still owns the path queue; a later checkpoint cannot be deleted here.
        await fs.unlink(this.draftPath(session.filePath)).catch(error => {
          console.warn(`${this.format.logTag} Saved file but could not remove recovery checkpoint:`, error);
        });
        return { version, originalCopyPath: session.originalCopyPath };
      });
    });
  }

  discardDraft(owner: number, sessionId: string): Promise<OfficeResult<null>> {
    return this.result(async () => {
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

/**
 * On Windows, whether a program such as Excel or WPS holds the file open so that writing it is
 * refused; access() checks only the read-only attribute there. Other refusals, such as a missing
 * permission, show when saving.
 */
async function isHeldOpen(filePath: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    await (await fs.open(filePath, 'r+')).close();
    return false;
  } catch (error) {
    return isHeldByAnotherProgram(error);
  }
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
    for (let attempt = 0; ; attempt++) {
      // Checked before every attempt: the file may change while a retry waits.
      await beforeReplace?.();
      try {
        await fs.rename(temporary, filePath);
        return;
      } catch (error) {
        if (attempt >= REPLACE_RETRY_DELAYS_MS.length || !isHeldByAnotherProgram(error)) throw error;
        await new Promise(resolve => setTimeout(resolve, REPLACE_RETRY_DELAYS_MS[attempt]));
      }
    }
  } finally {
    await fs.unlink(temporary).catch((): void => undefined);
  }
}
