import fs from 'fs';
import path from 'path';

/**
 * Orphaned OpenClaw config lock cleanup.
 *
 * OpenClaw serializes every openclaw.json write (config.set / config.apply,
 * doctor, plugin installs) with an @openclaw/fs-safe sidecar lock at
 * `<realpath(config dir)>/openclaw.json.lock`. fs-safe creates that file with
 * O_EXCL and writes its `{ pid, createdAt }` payload afterwards, so a writer
 * terminated in between (Windows TerminateProcess, a crash, power loss) leaves
 * an EMPTY lock behind. OpenClaw v2026.8.1 never reclaims a lock without a pid
 * or createdAt (src/infra/stale-lock-file.ts), so every later config write
 * waits out its ~19.5s retry budget and fails with file_lock_timeout, across
 * gateway restarts, until the file is removed. The reclaim guard
 * (`<lock>.reclaim`, a directory) blocks every acquirer the same way when its
 * owner dies while removing a stale lock.
 *
 * A live writer publishes its payload right after creating the lock and holds
 * the guard only while unlinking a stale lock, so an empty lock or a guard
 * older than the grace window is orphaned whichever processes are running.
 * Removal follows fs-safe's own protocol: hold the guard, recheck the lock's
 * identity, then unlink. A lock whose recorded owner is alive is never touched.
 */

/** Matches OpenClaw's config mutation staleness window (src/config/mutate.ts). */
export const CONFIG_LOCK_ORPHAN_GRACE_MS = 30_000;
const MAX_LOCK_PAYLOAD_BYTES = 4_096;

export const ConfigLockCleanupAction = {
  RemovedUnreadable: 'removed-unreadable',
  RemovedDeadOwner: 'removed-dead-owner',
  RemovedReclaimGuard: 'removed-reclaim-guard',
  KeptAliveOwner: 'kept-alive-owner',
  KeptRecent: 'kept-recent',
  KeptUnreadable: 'kept-unreadable',
  RemoveFailed: 'remove-failed',
} as const;
export type ConfigLockCleanupAction =
  typeof ConfigLockCleanupAction[keyof typeof ConfigLockCleanupAction];

export type ConfigLockCleanupResult = {
  path: string;
  action: ConfigLockCleanupAction;
  ownerPid?: number;
  ageMs?: number;
};

const REMOVED_ACTIONS: ReadonlySet<ConfigLockCleanupAction> = new Set([
  ConfigLockCleanupAction.RemovedUnreadable,
  ConfigLockCleanupAction.RemovedDeadOwner,
  ConfigLockCleanupAction.RemovedReclaimGuard,
]);

export function isConfigLockRemoval(result: ConfigLockCleanupResult): boolean {
  return REMOVED_ACTIONS.has(result.action);
}

/** Mirrors @openclaw/fs-safe: the lock sits beside the realpath of the config directory. */
export function normalizeOpenClawConfigPath(configPath: string): string {
  const resolvedPath = path.resolve(configPath);
  try {
    return path.join(fs.realpathSync.native(path.dirname(resolvedPath)), path.basename(resolvedPath));
  } catch {
    // Keep the lexical path when the config directory is unavailable.
    return resolvedPath;
  }
}

export function resolveOpenClawConfigLockPath(configPath: string): string {
  return `${normalizeOpenClawConfigPath(configPath)}.lock`;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves the owner is gone; anything else keeps the lock.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function lstatOrNull(filePath: string): fs.BigIntStats | null {
  try {
    return fs.lstatSync(filePath, { bigint: true });
  } catch {
    return null;
  }
}

const sameFile = (left: fs.BigIntStats, right: fs.BigIntStats): boolean =>
  left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs;

const OwnerKind = { Pid: 'pid', Missing: 'missing', Unknown: 'unknown' } as const;
type LockOwner =
  | { kind: typeof OwnerKind.Pid; pid: number }
  | { kind: typeof OwnerKind.Missing }
  | { kind: typeof OwnerKind.Unknown };

/** Missing means the file was read and holds no owner; Unknown means it could not be read. */
function readLockOwner(lockPath: string): LockOwner {
  let fd: number | undefined;
  let text: string;
  try {
    fd = fs.openSync(lockPath, fs.constants.O_RDONLY);
    const buffer = Buffer.alloc(MAX_LOCK_PAYLOAD_BYTES + 1);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes > MAX_LOCK_PAYLOAD_BYTES) return { kind: OwnerKind.Unknown };
    text = buffer.toString('utf8', 0, bytes);
  } catch {
    return { kind: OwnerKind.Unknown };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* The decision does not depend on close. */ }
    }
  }
  try {
    const payload: unknown = JSON.parse(text);
    const pid = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as { pid?: unknown }).pid
      : undefined;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0
      ? { kind: OwnerKind.Pid, pid }
      : { kind: OwnerKind.Missing };
  } catch {
    return { kind: OwnerKind.Missing };
  }
}

