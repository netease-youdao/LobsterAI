import * as fs from 'fs';
import * as path from 'path';

import {
  COWORK_TEMP_ATTACHMENTS_DIR_NAME,
  COWORK_TEMP_DIR_NAME,
} from '../../shared/cowork/constants';

/**
 * Manual, user-confirmed cleaner for per-working-directory `.cowork-temp`
 * scratch dirs. There is deliberately NO automatic deletion: the renderer
 * first shows a preview (what would be removed, per directory) and only a
 * user-confirmed clean actually deletes files.
 *
 * Safety model (mirrors Codex's projectless-dir handling):
 * - Only operates on paths strictly inside `<cwd>/.cowork-temp`.
 * - The temp dir must be a real directory (not a symlink); symlinked entries
 *   are never followed nor deleted.
 * - The `attachments/` subtree uses a long retention (originals are
 *   referenced by message re-edit), and the root `.gitignore` marker is
 *   preserved.
 * - Working directories with an active session are never cleaned.
 * - Clean targets are re-derived from the session store and intersected with
 *   the caller's selection, so IPC input cannot name arbitrary paths.
 *
 * This module is Electron-free so the sweep logic stays unit-testable.
 */

/** Attachment originals are kept this long before a clean removes them. */
export const COWORK_TEMP_ATTACHMENTS_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

const SWEEP_MAX_ENTRIES = 20000;
const MAX_SWEEP_DEPTH = 8;
const GITIGNORE_FILE_NAME = '.gitignore';

export interface CoworkTempSweepOptions {
  /** Scratch files with mtime older than now - retentionMs are deleted. 0 deletes all scratch files. */
  retentionMs: number;
  /** Retention for files under the attachments subtree. Defaults to 90 days. */
  attachmentsRetentionMs?: number;
  /** When true, nothing is deleted; deletedFiles/freedBytes report what a real sweep would remove. */
  dryRun?: boolean;
  now?: number;
  maxEntries?: number;
  maxDepth?: number;
}

export interface CoworkTempSweepResult {
  /** Files removed (or, in dryRun, files that would be removed). */
  deletedFiles: number;
  /** Bytes removed (or, in dryRun, bytes that would be removed). */
  freedBytes: number;
  /** All files seen during the walk, including protected/fresh ones. */
  totalFiles: number;
  /** Total bytes seen during the walk. */
  totalBytes: number;
  skippedEntries: number;
  truncated: boolean;
}

export interface CoworkTempUsage {
  bytes: number;
  files: number;
  cleanableBytes: number;
  cleanableFiles: number;
  truncated: boolean;
}

export function getCoworkTempDirPath(cwd: string): string {
  return path.join(cwd, COWORK_TEMP_DIR_NAME);
}

/**
 * Walk up from a path and return the enclosing `.cowork-temp` root, or null
 * when the path is not inside one.
 */
export function findCoworkTempRoot(childPath: string): string | null {
  const resolved = path.resolve(childPath);
  const segments = resolved.split(path.sep);
  const index = segments.lastIndexOf(COWORK_TEMP_DIR_NAME);
  if (index < 0) return null;
  return segments.slice(0, index + 1).join(path.sep) || null;
}

/**
 * Drop a `*` .gitignore marker into the temp dir so model-written scratch
 * files do not pollute `git status` of user project repositories. Idempotent;
 * never overwrites an existing file.
 */
export function ensureCoworkTempGitignore(tempDir: string): void {
  try {
    const gitignorePath = path.join(tempDir, GITIGNORE_FILE_NAME);
    if (fs.existsSync(gitignorePath)) return;
    if (!isRealDirectorySync(tempDir)) return;
    fs.writeFileSync(gitignorePath, '*\n', { flag: 'wx' });
  } catch {
    // Best effort — a read-only or concurrent-created file is fine.
  }
}

