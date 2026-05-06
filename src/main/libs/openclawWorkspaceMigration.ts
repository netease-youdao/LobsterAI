/**
 * One-time migration: move main agent workspace files from the user's
 * configured working directory to the fixed `{STATE_DIR}/workspace-main/`
 * path, so the main agent workspace is decoupled from the working directory.
 *
 * Safe to call multiple times — uses a kv flag for idempotency.
 * Never deletes source files.
 */

import fs from 'fs';
import path from 'path';

import type { SqliteStore } from '../sqliteStore';
import {
  getMainAgentWorkspacePath,
  syncMemoryFileOnWorkspaceChange,
} from './openclawMemoryFile';

const TAG = '[OpenClaw Migration]';
const MIGRATION_KEY = 'migration.mainAgentWorkspace.v1.completed';

const BOOTSTRAP_FILES = ['IDENTITY.md', 'USER.md', 'SOUL.md'];

/**
 * Copy a file from `src` to `dest` only if `src` exists and `dest` is
 * missing or empty.  Returns true if a copy was made.
 */
function copyIfNeeded(src: string, dest: string): boolean {
  try {
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) return false;
    const srcContent = fs.readFileSync(src, 'utf8');
    if (!srcContent.trim()) return false; // nothing worth copying

    // Don't overwrite non-empty destination
    try {
      const destContent = fs.readFileSync(dest, 'utf8');
      if (destContent.trim()) return false;
    } catch {
      // dest doesn't exist — proceed with copy
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, srcContent, 'utf8');
    return true;
  } catch (err) {
    console.warn(`${TAG} copyIfNeeded failed: ${src} → ${dest}:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Recursively copy a directory if the destination does not exist.
 */
function copyDirIfNeeded(src: string, dest: string): boolean {
  try {
    if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) return false;
    if (fs.existsSync(dest)) return false; // don't overwrite existing dir

    fs.cpSync(src, dest, { recursive: true });
    return true;
  } catch (err) {
    console.warn(`${TAG} copyDirIfNeeded failed: ${src} → ${dest}:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Migrate main agent workspace files from the old working directory to
 * `{STATE_DIR}/workspace-main/`.
 */
export function migrateMainAgentWorkspace(
  stateDir: string,
  oldWorkingDirectory: string | undefined,
  store: SqliteStore,
): void {
  // Already completed — skip
  if (store.get<string>(MIGRATION_KEY) === '1') return;

  const oldDir = (oldWorkingDirectory || '').trim();
  const newDir = getMainAgentWorkspacePath(stateDir);

  console.log(`${TAG} Starting main agent workspace migration: ${oldDir || '(empty)'} → ${newDir}`);

  // Ensure destination exists
  fs.mkdirSync(newDir, { recursive: true });

  // Skip if source and destination are the same path
  if (oldDir && path.resolve(oldDir) === path.resolve(newDir)) {
    console.log(`${TAG} Source and destination are identical, marking done`);
    store.set(MIGRATION_KEY, '1');
    return;
  }

  if (!oldDir) {
    console.log(`${TAG} No previous working directory configured, marking done`);
    store.set(MIGRATION_KEY, '1');
    return;
  }

  // 1. Migrate MEMORY.md via merge-dedup
  try {
    const result = syncMemoryFileOnWorkspaceChange(oldDir, newDir);
    console.log(`${TAG} MEMORY.md migration: synced=${result.synced}${result.error ? `, error=${result.error}` : ''}`);
  } catch (err) {
    console.warn(`${TAG} MEMORY.md migration failed:`, err instanceof Error ? err.message : err);
  }

  // 2. Migrate bootstrap files (IDENTITY.md, USER.md, SOUL.md)
  for (const filename of BOOTSTRAP_FILES) {
    const src = path.join(oldDir, filename);
    const dest = path.join(newDir, filename);
    if (copyIfNeeded(src, dest)) {
      console.log(`${TAG} Migrated ${filename}`);
    }
  }

  // 3. Migrate memory/ directory (daily logs)
  const oldMemoryDir = path.join(oldDir, 'memory');
  const newMemoryDir = path.join(newDir, 'memory');
  if (copyDirIfNeeded(oldMemoryDir, newMemoryDir)) {
    console.log(`${TAG} Migrated memory/ directory`);
  }

  // Mark as completed
  store.set(MIGRATION_KEY, '1');
  console.log(`${TAG} Main agent workspace migration completed`);
}