const RemovalOutcome = { Removed: 'removed', Busy: 'busy', Changed: 'changed', Failed: 'failed' } as const;
type RemovalOutcome = typeof RemovalOutcome[keyof typeof RemovalOutcome];

/**
 * fs-safe acquirers wait while `<lock>.reclaim` exists, so holding it keeps
 * the observed lock from being replaced between the identity check and unlink.
 */
function removeLockUnderReclaimGuard(
  lockPath: string,
  observed: fs.BigIntStats,
  nowMs: number,
  graceMs: number,
): RemovalOutcome {
  const guardPath = `${lockPath}.reclaim`;
  try {
    fs.mkdirSync(guardPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return RemovalOutcome.Failed;
    const guard = lstatOrNull(guardPath);
    if (!guard?.isDirectory() || nowMs - Number(guard.mtimeMs) < graceMs) return RemovalOutcome.Busy;
    // An orphaned guard: adopt it, then release it below like our own.
  }
  try {
    const current = lstatOrNull(lockPath);
    if (!current?.isFile() || !sameFile(current, observed)) return RemovalOutcome.Changed;
    fs.unlinkSync(lockPath);
    return RemovalOutcome.Removed;
  } catch {
    return RemovalOutcome.Failed;
  } finally {
    try { fs.rmdirSync(guardPath); } catch { /* A leftover guard is retried on the next cleanup. */ }
  }
}

export type ConfigLockCleanupOptions = {
  configPath: string;
  graceMs?: number;
  now?: () => number;
  /** Override for tests. */
  isPidAliveFn?: (pid: number) => boolean;
};

/**
 * Remove an orphaned openclaw.json lock and reclaim guard. Safe to call while
 * a gateway runs: a lock with a live owner, a lock that is still young, and a
 * lock that could not be read are all kept.
 */
export function cleanupStaleOpenClawConfigLock(options: ConfigLockCleanupOptions): ConfigLockCleanupResult[] {
  const graceMs = options.graceMs ?? CONFIG_LOCK_ORPHAN_GRACE_MS;
  const nowMs = (options.now ?? Date.now)();
  const pidAlive = options.isPidAliveFn ?? isPidAlive;
  const lockPath = resolveOpenClawConfigLockPath(options.configPath);
  const results: ConfigLockCleanupResult[] = [];

  const lock = lstatOrNull(lockPath);
  if (lock?.isFile()) {
    const ageMs = Math.max(0, nowMs - Number(lock.mtimeMs));
    const owner = readLockOwner(lockPath);
    let removedAction: ConfigLockCleanupAction | null = null;
    if (owner.kind === OwnerKind.Pid) {
      if (pidAlive(owner.pid)) {
        results.push({ path: lockPath, action: ConfigLockCleanupAction.KeptAliveOwner, ownerPid: owner.pid, ageMs });
      } else {
        removedAction = ConfigLockCleanupAction.RemovedDeadOwner;
      }
    } else if (owner.kind === OwnerKind.Unknown) {
      results.push({ path: lockPath, action: ConfigLockCleanupAction.KeptUnreadable, ageMs });
    } else if (ageMs < graceMs) {
      // The writer may still be between creating the lock and writing its payload.
      results.push({ path: lockPath, action: ConfigLockCleanupAction.KeptRecent, ageMs });
    } else {
      removedAction = ConfigLockCleanupAction.RemovedUnreadable;
    }
    if (removedAction) {
      const ownerPid = owner.kind === OwnerKind.Pid ? owner.pid : undefined;
      const outcome = removeLockUnderReclaimGuard(lockPath, lock, nowMs, graceMs);
      if (outcome === RemovalOutcome.Removed) {
        results.push({ path: lockPath, action: removedAction, ageMs, ...(ownerPid ? { ownerPid } : {}) });
      } else if (outcome === RemovalOutcome.Failed) {
        results.push({ path: lockPath, action: ConfigLockCleanupAction.RemoveFailed, ageMs, ...(ownerPid ? { ownerPid } : {}) });
      }
      // Busy and Changed mean another process is handling this lock right now.
    }
  }

  const guardPath = `${lockPath}.reclaim`;
  const guard = lstatOrNull(guardPath);
  if (guard?.isDirectory()) {
    const ageMs = Math.max(0, nowMs - Number(guard.mtimeMs));
    if (ageMs >= graceMs) {
      try {
        fs.rmdirSync(guardPath);
        results.push({ path: guardPath, action: ConfigLockCleanupAction.RemovedReclaimGuard, ageMs });
      } catch {
        results.push({ path: guardPath, action: ConfigLockCleanupAction.RemoveFailed, ageMs });
      }
    }
  }

  return results;
}
