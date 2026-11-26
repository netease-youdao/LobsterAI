import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRemoteFileWriter, RemoteLogQueue } from './remoteLogSink';

const turn = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

describe('optional remote diagnostics', () => {
  it('never writes in the business call stack and preserves order', async () => {
    const writes: string[] = [], writer = vi.fn(async (text: string) => { writes.push(text); });
    const queue = new RemoteLogQueue(writer);
    queue.enqueue('info', 'first', {}); queue.enqueue('warn', 'second', {});
    expect(writer).not.toHaveBeenCalled();
    await turn();
    expect(writes.join('')).toMatch(/first.*\n.*second/s);
  });
  it('caps a stalled writer and reserves capacity for desktop execution facts', async () => {
    let finish: (() => void) | undefined;
    const writer = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const queue = new RemoteLogQueue(writer);
    queue.enqueue('info', 'initial', {}); await turn();
    for (let n = 0; n < 2000; n++) queue.enqueue('debug', 'poll', {});
    expect(queue.snapshot().queued).toBe(768);
    for (let n = 0; n < 300; n++) queue.enqueue('info', 'terminal', { event: 'desktop.run.terminal' });
    expect(queue.snapshot().queued).toBe(1024); expect(writer).toHaveBeenCalledTimes(1);
    expect(queue.snapshot().dropped).toBeGreaterThan(0);
    // No real I/O and no timers retain the unresolved fake writer.
    finish?.(); await turn();
  });
  it('contains disk failure, backs off, and reports losses when writing recovers', async () => {
    let now = 0;
    const writer = vi.fn().mockRejectedValueOnce(new Error('ENOSPC private path')).mockResolvedValue(undefined);
    const queue = new RemoteLogQueue(writer, () => now);
    expect(() => queue.enqueue('info', 'saved', {})).not.toThrow(); await turn();
    queue.enqueue('info', 'during backoff', {}); await turn();
    expect(writer).toHaveBeenCalledTimes(1);
    now = 30001; queue.enqueue('info', 'recovered', {}); await turn();
    expect(writer).toHaveBeenCalledTimes(2);
    expect(writer.mock.calls[1][0]).toContain('remote.log.dropped');
    expect(writer.mock.calls[1][0]).not.toContain('ENOSPC');
  });
  it('limits UTF-8 log lines and contains serialization failures', async () => {
    const writer = vi.fn(async (_text: string) => {}), queue = new RemoteLogQueue(writer);
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(() => queue.enqueue('info', 'cycle', cyclic)).not.toThrow();
    queue.enqueue('info', 'large', { value: '中文'.repeat(5000) }); await turn();
    const text = writer.mock.calls[0]?.[0] as unknown as string;
    expect(text).toContain('remote.log.truncated');
    expect(text.split('\n').every(line => Buffer.byteLength(line) < 4096)).toBe(true);
  });
  it('keeps compact batch receipts even when a fast request would not be sampled', async () => {
    const writes: string[] = [], queue = new RemoteLogQueue(async text => { writes.push(text); });
    const fields = { requestId: 'a', operation: 'batch', batchId: 'batch-1', elapsedMs: 50,
      requestStartedAt: '2026-10-08T10:12:56.900Z', transportRequestedAt: '2026-10-08T10:12:56.901Z',
      firstSourceSeq: '29', lastSourceSeq: '35', events: [{ eventId: 'event-1' }] };
    queue.enqueue('debug', '[RemoteSync] Request started', fields);
    queue.enqueue('debug', '[RemoteSync] Request succeeded', fields);
    await turn();
    const lines = writes.join('').trim().split('\n').map(line => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'debug', message: '[RemoteSync] Request succeeded', fields: {
      requestId: fields.requestId, operation: 'batch', batchId: 'batch-1', elapsedMs: 50,
      requestStartedAt: fields.requestStartedAt, transportRequestedAt: fields.transportRequestedAt,
      firstSourceSeq: '29', lastSourceSeq: '35',
    } });
    expect(lines[0].fields).not.toHaveProperty('events');
    expect(fields.events).toHaveLength(1);
  });
  it('preserves slow successful requests without changing ordinary success sampling', async () => {
    const writes: string[] = [], queue = new RemoteLogQueue(async text => { writes.push(text); });
    for (const elapsedMs of [50, 999, 1000, 28000, Number.NaN, Number.POSITIVE_INFINITY]) {
      queue.enqueue('debug', '[RemoteSync] Request succeeded', { requestId: 'a', operation: 'live_projection', elapsedMs });
      queue.enqueue('debug', '[RemoteDiagnostic]', { event: 'remote.request.completed', requestId: 'a', result: 'success', durationMs: elapsedMs });
    }
    // The stable sample bucket for this ID is retained for both start and success.
    queue.enqueue('debug', '[RemoteSync] Request started', { requestId: 'd', operation: 'live_projection' });
    queue.enqueue('debug', '[RemoteSync] Request succeeded', { requestId: 'd', operation: 'live_projection', elapsedMs: 50 });
    await turn();
    const lines = writes.join('').trim().split('\n').map(line => JSON.parse(line));
    expect(lines).toHaveLength(6);
    expect(lines.filter(line => line.fields.requestId === 'a').map(line => line.fields.elapsedMs ?? line.fields.durationMs))
      .toEqual([1000, 1000, 28000, 28000]);
    expect(lines.filter(line => line.fields.requestId === 'd').map(line => line.message))
      .toEqual(['[RemoteSync] Request started', '[RemoteSync] Request succeeded']);
  });
  it('rotates only its own two files and survives restarting with an existing current file', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'lobsterai-remote-log-')); directories.push(directory);
    let writer = createRemoteFileWriter(directory, 64);
    await fs.writeFile(path.join(directory, 'main.log'), 'core log');
    await writer('a'.repeat(40)); await writer('b'.repeat(40));
    writer = createRemoteFileWriter(directory, 64); await writer('c'.repeat(40));
    expect(await fs.readFile(path.join(directory, 'remote.log'), 'utf8')).toBe('c'.repeat(40));
    expect(await fs.readFile(path.join(directory, 'remote.old.log'), 'utf8')).toBe('b'.repeat(40));
    expect(await fs.readFile(path.join(directory, 'main.log'), 'utf8')).toBe('core log');
  });
});
