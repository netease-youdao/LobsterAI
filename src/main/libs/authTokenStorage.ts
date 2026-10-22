export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface TokenEncryption {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface TokenKeyValueStore {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
  delete(key: string): void;
}

export interface AuthTokenStorage {
  get(): AuthTokens | null;
  save(tokens: AuthTokens): void;
  clear(): void;
}

export const AUTH_TOKENS_STORE_KEY = 'auth_tokens';

interface EncryptedAuthTokens {
  v: 2;
  enc: string;
}

const isAuthTokens = (value: unknown): value is AuthTokens => (
  typeof value === 'object' && value !== null
  && typeof (value as AuthTokens).accessToken === 'string'
  && typeof (value as AuthTokens).refreshToken === 'string'
);

const isEncryptedAuthTokens = (value: unknown): value is EncryptedAuthTokens => (
  typeof value === 'object' && value !== null
  && (value as EncryptedAuthTokens).v === 2
  && typeof (value as EncryptedAuthTokens).enc === 'string'
);

const pick = (tokens: AuthTokens): AuthTokens => ({
  accessToken: tokens.accessToken,
  refreshToken: tokens.refreshToken,
});

/**
 * Persists tokens only with OS encryption; otherwise they live in memory until the app exits.
 * Tokens written by older versions are migrated or removed from storage. Ciphertext that cannot be
 * decrypted (for example after restoring a backup on another machine) means the user signs in again.
 */
export function createAuthTokenStorage(deps: {
  store: TokenKeyValueStore;
  encryption: TokenEncryption;
  platform: NodeJS.Platform;
}): AuthTokenStorage {
  let cached: AuthTokens | null | undefined;

  const canEncrypt = (): boolean => {
    try {
      if (deps.platform === 'linux') {
        const backend = deps.encryption.getSelectedStorageBackend();
        if (backend === 'basic_text' || backend === 'unknown') return false;
      }
      return deps.encryption.isEncryptionAvailable();
    } catch {
      return false;
    }
  };

  const persist = (tokens: AuthTokens): void => {
    if (canEncrypt()) {
      try {
        const enc = deps.encryption.encryptString(JSON.stringify(tokens)).toString('base64');
        deps.store.set<EncryptedAuthTokens>(AUTH_TOKENS_STORE_KEY, { v: 2, enc });
        return;
      } catch (error) {
        console.warn('[AuthTokens] encryption failed; keeping tokens in memory only:',
          error instanceof Error ? error.name : 'unknown');
      }
    } else {
      console.warn('[AuthTokens] OS encryption is unavailable; keeping tokens in memory only');
    }
    // Remove both legacy plaintext and stale credentials from a previous account.
    deps.store.delete(AUTH_TOKENS_STORE_KEY);
  };

  const load = (): AuthTokens | null => {
    const stored = deps.store.get<unknown>(AUTH_TOKENS_STORE_KEY);
    if (isAuthTokens(stored)) {
      const tokens = pick(stored);
      persist(tokens);
      return tokens;
    }
    if (!isEncryptedAuthTokens(stored)) return null;
    try {
      const decrypted: unknown = JSON.parse(deps.encryption.decryptString(Buffer.from(stored.enc, 'base64')));
      if (isAuthTokens(decrypted)) return pick(decrypted);
    } catch (error) {
      console.warn('[AuthTokens] stored tokens could not be decrypted; sign-in is required:',
        error instanceof Error ? error.name : 'unknown');
    }
    return null;
  };

  return {
    get() {
      if (cached === undefined) cached = load();
      return cached;
    },
    save(tokens) {
      cached = pick(tokens);
      persist(cached);
    },
    clear() {
      cached = null;
      deps.store.delete(AUTH_TOKENS_STORE_KEY);
    },
  };
}
