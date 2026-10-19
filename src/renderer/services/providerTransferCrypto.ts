import { EXPORT_FORMAT_TYPE } from '../constants/app';
import {
  type EncryptedProvidersFile,
  isTransferRecord,
  ProviderTransferCrypto as CryptoFormat,
  ProviderTransferError,
  ProviderTransferErrorCode,
  ProviderTransferLimits,
  ProviderTransferMode,
  ProviderTransferVersion,
  requireTransfer,
} from './providerTransferTypes';

const encode = (bytes: Uint8Array): string => {
  // Chunking avoids exceeding the argument limit for large export files.
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
};

export const decodeProviderTransferBytes = (value: unknown, length?: number): Uint8Array<ArrayBuffer> => {
  requireTransfer(typeof value === 'string' && value.length > 0);
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new ProviderTransferError(ProviderTransferErrorCode.InvalidFile);
  }
  requireTransfer(btoa(binary) === value && (length === undefined || binary.length === length));
  return Uint8Array.from(binary, character => character.charCodeAt(0));
};

export const validateExportPassword = (password: string): void => {
  if (!password.trim()) throw new ProviderTransferError(ProviderTransferErrorCode.PasswordRequired);
  if (Array.from(password.trim()).length < ProviderTransferLimits.PasswordMin
    || password.length > ProviderTransferLimits.PasswordMax) {
    throw new ProviderTransferError(ProviderTransferErrorCode.WeakPassword);
  }
};

const deriveKey = async (password: string, salt: Uint8Array<ArrayBuffer>, iterations: number) => {
  const material = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), CryptoFormat.KeyDerivation, false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: CryptoFormat.KeyDerivation, hash: CryptoFormat.Hash, salt, iterations },
    material,
    { name: CryptoFormat.Algorithm, length: CryptoFormat.KeyBits },
    false,
    ['encrypt', 'decrypt'],
  );
};

// Reconstruct the authenticated header in a fixed order, independent of JSON key order.
const authenticatedHeader = (file: EncryptedProvidersFile): Uint8Array<ArrayBuffer> => new TextEncoder().encode(JSON.stringify({
  type: file.type,
  version: file.version,
  mode: file.mode,
  exportedAt: file.exportedAt,
  encryption: {
    algorithm: file.encryption.algorithm,
    keyDerivation: file.encryption.keyDerivation,
    hash: file.encryption.hash,
    iterations: file.encryption.iterations,
    salt: file.encryption.salt,
    iv: file.encryption.iv,
  },
}));

export const validateEncryptedProvidersFile = (value: Record<string, unknown>): EncryptedProvidersFile => {
  const metadata = value.encryption;
  requireTransfer(value.type === EXPORT_FORMAT_TYPE
    && value.version === ProviderTransferVersion.Current
    && value.mode === ProviderTransferMode.Encrypted
    && typeof value.exportedAt === 'string' && Number.isFinite(Date.parse(value.exportedAt))
    && isTransferRecord(metadata));
  requireTransfer(Object.keys(value).every(key => ['type', 'version', 'mode', 'exportedAt', 'encryption', 'encrypted'].includes(key)));
  requireTransfer(Object.keys(metadata).every(key => ['algorithm', 'keyDerivation', 'hash', 'iterations', 'salt', 'iv'].includes(key)));
  requireTransfer(metadata.algorithm === CryptoFormat.Algorithm
    && metadata.keyDerivation === CryptoFormat.KeyDerivation && metadata.hash === CryptoFormat.Hash
    && typeof metadata.iterations === 'number' && Number.isSafeInteger(metadata.iterations)
    && metadata.iterations >= CryptoFormat.Iterations && metadata.iterations <= CryptoFormat.MaxIterations);
  decodeProviderTransferBytes(metadata.salt, CryptoFormat.SaltBytes);
  decodeProviderTransferBytes(metadata.iv, CryptoFormat.IvBytes);
  requireTransfer(decodeProviderTransferBytes(value.encrypted).length >= CryptoFormat.TagBits / 8);
  return value as unknown as EncryptedProvidersFile;
};

export const encryptProviderTransfer = async (plaintext: string, password: string): Promise<EncryptedProvidersFile> => {
  validateExportPassword(password);
  const salt = crypto.getRandomValues(new Uint8Array(CryptoFormat.SaltBytes));
  const iv = crypto.getRandomValues(new Uint8Array(CryptoFormat.IvBytes));
  const file: EncryptedProvidersFile = {
    type: EXPORT_FORMAT_TYPE,
    version: ProviderTransferVersion.Current,
    mode: ProviderTransferMode.Encrypted,
    exportedAt: new Date().toISOString(),
    encryption: {
      algorithm: CryptoFormat.Algorithm,
      keyDerivation: CryptoFormat.KeyDerivation,
      hash: CryptoFormat.Hash,
      iterations: CryptoFormat.Iterations,
      salt: encode(salt),
      iv: encode(iv),
    },
    encrypted: '',
  };
  const key = await deriveKey(password, salt, file.encryption.iterations);
  const encrypted = await crypto.subtle.encrypt(
    { name: CryptoFormat.Algorithm, iv, additionalData: authenticatedHeader(file), tagLength: CryptoFormat.TagBits },
    key, new TextEncoder().encode(plaintext),
  );
  return { ...file, encrypted: encode(new Uint8Array(encrypted)) };
};

export const decryptProviderTransfer = async (file: EncryptedProvidersFile, password: string): Promise<string> => {
  validateEncryptedProvidersFile(file as unknown as Record<string, unknown>);
  if (!password || password.length > ProviderTransferLimits.PasswordMax) {
    throw new ProviderTransferError(ProviderTransferErrorCode.PasswordRequired);
  }
  const key = await deriveKey(password, decodeProviderTransferBytes(file.encryption.salt), file.encryption.iterations);
  try {
    const decrypted = await crypto.subtle.decrypt({
      name: CryptoFormat.Algorithm,
      iv: decodeProviderTransferBytes(file.encryption.iv),
      additionalData: authenticatedHeader(file),
      tagLength: CryptoFormat.TagBits,
    }, key, decodeProviderTransferBytes(file.encrypted));
    return new TextDecoder('utf-8', { fatal: true }).decode(decrypted);
  } catch {
    throw new ProviderTransferError(ProviderTransferErrorCode.DecryptFailed);
  }
};
