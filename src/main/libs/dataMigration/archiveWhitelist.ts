import fs from 'fs';
import path from 'path';

import {
  DSH_PROFILE_DIR_NAME,
  DSH_PROFILE_NAME,
  WORKSPACES_DIR_NAME,
} from '../../../shared/dshEngine/hostConstants';
import { OFFICE_EDITORS } from '../../../shared/office/editors';
import { MEMORY_FTS_DB_NAME } from '../../memory/lobsterMemoryService';

export const OFFICE_DRAFT_DIR_NAMES = OFFICE_EDITORS.map(editor => `${editor.id}-drafts`);

export const REWRITABLE_USER_DATA_SUBDIRS = [
  'cowork-image-originals',
  'generated-images',
  'generated-videos',
  WORKSPACES_DIR_NAME,
  'SKILLs',
  'image-editing',
  'browser-annotation-assets',
  'qq-media',
  ...OFFICE_DRAFT_DIR_NAMES,
] as const;

export const MEMORY_FTS_EXCLUDED_RELATIVE_PATHS = [
  `${WORKSPACES_DIR_NAME}/${MEMORY_FTS_DB_NAME}`,
  `${WORKSPACES_DIR_NAME}/${MEMORY_FTS_DB_NAME}-wal`,
  `${WORKSPACES_DIR_NAME}/${MEMORY_FTS_DB_NAME}-shm`,
] as const;

const DSH_PROFILE_SUBDIR = `${DSH_PROFILE_DIR_NAME}/profiles/${DSH_PROFILE_NAME}`;

/**
 * Single Source of Truth for all non-SQLite files and directories inside
 * `userData` that belong to a DSH backup/restore archive.
 *
 * Everything outside this whitelist (Chromium caches, `external-browser/`,
 * `Partitions/`, `openclaw/`, `legacy-openclaw-backup/`, `dsh-profile/logs`,
 * `dsh-profile/bin`, `dsh-profile/cache`, `dsh-profile/dsh-launcher`,
 * `dsh-profile/profiles/lobsterai/node_modules`, thumbnails, update downloads,
 * `runtimes/`, `mcp-packages/`, etc.) is excluded automatically from backups
 * and left untouched on the target machine during restore.
 */
export const WHITELISTED_FILES = [
  `${DSH_PROFILE_DIR_NAME}/cordis.patch.yml`,
  `${DSH_PROFILE_SUBDIR}/package.json`,
  `${DSH_PROFILE_SUBDIR}/pnpm-workspace.yaml`,
  `${DSH_PROFILE_SUBDIR}/pnpm-lock.yaml`,
  `${DSH_PROFILE_SUBDIR}/cordis.patch.yml`,
] as const;

export const WHITELISTED_DIRECTORIES = [
  `${DSH_PROFILE_DIR_NAME}/sessions`,
  `${DSH_PROFILE_DIR_NAME}/credentials`,
  `${DSH_PROFILE_DIR_NAME}/agents-home`,
  WORKSPACES_DIR_NAME,
  'SKILLs',
  'skins',
  'cowork-image-originals',
  'generated-images',
  'generated-videos',
  'image-editing',
  'browser-annotation-assets',
  'qq-media',
  ...OFFICE_DRAFT_DIR_NAMES,
  'auth',
  'codex',
] as const;

export const WHITELIST_MANIFEST_PATHS = [
  ...WHITELISTED_FILES,
  ...WHITELISTED_DIRECTORIES,
] as const;

export const DEFAULT_MAX_ROLLBACK_ARCHIVES = 2;

const WHITELISTED_FILE_SET = new Set<string>(WHITELISTED_FILES);
const MEMORY_FTS_EXCLUDED_SET = new Set<string>(MEMORY_FTS_EXCLUDED_RELATIVE_PATHS);

const toPosixPath = (value: string): string => value.replace(/\\/g, '/');

