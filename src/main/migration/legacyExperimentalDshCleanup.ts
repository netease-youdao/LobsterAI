// One-shot, non-blocking cleanup for legacy experimental DSH model configs.
//
// Earlier LobsterAI builds offered an experimental DeepSeek Harness workbench
// under Settings -> Experimental that ran directly against the user's shared
// `~/.dsh` home (falling back to `<userData>/dsh` on writer lock conflict) and
// synced LobsterAI-managed provider routes (`lobsterai-*`) plus an optional
// `agent-default-model` override into:
//   - `$DSH_HOME/profiles/web/cordis.patch.yml` (DSH 0.2 era)
//   - `$DSH_HOME/settings.yaml` (DSH 0.1.x era, which standalone DSH 0.2 could
//     also have auto-imported into any active profile under `$DSH_HOME/profiles/*`)
//   - `$DSH_HOME/.lobsterai-dsh-writer.json` (shared-home writer lock)
//
// LobsterAI v2 runs DSH exclusively in its isolated App-Owned Profile
// (`<userData>/dsh-profile`) and registers models in memory, so those persisted
// `lobsterai-*` routes are permanently dead in standalone DSH. This module
// surgically strips only LobsterAI-owned entries while preserving all user
// routes, `!!js` expressions, non-LobsterAI default models, credentials,
// plugins, and session histories.
//
// No Electron imports; paths and KV access are injected so everything stays
// directly testable under Node Vitest.

import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as os from 'os';
import * as path from 'path';

import { LEGACY_OPENCLAW_BACKUP_DIR_NAME } from '../../shared/dshEngine/hostConstants';
import {
  ExperimentalDshCleanupSkipReason,
  LEGACY_EXPERIMENTAL_DSH_CONFIG_KV_KEY,
  LEGACY_EXPERIMENTAL_DSH_STATE_DIR_NAME,
  MIGRATION_V2_COMPLETED_KV_KEY,
  MIGRATION_V2_EXPERIMENTAL_DSH_CLEANUP_KV_KEY,
} from '../../shared/migration/constants';

export const DSH_MANAGED_PROVIDER_PREFIX = 'lobsterai-';
export const DSH_WRITER_LOCK_FILENAME = '.lobsterai-dsh-writer.json';

const PROFILES_DIR_NAME = 'profiles';
const PROFILE_PATCH_FILENAME = 'cordis.patch.yml';
const PROFILE_LOCK_FILENAME = 'package.json.lock';
const LEGACY_SETTINGS_FILENAME = 'settings.yaml';
const BACKUP_SUBDIR_NAME = 'experimental-dsh-cleanup';

const DEFAULT_LOCK_TIMEOUT_MS = 2_000;
const LOCK_BACKOFF_INITIAL_MS = 20;
const LOCK_BACKOFF_MAX_MS = 200;
const MAX_CLEANUP_ATTEMPTS = 3;

const WINDOWS_TRANSIENT_RENAME_ERRORS: ReadonlySet<string> = new Set(['EACCES', 'EBUSY', 'EPERM']);
const WINDOWS_RENAME_RETRY_INITIAL_MS = 20;
const WINDOWS_RENAME_RETRY_MAX_MS = 200;
const WINDOWS_RENAME_RETRY_LIMIT = 8;

const TRANSIENT_FS_ERROR_CODES: ReadonlySet<string> = new Set([
  'EACCES',
  'EBUSY',
  'EEXIST',
  'EMFILE',
  'ENFILE',
  'EPERM',
]);

interface DshProfileEntry {
  id: string;
  name: string;
}

const PI_AI_ENTRY: DshProfileEntry = {
  id: 'llm-pi-ai',
  name: '@deepseek-ai/dsh-llm-pi-ai',
};
const DEFAULT_MODEL_ENTRY: DshProfileEntry = {
  id: 'agent-default-model',
  name: '@deepseek-ai/dsh-agent-default-model',
};

