import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { RemoteInitializationFailure as Failure } from '../../shared/remote/constants';
import { createRemoteDatabaseFence, type IdentityCipher, loadRemoteIdentity, RemoteIdentityError } from './installationIdentity';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-identity-read-'));
  directories.push(directory);
  const profile = path.join(directory, 'profile');
  fs.mkdirSync(profile);
  const identityDirectory = path.join(directory, 'LobsterAI-remote-identity', createHash('sha256').update(fs.realpathSync(profile)).digest('hex'));
  const filename = path.join(identityDirectory, 'identity.bin');
  const cipher: IdentityCipher = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
    decryptString: vi.fn((value: Buffer) => {
      const text = value.toString();
      if (!text.startsWith('encrypted:')) throw new Error('private ciphertext details');
      return text.slice('encrypted:'.length);
    }),
  };
  return { directory, profile, identityDirectory, filename, cipher,
    load: (allowCreate = true) => loadRemoteIdentity(directory, profile, cipher, allowCreate) };
}

function expectFailure(action: () => unknown, failure: RemoteIdentityError['failure']): void {
  try { action(); throw new Error('Expected identity error'); }
  catch (error) {
    expect(error).toBeInstanceOf(RemoteIdentityError);
    expect((error as RemoteIdentityError).failure).toBe(failure);
    expect((error as Error).message).toBe(`Remote initialization failed: ${failure}`);
    expect((error as Error).message).not.toMatch(/private|ciphertext|token|deviceKey|Users|secret-value/u);
  }
}

describe('remote installation identity', () => {
  test('verifies encryption before publishing and reads the same identity without re-encrypting', () => {
    const f = fixture();
    const identity = f.load();
    expect(f.cipher.encryptString).toHaveBeenCalledTimes(1);
    expect(f.cipher.decryptString).toHaveBeenCalledTimes(1);
    const original = fs.readFileSync(f.filename);
    expect(f.load()).toEqual(identity);
    expect(f.cipher.encryptString).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(f.filename)).toEqual(original);
    expect(fs.readdirSync(f.identityDirectory)).toEqual(['identity.bin']);
  });

  test.each(['false', 'throws'] as const)('preserves identity when secure storage is unavailable: %s', mode => {
    const f = fixture(); f.load(); const original = fs.readFileSync(f.filename);
    vi.mocked(f.cipher.encryptString).mockClear();
    vi.mocked(f.cipher.isEncryptionAvailable).mockImplementation(() => {
      if (mode === 'throws') throw new Error('private account details');
      return false;
    });
    expectFailure(() => f.load(), Failure.SecureStorageUnavailable);
    expect(f.cipher.encryptString).not.toHaveBeenCalled();
    expect(fs.readFileSync(f.filename)).toEqual(original);
  });

  test('retries decryption with the same identity after a transient native failure', () => {
    const f = fixture(); const identity = f.load(); const original = fs.readFileSync(f.filename);
    vi.mocked(f.cipher.encryptString).mockClear();
    vi.mocked(f.cipher.decryptString).mockImplementationOnce(() => { throw new Error('secret-value token'); });
    expectFailure(() => f.load(), Failure.IdentityUnreadable);
    expect(fs.readFileSync(f.filename)).toEqual(original);
    expect(f.load()).toEqual(identity);
    expect(f.cipher.encryptString).not.toHaveBeenCalled();
  });

  test.each(['broken ciphertext', 'encrypted:{"deviceKey":"secret-value"}', 'encrypted:null', 'encrypted:[]'])('never overwrites unreadable or invalid identity: %s', stored => {
    const f = fixture(); f.load(); fs.writeFileSync(f.filename, stored);
    vi.mocked(f.cipher.encryptString).mockClear();
    expectFailure(() => f.load(), stored.startsWith('encrypted:') ? Failure.IdentityInvalid : Failure.IdentityUnreadable);
    expect(fs.readFileSync(f.filename).toString()).toBe(stored);
    expect(f.cipher.encryptString).not.toHaveBeenCalled();
  });

  test('rejects an oversized identity before decryption without changing its bytes', () => {
    const f = fixture(); f.load();
    const oversized = Buffer.alloc(64 * 1024 + 1, 65); fs.writeFileSync(f.filename, oversized);
    vi.mocked(f.cipher.decryptString).mockClear(); vi.mocked(f.cipher.encryptString).mockClear();
    expectFailure(() => f.load(), Failure.IdentityInvalid);
    expect(f.cipher.decryptString).not.toHaveBeenCalled(); expect(f.cipher.encryptString).not.toHaveBeenCalled();
    expect(fs.readFileSync(f.filename)).toEqual(oversized);
  });

  test('does not treat a read permission failure as a missing identity', () => {
    const f = fixture(); f.load(); const original = fs.readFileSync(f.filename);
    vi.mocked(f.cipher.encryptString).mockClear();
    const read = vi.spyOn(fs, 'openSync').mockImplementation(() => { throw Object.assign(new Error('private path'), { code: 'EACCES' }); });
    expectFailure(() => f.load(), Failure.LocalStorageUnavailable);
    expect(f.cipher.encryptString).not.toHaveBeenCalled();
    read.mockRestore(); expect(fs.readFileSync(f.filename)).toEqual(original);
  });

  test.each(['checkpoint.bin', 'security-v1', 'registrations', 'identity.bin.interrupted.tmp'])('does not regenerate a missing identity when prior evidence remains: %s', name => {
    const f = fixture(); fs.mkdirSync(f.identityDirectory, { recursive: true });
    fs.writeFileSync(path.join(f.identityDirectory, name), 'preserved');
    expectFailure(() => f.load(), Failure.IdentityUnreadable);
    expect(f.cipher.encryptString).not.toHaveBeenCalled();
    expect(fs.existsSync(f.filename)).toBe(false);
    expect(fs.readFileSync(path.join(f.identityDirectory, name)).toString()).toBe('preserved');
  });

  test('does not create an identity when the caller has existing database evidence', () => {
    const f = fixture(); expectFailure(() => f.load(false), Failure.IdentityUnreadable);
    expect(f.cipher.encryptString).not.toHaveBeenCalled();
    expect(fs.existsSync(f.filename)).toBe(false);
  });

  test('does not create files when encryption fails', () => {
    const f = fixture(); vi.mocked(f.cipher.encryptString).mockImplementation(() => { throw new Error('secret-value'); });
    expectFailure(() => f.load(), Failure.SecureStorageUnavailable);
    expect(fs.existsSync(f.identityDirectory)).toBe(false);
  });

  test.each(['decrypt failure', 'invalid value', 'different valid identity'])('does not publish a failed encryption roundtrip: %s', mode => {
    const f = fixture(); const other = fixture().load();
    vi.mocked(f.cipher.decryptString).mockImplementation(() => {
      if (mode === 'decrypt failure') throw new Error('secret-value');
      return mode === 'invalid value' ? 'private invalid JSON' : JSON.stringify(other);
    });
    expectFailure(() => f.load(), mode === 'decrypt failure' ? Failure.IdentityUnreadable : Failure.IdentityInvalid);
    expect(fs.existsSync(f.identityDirectory)).toBe(false);
  });

  test('keeps a concurrently published identity instead of replacing it', () => {
    const f = fixture();
    const link = vi.spyOn(fs, 'linkSync').mockImplementation((_temporary, filename) => {
      fs.writeFileSync(filename, 'preserved concurrent identity');
      throw Object.assign(new Error('private path'), { code: 'EEXIST' });
    });
    expectFailure(() => f.load(), Failure.LocalStorageUnavailable);
    link.mockRestore();
    expect(fs.readFileSync(f.filename).toString()).toBe('preserved concurrent identity');
    expect(fs.readdirSync(f.identityDirectory)).toEqual(['identity.bin']);
  });

  test('sanitizes file write failures and does not leave a partial published identity', () => {
    const f = fixture(); vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('private path secret-value'); });
    expectFailure(() => f.load(), Failure.LocalStorageUnavailable);
    expect(fs.existsSync(f.filename)).toBe(false);
    expect(fs.readdirSync(f.identityDirectory)).toEqual([]);
  });
});

