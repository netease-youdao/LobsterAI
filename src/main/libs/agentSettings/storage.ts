import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { AgentSettingsError, type AgentSettingsPersistence, AgentSettingsReason } from './types';

const fail = (): never => { throw new AgentSettingsError(AgentSettingsReason.LocalAction); };
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

/** Refuse links in every existing path component, including the supplied root. */
export function assertSettingsDirectory(directory: string, create = false): boolean {
  const resolved = path.resolve(directory);
  const root = path.parse(resolved).root;
  let current = root;
  for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (!missing(error)) return fail();
      if (!create) return false;
      try { fs.mkdirSync(current, { mode: 0o700 }); stat = fs.lstatSync(current); } catch { return fail(); }
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return fail();
  }
  return true;
}

export interface AgentSettingsDocument { text: string; state: 'missing' | 'empty' | 'present'; modifiedAt: string | null }
export function readSettingsDocument(file: string, maxBytes: number): AgentSettingsDocument {
  if (!assertSettingsDirectory(path.dirname(file))) return { text: '', state: 'missing', modifiedAt: null };
  let descriptor: number | undefined;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink()) return fail();
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) return fail();
    if (stat.size > maxBytes) throw new AgentSettingsError(AgentSettingsReason.TooLarge);
    // Bounded allocation/read even when another process grows the file after stat.
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(descriptor, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length > maxBytes) throw new AgentSettingsError(AgentSettingsReason.TooLarge);
    const after = fs.fstatSync(descriptor);
    const current = fs.lstatSync(file);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino) throw new AgentSettingsError(AgentSettingsReason.Conflict);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || length !== stat.size) throw new AgentSettingsError(AgentSettingsReason.Conflict);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    return { text, state: text ? 'present' : 'empty', modifiedAt: stat.mtime.toISOString() };
  } catch (error) {
    if (error instanceof AgentSettingsError) throw error;
    if (missing(error)) return { text: '', state: 'missing', modifiedAt: null };
    return fail();
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

/** Caller holds its writer lease and rechecks content immediately before this synchronous write. */
export function writeSettingsFile(file: string, data: string | Buffer): void {
  assertSettingsDirectory(path.dirname(file), true);
  try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink()) return fail(); }
  catch (error) { if (!missing(error)) throw error; }
  const temporary = path.join(path.dirname(file), `.agent-settings-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(descriptor, data);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    assertSettingsDirectory(path.dirname(file));
    fs.renameSync(temporary, file);
    // Directory fsync is supported on Unix, but not on all Windows filesystems.
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } catch (error) {
    if (error instanceof AgentSettingsError) throw error;
    return fail();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (!missing(error)) fail(); }
  }
}

/** Linux's basic-text fallback is not OS-protected encryption. */
export function isSettingsEncryptionAvailable(protection: { isEncryptionAvailable(): boolean; getSelectedStorageBackend?(): string }, platform = process.platform): boolean {
  try {
    if (!protection.isEncryptionAvailable()) return false;
    return platform !== 'linux' || ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(protection.getSelectedStorageBackend?.() ?? 'unknown');
  } catch { return false; }
}

/** Supply Electron safeStorage (only when encryption is available); no plaintext fallback. */
export class AgentSettingsFileStore implements AgentSettingsPersistence {
  constructor(private readonly directory: string, private readonly protection: {
    encryptString(plaintext: string): Buffer; decryptString(ciphertext: Buffer): string;
  }) { assertSettingsDirectory(directory, true); }
  private filename(key: string): string { return path.join(this.directory, `${createHash('sha256').update(key).digest('hex')}.sealed`); }
  get<T>(key: string): T | null {
    const file = this.filename(key);
    assertSettingsDirectory(this.directory);
    let descriptor: number | undefined;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) return fail();
      descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const opened = fs.fstatSync(descriptor);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino) return fail();
      return JSON.parse(this.protection.decryptString(fs.readFileSync(descriptor))) as T;
    } catch (error) { if (missing(error)) return null; return fail(); }
    finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  }
  set(key: string, value: unknown): void {
    try { writeSettingsFile(this.filename(key), this.protection.encryptString(JSON.stringify(value))); }
    catch { throw new AgentSettingsError(AgentSettingsReason.Unavailable); }
  }
}
