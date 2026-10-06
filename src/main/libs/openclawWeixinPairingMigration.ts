import fs from 'fs';
import path from 'path';

import { WeixinPlugin } from '../../shared/im/weixin';

/**
 * Legacy Weixin pairing allowlists.
 *
 * OpenClaw runtimes before v2026.8.1 persisted pairing approvals as
 * `credentials/openclaw-weixin[-<accountId>]-allowFrom.json`. The pinned
 * runtime imports those files into shared SQLite during gateway startup, but
 * it can only attribute an account-scoped file when the channel config
 * declares that account. LobsterAI never writes `accounts` for Weixin, so the
 * runtime reports the file as unresolved, and any migration warning makes it
 * refuse to report the gateway ready. Doctor leaves the file in place too, so
 * the refusal repeats on every restart and Quick Repair.
 *
 * The bundled Weixin plugin only reads such a file for `pairing` policy
 * authorization; it also honors the channel config's allowFrom entries. Merge
 * the approved ids into the LobsterAI Weixin config, then move the file out
 * of `credentials/` into a startup recovery backup so the runtime no longer
 * sees it. Bytes are preserved verbatim; nothing is deleted.
 */

const CREDENTIALS_DIR = 'credentials';
const STARTUP_RECOVERY_BACKUPS_DIR = 'startup-recovery-backups';
const BACKUP_KIND = 'weixin-allowfrom';
const ALLOW_FROM_SUFFIX = '-allowFrom.json';
const CHANNEL_ALLOW_FROM_FILE = `${WeixinPlugin.Id}${ALLOW_FROM_SUFFIX}`;
const ACCOUNT_ALLOW_FROM_PREFIX = `${WeixinPlugin.Id}-`;
/** A policy marker, not a sender id; LobsterAI derives it from dmPolicy. */
const ALLOW_ALL = '*';

export const WeixinPairingMigrationStatus = {
  Skipped: 'skipped',
  Migrated: 'migrated',
  Failed: 'failed',
} as const;
export type WeixinPairingMigrationStatus =
  typeof WeixinPairingMigrationStatus[keyof typeof WeixinPairingMigrationStatus];

export interface WeixinAllowFromStore {
  getWeixinConfig(): { allowFrom: string[] };
  setWeixinConfig(config: { allowFrom: string[] }): void;
}

export interface WeixinPairingMigrationFile {
  source: string;
  /** `null` for the channel-level `openclaw-weixin-allowFrom.json`. */
  accountKey: string | null;
  /** Sender ids the file approved, normalized and deduplicated. */
  entries: string[];
  backupPath?: string;
  error?: string;
}

export interface WeixinPairingMigrationResult {
  status: WeixinPairingMigrationStatus;
  files: WeixinPairingMigrationFile[];
  /** Ids appended to the Weixin channel allowFrom config by this run. */
  addedEntries: string[];
  backupDir?: string;
  error?: string;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseLegacyFilename(filename: string): { accountKey: string | null } | null {
  if (filename === CHANNEL_ALLOW_FROM_FILE) return { accountKey: null };
  if (!filename.startsWith(ACCOUNT_ALLOW_FROM_PREFIX) || !filename.endsWith(ALLOW_FROM_SUFFIX)) return null;
  const accountKey = filename.slice(ACCOUNT_ALLOW_FROM_PREFIX.length, -ALLOW_FROM_SUFFIX.length);
  return accountKey ? { accountKey } : null;
}

function listLegacyWeixinAllowFromFiles(stateDir: string): Array<{ source: string; accountKey: string | null }> {
  const dir = path.join(stateDir, CREDENTIALS_DIR);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter(entry => entry.isFile())
    .map(entry => ({ name: entry.name, parsed: parseLegacyFilename(entry.name) }))
    .filter((entry): entry is { name: string; parsed: { accountKey: string | null } } => entry.parsed !== null)
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, parsed }) => ({ source: path.join(dir, name), accountKey: parsed.accountKey }));
}

function readLegacyAllowFromEntries(source: string): { entries: string[] } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(source, 'utf8'));
  } catch (error) {
    return { error: `unreadable legacy allowFrom file: ${describeError(error)}` };
  }
  const values = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { allowFrom?: unknown }).allowFrom)
      ? (parsed as { allowFrom: unknown[] }).allowFrom
      : null;
  if (!values) return { error: 'legacy allowFrom file has no allowFrom list' };
  const entries: string[] = [];
  for (const value of values) {
    const id = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
    if (!id || id === ALLOW_ALL || entries.includes(id)) continue;
    entries.push(id);
  }
  return { entries };
}