describe('remote legacy database checkpoint', () => {
  test('preserves the checkpoint and only advances after a completed write', () => {
    const f = fixture(); const identity = f.load();
    const fence = createRemoteDatabaseFence(f.directory, f.profile, f.cipher, identity);
    expect(fence.checkpoint).toBe(0);
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => { throw new Error('private disk error'); });
    expectFailure(() => fence.advance(), Failure.LocalStorageUnavailable);
    write.mockRestore();
    expect(fence.advance()).toBe(1);
    expect(createRemoteDatabaseFence(f.directory, f.profile, f.cipher, identity).checkpoint).toBe(1);
  });

  test.each(['broken ciphertext', 'encrypted:', 'encrypted:-1', 'encrypted:1.5', 'encrypted:9007199254740992', 'encrypted:NaN'])('preserves a bad checkpoint instead of resetting it: %s', stored => {
    const f = fixture(); const identity = f.load();
    const filename = path.join(f.identityDirectory, 'checkpoint.bin'); fs.writeFileSync(filename, stored);
    vi.mocked(f.cipher.encryptString).mockClear();
    expectFailure(() => createRemoteDatabaseFence(f.directory, f.profile, f.cipher, identity), stored.startsWith('encrypted:') ? Failure.IdentityInvalid : Failure.IdentityUnreadable);
    expect(fs.readFileSync(filename).toString()).toBe(stored);
    expect(f.cipher.encryptString).not.toHaveBeenCalled();
  });

  test('rejects an oversized checkpoint before decryption without resetting it', () => {
    const f = fixture(); const identity = f.load();
    const filename = path.join(f.identityDirectory, 'checkpoint.bin');
    const oversized = Buffer.alloc(64 * 1024 + 1, 65); fs.writeFileSync(filename, oversized);
    vi.mocked(f.cipher.decryptString).mockClear(); vi.mocked(f.cipher.encryptString).mockClear();
    expectFailure(() => createRemoteDatabaseFence(f.directory, f.profile, f.cipher, identity), Failure.IdentityInvalid);
    expect(f.cipher.decryptString).not.toHaveBeenCalled(); expect(f.cipher.encryptString).not.toHaveBeenCalled();
    expect(fs.readFileSync(filename)).toEqual(oversized);
  });

  test('classifies checkpoint read I/O and encryption unavailability', () => {
    const f = fixture(); const identity = f.load();
    const read = vi.spyOn(fs, 'openSync').mockImplementation(() => { throw Object.assign(new Error('private checkpoint path'), { code: 'EPERM' }); });
    expectFailure(() => createRemoteDatabaseFence(f.directory, f.profile, f.cipher, identity), Failure.LocalStorageUnavailable);
    read.mockRestore(); vi.mocked(f.cipher.isEncryptionAvailable).mockReturnValue(false);
    expectFailure(() => createRemoteDatabaseFence(f.directory, f.profile, f.cipher, identity), Failure.SecureStorageUnavailable);
  });
});
