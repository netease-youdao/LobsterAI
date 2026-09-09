import { createHash,randomBytes, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

export interface RemoteIdentity {
  installationId: string; deviceKey: string; databaseId: string;
}
export interface IdentityCipher {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
/** Kept outside userData/backups; safeStorage binds the secret to this OS account. */
export function loadRemoteIdentity(appData: string, userData: string, cipher: IdentityCipher): RemoteIdentity {
  if (!cipher.isEncryptionAvailable()) throw new Error('Secure device credential storage is unavailable');
  const profile = createHash('sha256').update(fs.realpathSync(userData)).digest('hex');
  const directory = path.join(appData, 'LobsterAI-remote-identity', profile);
  const filename = path.join(directory, 'identity.bin');
  if (fs.existsSync(filename)) {
    const value = JSON.parse(cipher.decryptString(fs.readFileSync(filename))) as RemoteIdentity;
    if (!value.installationId || !value.deviceKey || !value.databaseId) throw new Error('Invalid remote installation identity');
    return value;
  }
  const value: RemoteIdentity = {
    installationId: randomUUID(), deviceKey: randomBytes(32).toString('base64url'), databaseId: randomUUID(),
  };
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, cipher.encryptString(JSON.stringify(value))); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, filename);
  // Windows does not support opening directories for fsync.
  if (process.platform !== 'win32') {
    const directoryFd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  }
  return value;
}

/** Write-ahead external checkpoint detects restored/copied SQLite and downgrade writes. */
export function createRemoteDatabaseFence(appData: string, userData: string, cipher: IdentityCipher, identity: RemoteIdentity): { checkpoint: number; advance: () => number } {
  const profile = createHash('sha256').update(fs.realpathSync(userData)).digest('hex');
  const directory = path.join(appData, 'LobsterAI-remote-identity', profile);
  const filename = path.join(directory, 'checkpoint.bin');
  let checkpoint = fs.existsSync(filename) ? Number(cipher.decryptString(fs.readFileSync(filename))) : 0;
  if (!Number.isSafeInteger(checkpoint) || checkpoint < 0) throw new Error('Invalid remote database checkpoint');
  return { checkpoint, advance: () => {
    checkpoint++;
    if (!Number.isSafeInteger(checkpoint)) throw new Error('Remote database checkpoint exhausted');
    const temporary = `${filename}.${identity.installationId}.tmp`;
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, cipher.encryptString(String(checkpoint))); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, filename);
    if (process.platform !== 'win32') { const fd = fs.openSync(directory, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
    return checkpoint;
  } };
}