function createBackupDir(stateDir: string, now: Date): string {
  const root = path.join(stateDir, STARTUP_RECOVERY_BACKUPS_DIR, BACKUP_KIND);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(root, `${now.toISOString().replace(/[:.]/g, '-')}-`));
}

/**
 * Fold every legacy Weixin allowFrom file into the channel config, then
 * archive it. The config is persisted before any file moves, so a failed
 * archive can be retried without losing approvals; a failed config write
 * leaves every file in place.
 */
export function migrateLegacyWeixinAllowFrom(params: {
  stateDir: string;
  getStore: () => WeixinAllowFromStore;
  now?: () => Date;
}): WeixinPairingMigrationResult {
  const files = listLegacyWeixinAllowFromFiles(params.stateDir).map((file): WeixinPairingMigrationFile => {
    const read = readLegacyAllowFromEntries(file.source);
    return 'entries' in read
      ? { ...file, entries: read.entries }
      : { ...file, entries: [], error: read.error };
  });
  if (files.length === 0) return { status: WeixinPairingMigrationStatus.Skipped, files, addedEntries: [] };

  const store = params.getStore();
  const current = store.getWeixinConfig().allowFrom;
  const configured = Array.isArray(current) ? current.filter((id): id is string => typeof id === 'string') : [];
  const known = new Set(configured.map(id => id.trim()));
  const addedEntries: string[] = [];
  for (const file of files) {
    for (const id of file.entries) {
      if (known.has(id)) continue;
      known.add(id);
      addedEntries.push(id);
    }
  }
  if (addedEntries.length > 0) {
    try {
      store.setWeixinConfig({ allowFrom: [...configured, ...addedEntries] });
    } catch (error) {
      return {
        status: WeixinPairingMigrationStatus.Failed, files, addedEntries: [],
        error: `Weixin config update failed: ${describeError(error)}`,
      };
    }
  }

  let backupDir: string | undefined;
  let archiveFailed = false;
  for (const file of files) {
    try {
      backupDir ??= createBackupDir(params.stateDir, params.now?.() ?? new Date());
      const backupPath = path.join(backupDir, path.basename(file.source));
      fs.renameSync(file.source, backupPath);
      file.backupPath = backupPath;
    } catch (error) {
      archiveFailed = true;
      file.error = [file.error, `archive failed: ${describeError(error)}`].filter(Boolean).join('; ');
    }
  }
  return {
    status: archiveFailed ? WeixinPairingMigrationStatus.Failed : WeixinPairingMigrationStatus.Migrated,
    files,
    addedEntries,
    ...(backupDir ? { backupDir } : {}),
    ...(archiveFailed ? { error: 'Some legacy Weixin allowFrom files could not be archived.' } : {}),
  };
}

/** Config-sync entry point: never throws, logs counts rather than sender ids. */
export function runLegacyWeixinAllowFromMigration(params: {
  stateDir: string;
  getStore: () => WeixinAllowFromStore;
}): WeixinPairingMigrationResult {
  let result: WeixinPairingMigrationResult;
  try {
    result = migrateLegacyWeixinAllowFrom(params);
  } catch (error) {
    console.error('[OpenClaw] Legacy Weixin allowFrom migration failed:', error);
    return { status: WeixinPairingMigrationStatus.Failed, files: [], addedEntries: [], error: describeError(error) };
  }
  if (result.status === WeixinPairingMigrationStatus.Skipped) return result;
  for (const file of result.files) {
    if (file.error) console.warn(`[OpenClaw] Legacy Weixin allowFrom file ${file.source}: ${file.error}`);
  }
  const summary = { files: result.files.length, added: result.addedEntries.length, backupDir: result.backupDir };
  if (result.status === WeixinPairingMigrationStatus.Failed) {
    console.error('[OpenClaw] Legacy Weixin allowFrom migration incomplete:', summary, new Error(result.error));
  } else {
    console.log('[OpenClaw] Migrated legacy Weixin allowFrom file(s) into the channel config:', summary);
  }
  return result;
}
