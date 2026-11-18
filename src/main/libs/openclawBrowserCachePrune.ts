import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { type DiskCleanupThrottle, isDiskCleanupStopped, UNTHROTTLED_DISK_CLEANUP } from './openclawDiskCleanupThrottle';
import { removeTreeNoFollow } from './removeTreeNoFollow';

/** A managed Chrome user-data dir's caches are reclaimed once they exceed this. */
export const OPENCLAW_BROWSER_CACHE_PRUNE_THRESHOLD_BYTES = 512 * 1024 * 1024;
/** Minimum time between prune passes; measuring walks the cache trees. */
export const OPENCLAW_BROWSER_CACHE_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Rebuilt by Chromium on demand. "Service Worker" (CacheStorage, ScriptCache
// and the registration Database) goes as a unit: dropping scripts alone leaves
// registrations Chromium can only recover by wiping them itself. Cookies,
// Local Storage, IndexedDB and Login Data are never candidates.
const CHROMIUM_PROFILE_CACHE_ENTRIES = ['Cache', 'Code Cache', 'GPUCache', 'Service Worker'];
const CHROMIUM_PROFILE_DIR = /^(?:Default|Profile \d+)$/;
const STAGED_SUFFIX = '.lobsterai-stale-';
const STAGED_ENTRY = /\.lobsterai-stale-[0-9a-f]+$/;

export interface OpenClawBrowserCachePruneOptions {
  thresholdBytes?: number;
  platform?: NodeJS.Platform;
  homeDir?: string;
  isPidAlive?: (pid: number) => boolean;
  throttle?: DiskCleanupThrottle;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function lstatOrNull(target: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function listDirectories(directory: string, pattern: RegExp): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory() && pattern.test(entry.name))
      .map(entry => path.join(directory, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Chromium holds the profile while running: POSIX `SingletonLock` links to
 * `<host>-<pid>`; Windows keeps a delete-on-close `lockfile`. An unreadable
 * lock counts as in use.
 */
async function isChromeProfileInUse(userDataDir: string, options: Required<OpenClawBrowserCachePruneOptions>): Promise<boolean> {
  if (options.platform === 'win32') return Boolean(await lstatOrNull(path.join(userDataDir, 'lockfile')));
  const lockPath = path.join(userDataDir, 'SingletonLock');
  if (!await lstatOrNull(lockPath)) return false;
  try {
    const pid = Number(/-(\d+)$/.exec(await fs.promises.readlink(lockPath))?.[1]);
    return !Number.isInteger(pid) || pid <= 0 || options.isPidAlive(pid);
  } catch {
    return true;
  }
}

/**
 * macOS Chromium keeps HTTP and code caches for a profile under Application
 * Support in the matching ~/Library/Caches path instead of the profile dir.
 */
function resolveCacheMirrorDir(userDataDir: string, options: Required<OpenClawBrowserCachePruneOptions>): string | null {
  if (options.platform !== 'darwin') return null;
  const appSupport = path.join(options.homeDir, 'Library', 'Application Support');
  const relative = path.relative(appSupport, userDataDir);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return path.join(options.homeDir, 'Library', 'Caches', relative);
}

/** Sum file sizes under the targets, stopping once the limit is exceeded. */
async function measureUpTo(targets: string[], limit: number, throttle: DiskCleanupThrottle): Promise<number> {
  let total = 0;
  const pending = [...targets];
  while (pending.length && total <= limit) {
    const target = pending.pop()!;
    const stats = await lstatOrNull(target);
    await throttle.step();
    if (!stats || stats.isSymbolicLink()) continue;
    if (!stats.isDirectory()) {
      total += stats.size;
      continue;
    }
    for (const entry of await fs.promises.readdir(target)) pending.push(path.join(target, entry));
  }
  return total;
}

async function pruneUserDataDir(userDataDir: string, options: Required<OpenClawBrowserCachePruneOptions>): Promise<string[]> {
  if (await isChromeProfileInUse(userDataDir, options)) return [];
  const mirror = resolveCacheMirrorDir(userDataDir, options);
  const profileDirs = [
    ...await listDirectories(userDataDir, CHROMIUM_PROFILE_DIR),
    ...(mirror ? await listDirectories(mirror, CHROMIUM_PROFILE_DIR) : []),
  ];
  // Finish removals a previous run staged but could not complete.
  for (const staged of (await Promise.all(profileDirs.map(dir => listDirectories(dir, STAGED_ENTRY)))).flat()) {
    await removeTreeNoFollow(staged, () => options.throttle.step()).catch((error: unknown) => {
      if (isDiskCleanupStopped(error)) throw error;
      console.warn(`[OpenClaw] could not remove staged browser cache ${staged}:`, error);
    });
  }
  const candidates: string[] = [];
  for (const profileDir of profileDirs) {
    for (const name of CHROMIUM_PROFILE_CACHE_ENTRIES) {
      const candidate = path.join(profileDir, name);
      if ((await lstatOrNull(candidate))?.isDirectory()) candidates.push(candidate);
    }
  }
  if (await measureUpTo(candidates, options.thresholdBytes, options.throttle) <= options.thresholdBytes) return [];
  // Chrome may have started while measuring. Each rename is atomic, so a
  // browser launched after this check sees a cache dir whole or gone, never
  // half-deleted; the slow removal then runs on the staged copies.
  if (await isChromeProfileInUse(userDataDir, options)) return [];
  const staged: Array<{ candidate: string; stagedPath: string }> = [];
  for (const candidate of candidates) {
    const stagedPath = `${candidate}${STAGED_SUFFIX}${crypto.randomBytes(4).toString('hex')}`;
    try {
      await fs.promises.rename(candidate, stagedPath);
      staged.push({ candidate, stagedPath });
    } catch (error) {
      console.warn(`[OpenClaw] could not stage browser cache ${candidate} for removal:`, error);
    }
  }
  const removed: string[] = [];
  for (const { candidate, stagedPath } of staged) {
    try {
      await removeTreeNoFollow(stagedPath, () => options.throttle.step());
      removed.push(candidate);
    } catch (error) {
      if (isDiskCleanupStopped(error)) throw error;
      console.warn(`[OpenClaw] could not remove browser cache ${stagedPath}:`, error);
    }
  }
  return removed;
}

/**
 * Reclaim regenerable caches of OpenClaw-managed Chrome profiles
 * (`<stateDir>/browser/<name>/user-data`) whose total cache size exceeds the
 * threshold, skipping any profile a running Chrome still holds. Best-effort:
 * failures are logged and skipped. With a throttle, a stopped pass throws
 * DiskCleanupStoppedError; staged copies are finished on the next pass.
 * Returns the removed cache directories.
 */
export async function pruneOpenClawBrowserCaches(
  stateDir: string, options: OpenClawBrowserCachePruneOptions = {},
): Promise<string[]> {
  const resolved: Required<OpenClawBrowserCachePruneOptions> = {
    thresholdBytes: options.thresholdBytes ?? OPENCLAW_BROWSER_CACHE_PRUNE_THRESHOLD_BYTES,
    platform: options.platform ?? process.platform,
    homeDir: options.homeDir ?? os.homedir(),
    isPidAlive: options.isPidAlive ?? isPidAlive,
    throttle: options.throttle ?? UNTHROTTLED_DISK_CLEANUP,
  };
  let browserProfiles: string[];
  try {
    browserProfiles = await listDirectories(path.join(stateDir, 'browser'), /^/);
  } catch (error) {
    console.warn('[OpenClaw] could not list managed browser profiles:', error);
    return [];
  }
  const removed: string[] = [];
  for (const browserProfile of browserProfiles) {
    const userDataDir = path.join(browserProfile, 'user-data');
    try {
      removed.push(...await pruneUserDataDir(userDataDir, resolved));
    } catch (error) {
      if (isDiskCleanupStopped(error)) throw error;
      console.warn(`[OpenClaw] could not prune browser caches in ${userDataDir}:`, error);
    }
  }
  return removed;
}
