import { createHash, randomBytes, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import { RemoteInitializationFailure } from '../../shared/remote/constants';

export interface RemoteIdentity {
  installationId: string; deviceKey: string; databaseId: string;
}
export interface IdentityCipher {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
type InitializationFailure = typeof RemoteInitializationFailure[keyof typeof RemoteInitializationFailure];

/** Only a fixed classification may cross the IPC/logging boundary. */
export class RemoteIdentityError extends Error {
  constructor(readonly failure: InitializationFailure) {
    super(`Remote initialization failed: ${failure}`);
    this.name = 'RemoteIdentityError';
  }
}

function assertEncryptionAvailable(cipher: IdentityCipher): void {
  try {
    if (cipher.isEncryptionAvailable()) return;
  } catch { /* The native error can contain local account or credential details. */ }
  throw new RemoteIdentityError(RemoteInitializationFailure.SecureStorageUnavailable);
}

const MAX_IDENTITY_FILE_BYTES = 64 * 1024;

function readFile(filename: string): Buffer | null {
  try {
    const fd = fs.openSync(filename, 'r');
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new RemoteIdentityError(RemoteInitializationFailure.LocalStorageUnavailable);
      if (stat.size > MAX_IDENTITY_FILE_BYTES) throw new RemoteIdentityError(RemoteInitializationFailure.IdentityInvalid);
      // Bound the actual read too: another process may grow the file after fstat.
      const bytes = Buffer.alloc(MAX_IDENTITY_FILE_BYTES + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
        if (!count) break;
        offset += count;
      }
      if (offset > MAX_IDENTITY_FILE_BYTES) throw new RemoteIdentityError(RemoteInitializationFailure.IdentityInvalid);
      return bytes.subarray(0, offset);
    } finally { fs.closeSync(fd); }
  } catch (error) {
    if (error instanceof RemoteIdentityError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try { fs.lstatSync(filename); }
      catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code === 'ENOENT') return null;
      }
    }
    throw new RemoteIdentityError(RemoteInitializationFailure.LocalStorageUnavailable);
  }
}

function decrypt(cipher: IdentityCipher, bytes: Buffer): string {
  try { return cipher.decryptString(bytes); }
  catch { throw new RemoteIdentityError(RemoteInitializationFailure.IdentityUnreadable); }
}

function encrypt(cipher: IdentityCipher, value: string): Buffer {
  try { return cipher.encryptString(value); }
  catch { throw new RemoteIdentityError(RemoteInitializationFailure.SecureStorageUnavailable); }
}

function parseIdentity(value: string): RemoteIdentity {
  try {
    const parsed = JSON.parse(value) as RemoteIdentity;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || typeof parsed.installationId !== 'string' || !uuid.test(parsed.installationId)
      || typeof parsed.databaseId !== 'string' || !uuid.test(parsed.databaseId)
      || typeof parsed.deviceKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(parsed.deviceKey)) {
      throw new Error('Invalid identity');
    }
    return { installationId: parsed.installationId, deviceKey: parsed.deviceKey, databaseId: parsed.databaseId };
  } catch { throw new RemoteIdentityError(RemoteInitializationFailure.IdentityInvalid); }
}

function identityDirectory(appData: string, userData: string): string {
  try {
    const profile = createHash('sha256').update(fs.realpathSync(userData)).digest('hex');
    return path.join(appData, 'LobsterAI-remote-identity', profile);
  } catch { throw new RemoteIdentityError(RemoteInitializationFailure.LocalStorageUnavailable); }
}

function assertFirstUse(directory: string, allowCreate: boolean): void {
  if (!allowCreate) throw new RemoteIdentityError(RemoteInitializationFailure.IdentityUnreadable);
  let entries: string[];
  try { entries = fs.readdirSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new RemoteIdentityError(RemoteInitializationFailure.LocalStorageUnavailable);
  }
  // Even an incomplete prior write is evidence that this may be an existing installation.
  if (entries.length) throw new RemoteIdentityError(RemoteInitializationFailure.IdentityUnreadable);
}

function syncDirectory(directory: string): void {
  // Windows does not support opening directories for fsync.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeFile(filename: string, bytes: Buffer, exclusive: boolean): void {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    // Publishing a newly created identity must never replace one created by another writer.
    if (exclusive) fs.linkSync(temporary, filename); else fs.renameSync(temporary, filename);
    if (exclusive) fs.unlinkSync(temporary);
    syncDirectory(path.dirname(filename));
  } catch { throw new RemoteIdentityError(RemoteInitializationFailure.LocalStorageUnavailable); }
  finally {
    try { fs.unlinkSync(temporary); } catch { /* Only remove this attempt's temporary file. */ }
  }
}

/** Kept outside userData/backups; safeStorage binds the secret to this OS account. */
export function loadRemoteIdentity(appData: string, userData: string, cipher: IdentityCipher, allowCreate = true): RemoteIdentity {
  assertEncryptionAvailable(cipher);
  const directory = identityDirectory(appData, userData);
  const filename = path.join(directory, 'identity.bin');
  const bytes = readFile(filename);
  if (bytes !== null) return parseIdentity(decrypt(cipher, bytes));
  assertFirstUse(directory, allowCreate);
  const value: RemoteIdentity = {
    installationId: randomUUID(), deviceKey: randomBytes(32).toString('base64url'), databaseId: randomUUID(),
  };
  const encrypted = encrypt(cipher, JSON.stringify(value));
  const verified = parseIdentity(decrypt(cipher, encrypted));
  if (verified.installationId !== value.installationId || verified.deviceKey !== value.deviceKey || verified.databaseId !== value.databaseId) {
    throw new RemoteIdentityError(RemoteInitializationFailure.IdentityInvalid);
  }
  try { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  catch { throw new RemoteIdentityError(RemoteInitializationFailure.LocalStorageUnavailable); }
  writeFile(filename, encrypted, true);
  return value;
}

/** Write-ahead external checkpoint detects restored/copied SQLite and downgrade writes. */
export function createRemoteDatabaseFence(appData: string, userData: string, cipher: IdentityCipher, _identity: RemoteIdentity): { checkpoint: number; advance: () => number } {
  assertEncryptionAvailable(cipher);
  const directory = identityDirectory(appData, userData);
  const filename = path.join(directory, 'checkpoint.bin');
  const bytes = readFile(filename);
  const stored = bytes === null ? '0' : decrypt(cipher, bytes);
  let checkpoint = Number(stored);
  if (!/^(0|[1-9][0-9]*)$/u.test(stored) || !Number.isSafeInteger(checkpoint) || checkpoint < 0) {
    throw new RemoteIdentityError(RemoteInitializationFailure.IdentityInvalid);
  }
  return { checkpoint, advance: () => {
    assertEncryptionAvailable(cipher);
    const next = checkpoint + 1;
    if (!Number.isSafeInteger(next)) throw new RemoteIdentityError(RemoteInitializationFailure.IdentityInvalid);
    writeFile(filename, encrypt(cipher, String(next)), false);
    checkpoint = next;
    return checkpoint;
  } };
}
