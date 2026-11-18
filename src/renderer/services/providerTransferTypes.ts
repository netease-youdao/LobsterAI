import { EXPORT_FORMAT_TYPE } from '../constants/app';

export const ProviderTransferVersion = { LocalKey: 1, LegacyPassword: 2, Current: 3 } as const;
export const ProviderTransferMode = { Configuration: 'configuration', Encrypted: 'encrypted' } as const;
export type ProviderTransferMode = typeof ProviderTransferMode[keyof typeof ProviderTransferMode];
export const ProviderTransferAction = { Export: 'export', Import: 'import' } as const;
export type ProviderTransferAction = typeof ProviderTransferAction[keyof typeof ProviderTransferAction];

export const ProviderTransferLimits = {
  FileBytes: 5 * 1024 * 1024,
  Providers: 100,
  Models: 1000,
  PasswordMin: 12,
  PasswordMax: 1024,
} as const;

export const ProviderTransferErrorCode = {
  InvalidFile: 'invalidProvidersFile',
  TooLarge: 'providersFileTooLarge',
  PasswordRequired: 'passwordRequired',
  WeakPassword: 'providersPasswordWeak',
  DecryptFailed: 'providersDecryptFailed',
  LegacyDecryptFailed: 'decryptProvidersFailed',
  EndpointConflict: 'providersEndpointConflict',
  ConfigurationChanged: 'providersConfigurationChanged',
} as const;
export type ProviderTransferErrorCode = typeof ProviderTransferErrorCode[keyof typeof ProviderTransferErrorCode];

export class ProviderTransferError extends Error {
  constructor(public readonly code: ProviderTransferErrorCode) {
    super(code);
    this.name = 'ProviderTransferError';
  }
}

export const ProviderTransferCrypto = {
  Algorithm: 'AES-GCM',
  KeyDerivation: 'PBKDF2',
  Hash: 'SHA-256',
  KeySource: 'password',
  Iterations: 600_000,
  MaxIterations: 2_000_000,
  SaltBytes: 16,
  IvBytes: 12,
  KeyBits: 256,
  TagBits: 128,
} as const;

export interface EncryptedProvidersFile {
  type: typeof EXPORT_FORMAT_TYPE;
  version: typeof ProviderTransferVersion.Current;
  mode: typeof ProviderTransferMode.Encrypted;
  exportedAt: string;
  encryption: {
    algorithm: typeof ProviderTransferCrypto.Algorithm;
    keyDerivation: typeof ProviderTransferCrypto.KeyDerivation;
    hash: typeof ProviderTransferCrypto.Hash;
    iterations: number;
    salt: string;
    iv: string;
  };
  encrypted: string;
}

export const isTransferRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

export function requireTransfer(condition: unknown): asserts condition {
  if (!condition) throw new ProviderTransferError(ProviderTransferErrorCode.InvalidFile);
}

export const parseTransferJson = (raw: string): unknown => {
  if (new TextEncoder().encode(raw).byteLength > ProviderTransferLimits.FileBytes) {
    throw new ProviderTransferError(ProviderTransferErrorCode.TooLarge);
  }
  try {
    return JSON.parse(raw, (key, value: unknown) => {
      requireTransfer(!['__proto__', 'constructor', 'prototype'].includes(key));
      return value;
    }) as unknown;
  } catch (error) {
    if (error instanceof ProviderTransferError) throw error;
    throw new ProviderTransferError(ProviderTransferErrorCode.InvalidFile);
  }
};