// Matches cordis-plugin-include's entry-list YAML dialect so user rows carrying
// `!!js` scalar expressions survive a rewrite intact.
const DSH_JS_EXPRESSION = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown) => typeof data === 'string',
  construct: (data: string) => ({ __jsExpr: data }),
  predicate: (data: object) => data instanceof Object && '__jsExpr' in data,
  represent: (data: object) => (data as { __jsExpr: string }).__jsExpr,
});
const PROFILE_PATCH_SCHEMA = yaml.JSON_SCHEMA.extend(DSH_JS_EXPRESSION);

export const ExperimentalDshCleanupStatus = {
  AlreadyCompleted: 'already_completed',
  SkippedFreshInstall: 'skipped_fresh_install',
  Completed: 'completed',
  RetryScheduled: 'retry_scheduled',
  PartialGaveUp: 'partial_gave_up',
} as const;
export type ExperimentalDshCleanupStatus =
  typeof ExperimentalDshCleanupStatus[keyof typeof ExperimentalDshCleanupStatus];

export interface StripDshProfilePatchResult {
  text: string;
  changed: boolean;
  removedRoutes: string[];
  clearedDefaultModel: boolean;
}

export interface StripLegacyDshSettingsResult {
  /** Updated YAML content, or `null` when the entire document became empty and can be deleted. */
  text: string | null;
  changed: boolean;
  removedRoutes: string[];
  clearedDefaultModel: boolean;
}

export interface ExperimentalDshHomeCleanupResult {
  removedRoutes: string[];
  clearedDefaultProfiles: string[];
  cleanedFiles: string[];
  writerLockRemoved: boolean;
  warnings: string[];
  hadTransientFailure: boolean;
  backupCreated: boolean;
}

export interface ExperimentalDshCleanupKvPort {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

export interface CleanupLegacyExperimentalDshOptions {
  userDataDir: string;
  /** Defaults to `path.join(os.homedir(), '.dsh')`. */
  sharedDshHomeDir?: string;
  kv: ExperimentalDshCleanupKvPort;
  now?: () => Date;
  lockTimeoutMs?: number;
  isProcessAlive?: (pid: number) => boolean;
}

export interface CleanupLegacyExperimentalDshResult {
  status: ExperimentalDshCleanupStatus;
  removedRoutes: string[];
  clearedDefaultProfiles: string[];
  cleanedFiles: string[];
  writerLockRemoved: boolean;
  warnings: string[];
  backupDir: string | null;
  attempts?: number;
}

class LockTimeoutError extends Error {
  readonly code = 'ELOCKTIMEOUT';

