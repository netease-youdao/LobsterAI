import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Worker } from 'worker_threads';

import type { RemoteOwner } from '../../shared/remote/constants';
import { RemoteFileReason } from '../../shared/remote/files';
import { RemoteTelemetryEvent as TelemetryEvent } from '../../shared/remote/telemetry';
import { remoteDiagnostics } from './remoteDiagnostics';
import { captureRemoteTelemetry } from './remoteTelemetry';
import { RemoteWorkerFile, remoteWorkerPath } from './remoteWorkerPath';

export const REMOTE_FILE_CACHE_BYTES = 200 * 1024 * 1024;
export interface RemoteFileSnapshot { path: string; sizeBytes: string; sha256?: string; identity: string; cacheIdentity?: string }
export function remoteFileCacheDirectory(root: string, owner: RemoteOwner): string {
  return path.join(root, createHash('sha256').update(owner.userId).digest('hex'), createHash('sha256').update(owner.scopeKey).digest('hex'));
}
const Work = { Capture: 'capture', Verify: 'verify', Input: 'input' } as const;
let worker: Worker | null = null;
let workerTelemetry: ReturnType<typeof captureRemoteTelemetry> | null = null;
let sequence = 0;
let queuedBytes = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void;
  started: number; timer: ReturnType<typeof setTimeout>; guard: ReturnType<typeof setInterval>; bytes: number }>();
function failWorker(current: Worker, reason: string): void {
  if (worker !== current) return;
  workerTelemetry?.emit(TelemetryEvent.WorkerExit, { role: 'file', phase: 'exit', reason, outcome: 'failed' }); workerTelemetry = null;
  worker = null; remoteDiagnostics.record('worker.failed');
  for (const item of pending.values()) { clearTimeout(item.timer); clearInterval(item.guard); item.reject(new Error(RemoteFileReason.Transfer)); }
  pending.clear(); queuedBytes = 0;
  void current.terminate();
}
function getWorker(): Worker {
  if (worker) return worker;
  const telemetry = captureRemoteTelemetry({ role: 'file', worker_instance_id: randomUUID() });
  let current: Worker;
  try { current = new Worker(remoteWorkerPath(RemoteWorkerFile.FileSnapshot)); }
  catch (error) { telemetry.emit(TelemetryEvent.WorkerExit, { phase: 'starting', reason: 'WORKER_SPAWN_ERROR' }); throw error; }
  workerTelemetry = telemetry;
  telemetry.emit(TelemetryEvent.WorkerRestart, { phase: 'starting', reason: 'STATE_CHANGED' });
  current.once('online', () => { if (worker === current) telemetry.emit(TelemetryEvent.WorkerRestart, { phase: 'ready', reason: 'STATE_CHANGED' }); });
  current.unref(); worker = current;
  current.on('message', (reply: { id: number; value?: unknown; error?: string }) => {
    const item = pending.get(reply.id); if (!item) return;
    pending.delete(reply.id); queuedBytes -= item.bytes; clearTimeout(item.timer); clearInterval(item.guard);
    remoteDiagnostics.gauge('files.queue', pending.size); remoteDiagnostics.gauge('files.durationMs', performance.now() - item.started);
    remoteDiagnostics.record(reply.error ? 'files.failed' : 'files.completed');
    if (reply.error) item.reject(new Error(reply.error)); else item.resolve(reply.value);
  });
  current.on('error', () => failWorker(current, 'WORKER_SPAWN_ERROR')); current.on('exit', () => failWorker(current, 'WORKER_EXIT'));
  return current;
}
function run(kind: typeof Work[keyof typeof Work], args: unknown, assertAllowed: () => void, bytes = 0): Promise<unknown> {
  assertAllowed();
  if (pending.size >= 16 || queuedBytes + bytes > 32 * 1024 * 1024) return Promise.reject(new Error(RemoteFileReason.Transfer));
  const current = getWorker(); const cancel = new SharedArrayBuffer(4); const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => failWorker(current, 'WORKER_WATCHDOG'), 30000);
    const guard = setInterval(() => { try { assertAllowed(); } catch { Atomics.store(new Int32Array(cancel), 0, 1); } }, 50);
    pending.set(id, { resolve, reject, started: performance.now(), timer, guard, bytes }); queuedBytes += bytes;
    remoteDiagnostics.gauge('files.queue', pending.size);
    try { current.postMessage({ id, kind, args, cancel }); } catch { failWorker(current, 'WORKER_IPC_FAILURE'); }
  });
}
export async function writeRemoteTemporaryInput(root: string, owner: RemoteOwner, base64: string, assertAllowed: () => void): Promise<string> {
  if (base64.length > 14_000_000) throw new Error(RemoteFileReason.Size);
  const file = await run(Work.Input, { directory: remoteFileCacheDirectory(root, owner), base64 }, assertAllowed, base64.length * 2) as string;
  try { assertAllowed(); return file; } catch (error) { await fs.promises.rm(file, { force: true }); throw error; }
}
/** Copies and hashes on a bounded worker. A mutable source proves a current version, not a past terminal boundary. */
export async function captureRemoteFileSnapshot(source: string, root: string, owner: RemoteOwner, maximumBytes: number,
  assertAllowed: () => void): Promise<RemoteFileSnapshot> {
  const snapshot = await run(Work.Capture, { source, directory: remoteFileCacheDirectory(root, owner), maximumBytes }, assertAllowed) as RemoteFileSnapshot;
  try { assertAllowed(); return snapshot; } catch (error) { await fs.promises.rm(snapshot.path, { force: true }); throw error; }
}
export async function verifyRemoteFileSnapshot(snapshot: RemoteFileSnapshot, current: () => boolean, source?: string): Promise<string> {
  const assert = () => { if (!current()) throw new Error(RemoteFileReason.Access); };
  const digest = await run(Work.Verify, { snapshot, source }, assert) as string;
  assert(); return digest;
}
