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
 *
 * A lock can also outlive its writer while the recorded PID still looks
 * alive: after an unclean shutdown Windows may hand that PID to a SYSTEM or
 * elevated process that neither LobsterAI nor OpenClaw can inspect, and both
 * then keep treating it as a live gateway. OpenClaw v2026.8.1 writers keep
 * `<lock>.sqlite` in an exclusive SQLite transaction for as long as they own
 * `<lock>`, and the OS drops that file lock when the process exits, so
 * acquiring it proves the writer is gone whoever owns the PID now.
 */

export type GatewayLockPayload = {
  pid: number;
  createdAt?: string;
  configPath?: string;
  stateDir?: string;
  startTime?: number;
  ownerId?: string;
  role?: string;
  port?: number;
};

export const GatewayLockCleanupAction = {
  RemovedUnreadable: 'removed-unreadable',
  RemovedDeadOwner: 'removed-dead-owner',
  RemovedReusedPid: 'removed-reused-pid',
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

/**
 * OpenClaw runtimes verified to hold `<lock>.sqlite` for as long as they own
 * `<lock>`. Upstream main dropped these companions (#157413), so re-check the
 * gateway lock protocol on every OpenClaw upgrade before extending this list.
 */
const LOCK_COORDINATOR_OPENCLAW_VERSIONS: ReadonlySet<string> = new Set(['2026.8.1']);

export function openClawRuntimeHoldsLockCoordinators(version: string | null | undefined): boolean {
  return !!version && LOCK_COORDINATOR_OPENCLAW_VERSIONS.has(version.trim().replace(/^v/, ''));
}

export type GatewayLockCoordinator = { release: () => void };

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
    const fields = parsed as Record<string, unknown>;
    const payload: GatewayLockPayload = { pid };
    for (const key of ['createdAt', 'configPath', 'stateDir', 'ownerId', 'role'] as const) {
      if (typeof fields[key] === 'string') payload[key] = fields[key];
    }
    if (typeof fields.startTime === 'number' && Number.isFinite(fields.startTime)) payload.startTime = fields.startTime;
    if (typeof fields.port === 'number' && Number.isInteger(fields.port) && fields.port > 0 && fields.port <= 65535) payload.port = fields.port;
    return payload;
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
  /**
   * Exclusively acquires a lock's `<lock>.sqlite` companion, or returns null
   * when it is held or missing. Pass it only when the bundled runtime's
   * writers hold that companion (see openClawRuntimeHoldsLockCoordinators);
   * it lets cleanup reclaim locks whose recorded PID was reused.
   */
  tryAcquireLockCoordinator?: (coordinatorPath: string) => GatewayLockCoordinator | null;
};

function removeLockFile(
  lockPath: string,
  action:
    | typeof GatewayLockCleanupAction.RemovedUnreadable
    | typeof GatewayLockCleanupAction.RemovedDeadOwner
    | typeof GatewayLockCleanupAction.RemovedReusedPid,
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
 * Writers publish and keep their payload only while holding the companion
 * coordinator. Holding it ourselves with the payload unchanged proves that
 * writer exited and its recorded PID now belongs to another process.
 */
function reclaimLockOfExitedWriter(
  lockPath: string,
  raw: string | null,
  ownerPid: number,
  tryAcquireLockCoordinator: (coordinatorPath: string) => GatewayLockCoordinator | null,
): GatewayLockCleanupResult | null {
  const coordinator = tryAcquireLockCoordinator(`${lockPath}.sqlite`);
  if (!coordinator) {
    return null;
  }
  try {
    let current: string | null = null;
    try {
      current = fs.readFileSync(lockPath, 'utf8');
    } catch {
      current = null;
    }
    // Only the exact payload observed without the coordinator is proven stale.
    if (current !== raw) {
      return null;
    }
    return removeLockFile(lockPath, GatewayLockCleanupAction.RemovedReusedPid, ownerPid);
  } finally {
    coordinator.release();
  }
}

/**
 * Reclaim stale gateway lock files for our config path.
 *
 * MUST only be called when the caller knows it has no live gateway child of
 * its own (before spawning a gateway, or right after confirming the previous
 * one exited). A lock whose payload is readable and whose owner pid is alive
 * is never touched, unless `tryAcquireLockCoordinator` proves its writer
 * exited and the PID was reused.
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
      // Payloads without ownerId predate v2026.8.1 and its coordinators.
      const reclaimed = options.tryAcquireLockCoordinator && payload.ownerId
        ? reclaimLockOfExitedWriter(lockPath, raw, payload.pid, options.tryAcquireLockCoordinator)
        : null;
      results.push(reclaimed ?? { lockPath, action: GatewayLockCleanupAction.KeptAliveOwner, ownerPid: payload.pid });
      continue;
    }
    results.push(removeLockFile(lockPath, GatewayLockCleanupAction.RemovedDeadOwner, payload.pid));
  }

  return results;
}
