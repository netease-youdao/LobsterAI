// Single-writer protection for the shared dsh home.
//
// dsh's session persistence documents "one live writer per session": each
// backend keeps its own in-memory seq counter, so a second live process
// reusing a committed seq corrupts the log ("seq gap in committed region").
// Sharing ~/.dsh with a standalone dsh therefore requires that only one of
// them is running at a time.
//
// Two detections, in order of reliability:
//   1. a writer lock we maintain inside the shared home — authoritative for
//      LobsterAI-owned instances, including stale locks from a hard kill;
//   2. an HTTP probe of the standalone's documented default port — best
//      effort, since a standalone on a custom port is undetectable.
// When a foreign writer is found the caller falls back to the isolated home:
// history is not shared for that run, but nothing is corrupted.

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

export const DSH_WRITER_LOCK_FILE = '.lobsterai-dsh-writer.json';
export const DSH_STANDALONE_DEFAULT_PORT = 3080;
const PROBE_TIMEOUT_MS = 1_500;

export interface DshWriterLock {
  pid: number;
  port: number;
  startedAt: string;
}

export const DshSharedHomeDecision = {
  Shared: 'shared',
  IsolatedForeignLock: 'isolated-foreign-lock',
  IsolatedStandaloneRunning: 'isolated-standalone-running',
} as const;
export type DshSharedHomeDecision = typeof DshSharedHomeDecision[keyof typeof DshSharedHomeDecision];

export function parseDshWriterLock(raw: string): DshWriterLock | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0) return null;
    return {
      pid: record.pid,
      port: typeof record.port === 'number' ? record.port : 0,
      startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
    };
  } catch {
    return null;
  }
}

// A lock only blocks sharing when it names a *live, foreign* process. Our own
// pid means a restart inside this app, and a dead pid is a leftover from a
// crash or hard kill.
export function isBlockingWriterLock(
  lock: DshWriterLock | null,
  currentPid: number,
  isAlive: (pid: number) => boolean
): boolean {
  if (!lock) return false;
  if (lock.pid === currentPid) return false;
  return isAlive(lock.pid);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readWriterLock(sharedHome: string): DshWriterLock | null {
  try {
    return parseDshWriterLock(fs.readFileSync(path.join(sharedHome, DSH_WRITER_LOCK_FILE), 'utf8'));
  } catch {
    return null;
  }
}

export function writeWriterLock(sharedHome: string, port: number): void {
  try {
    fs.mkdirSync(sharedHome, { recursive: true, mode: 0o700 });
    const lock: DshWriterLock = { pid: process.pid, port, startedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(sharedHome, DSH_WRITER_LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    console.warn('[DSH] Could not write the shared-home writer lock', error);
  }
}

export function clearWriterLock(sharedHome: string): void {
  const lockPath = path.join(sharedHome, DSH_WRITER_LOCK_FILE);
  const lock = readWriterLock(sharedHome);
  // Never clear a lock another live process owns.
  if (lock && lock.pid !== process.pid && isProcessAlive(lock.pid)) return;
  try {
    fs.rmSync(lockPath, { force: true });
  } catch {
    // Best effort.
  }
}

// Answers "is a dsh web server already serving on this port?" — a standalone
// run of `dsh web` with no --port lands on the documented default.
export function probeStandaloneDsh(port = DSH_STANDALONE_DEFAULT_PORT): Promise<boolean> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ type: 'client-request', rpcId: 'lobsterai-probe', method: 'host.describe', payload: {} });
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/host.describe',
        method: 'POST',
        timeout: PROBE_TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          if (raw.length < 4_096) raw += chunk;
        });
        response.on('end', () => {
          try {
            resolve(JSON.parse(raw)?.result?.ok === true);
          } catch {
            resolve(false);
          }
        });
      }
    );
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
    request.end(body);
  });
}

export interface DshSharedHomeResolution {
  dataHome: string | null;
  decision: DshSharedHomeDecision;
}

// Decides whether this run may write the shared store. Returns the home to
// hand the config renderer (null = keep our isolated home).
export async function resolveSharedDataHome(sharedHome: string): Promise<DshSharedHomeResolution> {
  if (isBlockingWriterLock(readWriterLock(sharedHome), process.pid, isProcessAlive)) {
    return { dataHome: null, decision: DshSharedHomeDecision.IsolatedForeignLock };
  }
  if (await probeStandaloneDsh()) {
    return { dataHome: null, decision: DshSharedHomeDecision.IsolatedStandaloneRunning };
  }
  return { dataHome: sharedHome, decision: DshSharedHomeDecision.Shared };
}