  constructor(lockPath: string) {
    super(`Timed out acquiring dsh lock at ${lockPath}`);
    this.name = 'LockTimeoutError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isManagedRouteId(routeId: unknown): routeId is string {
  return typeof routeId === 'string' && routeId.startsWith(DSH_MANAGED_PROVIDER_PREFIX);
}

function matchesProfileEntry(row: unknown, entry: DshProfileEntry): row is Record<string, unknown> {
  return (
    isRecord(row)
    && row.id === entry.id
    && !('insert' in row)
    && (row.name === undefined || row.name === entry.name)
  );
}

function hasNonIdentityRowFields(row: Record<string, unknown>): boolean {
  return Object.keys(row).some((key) => key !== 'id' && key !== 'name' && key !== 'config');
}

function extractLeadingCommentHeader(text: string): string {
  return text.match(/^(?:[ \t]*#[^\n]*\n)+/)?.[0] ?? '';
}

/**
 * Pure removal of LobsterAI-managed provider routes (`lobsterai-*`) and any
 * `agent-default-model` pointing at a `lobsterai-*` route from a DSH 0.2
 * profile `cordis.patch.yml`.
 *
 * Preserves all non-LobsterAI rows, user-defined providers, `!!js` expressions,
 * and leading file header comments. Returns `changed: false` when nothing
 * LobsterAI-managed is present so callers avoid rewriting untouched files.
 */
export function stripLobsterAiFromDshProfilePatch(text: string): StripDshProfilePatchResult {
  if (text.trim() === '') {
    return { text, changed: false, removedRoutes: [], clearedDefaultModel: false };
  }

  const parsed: unknown = yaml.load(text, { schema: PROFILE_PATCH_SCHEMA });
  if (parsed === null || parsed === undefined) {
    return { text, changed: false, removedRoutes: [], clearedDefaultModel: false };
  }
  if (!Array.isArray(parsed)) {
    throw new Error('dsh profile patch is not a YAML sequence');
  }

  const removedRoutes: string[] = [];
  let clearedDefaultModel = false;
  const nextRows: unknown[] = [];

  for (const row of parsed) {
    if (matchesProfileEntry(row, PI_AI_ENTRY)) {
      if (isRecord(row.config) && isRecord(row.config.providers)) {
        const remainingProviders: Record<string, unknown> = {};
        let rowRemoved = false;
        for (const [routeId, routeConfig] of Object.entries(row.config.providers)) {
          if (isManagedRouteId(routeId)) {
            removedRoutes.push(routeId);
            rowRemoved = true;
          } else {
            remainingProviders[routeId] = routeConfig;
          }
        }
        if (rowRemoved) {
          const { providers: _droppedProviders, ...configRest } = row.config;
          const nextConfig: Record<string, unknown> = Object.keys(remainingProviders).length > 0
            ? { ...configRest, providers: remainingProviders }
            : configRest;

          if (Object.keys(nextConfig).length > 0) {
            nextRows.push({ ...row, config: nextConfig });
          } else if (hasNonIdentityRowFields(row)) {
            const { config: _droppedConfig, ...rowWithoutConfig } = row;
            nextRows.push(rowWithoutConfig);
          }
          // Otherwise row had only id/name + now-empty config -> drop row.
          continue;
        }
      }
      nextRows.push(row);
      continue;
    }

    if (matchesProfileEntry(row, DEFAULT_MODEL_ENTRY)) {
      if (isRecord(row.config) && isManagedRouteId(row.config.provider)) {
        clearedDefaultModel = true;
        if (hasNonIdentityRowFields(row)) {
          const { config: _droppedConfig, ...rowWithoutConfig } = row;
          nextRows.push(rowWithoutConfig);
        }
        // Dropping the override lets DSH inherit dsh-base's shipped default model.
        continue;
      }
      nextRows.push(row);
      continue;
    }

    nextRows.push(row);
  }

  if (removedRoutes.length === 0 && !clearedDefaultModel) {
    return { text, changed: false, removedRoutes: [], clearedDefaultModel: false };
  }

  const header = extractLeadingCommentHeader(text);
  const body = nextRows.length === 0
    ? '[]\n'
    : yaml.dump(nextRows, { schema: PROFILE_PATCH_SCHEMA, lineWidth: 120, noRefs: true });

  return {
    text: header + body,
    changed: true,
    removedRoutes,
    clearedDefaultModel,
  };
}

/**
 * Pure removal of LobsterAI-managed provider routes (`lobsterai-*`) and any
 * `agent-default-model` pointing at a `lobsterai-*` route from a legacy
 * DSH 0.1.x `$DSH_HOME/settings.yaml`.
 *
 * Returns `text: null` when removing LobsterAI entries leaves the entire YAML
 * map empty so the caller can delete the file cleanly instead of leaving an
 * empty `{}` document behind.
 */
export function stripLobsterAiFromLegacyDshSettings(text: string): StripLegacyDshSettingsResult {
  if (text.trim() === '') {
    return { text, changed: false, removedRoutes: [], clearedDefaultModel: false };
  }

  const parsed: unknown = yaml.load(text);
  if (parsed === null || parsed === undefined) {
    return { text, changed: false, removedRoutes: [], clearedDefaultModel: false };
  }
  if (!isRecord(parsed)) {
    throw new Error('legacy settings root is not a map');
  }

  const doc: Record<string, unknown> = { ...parsed };
  const removedRoutes: string[] = [];
  let clearedDefaultModel = false;

  const piAi = doc[PI_AI_ENTRY.id];
  if (isRecord(piAi) && isRecord(piAi.providers)) {
    const remainingProviders: Record<string, unknown> = {};
    let sectionRemoved = false;
    for (const [routeId, routeConfig] of Object.entries(piAi.providers)) {
      if (isManagedRouteId(routeId)) {
        removedRoutes.push(routeId);
        sectionRemoved = true;
      } else {
        remainingProviders[routeId] = routeConfig;
      }
    }
    if (sectionRemoved) {
      const { providers: _droppedProviders, ...piAiRest } = piAi;
      const nextPiAi: Record<string, unknown> = Object.keys(remainingProviders).length > 0
        ? { ...piAiRest, providers: remainingProviders }
        : piAiRest;

      if (Object.keys(nextPiAi).length > 0) {
        doc[PI_AI_ENTRY.id] = nextPiAi;
      } else {
        delete doc[PI_AI_ENTRY.id];
      }
    }
  }

  const defaultModel = doc[DEFAULT_MODEL_ENTRY.id];
  if (isRecord(defaultModel) && isManagedRouteId(defaultModel.provider)) {
    clearedDefaultModel = true;
    delete doc[DEFAULT_MODEL_ENTRY.id];
  }

  if (removedRoutes.length === 0 && !clearedDefaultModel) {
    return { text, changed: false, removedRoutes: [], clearedDefaultModel: false };
  }

  if (Object.keys(doc).length === 0) {
    return { text: null, changed: true, removedRoutes, clearedDefaultModel };
  }

  const header = extractLeadingCommentHeader(text);
  return {
    text: header + yaml.dump(doc, { lineWidth: 120, noRefs: true }),
    changed: true,
    removedRoutes,
    clearedDefaultModel,
  };
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseLockRecordPid(record: string): number | null {
  if (!/^\d+\r?\n?$/.test(record)) return null;
  const pid = Number(record.trim());
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff) return null;
  return pid;
}

function lockRecordHolderExited(record: string, isAlive: (pid: number) => boolean): boolean {
  const pid = parseLockRecordPid(record);
  if (pid === null || pid === process.pid) return false;
  return !isAlive(pid);
}

async function readLockRecord(lockPath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(lockPath, 'utf8');
  } catch {
    return null;
  }
}

async function isLockContention(error: unknown, lockPath: string): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'EEXIST') return true;
  if (code !== 'EPERM') return false;
  try {
    await fs.promises.lstat(lockPath);
    return true;
  } catch {
    return false;
  }
}

async function takeOverExitedLock(
  lockPath: string,
  isAlive: (pid: number) => boolean,
): Promise<boolean> {
  const record = await readLockRecord(lockPath);
  if (record === null || !lockRecordHolderExited(record, isAlive)) return false;

  const claimPath = `${lockPath}.takeover-${createHash('sha256').update(record).digest('hex').slice(0, 16)}`;
  try {
    await fs.promises.writeFile(claimPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'EEXIST' || code === 'EPERM') return false;
    throw error;
  }

  try {
    if ((await readLockRecord(lockPath)) !== record || !lockRecordHolderExited(record, isAlive)) {
      return false;
    }
    try {
      await fs.promises.rm(lockPath, { force: true });
      return true;
    } catch {
      return false;
    }
  } finally {
    await fs.promises.rm(claimPath, { force: true }).catch((): void => undefined);
  }
}

async function withDshFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: { timeoutMs: number; isProcessAlive: (pid: number) => boolean },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  let backoffMs = LOCK_BACKOFF_INITIAL_MS;

