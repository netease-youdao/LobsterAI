import type Database from 'better-sqlite3';
import crypto from 'crypto';

import {
  type BrowserCredentialAvailability,
  BrowserCredentialAvailabilityReason,
  type BrowserCredentialSaveRequest,
  type BrowserCredentialSummary,
} from '../../shared/browserCredentials/constants';
import type { SqliteStore } from '../sqliteStore';

const MAX_ORIGIN_LENGTH = 2_048;
const MAX_USERNAME_LENGTH = 512;
const MAX_PASSWORD_LENGTH = 8_192;
const AVAILABILITY_STORE_KEY = 'browserCredentials.availability';

interface BrowserCredentialRow {
  id: string;
  origin: string;
  username: string;
  encrypted_password: Buffer;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
}
export interface BrowserCredentialCrypto {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface BrowserCredentialSecret {
  summary: BrowserCredentialSummary;
  password: string;
}

const isLoopbackHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(normalized);
};

export const normalizeBrowserCredentialOrigin = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ORIGIN_LENGTH) {
    throw new Error('A valid website origin is required.');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error('A valid website origin is required.');
  }

  if (parsed.username || parsed.password) {
    throw new Error('The website origin must not include credentials.');
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname))) {
    throw new Error('Saved browser credentials require HTTPS, except for localhost.');
  }
  return parsed.origin;
};

const normalizeUsername = (value: string): string => {
  const username = value.trim();
  if (!username || username.length > MAX_USERNAME_LENGTH) {
    throw new Error('A valid username is required.');
  }
  return username;
};

const validatePassword = (value: string): string => {
  if (!value || value.length > MAX_PASSWORD_LENGTH) {
    throw new Error('A valid password is required.');
  }
  return value;
};

const rowToSummary = (row: BrowserCredentialRow): BrowserCredentialSummary => ({
  id: row.id,
  origin: row.origin,
  username: row.username,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
});

export class BrowserCredentialService {
  private initialized = false;
  private availability: BrowserCredentialAvailability | undefined;
  private encryptionVerified = false;
  private requiresRestart = false;

  constructor(
    private readonly db: Database.Database,
    private readonly encryption: BrowserCredentialCrypto,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly store?: Pick<SqliteStore, 'get' | 'set'>,
  ) {}

  getAvailability(): BrowserCredentialAvailability {
    // Reading settings or observing a login form must never open an OS prompt.
    // Persist only the last known status; actual secret operations still check
    // the OS backend again after every application restart.
    if (!this.availability) {
      const saved = this.store?.get<BrowserCredentialAvailability>(AVAILABILITY_STORE_KEY);
      if (saved?.available === true) {
        this.availability = { available: true };
      } else if (
        saved?.available === false
        && saved.reason
        && Object.values(BrowserCredentialAvailabilityReason).includes(saved.reason)
      ) {
        this.availability = { available: false, reason: saved.reason };
      } else {
        // Existing saved logins predate the explicit enable action.
        this.availability = this.list().length > 0
          ? { available: true }
          : { available: false, reason: BrowserCredentialAvailabilityReason.AccessNotRequested };
      }
    }
    return {
      ...this.availability,
      ...(this.requiresRestart ? { requiresRestart: true } : {}),
    };
  }

  requestAccess(): BrowserCredentialAvailability {
    if (this.requiresRestart) return this.getAvailability();
    try {
      if (this.platform === 'linux') {
        const backend = this.encryption.getSelectedStorageBackend();
        if (backend === 'basic_text' || backend === 'unknown') {
          return this.rememberAvailability({
            available: false,
            reason: BrowserCredentialAvailabilityReason.InsecureStorageBackend,
          });
        }
      }

      const available = this.encryption.isEncryptionAvailable();
      // Electron's synchronous macOS OSCrypt backend caches a failed keychain
      // lookup for the lifetime of the process. A retry needs an app restart.
      this.requiresRestart = this.platform === 'darwin' && !available;
      return this.rememberAvailability(available
        ? { available: true }
        : {
          available: false,
          reason: BrowserCredentialAvailabilityReason.EncryptionUnavailable,
        });
    } catch (error) {
      this.requiresRestart = this.platform === 'darwin';
      this.rememberAvailability({
        available: false,
        reason: BrowserCredentialAvailabilityReason.EncryptionUnavailable,
      });
      throw error;
    }
  }

  list(origin?: string): BrowserCredentialSummary[] {
    this.ensureTable();
    const normalizedOrigin = origin ? normalizeBrowserCredentialOrigin(origin) : undefined;
    const rows = normalizedOrigin
      ? this.db.prepare(`
          SELECT id, origin, username, encrypted_password, created_at, updated_at, last_used_at
          FROM browser_credentials
          WHERE origin = ?
          ORDER BY username COLLATE NOCASE ASC
        `).all(normalizedOrigin) as BrowserCredentialRow[]
      : this.db.prepare(`
          SELECT id, origin, username, encrypted_password, created_at, updated_at, last_used_at
          FROM browser_credentials
          ORDER BY origin COLLATE NOCASE ASC, username COLLATE NOCASE ASC
        `).all() as BrowserCredentialRow[];
    return rows.map(rowToSummary);
  }

