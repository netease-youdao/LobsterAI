import { createHash, randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { Worker } from 'worker_threads';

import type { RemoteOwner } from '../../shared/remote/constants';
import { RemoteFileReason } from '../../shared/remote/files';
import { RemoteTelemetryEvent as TelemetryEvent } from '../../shared/remote/telemetry';
import { remoteDiagnostics } from './remoteDiagnostics';
import { RemoteFileRequestError } from './remoteFileRetry';
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
let terminating = false;
let active: number | null = null;
let sequence = 0;
let queuedBytes = 0;
interface FileWork {
  kind: typeof Work[keyof typeof Work]; args: unknown; cancel: SharedArrayBuffer; assertAllowed: () => void; cleanupPath?: string;
  resolve: (value: unknown) => void; reject: (error: Error) => void;
  enqueued: number; started: number | null; timer: ReturnType<typeof setTimeout>; guard: ReturnType<typeof setInterval>; bytes: number;
}
const pending = new Map<number, FileWork>();
const unavailable = (): Error => new RemoteFileRequestError(RemoteFileReason.Transfer);
function settle(id: number, error: Error | null, value?: unknown): void {
  const item = pending.get(id); if (!item) return;
  pending.delete(id); queuedBytes -= item.bytes; clearTimeout(item.timer); clearInterval(item.guard);
  if (active === id) active = null;
  remoteDiagnostics.gauge('files.queue', pending.size);
  if (item.started !== null) remoteDiagnostics.gauge('files.durationMs', performance.now() - item.started);
  remoteDiagnostics.record(error ? 'files.failed' : 'files.completed');
  if (error && item.cleanupPath) {
    // This job has not published a path. On termination this runs only after actual worker exit.
    void fs.promises.rm(item.cleanupPath, { force: true }).catch(() => remoteDiagnostics.record('files.failed')).finally(() => item.reject(error));
  } else if (error) item.reject(error); else item.resolve(value);
}
function exited(current: Worker): void {
  if (worker !== current) return;
  worker = null; terminating = false; workerTelemetry = null;
  if (active !== null) settle(active, unavailable());
  pump();
}
function failWorker(current: Worker, reason: string): void {
  if (worker !== current || terminating) return;
  terminating = true; remoteDiagnostics.record('worker.failed');
  workerTelemetry?.emit(TelemetryEvent.WorkerExit, { role: 'file', phase: 'cancelling', reason, outcome: 'failed' });
  // Keep the worker and its active allocation fenced until actual exit. Unsent jobs retain their own queue budget.
  void current.terminate().then(() => exited(current), () => {
    // A rejected terminate is not proof of exit. The exit listener remains the only release path.
    workerTelemetry?.emit(TelemetryEvent.WorkerExit, { role: 'file', phase: 'cancelling', reason: 'WORKER_TERMINATION_FAILED', outcome: 'failed' });
  });
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
  current.on('message', (reply: { id: number; value?: unknown; error?: string; transient?: boolean }) => {
    if (worker !== current || terminating || active !== reply.id) return;
    const error = reply.error ? reply.transient ? new RemoteFileRequestError(reply.error) : new Error(reply.error) : null;
    settle(reply.id, error, reply.value); pump();
  });
  current.on('error', () => failWorker(current, 'WORKER_SPAWN_ERROR'));
  current.on('exit', () => exited(current));
  return current;
}
function cancel(id: number): void {
  const item = pending.get(id); if (!item) return;
  Atomics.store(new Int32Array(item.cancel), 0, 1);
  if (active !== id) { settle(id, unavailable()); pump(); return; }
  clearInterval(item.guard); clearTimeout(item.timer);
  // Cooperative cancellation is task-local. Terminate only when the running job cannot acknowledge it.
  item.timer = setTimeout(() => { if (worker && active === id) failWorker(worker, 'WORKER_WATCHDOG'); }, 1000);
}
function pump(): void {
  if (terminating || active !== null || !pending.size) return;
  const [id, item] = pending.entries().next().value!;
  try { item.assertAllowed(); }
  catch { settle(id, unavailable()); pump(); return; }
  let current: Worker;
  try { current = getWorker(); }
  catch { settle(id, unavailable()); pump(); return; }
  active = id; item.started = performance.now(); clearTimeout(item.timer);
  remoteDiagnostics.gauge('files.queueWaitMs', item.started - item.enqueued);
  item.timer = setTimeout(() => cancel(id), 30000);
  try { current.postMessage({ id, kind: item.kind, args: item.args, cancel: item.cancel }); }
  catch { failWorker(current, 'WORKER_IPC_FAILURE'); }
}
function run(kind: typeof Work[keyof typeof Work], args: unknown, assertAllowed: () => void, bytes = 0, cleanupPath?: string): Promise<unknown> {
  assertAllowed();
  if (pending.size >= 16 || queuedBytes + bytes > 32 * 1024 * 1024) return Promise.reject(unavailable());
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => cancel(id), 120000);
    const guard = setInterval(() => { try { assertAllowed(); } catch { cancel(id); } }, 50);
    pending.set(id, { kind, args, cancel: new SharedArrayBuffer(4), assertAllowed, resolve, reject, cleanupPath,
      enqueued: performance.now(), started: null, timer, guard, bytes });
    queuedBytes += bytes; remoteDiagnostics.gauge('files.queue', pending.size); pump();
  });
}
export async function writeRemoteTemporaryInput(root: string, owner: RemoteOwner, base64: string, assertAllowed: () => void): Promise<string> {
  if (base64.length > 14_000_000) throw new Error(RemoteFileReason.Size);
  const directory = remoteFileCacheDirectory(root, owner), target = path.join(directory, randomUUID());
  const file = await run(Work.Input, { directory, target, base64 }, assertAllowed, base64.length * 2, target) as string;
  try { assertAllowed(); return file; } catch (error) { await fs.promises.rm(file, { force: true }); throw error; }
}
/** Copies and hashes on a bounded worker. A mutable source proves a current version, not a past terminal boundary. */
export async function captureRemoteFileSnapshot(source: string, root: string, owner: RemoteOwner, maximumBytes: number,
  assertAllowed: () => void): Promise<RemoteFileSnapshot> {
  const directory = remoteFileCacheDirectory(root, owner), target = path.join(directory, randomUUID());
  const snapshot = await run(Work.Capture, { source, directory, target, maximumBytes }, assertAllowed, 0, target) as RemoteFileSnapshot;
  try { assertAllowed(); return snapshot; } catch (error) { await fs.promises.rm(snapshot.path, { force: true }); throw error; }
}
export async function verifyRemoteFileSnapshot(snapshot: RemoteFileSnapshot, current: () => boolean, source?: string): Promise<string> {
  const assert = () => { if (!current()) throw new Error(RemoteFileReason.Access); };
  const digest = await run(Work.Verify, { snapshot, source }, assert) as string;
  assert(); return digest;
}
