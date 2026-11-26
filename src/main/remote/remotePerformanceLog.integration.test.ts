import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { expect, it, vi } from 'vitest';

import { createRemoteFileWriter, RemoteLogQueue } from './remoteLogSink';
import { RemotePerformanceEvent as Event, type RemotePerformanceFields, RemotePerformanceOutcome as Outcome,
  RemotePerformanceStage as Stage, RemotePerformanceTracker } from './remotePerformanceLog';

async function drained(queue: RemoteLogQueue): Promise<void> {
  const deadline = performance.now() + 5000;
  while (queue.snapshot().queued || queue.snapshot().writing) {
    if (performance.now() > deadline) throw new Error('REMOTE_PERFORMANCE_LOG_DRAIN_TIMEOUT');
    // Keep the real event loop and asynchronous filesystem writer running; no fake I/O completion.
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

it('persists bounded performance records through the existing asynchronous remote.log export chain', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-performance-log-'));
  const queue = new RemoteLogQueue(createRemoteFileWriter(directory));
  let now = 0;
  const tracker = new RemotePerformanceTracker({ now: () => now,
    enqueue: (level, message, fields) => queue.enqueue(level, message, fields) });
  // Only the observation timer is controlled. setImmediate, the queue and filesystem remain real.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const secret = 'private-conversation-and-token';
  const rawUrl = 'https://private.example/api?credential=private-conversation-and-token';
  try {
    tracker.start();
    const value = { secret, url: rawUrl, body: secret };
    expect(tracker.sync(Stage.RemoteState, () => { now += 125; return value; })).toBe(value);
    const end = tracker.begin(Stage.NetworkRequest); now += 1500;
    end(Outcome.Succeeded, { transportMs: 120, replyDeliveryMs: 1380, bytes: 256,
      url: rawUrl, body: secret, token: secret, requestId: secret } as RemotePerformanceFields);

    const longestStage = Object.values(Stage).reduce((longest, stage) => stage.length > longest.length ? stage : longest);
    for (let index = 0; index < 8; index++) tracker.sync(longestStage, () => { now += 60; });
    const pending = Array.from({ length: 12 }, () => tracker.begin(longestStage));
    now += 1100; pending.forEach(finish => finish());
    // Saturate only bounded diagnostics memory, without blocking the application or performing network work.
    for (let index = 0; index < 80; index++) tracker.begin(longestStage);
    now += 1400; await vi.advanceTimersByTimeAsync(1000);
    tracker.stop(); await drained(queue);

    const text = await fs.readFile(path.join(directory, 'remote.log'), 'utf8');
    const lines = text.trim().split('\n');
    const records = lines.map(line => JSON.parse(line) as { timestamp: string; level: string; message: string; fields: Record<string, unknown> });
    expect(records.length).toBeGreaterThanOrEqual(4);
    expect(records.every(record => record.level === 'debug' && record.message === '[RemotePerformance]')).toBe(true);
    expect(records.every(record => typeof record.timestamp === 'string' && record.fields.pid === process.pid)).toBe(true);
    expect(records.map(record => record.fields)).toContainEqual(expect.objectContaining({ stage: Stage.RemoteState,
      event: Event.Sync, syncMs: 125, outcome: Outcome.Succeeded }));
    expect(records.map(record => record.fields)).toContainEqual(expect.objectContaining({ stage: Stage.NetworkRequest,
      event: Event.Span, elapsedMs: 1500, transportMs: 120, replyDeliveryMs: 1380, bytes: 256 }));
    const lag = records.find(record => record.fields.event === Event.EventLoopLag)!;
    expect(lag.fields).toMatchObject({ lagMs: 3605, activeCount: 64, activeDropped: 16 });
    expect(lag.fields.active).toHaveLength(8); expect(lag.fields.recentSlow).toHaveLength(8);
    expect(Buffer.byteLength(JSON.stringify(lag.fields))).toBeLessThan(3500);
    expect(lines.every(line => Buffer.byteLength(line) < 4096)).toBe(true);
    expect(text).not.toContain('remote.log.truncated'); expect(text).not.toContain('remote.log.dropped');
    expect(text).not.toContain(secret); expect(text).not.toContain(rawUrl);
    for (const record of records) for (const key of ['url', 'body', 'token', 'requestId']) expect(record.fields).not.toHaveProperty(key);
    expect(queue.snapshot()).toEqual({ queued: 0, writing: false, dropped: 0 });
  } finally {
    tracker.stop(); vi.useRealTimers(); await drained(queue);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