  for (;;) {
    try {
      await fs.promises.writeFile(lockPath, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if (!(await isLockContention(error, lockPath))) {
        throw error;
      }
      if (await takeOverExitedLock(lockPath, options.isProcessAlive)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new LockTimeoutError(lockPath);
      }
      await delay(backoffMs);
      backoffMs = Math.min(backoffMs * 2, LOCK_BACKOFF_MAX_MS);
    }
  }

  try {
    return await operation();
  } finally {
    await fs.promises.rm(lockPath, { force: true }).catch((): void => undefined);
  }
}

async function renameAtomicTemp(tempPath: string, targetPath: string): Promise<void> {
  let waitMs = WINDOWS_RENAME_RETRY_INITIAL_MS;
  for (let retries = 0; ; retries += 1) {
    try {
      await fs.promises.rename(tempPath, targetPath);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code ?? '';
      if (
        process.platform !== 'win32'
        || !WINDOWS_TRANSIENT_RENAME_ERRORS.has(code)
        || retries >= WINDOWS_RENAME_RETRY_LIMIT
      ) {
        throw error;
      }
    }
    await delay(waitMs);
    waitMs = Math.min(waitMs * 2, WINDOWS_RENAME_RETRY_MAX_MS);
  }
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.promises.writeFile(tempPath, content, { flag: 'wx', mode: 0o600 });
    await renameAtomicTemp(tempPath, filePath);
  } catch (error) {
    await fs.promises.rm(tempPath, { force: true }).catch((): void => undefined);
    throw error;
  }
}

