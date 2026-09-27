import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { BrowserCredentialAvailabilityReason } from '../../shared/browserCredentials/constants';
import type { SqliteStore } from '../sqliteStore';
import {
  type BrowserCredentialCrypto,
  BrowserCredentialService,
  normalizeBrowserCredentialOrigin,
} from './browserCredentialService';

class TestCredentialCrypto implements BrowserCredentialCrypto {
  available = true;
  backend = 'kwallet6';

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  getSelectedStorageBackend(): string {
    return this.backend;
  }

  encryptString(plainText: string): Buffer {
    return Buffer.from(`encrypted:${plainText}`, 'utf8');
  }

  decryptString(encrypted: Buffer): string {
    return encrypted.toString('utf8').replace(/^encrypted:/, '');
  }
}

describe('BrowserCredentialService', () => {
  let db: Database.Database;
  let encryption: TestCredentialCrypto;
  let service: BrowserCredentialService;
  let storedSettings: Map<string, unknown>;
  let store: Pick<SqliteStore, 'get' | 'set'>;

  beforeEach(() => {
    db = new Database(':memory:');
    encryption = new TestCredentialCrypto();
    storedSettings = new Map();
    store = {
      get: <T>(key: string) => storedSettings.get(key) as T | undefined,
      set: <T>(key: string, value: T) => { storedSettings.set(key, value); },
    };
    service = new BrowserCredentialService(db, encryption, 'win32', store);
  });

  afterEach(() => {
    db.close();
  });

  test('normalizes secure origins and permits localhost HTTP only', () => {
    expect(normalizeBrowserCredentialOrigin('Example.com/login')).toBe('https://example.com');
    expect(normalizeBrowserCredentialOrigin('http://localhost:5175/login')).toBe('http://localhost:5175');
    expect(() => normalizeBrowserCredentialOrigin('http://example.com/login')).toThrow(/HTTPS/);
    expect(() => normalizeBrowserCredentialOrigin('ftp://example.com')).toThrow(/HTTPS/);
  });

  test('stores encrypted passwords and never exposes them in summaries', () => {
    const saved = service.save({
      origin: 'https://example.com/login',
      username: 'alice@example.com',
      password: 'correct horse battery staple',
    });

    expect(saved).toMatchObject({
      origin: 'https://example.com',
      username: 'alice@example.com',
    });
    expect(service.list()).toEqual([saved]);
    const stored = db.prepare('SELECT encrypted_password FROM browser_credentials WHERE id = ?')
      .get(saved.id) as { encrypted_password: Buffer };
    expect(stored.encrypted_password.toString('utf8')).toBe('encrypted:correct horse battery staple');
    expect(service.getSecret(saved.id, 'https://example.com/account').password)
      .toBe('correct horse battery staple');
  });

  test('updates the matching origin and username instead of creating duplicates', () => {
    const first = service.save({
      origin: 'example.com',
      username: 'Alice',
      password: 'first',
    });
    const second = service.save({
      origin: 'https://example.com/path',
      username: 'alice',
      password: 'second',
    });

    expect(second.id).toBe(first.id);
    expect(service.list()).toHaveLength(1);
    expect(service.getSecret(first.id, 'https://example.com').password).toBe('second');
  });

  test('refuses decryption for another origin', () => {
    const saved = service.save({
      origin: 'https://example.com',
      username: 'alice',
      password: 'secret',
    });
    expect(() => service.getSecret(saved.id, 'https://other.example.com')).toThrow(/does not match/);
  });

  test('reports unavailable or insecure OS storage', () => {
    encryption.available = false;
    expect(service.requestAccess()).toEqual({
      available: false,
      reason: BrowserCredentialAvailabilityReason.EncryptionUnavailable,
    });

    encryption.available = true;
    encryption.backend = 'basic_text';
    const linuxService = new BrowserCredentialService(db, encryption, 'linux');
    expect(linuxService.requestAccess()).toEqual({
      available: false,
      reason: BrowserCredentialAvailabilityReason.InsecureStorageBackend,
    });
  });

  test('opening settings and listing accounts never probes OS encryption', () => {
    const probe = vi.spyOn(encryption, 'isEncryptionAvailable');
    expect(service.getAvailability()).toEqual({
      available: false,
      reason: BrowserCredentialAvailabilityReason.AccessNotRequested,
    });
    expect(service.list()).toEqual([]);
    service.getAvailability();
    expect(probe).not.toHaveBeenCalled();
  });

  test('remembers access across settings visits and application restarts without prompting', () => {
    const probe = vi.spyOn(encryption, 'isEncryptionAvailable');
    expect(service.requestAccess()).toEqual({ available: true });
    expect(service.getAvailability()).toEqual({ available: true });

    const restarted = new BrowserCredentialService(db, encryption, 'win32', store);
    expect(restarted.getAvailability()).toEqual({ available: true });
    expect(probe).toHaveBeenCalledTimes(1);
    expect([...storedSettings.values()]).toEqual([{ available: true }]);
  });

  test('keeps a failed request quiet until the user explicitly retries', () => {
    encryption.available = false;
    const probe = vi.spyOn(encryption, 'isEncryptionAvailable');
    expect(service.requestAccess().available).toBe(false);
    service.getAvailability();
    const restarted = new BrowserCredentialService(db, encryption, 'win32', store);
    expect(restarted.getAvailability().available).toBe(false);
    expect(() => restarted.save({ origin: 'example.com', username: 'alice', password: 'secret' }))
      .toThrow(/unavailable/);
    expect(probe).toHaveBeenCalledTimes(1);

    encryption.available = true;
    expect(restarted.requestAccess()).toEqual({ available: true });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  test('explains the macOS restart requirement and permits authorization after relaunch', () => {
    const macService = new BrowserCredentialService(db, encryption, 'darwin', store);
    encryption.available = false;
    const probe = vi.spyOn(encryption, 'isEncryptionAvailable');
    expect(macService.requestAccess()).toEqual({
      available: false,
      reason: BrowserCredentialAvailabilityReason.EncryptionUnavailable,
      requiresRestart: true,
    });
    expect(macService.getAvailability().requiresRestart).toBe(true);
    macService.requestAccess();
    expect(probe).toHaveBeenCalledTimes(1);

    encryption.available = true;
    const restarted = new BrowserCredentialService(db, encryption, 'darwin', store);
    expect(restarted.getAvailability()).toEqual({
      available: false,
      reason: BrowserCredentialAvailabilityReason.EncryptionUnavailable,
    });
    expect(restarted.requestAccess()).toEqual({ available: true });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  test('rechecks the OS before using a remembered grant after restart', () => {
    const saved = service.save({ origin: 'example.com', username: 'alice', password: 'secret' });
    encryption.available = false;
    const decrypt = vi.spyOn(encryption, 'decryptString');
    const restarted = new BrowserCredentialService(db, encryption, 'win32', store);

    expect(restarted.getAvailability().available).toBe(true);
    expect(() => restarted.getSecret(saved.id, saved.origin)).toThrow(/unavailable/);
    expect(decrypt).not.toHaveBeenCalled();
    expect(restarted.getAvailability().available).toBe(false);
    expect(restarted.list()).toEqual([saved]);
  });

  test.each(['basic_text', 'unknown'])('never trusts a remembered grant on insecure Linux backend %s', backend => {
    service.requestAccess();
    encryption.backend = backend;
    const encrypt = vi.spyOn(encryption, 'encryptString');
    const restarted = new BrowserCredentialService(db, encryption, 'linux', store);
    expect(() => restarted.save({ origin: 'example.com', username: 'alice', password: 'secret' }))
      .toThrow(/unavailable/);
    expect(encrypt).not.toHaveBeenCalled();
    expect(restarted.getAvailability().reason).toBe(BrowserCredentialAvailabilityReason.InsecureStorageBackend);
  });

  test('clears remembered availability when an encryption operation fails', () => {
    service.requestAccess();
    const encrypt = vi.spyOn(encryption, 'encryptString').mockImplementationOnce(() => {
      throw new Error('OS storage locked');
    });
    expect(() => service.save({ origin: 'example.com', username: 'alice', password: 'secret' }))
      .toThrow('OS storage locked');
    expect(service.list()).toEqual([]);
    const restarted = new BrowserCredentialService(db, encryption, 'win32', store);
    expect(restarted.getAvailability().available).toBe(false);

    expect(service.requestAccess().available).toBe(true);
    service.save({ origin: 'example.com', username: 'alice', password: 'secret' });
    expect(encrypt).toHaveBeenCalledTimes(2);
  });

  test('keeps existing accounts enabled without a keychain lookup during upgrade', () => {
    service.save({ origin: 'example.com', username: 'alice', password: 'secret' });
    storedSettings.clear();
    const probe = vi.spyOn(encryption, 'isEncryptionAvailable');
    const upgraded = new BrowserCredentialService(db, encryption, 'darwin', store);
    expect(upgraded.getAvailability()).toEqual({ available: true });
    expect(probe).not.toHaveBeenCalled();
  });

  test('rejects unrelated origins before probing OS storage after restart', () => {
    const saved = service.save({ origin: 'example.com', username: 'alice', password: 'secret' });
    const probe = vi.spyOn(encryption, 'isEncryptionAvailable');
    const restarted = new BrowserCredentialService(db, encryption, 'darwin', store);
    expect(() => restarted.getSecret(saved.id, 'https://other.example.com')).toThrow(/does not match/);
    expect(probe).not.toHaveBeenCalled();
  });
});
