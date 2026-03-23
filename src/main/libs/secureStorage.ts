/**
 * Secure Storage for Sensitive Data
 * 
 * This module provides encryption for sensitive data stored in SQLite.
 * It uses AES-256-GCM with a key derived from machine-specific identifiers.
 * 
 * Security considerations:
 * - The key is derived from machine-specific data, making encrypted data
 *   non-portable between machines (intentional security feature)
 * - Uses PBKDF2 with 100,000 iterations for key derivation
 * - Each encryption operation uses a random IV
 */

import crypto from 'crypto';
import os from 'os';
import { execSync } from 'child_process';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const PBKDF2_ITERATIONS = 100000;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

// Encryption format version for future migration support
const ENCRYPTION_VERSION = 1;
const ENCRYPTED_PREFIX = `$LOBSTER_ENC_V${ENCRYPTION_VERSION}$`;

/**
 * Get machine-specific identifier without external dependencies.
 * Uses platform-specific methods to get a stable machine ID.
 */
let cachedMachineId: string | null = null;

const getMachineId = (): string => {
  if (cachedMachineId) {
    return cachedMachineId;
  }

  try {
    const platform = os.platform();

    if (platform === 'win32') {
      // Windows: Use WMIC to get the machine GUID
      const result = execSync(
        'wmic csproduct get uuid',
        { encoding: 'utf8', timeout: 5000, windowsHide: true }
      );
      const match = result.match(/([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})/i);
      if (match) {
        cachedMachineId = match[1];
        return cachedMachineId;
      }
    } else if (platform === 'darwin') {
      // macOS: Use IOPlatformUUID
      const result = execSync(
        "ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID",
        { encoding: 'utf8', timeout: 5000 }
      );
      const match = result.match(/"([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})"/i);
      if (match) {
        cachedMachineId = match[1];
        return cachedMachineId;
      }
    } else {
      // Linux: Read machine-id
      const result = execSync(
        'cat /etc/machine-id || cat /var/lib/dbus/machine-id',
        { encoding: 'utf8', timeout: 5000 }
      );
      cachedMachineId = result.trim();
      if (cachedMachineId) {
        return cachedMachineId;
      }
    }
  } catch {
    // Fallback below
  }

  // Fallback: Generate a hash from available system info
  const fallbackData = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.cpus()[0]?.model || '',
    os.totalmem().toString(),
  ].join(':');
  cachedMachineId = crypto.createHash('sha256').update(fallbackData).digest('hex');
  return cachedMachineId;
};

/**
 * Generate a machine-specific encryption key.
 * This key is derived from:
 * - Machine ID (hardware-specific identifier)
 * - OS hostname
 * - Username
 * This ensures encrypted data cannot be decrypted on a different machine.
 */
let cachedKey: Buffer | null = null;
let cachedSalt: Buffer | null = null;

const getMachineKey = (salt: Buffer): Buffer => {
  if (cachedKey && cachedSalt && cachedSalt.equals(salt)) {
    return cachedKey;
  }

  const machineId = getMachineId();

  const keyMaterial = [
    machineId,
    os.hostname(),
    os.userInfo().username,
    'lobsterai-secure-storage', // App-specific salt
  ].join(':');

  cachedKey = crypto.pbkdf2Sync(
    keyMaterial,
    salt,
    PBKDF2_ITERATIONS,
    KEY_LENGTH,
    'sha256'
  );
  cachedSalt = salt;

  return cachedKey;
};

/**
 * Encrypt sensitive data using machine-specific key
 * 
 * @param plaintext - The data to encrypt
 * @returns Encrypted string with embedded salt and IV
 */
export const encryptSensitive = (plaintext: string): string => {
  if (!plaintext) {
    return plaintext;
  }

  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = getMachineKey(salt);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Format: prefix + base64(salt + iv + authTag + encrypted)
  const combined = Buffer.concat([salt, iv, authTag, encrypted]);
  return ENCRYPTED_PREFIX + combined.toString('base64');
};

/**
 * Decrypt sensitive data
 * 
 * @param ciphertext - The encrypted string from encryptSensitive
 * @returns Decrypted plaintext
 * @throws Error if decryption fails (wrong machine, corrupted data, etc.)
 */
export const decryptSensitive = (ciphertext: string): string => {
  if (!ciphertext || !ciphertext.startsWith(ENCRYPTED_PREFIX)) {
    // Not encrypted, return as-is for backward compatibility
    return ciphertext;
  }

  const encoded = ciphertext.slice(ENCRYPTED_PREFIX.length);
  const combined = Buffer.from(encoded, 'base64');

  if (combined.length < SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH + 1) {
    throw new Error('Invalid encrypted data format');
  }

  let offset = 0;
  const salt = combined.subarray(offset, offset + SALT_LENGTH);
  offset += SALT_LENGTH;
  const iv = combined.subarray(offset, offset + IV_LENGTH);
  offset += IV_LENGTH;
  const authTag = combined.subarray(offset, offset + AUTH_TAG_LENGTH);
  offset += AUTH_TAG_LENGTH;
  const encrypted = combined.subarray(offset);

  const key = getMachineKey(salt);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch (error) {
    throw new Error('Decryption failed - data may have been encrypted on a different machine');
  }
};

/**
 * Check if a string is encrypted with our format
 */
export const isEncrypted = (value: string): boolean => {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
};

/**
 * Encrypt all API keys in a providers object
 */
export const encryptProviders = (providers: Record<string, { apiKey?: string; [key: string]: unknown }>): Record<string, { apiKey?: string; [key: string]: unknown }> => {
  const result: Record<string, { apiKey?: string; [key: string]: unknown }> = {};

  for (const [key, provider] of Object.entries(providers)) {
    result[key] = { ...provider };
    if (provider.apiKey && !isEncrypted(provider.apiKey)) {
      result[key].apiKey = encryptSensitive(provider.apiKey);
    }
  }

  return result;
};

/**
 * Decrypt all API keys in a providers object
 */
export const decryptProviders = (providers: Record<string, { apiKey?: string; [key: string]: unknown }>): Record<string, { apiKey?: string; [key: string]: unknown }> => {
  const result: Record<string, { apiKey?: string; [key: string]: unknown }> = {};

  for (const [key, provider] of Object.entries(providers)) {
    result[key] = { ...provider };
    if (provider.apiKey && isEncrypted(provider.apiKey)) {
      try {
        result[key].apiKey = decryptSensitive(provider.apiKey);
      } catch (error) {
        console.warn(`[SecureStorage] Failed to decrypt API key for provider ${key}:`, error);
        // Keep the encrypted value to avoid data loss
        result[key].apiKey = provider.apiKey;
      }
    }
  }

  return result;
};