async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    throw error;
  }
}

function isTransientFsError(error: unknown): boolean {
  if (error instanceof LockTimeoutError) return true;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' && TRANSIENT_FS_ERROR_CODES.has(code);
}

async function writePreEditBackup(
  backupDir: string | null,
  filename: string,
  originalText: string,
): Promise<boolean> {
  if (!backupDir) return false;
  try {
    await fs.promises.mkdir(backupDir, { recursive: true, mode: 0o700 });
    const safeName = filename.replace(/[^a-zA-Z0-9._-]+/g, '_');
    await fs.promises.writeFile(path.join(backupDir, safeName), originalText, { mode: 0o600 });
    return true;
  } catch (error) {
    console.warn(`[MigrationV2] failed to save pre-cleanup backup ${filename}:`, error);
    return false;
  }
}

/**
 * Surgically strip LobsterAI-managed routes and default-model overrides from a
 * single DSH home directory (e.g., `~/.dsh` or `<userData>/dsh`), preserving
 * the directory itself and all non-LobsterAI user data.
 */
export async function cleanupExperimentalDshHome(options: {
  dshHomeDir: string;
  label: string;
  cleanWriterLock: boolean;
  backupDir?: string | null;
  lockTimeoutMs?: number;
  isProcessAlive?: (pid: number) => boolean;
}): Promise<ExperimentalDshHomeCleanupResult> {
  const {
    dshHomeDir,
    label,
    cleanWriterLock,
    backupDir = null,
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    isProcessAlive = defaultIsProcessAlive,
  } = options;

  const result: ExperimentalDshHomeCleanupResult = {
    removedRoutes: [],
    clearedDefaultProfiles: [],
    cleanedFiles: [],
    writerLockRemoved: false,
    warnings: [],
    hadTransientFailure: false,
    backupCreated: false,
  };

  if (!fs.existsSync(dshHomeDir)) {
    return result;
  }

  // 1. Scan all profile patches under `<dshHomeDir>/profiles/*/cordis.patch.yml`
  //    (covers `web` written by LobsterAI 0.2 AND any other profile standalone
  //    DSH 0.2 might have imported old `settings.yaml` into).
  const profilesDir = path.join(dshHomeDir, PROFILES_DIR_NAME);
  let profileEntries: fs.Dirent[] = [];
  try {
    profileEntries = await fs.promises.readdir(profilesDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      const message = error instanceof Error ? error.message : String(error);
      result.warnings.push(`failed to read ${profilesDir}: ${message}`);
      if (isTransientFsError(error)) result.hadTransientFailure = true;
    }
  }

  for (const entry of profileEntries) {
    // Only visit real subdirectories; never follow symlinks outside profiles/.
    if (!entry.isDirectory()) continue;

    const profileName = entry.name;
    const profileDir = path.join(profilesDir, profileName);
    const patchPath = path.join(profileDir, PROFILE_PATCH_FILENAME);

    let previewText: string | null;
    try {
      previewText = await readTextIfExists(patchPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.warnings.push(`failed to read ${patchPath}: ${message}`);
      if (isTransientFsError(error)) result.hadTransientFailure = true;
      continue;
    }

    // Zero-lock, zero-write fast path when no `lobsterai-` token exists in file.
    if (previewText === null || !previewText.includes(DSH_MANAGED_PROVIDER_PREFIX)) {
      continue;
    }

    const lockPath = path.join(profileDir, PROFILE_LOCK_FILENAME);
    try {
      await withDshFileLock(
        lockPath,
        async () => {
          const currentText = await readTextIfExists(patchPath);
          if (currentText === null || !currentText.includes(DSH_MANAGED_PROVIDER_PREFIX)) {
            return;
          }

          let stripped: StripDshProfilePatchResult;
          try {
            stripped = stripLobsterAiFromDshProfilePatch(currentText);
          } catch (parseError) {
            const message = parseError instanceof Error ? parseError.message : String(parseError);
            result.warnings.push(`skipped unreadable profile patch ${patchPath}: ${message}`);
            return;
          }

          if (!stripped.changed) return;

          if (await writePreEditBackup(backupDir, `${label}-profiles-${profileName}-${PROFILE_PATCH_FILENAME}.orig`, currentText)) {
            result.backupCreated = true;
          }
          await writeFileAtomic(patchPath, stripped.text);

          result.removedRoutes.push(...stripped.removedRoutes);
          if (stripped.clearedDefaultModel) {
            result.clearedDefaultProfiles.push(`${label}/${profileName}`);
          }
          result.cleanedFiles.push(patchPath);
        },
        { timeoutMs: lockTimeoutMs, isProcessAlive },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.warnings.push(`failed to clean ${patchPath}: ${message}`);
      if (isTransientFsError(error)) {
        result.hadTransientFailure = true;
      }
    }
  }

  // 2. Clean legacy pre-0.2 `$DSH_HOME/settings.yaml` if present so standalone
  //    DSH 0.2 never re-imports obsolete `lobsterai-*` routes on its next boot.
  const settingsPath = path.join(dshHomeDir, LEGACY_SETTINGS_FILENAME);
  let settingsPreview: string | null = null;
  try {
    settingsPreview = await readTextIfExists(settingsPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.warnings.push(`failed to read ${settingsPath}: ${message}`);
    if (isTransientFsError(error)) result.hadTransientFailure = true;
  }

  if (settingsPreview !== null && settingsPreview.includes(DSH_MANAGED_PROVIDER_PREFIX)) {
    const lockPath = `${settingsPath}.lock`;
    try {
      await withDshFileLock(
        lockPath,
        async () => {
          const currentText = await readTextIfExists(settingsPath);
          if (currentText === null || !currentText.includes(DSH_MANAGED_PROVIDER_PREFIX)) {
            return;
          }

          let stripped: StripLegacyDshSettingsResult;
          try {
            stripped = stripLobsterAiFromLegacyDshSettings(currentText);
          } catch (parseError) {
            const message = parseError instanceof Error ? parseError.message : String(parseError);
            result.warnings.push(`skipped unreadable legacy settings ${settingsPath}: ${message}`);
            return;
          }

          if (!stripped.changed) return;

          if (await writePreEditBackup(backupDir, `${label}-${LEGACY_SETTINGS_FILENAME}.orig`, currentText)) {
            result.backupCreated = true;
          }

          if (stripped.text === null) {
            await fs.promises.rm(settingsPath, { force: true });
          } else {
            await writeFileAtomic(settingsPath, stripped.text);
          }

          result.removedRoutes.push(...stripped.removedRoutes);
          if (stripped.clearedDefaultModel) {
            result.clearedDefaultProfiles.push(`${label}/settings.yaml`);
          }
          result.cleanedFiles.push(settingsPath);
        },
        { timeoutMs: lockTimeoutMs, isProcessAlive },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.warnings.push(`failed to clean ${settingsPath}: ${message}`);
      if (isTransientFsError(error)) {
        result.hadTransientFailure = true;
      }
    }
  }

  // 3. Remove stale shared-home writer lock if no live process owns it.
  if (cleanWriterLock) {
    const writerLockPath = path.join(dshHomeDir, DSH_WRITER_LOCK_FILENAME);
    try {
      const rawLock = await readTextIfExists(writerLockPath);
      if (rawLock !== null) {
        let holderAlive = false;
        try {
          const parsed = JSON.parse(rawLock) as { pid?: unknown };
          if (
            typeof parsed?.pid === 'number'
            && Number.isInteger(parsed.pid)
            && parsed.pid > 0
            && parsed.pid !== process.pid
          ) {
            holderAlive = isProcessAlive(parsed.pid);
          }
        } catch {
          // Malformed stale lock -> safe to remove.
        }
        if (!holderAlive) {
          await fs.promises.rm(writerLockPath, { force: true });
          result.writerLockRemoved = true;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.warnings.push(`failed to clean writer lock ${writerLockPath}: ${message}`);
      if (isTransientFsError(error)) {
        result.hadTransientFailure = true;
      }
    }
  }

  return result;
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function hasLocalExperimentalDshTraces(
  userDataDir: string,
  hasDshConfigKv: boolean,
): boolean {
  if (hasDshConfigKv) return true;
  for (const name of [
    LEGACY_EXPERIMENTAL_DSH_STATE_DIR_NAME,
    'dsh-runtime',
    'dsh-launcher',
    'dsh-observation',
  ]) {
    if (fs.existsSync(path.join(userDataDir, name))) {
      return true;
    }
  }
  return false;
}

function isPureFreshInstall(
  userDataDir: string,
  kv: ExperimentalDshCleanupKvPort,
): boolean {
  const hasDshConfigKv = kv.get(LEGACY_EXPERIMENTAL_DSH_CONFIG_KV_KEY) !== null;
  if (hasLocalExperimentalDshTraces(userDataDir, hasDshConfigKv)) {
    return false;
  }

  const completedRaw = kv.get(MIGRATION_V2_COMPLETED_KV_KEY);
  if (completedRaw) {
    const parsed = parseJsonObject(completedRaw);
    return parsed?.freshInstall === true;
  }

  // First launch of a brand-new install: sqlite was just initialized after
  // `runPreBootLegacyOpenClawMigration` skipped on missing sqlite file.
  const openclawStateDir = path.join(userDataDir, 'openclaw', 'state');
  const hasOpenClawState = fs.existsSync(openclawStateDir);
  const hasLegacyEngineKv = kv.get('cowork.agent_engine') === 'openclaw';
  return !hasOpenClawState && !hasLegacyEngineKv;
}

function formatBackupTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * Run the one-shot, idempotent async cleanup of legacy experimental DSH model
 * configuration across both `~/.dsh` and `<userData>/dsh` (preserving the
 * directories themselves and all non-LobsterAI user data), and remove the
 * obsolete `dsh_config` KV key from SQLite.
 */
export async function cleanupLegacyExperimentalDsh(
  options: CleanupLegacyExperimentalDshOptions,
): Promise<CleanupLegacyExperimentalDshResult> {
  const {
    userDataDir,
    sharedDshHomeDir = path.join(os.homedir(), '.dsh'),
    kv,
    now = () => new Date(),
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    isProcessAlive = defaultIsProcessAlive,
  } = options;

  const existingState = parseJsonObject(kv.get(MIGRATION_V2_EXPERIMENTAL_DSH_CLEANUP_KV_KEY));
  if (existingState && typeof existingState.completedAt === 'string' && existingState.completedAt.length > 0) {
    return {
      status: ExperimentalDshCleanupStatus.AlreadyCompleted,
      removedRoutes: [],
      clearedDefaultProfiles: [],
      cleanedFiles: [],
      writerLockRemoved: false,
      warnings: [],
      backupDir: null,
    };
  }

  if (isPureFreshInstall(userDataDir, kv)) {
    kv.set(
      MIGRATION_V2_EXPERIMENTAL_DSH_CLEANUP_KV_KEY,
      JSON.stringify({
        completedAt: now().toISOString(),
        skipped: ExperimentalDshCleanupSkipReason.FreshInstall,
      }),
    );
    return {
      status: ExperimentalDshCleanupStatus.SkippedFreshInstall,
      removedRoutes: [],
      clearedDefaultProfiles: [],
      cleanedFiles: [],
      writerLockRemoved: false,
      warnings: [],
      backupDir: null,
    };
  }

  const priorAttempts = typeof existingState?.attempts === 'number' && existingState.attempts > 0
    ? existingState.attempts
    : 0;

  const candidateBackupDir = path.join(
    userDataDir,
    LEGACY_OPENCLAW_BACKUP_DIR_NAME,
    BACKUP_SUBDIR_NAME,
    formatBackupTimestamp(now()),
  );

  const privateDshHomeDir = path.join(userDataDir, LEGACY_EXPERIMENTAL_DSH_STATE_DIR_NAME);
  const homes: Array<{ dir: string; label: string; cleanWriterLock: boolean }> = [
    { dir: sharedDshHomeDir, label: 'shared-dsh', cleanWriterLock: true },
  ];
  if (path.resolve(privateDshHomeDir) !== path.resolve(sharedDshHomeDir)) {
    homes.push({ dir: privateDshHomeDir, label: 'private-dsh', cleanWriterLock: false });
  }

  const removedRoutes: string[] = [];
  const clearedDefaultProfiles: string[] = [];
  const cleanedFiles: string[] = [];
  const warnings: string[] = [];
  let writerLockRemoved = false;
  let hadTransientFailure = false;
  let backupCreated = false;

  for (const home of homes) {
    const homeResult = await cleanupExperimentalDshHome({
      dshHomeDir: home.dir,
      label: home.label,
      cleanWriterLock: home.cleanWriterLock,
      backupDir: candidateBackupDir,
      lockTimeoutMs,
      isProcessAlive,
    });
    removedRoutes.push(...homeResult.removedRoutes);
    clearedDefaultProfiles.push(...homeResult.clearedDefaultProfiles);
    cleanedFiles.push(...homeResult.cleanedFiles);
    warnings.push(...homeResult.warnings);
    if (homeResult.writerLockRemoved) writerLockRemoved = true;
    if (homeResult.hadTransientFailure) hadTransientFailure = true;
    if (homeResult.backupCreated) backupCreated = true;
  }

  const uniqueRemovedRoutes = [...new Set(removedRoutes)];
  const backupDir = backupCreated ? candidateBackupDir : null;

  if (!hadTransientFailure) {
    kv.delete(LEGACY_EXPERIMENTAL_DSH_CONFIG_KV_KEY);
    kv.set(
      MIGRATION_V2_EXPERIMENTAL_DSH_CLEANUP_KV_KEY,
      JSON.stringify({
        completedAt: now().toISOString(),
        removedRoutes: uniqueRemovedRoutes,
        clearedDefaultProfiles,
        cleanedFilesCount: cleanedFiles.length,
        writerLockRemoved,
        ...(backupDir ? { backupDir } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      }),
    );
    return {
      status: ExperimentalDshCleanupStatus.Completed,
      removedRoutes: uniqueRemovedRoutes,
      clearedDefaultProfiles,
      cleanedFiles,
      writerLockRemoved,
      warnings,
      backupDir,
    };
  }

  const nextAttempts = priorAttempts + 1;
  if (nextAttempts >= MAX_CLEANUP_ATTEMPTS) {
    kv.delete(LEGACY_EXPERIMENTAL_DSH_CONFIG_KV_KEY);
    kv.set(
      MIGRATION_V2_EXPERIMENTAL_DSH_CLEANUP_KV_KEY,
      JSON.stringify({
        completedAt: now().toISOString(),
        partial: true,
        attempts: nextAttempts,
        removedRoutes: uniqueRemovedRoutes,
        clearedDefaultProfiles,
        cleanedFilesCount: cleanedFiles.length,
        writerLockRemoved,
        ...(backupDir ? { backupDir } : {}),
        warnings,
      }),
    );
    return {
      status: ExperimentalDshCleanupStatus.PartialGaveUp,
      removedRoutes: uniqueRemovedRoutes,
      clearedDefaultProfiles,
      cleanedFiles,
      writerLockRemoved,
      warnings,
      backupDir,
      attempts: nextAttempts,
    };
  }

  kv.set(
    MIGRATION_V2_EXPERIMENTAL_DSH_CLEANUP_KV_KEY,
    JSON.stringify({
      attempts: nextAttempts,
      lastAttemptAt: now().toISOString(),
      warnings,
    }),
  );
  return {
    status: ExperimentalDshCleanupStatus.RetryScheduled,
    removedRoutes: uniqueRemovedRoutes,
    clearedDefaultProfiles,
    cleanedFiles,
    writerLockRemoved,
    warnings,
    backupDir,
    attempts: nextAttempts,
  };
}