const normalizeRelativePosix = (relativePosixPath: string): string =>
  toPosixPath(relativePosixPath).replace(/^\/+/, '').replace(/\/+$/, '');

export const isMemoryFtsExcludedRelativePath = (relativePosixPath: string): boolean => {
  const normalized = normalizeRelativePosix(relativePosixPath);
  return MEMORY_FTS_EXCLUDED_SET.has(normalized);
};

/**
 * Returns true if `relativePosixPath` (relative to `userData`) is an exact
 * whitelisted file or resides inside a whitelisted directory (excluding
 * transient FTS5 index sidecars).
 */
export const isWhitelistedMigrationPath = (relativePosixPath: string): boolean => {
  const normalized = normalizeRelativePosix(relativePosixPath);
  if (!normalized) return false;
  if (isMemoryFtsExcludedRelativePath(normalized)) return false;
  if (WHITELISTED_FILE_SET.has(normalized)) return true;
  return WHITELISTED_DIRECTORIES.some(dir => (
    normalized === dir || normalized.startsWith(`${dir}/`)
  ));
};

/**
 * Returns true if `relativePosixPath` is a strict ancestor directory of at
 * least one whitelisted file or directory (used when descending `userData` or
 * validating directory entries in archives).
 */
export const isWhitelistedAncestorDirectory = (relativePosixPath: string): boolean => {
  const normalized = normalizeRelativePosix(relativePosixPath);
  if (!normalized) return true;
  const prefix = `${normalized}/`;
  return WHITELIST_MANIFEST_PATHS.some(entry => entry.startsWith(prefix));
};

export interface CollectedMigrationFile {
  relativePath: string;
  absolutePath: string;
  sizeBytes: number;
}

/**
 * Collects all regular (non-symlink) whitelisted files under `userDataPath`,
 * sorted deterministically by POSIX relative path.
 */
export const collectWhitelistedFilesSync = (
  userDataPath: string,
  options: { prefixFilter?: string } = {},
): CollectedMigrationFile[] => {
  const files: CollectedMigrationFile[] = [];
  const seen = new Set<string>();
  const prefixFilter = options.prefixFilter ? normalizeRelativePosix(options.prefixFilter) : null;

  const matchesPrefix = (relPosix: string): boolean => {
    if (!prefixFilter) return true;
    return relPosix === prefixFilter || relPosix.startsWith(`${prefixFilter}/`);
  };

  const addFileIfValid = (relPosix: string): void => {
    if (!matchesPrefix(relPosix) || seen.has(relPosix)) return;
    if (!isWhitelistedMigrationPath(relPosix)) return;
    const absPath = path.join(userDataPath, ...relPosix.split('/'));
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(absPath);
    } catch {
      return;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) return;
    seen.add(relPosix);
    files.push({
      relativePath: relPosix,
      absolutePath: absPath,
      sizeBytes: stat.size,
    });
  };

  const walkDirectory = (dirRelPosix: string): void => {
    const absDir = path.join(userDataPath, ...dirRelPosix.split('/'));
    let dirStat: fs.Stats;
    try {
      dirStat = fs.lstatSync(absDir);
    } catch {
      return;
    }
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return;

    const visit = (currentAbs: string, currentRel: string): void => {
      let entries: string[];
      try {
        entries = fs.readdirSync(currentAbs);
      } catch {
        return;
      }
      for (const entryName of entries) {
        const childAbs = path.join(currentAbs, entryName);
        const childRel = `${currentRel}/${entryName}`;
        if (!isWhitelistedMigrationPath(childRel)) continue;

        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(childAbs);
        } catch {
          continue;
        }
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          visit(childAbs, childRel);
        } else if (stat.isFile() && matchesPrefix(childRel) && !seen.has(childRel)) {
          seen.add(childRel);
          files.push({
            relativePath: childRel,
            absolutePath: childAbs,
            sizeBytes: stat.size,
          });
        }
      }
    };

    visit(absDir, dirRelPosix);
  };

  for (const relFile of WHITELISTED_FILES) {
    addFileIfValid(relFile);
  }
  for (const relDir of WHITELISTED_DIRECTORIES) {
    if (prefixFilter && !relDir.startsWith(`${prefixFilter}/`) && relDir !== prefixFilter && !prefixFilter.startsWith(`${relDir}/`)) {
      continue;
    }
    walkDirectory(relDir);
  }

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return files;
};

