import fs from 'fs';
import path from 'path';

export const DiagnosticPathKind = {
  File: 'file',
  Directory: 'directory',
  Symlink: 'symlink',
  Other: 'other',
  Missing: 'missing',
  Unreadable: 'unreadable',
} as const;

const MAX_LOCK_PAYLOAD_BYTES = 4_096;

export function inspectOpenClawPath(filePath: string) {
  try {
    const stat = fs.lstatSync(filePath);
    return {
      path: filePath,
      kind: stat.isSymbolicLink() ? DiagnosticPathKind.Symlink
        : stat.isFile() ? DiagnosticPathKind.File
          : stat.isDirectory() ? DiagnosticPathKind.Directory : DiagnosticPathKind.Other,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      changedAt: stat.ctime.toISOString(),
      createdAt: stat.birthtime.toISOString(),
    };
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    return {
      path: filePath,
      kind: errorCode === 'ENOENT' ? DiagnosticPathKind.Missing : DiagnosticPathKind.Unreadable,
      errorCode,
    };
  }
}

function isOwnerAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return null;
  }
}

function readLockOwner(lockPath: string): Record<string, unknown> {
  let fd: number | undefined;
  try {
    // Do not follow lock symlinks or read an unbounded/unrelated file into logs.
    if (!fs.lstatSync(lockPath).isFile() || fs.lstatSync(lockPath).isSymbolicLink()) return {};
    fd = fs.openSync(lockPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_LOCK_PAYLOAD_BYTES) return { payloadReadable: false };
    const buffer = Buffer.alloc(MAX_LOCK_PAYLOAD_BYTES);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const payload = JSON.parse(buffer.toString('utf8', 0, bytes)) as Record<string, unknown> | null;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { payloadReadable: false };
    const pid = payload.pid;
    const validPid = typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
    // Only owner metadata is allowed here: never include raw payload/config,
    // process arguments, credentials, or session contents.
    return {
      payloadReadable: true,
      ...(validPid ? { ownerPid: pid, ownerAlive: isOwnerAlive(pid), ownerIsApp: pid === process.pid } : {}),
      ...(typeof payload.createdAt === 'string' && Number.isFinite(Date.parse(payload.createdAt))
        ? { ownerCreatedAt: new Date(payload.createdAt).toISOString() } : {}),
      ...(typeof payload.startTime === 'number' && Number.isFinite(payload.startTime)
        ? { ownerStartTime: payload.startTime } : {}),
    };
  } catch (error) {
    return { payloadReadable: false, payloadErrorCode: (error as NodeJS.ErrnoException).code };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* Diagnostics must not change the startup result. */ }
    }
  }
}

export function inspectOpenClawConfigLock(configPath: string) {
  const resolvedPath = path.resolve(configPath);
  let normalizedPath = resolvedPath;
  try {
    // Same parent realpath normalization used by @openclaw/fs-safe.
    normalizedPath = path.join(fs.realpathSync.native(path.dirname(resolvedPath)), path.basename(resolvedPath));
  } catch { /* Keep the lexical path when the config directory is unavailable. */ }
  const lockPath = `${normalizedPath}.lock`;
  const lock = inspectOpenClawPath(lockPath);
  return {
    configPath: resolvedPath,
    normalizedConfigPath: normalizedPath,
    appPid: process.pid,
    appParentPid: process.ppid,
    observedAt: new Date().toISOString(),
    config: inspectOpenClawPath(normalizedPath),
    lock: { ...lock, ...(lock.kind === DiagnosticPathKind.File ? readLockOwner(lockPath) : {}) },
    reclaim: inspectOpenClawPath(`${lockPath}.reclaim`),
  };
}

export function logOpenClawConfigLockDiagnostics(
  configPath: string,
  reason: string,
  onlyIfPresent = false,
): void {
  const snapshot = inspectOpenClawConfigLock(configPath);
  if (onlyIfPresent && snapshot.lock.kind === DiagnosticPathKind.Missing
    && snapshot.reclaim.kind === DiagnosticPathKind.Missing) return;
  console.warn(`[OpenClaw] Config lock diagnostics: ${JSON.stringify({ reason, ...snapshot })}`);
}
