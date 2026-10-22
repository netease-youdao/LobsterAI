import { describe, expect, test, vi } from 'vitest';

import { AUTH_TOKENS_STORE_KEY, createAuthTokenStorage, type TokenEncryption } from './authTokenStorage';

const tokens = { accessToken: 'access-1', refreshToken: 'refresh-1' };

function memoryStore(initial?: unknown) {
  const values = new Map<string, unknown>();
  if (initial !== undefined) values.set(AUTH_TOKENS_STORE_KEY, initial);
  return {
    values,
    get: <T,>(key: string) => values.get(key) as T | undefined,
    set: vi.fn(<T,>(key: string, value: T) => {
      values.set(key, value);
    }),
    delete: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
}

function encryption(available = true, backend = 'keychain'): TokenEncryption {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (plainText: string) => Buffer.from(`enc:${plainText}`),
    decryptString: (encrypted: Buffer) => {
      const value = encrypted.toString();
      if (!value.startsWith('enc:')) throw new Error('bad ciphertext');
      return value.slice(4);
    },
  };
}

describe('createAuthTokenStorage', () => {
  test('re-saves plaintext tokens from older versions encrypted', () => {
    const store = memoryStore(tokens);
    const storage = createAuthTokenStorage({ store, encryption: encryption(), platform: 'darwin' });

    expect(storage.get()).toEqual(tokens);
    expect(store.values.get(AUTH_TOKENS_STORE_KEY)).toEqual({
      v: 2,
      enc: Buffer.from(`enc:${JSON.stringify(tokens)}`).toString('base64'),
    });
  });

  test('round-trips encrypted tokens across restarts', () => {
    const store = memoryStore();
    createAuthTokenStorage({ store, encryption: encryption(), platform: 'win32' }).save(tokens);

    const restarted = createAuthTokenStorage({ store, encryption: encryption(), platform: 'win32' });

    expect(restarted.get()).toEqual(tokens);
    expect(JSON.stringify(store.values.get(AUTH_TOKENS_STORE_KEY))).not.toContain('refresh-1');
  });

  test.each([
    ['linux', true, 'basic_text'],
    ['linux', true, 'unknown'],
    ['darwin', false, 'keychain'],
  ] as const)('keeps tokens only in memory without OS encryption: %s %s %s', (platform, available, backend) => {
    const store = memoryStore();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const crypto = encryption(available, backend);
    const storage = createAuthTokenStorage({ store, encryption: crypto, platform });
    storage.save(tokens);

    expect(storage.get()).toEqual(tokens);
    expect(store.set).not.toHaveBeenCalled();
    expect(store.values.has(AUTH_TOKENS_STORE_KEY)).toBe(false);
    expect(createAuthTokenStorage({ store, encryption: crypto, platform }).get()).toBeNull();
  });

  test('loads legacy plaintext once and removes it when encryption is unavailable', () => {
    const store = memoryStore(tokens);
    const storage = createAuthTokenStorage({ store, encryption: encryption(false), platform: 'darwin' });

    expect(storage.get()).toEqual(tokens);
    expect(store.values.has(AUTH_TOKENS_STORE_KEY)).toBe(false);
    expect(store.set).not.toHaveBeenCalled();
  });

  test.each(['legacy', 'encrypted'])('encryption failure removes stale %s credentials but retains the current session', (format) => {
    const store = memoryStore(format === 'legacy' ? tokens : { v: 2, enc: 'old-ciphertext' });
    const crypto = encryption();
    crypto.encryptString = () => { throw new Error('encryption unavailable'); };
    const storage = createAuthTokenStorage({ store, encryption: crypto, platform: 'win32' });
    const current = { accessToken: 'new-access', refreshToken: 'new-refresh' };
    storage.save(current);

    expect(storage.get()).toEqual(current);
    expect(store.values.has(AUTH_TOKENS_STORE_KEY)).toBe(false);
    expect(store.set).not.toHaveBeenCalled();
  });

  test('treats unreadable ciphertext as signed out without deleting it', () => {
    const store = memoryStore({ v: 2, enc: Buffer.from('garbage').toString('base64') });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const storage = createAuthTokenStorage({ store, encryption: encryption(), platform: 'darwin' });

    expect(storage.get()).toBeNull();
    expect(store.delete).not.toHaveBeenCalled();
  });

  test('clears stored tokens', () => {
    const store = memoryStore();
    const storage = createAuthTokenStorage({ store, encryption: encryption(), platform: 'darwin' });
    storage.save(tokens);

    storage.clear();

    expect(storage.get()).toBeNull();
    expect(store.values.has(AUTH_TOKENS_STORE_KEY)).toBe(false);
  });
});