  save(request: BrowserCredentialSaveRequest): BrowserCredentialSummary {
    this.ensureTable();
    const origin = normalizeBrowserCredentialOrigin(request.origin);
    const username = normalizeUsername(request.username);
    const password = validatePassword(request.password);
    const encryptedPassword = this.withEncryption(() => this.encryption.encryptString(password));
    const now = Date.now();
    const requestedId = request.id?.trim();

    if (requestedId) {
      const current = this.getRow(requestedId);
      if (!current) throw new Error('The saved browser credential no longer exists.');
      this.db.prepare(`
        UPDATE browser_credentials
        SET origin = ?, username = ?, encrypted_password = ?, updated_at = ?
        WHERE id = ?
      `).run(origin, username, encryptedPassword, now, requestedId);
      return rowToSummary(this.requireRow(requestedId));
    }

    const existing = this.db.prepare(`
      SELECT id, origin, username, encrypted_password, created_at, updated_at, last_used_at
      FROM browser_credentials
      WHERE origin = ? AND username = ? COLLATE NOCASE
    `).get(origin, username) as BrowserCredentialRow | undefined;
    if (existing) {
      this.db.prepare(`
        UPDATE browser_credentials
        SET username = ?, encrypted_password = ?, updated_at = ?
        WHERE id = ?
      `).run(username, encryptedPassword, now, existing.id);
      return rowToSummary(this.requireRow(existing.id));
    }

    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO browser_credentials (
        id, origin, username, encrypted_password, created_at, updated_at, last_used_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(id, origin, username, encryptedPassword, now, now);
    return rowToSummary(this.requireRow(id));
  }

  delete(id: string): boolean {
    this.ensureTable();
    const normalizedId = id.trim();
    if (!normalizedId) return false;
    return this.db.prepare('DELETE FROM browser_credentials WHERE id = ?').run(normalizedId).changes > 0;
  }

  getSecret(id: string, expectedOrigin: string): BrowserCredentialSecret {
    this.ensureTable();
    const row = this.requireRow(id.trim());
    const origin = normalizeBrowserCredentialOrigin(expectedOrigin);
    if (row.origin !== origin) {
      throw new Error('The saved browser credential does not match the current website.');
    }
    return {
      summary: rowToSummary(row),
      password: this.withEncryption(() => this.encryption.decryptString(row.encrypted_password)),
    };
  }

  markUsed(id: string): void {
    this.ensureTable();
    this.db.prepare('UPDATE browser_credentials SET last_used_at = ? WHERE id = ?')
      .run(Date.now(), id.trim());
  }

  private assertAvailable(): void {
    let availability = this.getAvailability();
    if (
      !this.encryptionVerified
      && (availability.available || availability.reason === BrowserCredentialAvailabilityReason.AccessNotRequested)
    ) {
      availability = this.requestAccess();
    }
    if (!availability.available) {
      throw new Error('Secure browser credential storage is unavailable on this device.');
    }
  }

  private rememberAvailability(availability: BrowserCredentialAvailability): BrowserCredentialAvailability {
    this.availability = availability;
    this.encryptionVerified = availability.available;
    this.store?.set(AVAILABILITY_STORE_KEY, availability);
    return this.getAvailability();
  }

  private withEncryption<T>(operation: () => T): T {
    this.assertAvailable();
    try {
      return operation();
    } catch (error) {
      this.rememberAvailability({
        available: false,
        reason: BrowserCredentialAvailabilityReason.EncryptionUnavailable,
      });
      throw error;
    }
  }

  private ensureTable(): void {
    if (this.initialized) return;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS browser_credentials (
        id TEXT PRIMARY KEY,
        origin TEXT NOT NULL,
        username TEXT NOT NULL,
        encrypted_password BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER,
        UNIQUE(origin, username COLLATE NOCASE)
      );
      CREATE INDEX IF NOT EXISTS idx_browser_credentials_origin
        ON browser_credentials(origin);
    `);
    this.initialized = true;
  }

  private getRow(id: string): BrowserCredentialRow | undefined {
    return this.db.prepare(`
      SELECT id, origin, username, encrypted_password, created_at, updated_at, last_used_at
      FROM browser_credentials
      WHERE id = ?
    `).get(id) as BrowserCredentialRow | undefined;
  }

  private requireRow(id: string): BrowserCredentialRow {
    const row = this.getRow(id);
    if (!row) throw new Error('The saved browser credential no longer exists.');
    return row;
  }
}