function isRealDirectorySync(dirPath: string): boolean {
  try {
    const stat = fs.lstatSync(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function isRealDirectory(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.lstat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

interface WalkState {
  rootPrefix: string;
  now: number;
  retentionMs: number;
  attachmentsRetentionMs: number;
  dryRun: boolean;
  maxEntries: number;
  maxDepth: number;
  visitedEntries: number;
  result: CoworkTempSweepResult;
}

async function sweepDirectory(
  dirPath: string,
  depth: number,
  inAttachments: boolean,
  state: WalkState,
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch {
    state.result.skippedEntries++;
    return;
  }

  for (const entry of entries) {
    if (state.visitedEntries >= state.maxEntries) {
      state.result.truncated = true;
      return;
    }
    state.visitedEntries++;

    const entryPath = path.join(dirPath, entry.name);
    // Belt-and-suspenders containment check against crafted names.
    if (!path.resolve(entryPath).startsWith(state.rootPrefix)) {
      state.result.skippedEntries++;
      continue;
    }
    if (entry.isSymbolicLink()) {
      state.result.skippedEntries++;
      continue;
    }

    if (entry.isDirectory()) {
      if (depth + 1 > state.maxDepth) {
        state.result.skippedEntries++;
        continue;
      }
      const enteringAttachments =
        inAttachments || (depth === 0 && entry.name === COWORK_TEMP_ATTACHMENTS_DIR_NAME);
      await sweepDirectory(entryPath, depth + 1, enteringAttachments, state);
      if (!state.dryRun) {
        try {
          await fs.promises.rmdir(entryPath);
        } catch {
          // Not empty or not removable — keep it.
        }
      }
      continue;
    }

    if (!entry.isFile()) {
      state.result.skippedEntries++;
      continue;
    }

    const isRootGitignore = depth === 0 && entry.name === GITIGNORE_FILE_NAME;

    try {
      const stat = await fs.promises.lstat(entryPath);
      state.result.totalFiles++;
      state.result.totalBytes += stat.size;
      if (isRootGitignore) {
        continue;
      }
      const retentionMs = inAttachments ? state.attachmentsRetentionMs : state.retentionMs;
      if (state.now - stat.mtimeMs < retentionMs) {
        continue;
      }
      if (!state.dryRun) {
        await fs.promises.unlink(entryPath);
      }
      state.result.deletedFiles++;
      state.result.freedBytes += stat.size;
    } catch {
      // Locked (Windows) or otherwise unreadable — skip, retry next sweep.
      state.result.skippedEntries++;
    }
  }
}

/**
 * Sweep one `.cowork-temp` directory. Returns a zero result when the path is
 * missing or not a real directory.
 */
export async function sweepCoworkTempDir(
  tempDir: string,
  options: CoworkTempSweepOptions,
): Promise<CoworkTempSweepResult> {
  const result: CoworkTempSweepResult = {
    deletedFiles: 0,
    freedBytes: 0,
    totalFiles: 0,
    totalBytes: 0,
    skippedEntries: 0,
    truncated: false,
  };

  if (!(await isRealDirectory(tempDir))) {
    return result;
  }

  const state: WalkState = {
    rootPrefix: path.resolve(tempDir) + path.sep,
    now: options.now ?? Date.now(),
    retentionMs: Math.max(0, options.retentionMs),
    attachmentsRetentionMs: Math.max(
      0,
      options.attachmentsRetentionMs ?? COWORK_TEMP_ATTACHMENTS_RETENTION_MS,
    ),
    dryRun: options.dryRun ?? false,
    maxEntries: options.maxEntries ?? SWEEP_MAX_ENTRIES,
    maxDepth: options.maxDepth ?? MAX_SWEEP_DEPTH,
    visitedEntries: 0,
    result,
  };

  await sweepDirectory(tempDir, 0, false, state);
  return result;
}

/**
 * Measure a `.cowork-temp` directory: total size plus what a clean would
 * currently remove (scratch immediately, attachments past their retention).
 * Read-only.
 */
export async function measureCoworkTempDir(
  tempDir: string,
  options: { maxEntries?: number; maxDepth?: number; now?: number } = {},
): Promise<CoworkTempUsage> {
  const result = await sweepCoworkTempDir(tempDir, {
    retentionMs: 0,
    dryRun: true,
    now: options.now,
    maxEntries: options.maxEntries ?? SWEEP_MAX_ENTRIES,
    maxDepth: options.maxDepth,
  });
  return {
    bytes: result.totalBytes,
    files: result.totalFiles,
    cleanableBytes: result.freedBytes,
    cleanableFiles: result.deletedFiles,
    truncated: result.truncated,
  };
}

export interface CoworkTempJanitorDeps {
  /** Distinct session working directories known to the app (all history). */
  listAllCwds(): string[];
  /** Working directories that currently have an active session (never cleaned). */
  listActiveCwds(): string[];
}

/** Per-directory preview entry shown in the confirmation dialog. */
export interface CoworkTempDirPreview {
  cwd: string;
  tempDir: string;
  totalBytes: number;
  totalFiles: number;
  cleanableBytes: number;
  cleanableFiles: number;
  /** Active sessions run here; the directory is excluded from cleaning. */
  isActive: boolean;
  truncated: boolean;
}

export interface CoworkTempPreview {
  dirs: CoworkTempDirPreview[];
  bytes: number;
  files: number;
  cleanableBytes: number;
  cleanableFiles: number;
  truncated: boolean;
}

export interface CoworkTempCleanSummary {
  sweptDirs: number;
  deletedFiles: number;
  freedBytes: number;
  skippedEntries: number;
  truncated: boolean;
}

const normalizeCwdForCompare = (cwd: string): string => {
  const resolved = path.resolve(cwd.trim());
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

export interface CoworkTempJanitor {
  /** Read-only scan of every known `.cowork-temp`, per directory. */
  preview(): Promise<CoworkTempPreview>;
  /**
   * Delete cleanable files in the selected working directories (all known
   * directories when omitted). Selections are validated against the session
   * store; active directories are always skipped.
   */
  clean(selectedCwds?: string[]): Promise<CoworkTempCleanSummary>;
}

export function createCoworkTempJanitor(deps: CoworkTempJanitorDeps): CoworkTempJanitor {
  let running = false;

  const listCandidates = (): Array<{ cwd: string; tempDir: string; isActive: boolean }> => {
    const activeCwds = new Set(deps.listActiveCwds().map(normalizeCwdForCompare));
    const seen = new Set<string>();
    const candidates: Array<{ cwd: string; tempDir: string; isActive: boolean }> = [];
    for (const cwd of deps.listAllCwds()) {
      if (!cwd?.trim()) continue;
      const normalized = normalizeCwdForCompare(cwd);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      const resolvedCwd = path.resolve(cwd.trim());
      candidates.push({
        cwd: resolvedCwd,
        tempDir: getCoworkTempDirPath(resolvedCwd),
        isActive: activeCwds.has(normalized),
      });
    }
    return candidates;
  };

  return {
    async preview(): Promise<CoworkTempPreview> {
      const preview: CoworkTempPreview = {
        dirs: [],
        bytes: 0,
        files: 0,
        cleanableBytes: 0,
        cleanableFiles: 0,
        truncated: false,
      };
      for (const candidate of listCandidates()) {
        if (!(await isRealDirectory(candidate.tempDir))) continue;
        const usage = await measureCoworkTempDir(candidate.tempDir);
        if (usage.files === 0) continue;
        const cleanableBytes = candidate.isActive ? 0 : usage.cleanableBytes;
        const cleanableFiles = candidate.isActive ? 0 : usage.cleanableFiles;
        preview.dirs.push({
          cwd: candidate.cwd,
          tempDir: candidate.tempDir,
          totalBytes: usage.bytes,
          totalFiles: usage.files,
          cleanableBytes,
          cleanableFiles,
          isActive: candidate.isActive,
          truncated: usage.truncated,
        });
        preview.bytes += usage.bytes;
        preview.files += usage.files;
        preview.cleanableBytes += cleanableBytes;
        preview.cleanableFiles += cleanableFiles;
        preview.truncated = preview.truncated || usage.truncated;
      }
      preview.dirs.sort((a, b) => b.cleanableBytes - a.cleanableBytes);
      return preview;
    },

    async clean(selectedCwds?: string[]): Promise<CoworkTempCleanSummary> {
      const summary: CoworkTempCleanSummary = {
        sweptDirs: 0,
        deletedFiles: 0,
        freedBytes: 0,
        skippedEntries: 0,
        truncated: false,
      };
      if (running) return summary;
      running = true;
      try {
        const selection = selectedCwds
          ? new Set(selectedCwds.map(normalizeCwdForCompare))
          : null;
        for (const candidate of listCandidates()) {
          if (candidate.isActive) continue;
          if (selection && !selection.has(normalizeCwdForCompare(candidate.cwd))) continue;
          if (!(await isRealDirectory(candidate.tempDir))) continue;
          ensureCoworkTempGitignore(candidate.tempDir);
          const result = await sweepCoworkTempDir(candidate.tempDir, { retentionMs: 0 });
          summary.sweptDirs++;
          summary.deletedFiles += result.deletedFiles;
          summary.freedBytes += result.freedBytes;
          summary.skippedEntries += result.skippedEntries;
          summary.truncated = summary.truncated || result.truncated;
          if (result.deletedFiles > 0) {
            console.debug(
              `[CoworkTempJanitor] cleaned ${candidate.tempDir}: ${result.deletedFiles} files, ${result.freedBytes} bytes`,
            );
          }
        }
        if (summary.deletedFiles > 0) {
          console.log(
            `[CoworkTempJanitor] manual clean removed ${summary.deletedFiles} files (${summary.freedBytes} bytes) across ${summary.sweptDirs} dirs`,
          );
        }
      } catch (error) {
        console.warn('[CoworkTempJanitor] clean failed:', error);
      } finally {
        running = false;
      }
      return summary;
    },
  };
}
