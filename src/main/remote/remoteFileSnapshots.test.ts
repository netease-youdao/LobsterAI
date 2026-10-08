import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ workers: [] as any[] }));
vi.mock('worker_threads', () => ({ Worker: class extends EventEmitter {
  messages: any[] = [];
  finishTermination: (() => void) | null = null;
  terminate = vi.fn(() => new Promise<number>(resolve => { this.finishTermination = () => { this.emit('exit', 1); resolve(1); }; }));
  constructor() { super(); state.workers.push(this); }
  unref(): void {}
  postMessage(message: unknown): void { this.messages.push(message); }
} }));

beforeEach(() => { vi.resetModules(); vi.useFakeTimers(); state.workers.length = 0; });
afterEach(() => { vi.useRealTimers(); });
const snapshot = { path: '/tmp/test-remote-file', sizeBytes: '1', identity: 'test' };

describe('file snapshot worker scheduling', () => {
  it('removes only its unfinished output after actual worker termination', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-file-cancel-'));
    try {
      const { writeRemoteTemporaryInput } = await import('./remoteFileSnapshots');
      const pending = writeRemoteTemporaryInput(root, { userId: 'owner', scopeKey: 'personal' }, 'eA==', () => {}).catch(error => error);
      const current = state.workers[0], target = current.messages[0].args.target;
      fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'partial');
      const unknown = path.join(path.dirname(target), 'unknown-receipt'); fs.writeFileSync(unknown, 'retained');
      await vi.advanceTimersByTimeAsync(31000);
      expect(current.terminate).toHaveBeenCalledOnce(); expect(fs.existsSync(target)).toBe(true);
      current.finishTermination();
      expect((await pending).message).toBe('FILE_TRANSFER_BUSY');
      expect(fs.existsSync(target)).toBe(false); expect(fs.readFileSync(unknown, 'utf8')).toBe('retained');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('starts the execution watchdog only when a queued task is dispatched and fences termination', async () => {
    const { verifyRemoteFileSnapshot } = await import('./remoteFileSnapshots');
    const first = verifyRemoteFileSnapshot(snapshot, () => true).catch(error => error);
    const second = verifyRemoteFileSnapshot(snapshot, () => true);
    const previous = state.workers[0];
    expect(previous.messages).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(31000);
    expect(previous.terminate).toHaveBeenCalledOnce(); expect(state.workers).toHaveLength(1);
    previous.emit('message', { id: 1, value: 'late' });
    expect(state.workers).toHaveLength(1);
    previous.finishTermination(); await Promise.resolve();
    expect((await first).message).toBe('FILE_TRANSFER_BUSY');
    const replacement = state.workers[1]; expect(replacement.messages).toHaveLength(1);
    previous.emit('message', { id: 2, value: 'wrong-worker' });
    replacement.emit('message', { id: 2, value: 'healthy' });
    expect(await second).toBe('healthy');
  });
  it('cancels a queued context without terminating the unrelated running task', async () => {
    const { verifyRemoteFileSnapshot } = await import('./remoteFileSnapshots');
    const first = verifyRemoteFileSnapshot(snapshot, () => true);
    let allowed = true;
    const second = verifyRemoteFileSnapshot(snapshot, () => allowed).catch(error => error);
    allowed = false; await vi.advanceTimersByTimeAsync(50);
    expect((await second).message).toBe('FILE_TRANSFER_BUSY');
    expect(state.workers[0].terminate).not.toHaveBeenCalled();
    state.workers[0].emit('message', { id: 1, value: 'healthy' });
    expect(await first).toBe('healthy');
  });
});