/**
 * Removes only whitelisted files and directories under `userDataPath` (plus
 * transient `workspaces/memory-fts.sqlite*` so stale FTS5 indexes rebuild cleanly
 * after restore), leaving all non-whitelisted directories untouched.
 */
export const clearWhitelistedUserDataSync = (
  userDataPath: string,
  removePathSync: (targetPath: string) => void = (targetPath) => {
    fs.rmSync(targetPath, { recursive: true, force: true });
  },
): void => {
  fs.mkdirSync(userDataPath, { recursive: true });

  for (const relFile of WHITELISTED_FILES) {
    const absPath = path.join(userDataPath, ...relFile.split('/'));
    if (fs.existsSync(absPath)) {
      removePathSync(absPath);
    }
  }

  for (const relDir of WHITELISTED_DIRECTORIES) {
    const absPath = path.join(userDataPath, ...relDir.split('/'));
    if (fs.existsSync(absPath)) {
      removePathSync(absPath);
    }
  }

  for (const relFts of MEMORY_FTS_EXCLUDED_RELATIVE_PATHS) {
    const absPath = path.join(userDataPath, ...relFts.split('/'));
    if (fs.existsSync(absPath)) {
      removePathSync(absPath);
    }
  }
};

/**
 * Copies only whitelisted files from `sourceRoot` into `targetRoot`.
 */
export const copyWhitelistedFilesSync = (
  sourceRoot: string,
  targetRoot: string,
  options: { skipAbsolutePath?: string } = {},
): CollectedMigrationFile[] => {
  const files = collectWhitelistedFilesSync(sourceRoot);
  const resolvedSkip = options.skipAbsolutePath ? path.resolve(options.skipAbsolutePath) : null;
  const copied: CollectedMigrationFile[] = [];

  for (const file of files) {
    if (resolvedSkip && path.resolve(file.absolutePath) === resolvedSkip) continue;
    const targetPath = path.join(targetRoot, ...file.relativePath.split('/'));
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(file.absolutePath, targetPath);
    copied.push(file);
  }

  return copied;
};

const ROLLBACK_ARCHIVE_RE = /^lobsterai-rollback-\d{8}-\d{6}\.tar\.gz$/i;

/**
 * Keeps only the newest `maxKeep` rollback archives under `rollbackRootPath`.
 */
export const pruneOldRollbackArchivesSync = (
  rollbackRootPath: string,
  maxKeep = DEFAULT_MAX_ROLLBACK_ARCHIVES,
): string[] => {
  if (!fs.existsSync(rollbackRootPath)) return [];
  const limit = Math.max(0, Math.floor(maxKeep));
  let entries: string[];
  try {
    entries = fs.readdirSync(rollbackRootPath);
  } catch {
    return [];
  }

  const rollbacks = entries
    .filter(name => ROLLBACK_ARCHIVE_RE.test(name))
    .map(name => {
      const fullPath = path.join(rollbackRootPath, name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(fullPath).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      return { name, fullPath, mtimeMs };
    })
    .sort((left, right) => {
      if (right.mtimeMs !== left.mtimeMs) return right.mtimeMs - left.mtimeMs;
      return right.name.localeCompare(left.name);
    });

  const removed: string[] = [];
  for (const stale of rollbacks.slice(limit)) {
    try {
      fs.rmSync(stale.fullPath, { force: true });
      removed.push(stale.fullPath);
    } catch {
      // Best-effort cleanup of older rollback snapshots.
    }
  }
  return removed;
};
