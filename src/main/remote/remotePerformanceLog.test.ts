import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { enqueueRemoteLog } from './remoteLogSink';
import { RemotePerformanceEvent as Event, type RemotePerformanceFields, RemotePerformanceOutcome as Outcome,
  RemotePerformanceReason as Reason, RemotePerformanceStage as Stage, RemotePerformanceTracker } from './remotePerformanceLog';

vi.mock('./remoteLogSink', () => ({ enqueueRemoteLog: vi.fn() }));
const trackers: RemotePerformanceTracker[] = [];
function fixture() {
  let now = 0;
  const enqueue = vi.fn<typeof enqueueRemoteLog>();
  const tracker = new RemotePerformanceTracker({ now: () => now, enqueue }); trackers.push(tracker);
  return { tracker, enqueue, advance: (ms: number) => { now += ms; },
    logs: (): Array<Record<string, unknown>> => enqueue.mock.calls.map(([level, message, fields]) => ({ level, message, ...fields })) };
}
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { trackers.splice(0).forEach(tracker => tracker.stop()); vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('bounded remote performance diagnostics', () => {
  it('records only slow or failed real synchronous sections and preserves exact business values', () => {
    const f = fixture(), value = { unchanged: true };
    expect(f.tracker.sync(Stage.RemoteState, () => { f.advance(49); return value; })).toBe(value);
    expect(f.logs()).toHaveLength(0);
    expect(f.tracker.sync(Stage.RemoteState, () => { f.advance(50); return value; })).toBe(value);
    expect(f.logs()).toEqual([expect.objectContaining({ level: 'debug', message: '[RemotePerformance]', stage: Stage.RemoteState,
      event: Event.Sync, syncMs: 50, outcome: Outcome.Succeeded, pid: process.pid, spanId: 2 })]);
    expect(f.logs()[0]).not.toHaveProperty('elapsedMs');
    const original = new Error('private business failure');
    expect(() => f.tracker.sync(Stage.Registration, () => { throw original; })).toThrow(original);
    expect(f.logs().at(-1)).toMatchObject({ event: Event.Sync, syncMs: 0, outcome: Outcome.Failed });
    expect(JSON.stringify(f.logs())).not.toContain(original.message);
  });
  it('records asynchronous elapsed time rather than synchronous blocking and finishes a span only once', () => {
    const f = fixture();
    const fast = f.tracker.begin(Stage.NetworkRequest); f.advance(999); fast();
    expect(f.logs()).toHaveLength(0);
    const slow = f.tracker.begin(Stage.NetworkRequest); f.advance(1000); slow(Outcome.Succeeded, { bytes: 123 }); slow(Outcome.Failed);
    expect(f.logs()).toEqual([expect.objectContaining({ event: Event.Span, elapsedMs: 1000, bytes: 123, spanId: 2 })]);
    expect(f.logs()[0]).not.toHaveProperty('syncMs');
  });
  it('measures an async helper first synchronous segment separately and preserves rejection identity', async () => {
    const f = fixture(); let resolve!: (value: number) => void;
    const pending = f.tracker.async(Stage.HistorySync, () => {
      f.advance(60); return new Promise<number>(done => { resolve = done; });
    });
    expect(f.logs()).toEqual([expect.objectContaining({ event: Event.Sync, syncMs: 60 })]);
    f.advance(1100); resolve(7); await expect(pending).resolves.toBe(7);
    expect(f.logs().at(-1)).toMatchObject({ event: Event.Span, elapsedMs: 1160, outcome: Outcome.Succeeded });
    const original = new Error('private rejected promise');
    await expect(f.tracker.async(Stage.CommandClaim, async () => { throw original; })).rejects.toBe(original);
    expect(f.logs().at(-1)).toMatchObject({ event: Event.Span, outcome: Outcome.Failed });
    expect(JSON.stringify(f.logs())).not.toContain(original.message);
  });
  it('bounds active spans and recent slow summaries even when callers never finish', async () => {
    const f = fixture();
    const longestStage = Object.values(Stage).reduce((longest, stage) => stage.length > longest.length ? stage : longest);
    const ends = Array.from({ length: 80 }, () => f.tracker.begin(longestStage));
    for (let index = 0; index < 12; index++) f.tracker.sync(longestStage, () => f.advance(60));
    f.tracker.start(); f.advance(2000); await vi.advanceTimersByTimeAsync(1000);
    const lag = f.logs().find(item => item.event === Event.EventLoopLag)!;
    expect(lag).toMatchObject({ lagMs: 1000, activeCount: 64, activeDropped: 28 });
    expect(lag.active).toHaveLength(8); expect(lag.recentSlow).toHaveLength(8);
    expect(Buffer.byteLength(JSON.stringify(lag))).toBeLessThan(3500);
    ends.forEach(end => end());
    f.advance(12000); await vi.advanceTimersByTimeAsync(1000);
    expect(f.logs().filter(item => item.event === Event.EventLoopLag).at(-1)).toMatchObject({ activeCount: 0, active: [] });
  });
  it('preserves a synchronous stall source after a burst of more than eight queued async completions', async () => {
    const f = fixture(); f.tracker.start();
    const ends = Array.from({ length: 12 }, () => f.tracker.begin(Stage.NetworkRequest));
    f.tracker.sync(Stage.RemoteState, () => f.advance(40000)); ends.forEach(end => end());
    await vi.advanceTimersByTimeAsync(1000);
    const lag = f.logs().find(item => item.event === Event.EventLoopLag)!;
    expect(lag.recentSlow).toHaveLength(8);
    expect((lag.recentSlow as unknown[])[0]).toMatchObject({ stage: Stage.RemoteState, event: Event.Sync, syncMs: 40000 });
    expect((lag.recentSlow as Array<Record<string, unknown>>).slice(1).every(item => item.event === Event.Span)).toBe(true);
    f.advance(60001); await vi.advanceTimersByTimeAsync(1000);
    expect(f.logs().filter(item => item.event === Event.EventLoopLag).at(-1)?.recentSlow).toEqual([]);
  });
  it('limits each fixed stage/event to one record per ten seconds and reports suppressed records', () => {
    const f = fixture();
    for (let index = 0; index < 3; index++) f.tracker.event(Stage.NetworkWorker, Event.Watchdog, { reason: Reason.ParentDelay });
    expect(f.logs()).toHaveLength(1);
    f.advance(9999); f.tracker.event(Stage.NetworkWorker, Event.Watchdog);
    expect(f.logs()).toHaveLength(1);
    f.advance(1); f.tracker.event(Stage.NetworkWorker, Event.Watchdog);
    expect(f.logs().at(-1)).toMatchObject({ suppressed: 3 });
    f.tracker.event(Stage.NetworkWorker, Event.Recovery, { reason: Reason.ParentRecovered });
    expect(f.logs()).toHaveLength(3);
  });
  it('keeps recovery start, recovery completion and a genuine watchdog failure in distinct bounded buckets', () => {
    const f = fixture();
    f.tracker.event(Stage.NetworkWorker, Event.RecoveryStarted, { reason: Reason.ParentDelay });
    f.advance(1); f.tracker.event(Stage.NetworkWorker, Event.RecoveryCompleted, { reason: Reason.ParentRecovered });
    f.advance(8000); f.tracker.event(Stage.NetworkWorker, Event.Watchdog, { reason: Reason.Watchdog, outcome: Outcome.Failed });
    expect(f.logs().map(item => item.event)).toEqual([Event.RecoveryStarted, Event.RecoveryCompleted, Event.Watchdog]);
  });
  it('applies a global budget across distinct valid stage/event pairs', () => {
    const f = fixture();
    for (const stage of Object.values(Stage)) for (const event of [Event.Instant, Event.Spawn, Event.Ready]) f.tracker.event(stage, event);
    expect(f.logs()).toHaveLength(64);
    f.advance(10000); f.tracker.event(Stage.NetworkWorker, Event.Exit, { reason: Reason.WorkerExit });
    expect(f.logs().at(-1)).toMatchObject({ globalSuppressed: Object.values(Stage).length * 3 - 64 });
  });
  it('drops arbitrary payload and identifiers, bounds numeric values and never accepts a replacement source pid', () => {
    const f = fixture();
    f.tracker.event(Stage.NetworkWorker, Event.Exit, {
      pid: 123, bytes: Infinity, queueWaitMs: NaN, rssBytes: 1e99, exitCode: -9, activeCount: -2, replyDeliveryMs: 123.45,
      connected: true, cancelled: 'private-string', outcome: Outcome.Failed, reason: Reason.ChildError,
      message: 'secret', url: 'https://private.example', token: 'secret', sessionId: 'secret', spanId: 'secret', phase: 'secret',
    } as unknown as RemotePerformanceFields);
    expect(f.logs()[0]).toMatchObject({ pid: process.pid, workerPid: 123, rssBytes: 1e12, exitCode: -9, activeCount: 0, replyDeliveryMs: 123.45, connected: true,
      outcome: Outcome.Failed, reason: Reason.ChildError });
    for (const key of ['bytes', 'queueWaitMs', 'cancelled', 'url', 'token', 'sessionId', 'spanId', 'phase']) expect(f.logs()[0]).not.toHaveProperty(key);
    expect(JSON.stringify(f.logs())).not.toContain('secret');
    f.tracker.event('private-stage' as Stage, Event.Instant); f.tracker.event(Stage.MainLoop, 'private-event' as Event);
    f.tracker.event(Stage.MainLoop, Event.Instant, { reason: 'private-reason', outcome: 'private-outcome' } as unknown as RemotePerformanceFields);
    expect(f.logs()).toHaveLength(2); expect(f.logs()[1]).not.toHaveProperty('reason'); expect(f.logs()[1]).not.toHaveProperty('outcome');
    f.tracker.event(Stage.NetworkRequest, Event.Instant, { replyDeliveryMs: Infinity });
    expect(f.logs().at(-1)).not.toHaveProperty('replyDeliveryMs');
    f.tracker.event(Stage.NetworkRequest, Event.Ready, { replyDeliveryMs: -1 });
    expect(f.logs().at(-1)).not.toHaveProperty('replyDeliveryMs');
    f.tracker.event(Stage.NetworkRequest, Event.Exit, { replyDeliveryMs: 1e99 });
    expect(f.logs().at(-1)).toMatchObject({ replyDeliveryMs: 1e12 });
  });
  it('summarizes stage counts, maxima, failures and suppression every sixty seconds', async () => {
    const f = fixture(); f.tracker.start();
    for (let index = 0; index < 3; index++) f.tracker.sync(Stage.RemoteState, () => f.advance(10));
    const end = f.tracker.begin(Stage.RemoteState); f.advance(2); end();
    f.tracker.event(Stage.RemoteState, Event.Instant, { outcome: Outcome.Failed });
    f.tracker.event(Stage.RemoteState, Event.Instant); f.tracker.event(Stage.RemoteState, Event.Instant);
    f.advance(60000); await vi.advanceTimersByTimeAsync(1000);
    const summary = f.logs().find(item => item.event === Event.Summary && item.stage === Stage.RemoteState);
    expect(summary).toMatchObject({ count: 7, syncCount: 3, spanCount: 1, failed: 1, syncMaxMs: 10, spanMaxMs: 2, suppressed: 2 });
    f.advance(60000); await vi.advanceTimersByTimeAsync(1000);
    expect(f.logs().filter(item => item.event === Event.Summary && item.stage === Stage.RemoteState)).toHaveLength(1);
  });
  it('detects loop drift from monotonic time while ignoring wall-clock jumps', async () => {
    const f = fixture(); f.tracker.start();
    vi.setSystemTime(new Date('2200-01-01')); f.advance(1199); await vi.advanceTimersByTimeAsync(1000);
    expect(f.logs()).toHaveLength(0);
    vi.setSystemTime(new Date('2000-01-01')); f.advance(1200); await vi.advanceTimersByTimeAsync(1000);
    expect(f.logs()).toEqual([expect.objectContaining({ event: Event.EventLoopLag, lagMs: 200, monotonicMs: 2399 })]);
  });
  it('stops timers, fences unfinished spans and remains inert until restarted', async () => {
    const f = fixture(); f.tracker.start(); f.tracker.start(); expect(vi.getTimerCount()).toBe(1);
    const end = f.tracker.begin(Stage.NetworkRequest); f.tracker.stop(); expect(vi.getTimerCount()).toBe(0);
    f.advance(60000); end(Outcome.Failed); f.tracker.event(Stage.NetworkWorker, Event.Exit);
    expect(f.tracker.sync(Stage.RemoteState, () => 7)).toBe(7); expect(f.logs()).toHaveLength(0);
    f.tracker.start(); end(Outcome.Failed); f.tracker.event(Stage.NetworkWorker, Event.Ready);
    expect(f.logs()).toHaveLength(1);
    f.advance(1200); await vi.advanceTimersByTimeAsync(1000);
    expect(f.logs().at(-1)).toMatchObject({ event: Event.EventLoopLag, active: [], recentSlow: [] });
  });
  it('never changes business results or errors when enqueue or hostile extra-field getters throw', async () => {
    const f = fixture(), original = new Error('business error');
    f.enqueue.mockImplementation(() => { throw new Error('logger error'); });
    expect(f.tracker.sync(Stage.RemoteState, () => { f.advance(60); return 7; })).toBe(7);
    expect(() => f.tracker.sync(Stage.Registration, () => { throw original; })).toThrow(original);
    await expect(f.tracker.async(Stage.CommandClaim, async () => { throw original; })).rejects.toBe(original);
    expect(() => f.tracker.event(Stage.MainLoop, Event.Instant)).not.toThrow();
    const extra = Object.defineProperty({}, 'workerPid', { get: () => { throw new Error('extra field'); } });
    expect(() => f.tracker.begin(Stage.NetworkRequest)(Outcome.Failed, extra)).not.toThrow();
    f.enqueue.mockReset(); f.advance(10000); f.tracker.event(Stage.MainLoop, Event.Instant);
    expect(f.logs()[0]).toMatchObject({ suppressed: 1 });
  });
  it('uses the direct asynchronous log enqueue by default without console output', () => {
    const log = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const tracker = new RemotePerformanceTracker(); trackers.push(tracker);
    tracker.event(Stage.NetworkWorker, Event.Spawn, { workerPid: 123 });
    expect(enqueueRemoteLog).toHaveBeenCalledWith('debug', '[RemotePerformance]', expect.objectContaining({ stage: Stage.NetworkWorker, workerPid: 123 }));
    expect(log).not.toHaveBeenCalled();
  });
});
