import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * Stale OpenClaw gateway lock cleanup.
 *
 * OpenClaw's gateway holds a single-instance lock file at
 * `<stateDir>/tmp/openclaw[-<uid>]/gateway.<sha256(configPath)[:8]>.lock` and
 * `gateway.state.lock` (see OpenClaw v2026.8.1 src/infra/gateway-lock.ts).
 * The payload is JSON:
 * `{ pid, createdAt, configPath, startTime? }`.
 *
 * When LobsterAI force-kills the gateway (Windows SIGTERM is
 * TerminateProcess), the kill can land between the lock file's create and
 * payload write, leaving an EMPTY lock file behind. OpenClaw treats an
 * unreadable payload as owner "unknown" and only reclaims it after a 30s
 * mtime staleness window — while its own acquire timeout is 5s — so every
 * respawn within those 30s fails with "gateway already running; lock
 * timeout". LobsterAI is the gateway's only supervisor, so whenever it knows
 * it has no live gateway child it can safely reclaim locks whose owner is
 * dead or whose payload is unreadable.
 */

export type GatewayLockPayload = {
  pid: number;
  createdAt?: string;
  configPath?: string;
};

export const GatewayLockCleanupAction = {
  RemovedUnreadable: 'removed-unreadable',
  RemovedDeadOwner: 'removed-dead-owner',
  KeptAliveOwner: 'kept-alive-owner',
  RemoveFailed: 'remove-failed',
} as const;
export type GatewayLockCleanupAction =
  typeof GatewayLockCleanupAction[keyof typeof GatewayLockCleanupAction];

export type GatewayLockCleanupResult = {
  lockPath: string;
  action: GatewayLockCleanupAction;
  ownerPid?: number;
};

const GATEWAY_LOCK_FILE_RE = /^(?:gateway\.[0-9a-f]{8}\.lock|gateway\.state\.lock)$/;

/** Mirrors OpenClaw v2026.8.1 resolveGatewayLockDir(). */
export function resolveGatewayLockDir(stateDir: string): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const suffix = uid != null ? `openclaw-${uid}` : 'openclaw';
  const resolvedStateDir = path.resolve(stateDir);
  let normalizedStateDir = resolvedStateDir;
  try {
    normalizedStateDir = fs.realpathSync.native(resolvedStateDir);
  } catch {
    // Missing paths have no filesystem identity yet; resolution is the safe fallback.
  }
  return path.join(normalizedStateDir, 'tmp', suffix);
}

/**
 * Mirrors OpenClaw v2026.8.1 config lock hashing: the gateway resolves
 * OPENCLAW_CONFIG_PATH through resolveUserPath() which is path.resolve() for
 * absolute paths, then hashes the resolved string.
 */
export function resolveGatewayLockPathForConfig(
  configPath: string,
  lockDir = resolveGatewayLockDir(path.dirname(path.resolve(configPath.trim()))),
): string {
  const resolved = path.resolve(configPath.trim());
  const hash = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 8);
  return path.join(lockDir, `gateway.${hash}.lock`);
}

function normalizePathForCompare(input: string): string {
  const resolved = path.resolve(input.trim());
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function parseGatewayLockPayload(raw: string): GatewayLockPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const pid = (parsed as { pid?: unknown }).pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      return null;
    }
    const configPath = (parsed as { configPath?: unknown }).configPath;
    return {
      pid,
      ...(typeof configPath === 'string' ? { configPath } : {}),
    };
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we lack permission to signal it.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

type CleanupOptions = {
  configPath: string;
  /** OpenClaw state directory; defaults to the config file's parent directory. */
  stateDir?: string;
  /** Override for tests; defaults to the OpenClaw lock directory. */
  lockDir?: string;
  /** Override for tests. */
  isPidAliveFn?: (pid: number) => boolean;
};

function removeLockFile(
  lockPath: string,
  action: typeof GatewayLockCleanupAction.RemovedUnreadable | typeof GatewayLockCleanupAction.RemovedDeadOwner,
  ownerPid?: number,
): GatewayLockCleanupResult {
  try {
    fs.rmSync(lockPath, { force: true });
    return { lockPath, action, ...(ownerPid != null ? { ownerPid } : {}) };
  } catch {
    return { lockPath, action: GatewayLockCleanupAction.RemoveFailed, ...(ownerPid != null ? { ownerPid } : {}) };
  }
}

/**
 * Reclaim stale gateway lock files for our config path.
 *
 * MUST only be called when the caller knows it has no live gateway child of
 * its own (before spawning a gateway, or right after confirming the previous
 * one exited). A lock whose payload is readable and whose owner pid is alive
 * is never touched.
 *
 * Two matching strategies:
 * - The exact config and state lock paths for our state tree. An unreadable
 *   payload here is reclaimed: only our managed state tree can legitimately
 *   own it, and the caller guarantees no such process is starting right now.
 * - Any other `gateway.*.lock` in the directory whose readable payload points
 *   at our configPath with a dead owner (guards against hash-input drift).
 *   Unreadable payloads under other hashes are left alone — they may belong
 *   to a user-run OpenClaw CLI with a different config.
 */
export function cleanupStaleGatewayLocks(options: CleanupOptions): GatewayLockCleanupResult[] {
  const stateDir = options.stateDir?.trim()
    ? path.resolve(options.stateDir.trim())
    : path.dirname(path.resolve(options.configPath.trim()));
  const lockDir = options.lockDir ?? resolveGatewayLockDir(stateDir);
  const pidAlive = options.isPidAliveFn ?? isPidAlive;
  const results: GatewayLockCleanupResult[] = [];
  const ownLockPaths = new Set([
    resolveGatewayLockPathForConfig(options.configPath, lockDir),
    path.join(lockDir, 'gateway.state.lock'),
  ]);
  const ownConfigKey = normalizePathForCompare(options.configPath);

  let entries: string[];
  try {
    entries = fs.readdirSync(lockDir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (!GATEWAY_LOCK_FILE_RE.test(entry)) {
      continue;
    }
    const lockPath = path.join(lockDir, entry);
    const isOwnLock = ownLockPaths.has(lockPath);

    let raw: string | null = null;
    try {
      raw = fs.readFileSync(lockPath, 'utf8');
    } catch {
      // Unreadable file handle: treat like an unreadable payload below.
      raw = null;
    }
    const payload = raw != null ? parseGatewayLockPayload(raw) : null;

    if (!payload) {
      if (isOwnLock) {
        results.push(removeLockFile(lockPath, GatewayLockCleanupAction.RemovedUnreadable));
      }
      continue;
    }

    const matchesOurConfig = isOwnLock
      || (payload.configPath != null && normalizePathForCompare(payload.configPath) === ownConfigKey);
    if (!matchesOurConfig) {
      continue;
    }

    if (pidAlive(payload.pid)) {
      results.push({ lockPath, action: GatewayLockCleanupAction.KeptAliveOwner, ownerPid: payload.pid });
      continue;
    }
    results.push(removeLockFile(lockPath, GatewayLockCleanupAction.RemovedDeadOwner, payload.pid));
  }

  return results;
}
