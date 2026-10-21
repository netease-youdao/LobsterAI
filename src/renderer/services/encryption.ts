import { CONFIG_KEYS } from '../config';
import { localStore } from './store';

const EXPORT_KEY_BYTES = 32;
const AES_GCM_IV_BYTES = 12;

let cachedKey: CryptoKey | null = null;
let cachedKeyPromise: Promise<CryptoKey> | null = null;

export interface EncryptedPayload {
  encrypted: string;
  iv: string;
}

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const getLocalStorage = (): Storage | null => {
  try {
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
      return globalThis.localStorage;
    }
  } catch {
    return null;
  }
  return null;
};

const readRawExportKey = (stored: unknown): Uint8Array<ArrayBuffer> | null => {
  if (!stored) {
    return null;
  }
  if (typeof stored === 'string') {
    try {
      return base64ToBytes(stored);
    } catch {
      return null;
    }
  }
  if (stored instanceof Uint8Array) {
    return new Uint8Array(stored);
  }
  if (stored instanceof ArrayBuffer) {
    return new Uint8Array(stored);
  }
  if (Array.isArray(stored) && stored.every((value) => typeof value === 'number')) {
    return new Uint8Array(stored);
  }
  if (typeof stored === 'object' && stored !== null && Array.isArray((stored as { data?: unknown }).data)) {
    const data = (stored as { data: unknown[] }).data;
    if (data.every((value) => typeof value === 'number')) {
      return new Uint8Array(data);
    }
  }
  return null;
};

const readExportKeyFromLocalStorage = (): Uint8Array<ArrayBuffer> | null => {
  const storage = getLocalStorage();
  if (!storage) {
    return null;
  }
  const stored = storage.getItem(CONFIG_KEYS.PROVIDERS_EXPORT_KEY);
  if (!stored) {
    return null;
  }
  try {
    return base64ToBytes(stored);
  } catch {
    return null;
  }
};

const writeExportKeyToLocalStorage = (raw: Uint8Array) => {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(CONFIG_KEYS.PROVIDERS_EXPORT_KEY, bytesToBase64(raw));
  } catch {
    return;
  }
};

const getStoredExportKey = async (): Promise<Uint8Array<ArrayBuffer> | null> => {
  const stored = await localStore.getItem<unknown>(CONFIG_KEYS.PROVIDERS_EXPORT_KEY);
  const parsed = readRawExportKey(stored);
  if (parsed) {
    writeExportKeyToLocalStorage(parsed);
    return parsed;
  }
  return readExportKeyFromLocalStorage();
};

const persistExportKey = async (raw: Uint8Array): Promise<void> => {
  await localStore.setItem(CONFIG_KEYS.PROVIDERS_EXPORT_KEY, bytesToBase64(raw));
  writeExportKeyToLocalStorage(raw);
};

const getOrCreateRawExportKey = async (): Promise<Uint8Array<ArrayBuffer>> => {
  const stored = await getStoredExportKey();
  if (stored) {
    return stored;
  }
  const raw = crypto.getRandomValues(new Uint8Array(EXPORT_KEY_BYTES));
  await persistExportKey(raw);
  return raw;
};

const getExportKey = async (): Promise<CryptoKey> => {
  if (cachedKey) {
    return cachedKey;
  }
  if (!cachedKeyPromise) {
    cachedKeyPromise = (async () => {
      if (!crypto?.subtle) {
        throw new Error('Crypto API unavailable');
      }
      const raw = await getOrCreateRawExportKey();
      return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    })();
  }
  cachedKey = await cachedKeyPromise;
  return cachedKey;
};

export const encryptSecret = async (value: string): Promise<EncryptedPayload> => {
  const key = await getExportKey();
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const encoded = new TextEncoder().encode(value);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return {
    encrypted: bytesToBase64(new Uint8Array(encrypted)),
    iv: bytesToBase64(iv),
  };
};

export const decryptSecret = async (payload: EncryptedPayload): Promise<string> => {
  if (!payload?.encrypted || !payload?.iv) {
    throw new Error('Invalid encrypted payload');
  }
  // Importing an old backup must not create a replacement local key on failure.
  const raw = await getStoredExportKey();
  if (!raw || raw.byteLength !== EXPORT_KEY_BYTES) {
    throw new Error('Legacy export key unavailable');
  }
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const iv = base64ToBytes(payload.iv);
  const encrypted = base64ToBytes(payload.encrypted);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
  return new TextDecoder().decode(decrypted);
};

// Password-based encryption/decryption for portable export/import
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_SALT_BYTES = 16;

export interface PasswordEncryptedPayload {
  encrypted: string;
  iv: string;
  salt: string;
}

const deriveKeyFromPassword = async (password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> => {
  if (!crypto?.subtle) {
    throw new Error('Crypto API unavailable');
  }
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
};

export const encryptWithPassword = async (value: string, password: string): Promise<PasswordEncryptedPayload> => {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const key = await deriveKeyFromPassword(password, salt);
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const encoded = new TextEncoder().encode(value);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return {
    encrypted: bytesToBase64(new Uint8Array(encrypted)),
    iv: bytesToBase64(iv),
    salt: bytesToBase64(salt),
  };
};

export const decryptWithPassword = async (payload: PasswordEncryptedPayload, password: string): Promise<string> => {
  if (!payload?.encrypted || !payload?.iv || !payload?.salt) {
    throw new Error('Invalid encrypted payload');
  }
  const salt = base64ToBytes(payload.salt);
  const key = await deriveKeyFromPassword(password, salt);
  const iv = base64ToBytes(payload.iv);
  const encrypted = base64ToBytes(payload.encrypted);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
  return new TextDecoder().decode(decrypted);
};
