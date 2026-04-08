/**
 * Unit tests for the safeStorage-backed auth token storage logic.
 *
 * Logic is mirrored inline to avoid importing Electron APIs in the test runner.
 * Any change to the saveAuthTokens / getAuthTokens / clearAuthTokens helpers
 * in main.ts must be reflected here.
 */
import { test, expect, beforeEach } from 'vitest';

// ── Mirror of storage constants ───────────────────────────────────────────
const SAFE_TOKEN_KEY = 'auth_tokens_encrypted';
const LEGACY_TOKEN_KEY = 'auth_tokens';

// ── Test-double for safeStorage ───────────────────────────────────────────
// XOR with 0x42 is symmetric and produces ciphertext that differs from plaintext.
const mockSafeStorage = {
  available: true,
  encryptString(s: string): Buffer {
    return Buffer.from(Buffer.from(s).map((b) => b ^ 0x42));
  },
  decryptString(buf: Buffer): string {
    return Buffer.from(buf.map((b) => b ^ 0x42)).toString();
  },
};

// ── Mirror of token storage logic ────────────────────────────────────────
type Store = Map<string, unknown>;

function createTokenStorage(
  store: Store,
  isEncryptionAvailable: () => boolean,
  encrypt: (s: string) => Buffer,
  decrypt: (b: Buffer) => string,
) {
  const save = (accessToken: string, refreshToken: string) => {
    if (isEncryptionAvailable()) {
      const cipher = encrypt(JSON.stringify({ accessToken, refreshToken }));
      store.set(SAFE_TOKEN_KEY, cipher.toString('base64'));
      store.delete(LEGACY_TOKEN_KEY);
    } else {
      store.set(LEGACY_TOKEN_KEY, { accessToken, refreshToken });
    }
  };

  const get = (): { accessToken: string; refreshToken: string } | null => {
    if (isEncryptionAvailable()) {
      const stored = store.get(SAFE_TOKEN_KEY) as string | undefined;
      if (stored) {
        try {
          const plain = decrypt(Buffer.from(stored, 'base64'));
          return JSON.parse(plain) as { accessToken: string; refreshToken: string };
        } catch {
          store.delete(SAFE_TOKEN_KEY);
          return null;
        }
      }
      const legacy = store.get(LEGACY_TOKEN_KEY) as
        | { accessToken: string; refreshToken: string }
        | undefined;
      if (legacy?.accessToken && legacy?.refreshToken) {
        save(legacy.accessToken, legacy.refreshToken);
        return legacy;
      }
      return null;
    }
    return (
      (store.get(LEGACY_TOKEN_KEY) as { accessToken: string; refreshToken: string } | undefined) ||
      null
    );
  };

  const clear = () => {
    store.delete(LEGACY_TOKEN_KEY);
    store.delete(SAFE_TOKEN_KEY);
  };

  return { save, get, clear };
}

// ── Test setup ────────────────────────────────────────────────────────────
let store: Store;
let tokens: ReturnType<typeof createTokenStorage>;

beforeEach(() => {
  store = new Map();
  mockSafeStorage.available = true;
  tokens = createTokenStorage(
    store,
    () => mockSafeStorage.available,
    (s) => mockSafeStorage.encryptString(s),
    (b) => mockSafeStorage.decryptString(b),
  );
});

// ── Tests ─────────────────────────────────────────────────────────────────

test('saves tokens to encrypted key and retrieves them correctly', () => {
  tokens.save('access123', 'refresh456');
  expect(store.has(SAFE_TOKEN_KEY)).toBe(true);
  expect(store.has(LEGACY_TOKEN_KEY)).toBe(false);
  expect(tokens.get()).toEqual({ accessToken: 'access123', refreshToken: 'refresh456' });
});

test('stored value does not contain plain-text token strings', () => {
  tokens.save('access123', 'refresh456');
  const raw = store.get(SAFE_TOKEN_KEY) as string;
  expect(raw).not.toContain('access123');
  expect(raw).not.toContain('refresh456');
});

test('returns null when no tokens are stored', () => {
  expect(tokens.get()).toBeNull();
});

test('clears both encrypted and legacy keys', () => {
  tokens.save('access123', 'refresh456');
  tokens.clear();
  expect(store.has(SAFE_TOKEN_KEY)).toBe(false);
  expect(store.has(LEGACY_TOKEN_KEY)).toBe(false);
  expect(tokens.get()).toBeNull();
});

test('migrates legacy plain-text tokens to encrypted storage on first read', () => {
  store.set(LEGACY_TOKEN_KEY, { accessToken: 'oldAccess', refreshToken: 'oldRefresh' });
  const result = tokens.get();
  expect(result).toEqual({ accessToken: 'oldAccess', refreshToken: 'oldRefresh' });
  // After migration: encrypted key exists, legacy key is gone
  expect(store.has(SAFE_TOKEN_KEY)).toBe(true);
  expect(store.has(LEGACY_TOKEN_KEY)).toBe(false);
});

test('migrated tokens can be retrieved again without re-migration', () => {
  store.set(LEGACY_TOKEN_KEY, { accessToken: 'oldAccess', refreshToken: 'oldRefresh' });
  tokens.get(); // triggers migration
  expect(tokens.get()).toEqual({ accessToken: 'oldAccess', refreshToken: 'oldRefresh' });
});

test('falls back to plain-text storage when encryption is unavailable', () => {
  mockSafeStorage.available = false;
  tokens.save('access123', 'refresh456');
  expect(store.has(LEGACY_TOKEN_KEY)).toBe(true);
  expect(store.has(SAFE_TOKEN_KEY)).toBe(false);
  expect(tokens.get()).toEqual({ accessToken: 'access123', refreshToken: 'refresh456' });
});

test('returns null and clears corrupted encrypted data', () => {
  // Store a value that is valid base64 but decodes to non-JSON after XOR decrypt
  store.set(SAFE_TOKEN_KEY, Buffer.from('not json at all !!!').toString('base64'));
  expect(tokens.get()).toBeNull();
  expect(store.has(SAFE_TOKEN_KEY)).toBe(false);
});

test('clear on plain-text fallback removes legacy key', () => {
  mockSafeStorage.available = false;
  tokens.save('access123', 'refresh456');
  tokens.clear();
  expect(store.has(LEGACY_TOKEN_KEY)).toBe(false);
  expect(tokens.get()).toBeNull();
});
