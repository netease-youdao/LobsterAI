import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteDisplaySnapshot, RemoteDisplaySnapshotTiming as Timing } from './remoteDisplaySnapshot';

const caches: Array<RemoteDisplaySnapshot<string>> = [];
function deferred() {
  let resolve!: (value: string | null) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string | null>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function fixture() {
  const jobs: Array<ReturnType<typeof deferred> & { contextKey: string; signal: AbortSignal }> = [];
  const onChanged = vi.fn();
  const produce = vi.fn((contextKey: string, signal: AbortSignal) => {
    const job = { ...deferred(), contextKey, signal }; jobs.push(job); return job.promise;
  });
  const cache = new RemoteDisplaySnapshot({ produce, onChanged }); caches.push(cache);
  return { cache, produce, onChanged, jobs };
}
const settle = async (): Promise<void> => { for (let index = 0; index < 5; index++) await Promise.resolve(); };
beforeEach(() => { vi.useFakeTimers(); });
afterEach(async () => {
  caches.splice(0).forEach(cache => cache.stop());
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers(); vi.restoreAllMocks();
});

describe('display-only remote snapshots', () => {
  it('only schedules timers from read and shares one producer across repeated reads', async () => {
    const { cache, produce, onChanged, jobs } = fixture();
    expect(cache.read('owner-A')).toBeNull(); expect(cache.read('owner-A')).toBeNull();
    expect(produce).not.toHaveBeenCalled(); expect(onChanged).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(produce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(Timing.refreshMs);
    expect(cache.read('owner-A')).toBeNull(); expect(produce).toHaveBeenCalledTimes(1);
    jobs[0].resolve('healthy'); await settle();
    expect(cache.read('owner-A')).toBe('healthy'); expect(onChanged).toHaveBeenCalledTimes(1);
  });
  it('refreshes at most once per five seconds while reads remain immediate', async () => {
    const { cache, produce, jobs } = fixture();
    cache.read('owner-A'); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000); jobs[0].resolve('first'); await settle();
    expect(cache.read('owner-A')).toBe('first');
    await vi.advanceTimersByTimeAsync(Timing.refreshMs - 1001);
    expect(produce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(produce).toHaveBeenCalledTimes(2);
    expect(cache.read('owner-A')).toBe('first');
    jobs[1].resolve('second'); await settle(); expect(cache.read('owner-A')).toBe('second');
  });
  it.each(['unknown', 'failure'])('clears the previous healthy value after a producer %s', async outcome => {
    const { cache, jobs, onChanged } = fixture();
    cache.read('owner-A'); await vi.advanceTimersByTimeAsync(0); jobs[0].resolve('healthy'); await settle();
    await vi.advanceTimersByTimeAsync(Timing.refreshMs);
    if (outcome === 'unknown') jobs[1].resolve(null); else jobs[1].reject(new Error('unavailable'));
    await settle(); expect(cache.read('owner-A')).toBeNull(); expect(onChanged).toHaveBeenCalledTimes(2);
  });
  it('expires and notifies at fifteen seconds even if the producer has not settled', async () => {
    const { cache, jobs, produce, onChanged } = fixture();
    cache.read('owner-A'); await vi.advanceTimersByTimeAsync(0); jobs[0].resolve('healthy'); await settle();
    await vi.advanceTimersByTimeAsync(Timing.ttlMs - 1);
    expect(cache.read('owner-A')).toBe('healthy'); expect(produce).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(cache.read('owner-A')).toBeNull(); expect(onChanged).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(Timing.ttlMs); expect(produce).toHaveBeenCalledTimes(2);
  });
  it('rejects an expired value in read even before a paused expiry timer runs', async () => {
    let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { cache, jobs, produce, onChanged } = fixture();
    cache.read('owner-A'); await vi.advanceTimersByTimeAsync(0); jobs[0].resolve('healthy'); await settle();
    now = Timing.ttlMs;
    expect(cache.read('owner-A')).toBeNull();
    expect(produce).toHaveBeenCalledTimes(1); expect(onChanged).toHaveBeenCalledTimes(1);
  });
  it('fences changed scopes immediately and retains the cancelled job until it settles', async () => {
    const { cache, jobs, produce, onChanged } = fixture();
    cache.read('owner-A'); await vi.advanceTimersByTimeAsync(0);
    const cancelled = vi.fn(); jobs[0].signal.addEventListener('abort', cancelled);
    expect(cache.read('owner-B')).toBeNull();
    expect(cancelled).not.toHaveBeenCalled(); expect(produce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0); expect(cancelled).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(Timing.refreshMs); expect(produce).toHaveBeenCalledTimes(1);
    jobs[0].resolve('old-account'); await settle();
    expect(cache.read('owner-B')).toBeNull(); expect(onChanged).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0); expect(jobs[1].contextKey).toBe('owner-B');
    jobs[1].resolve('new-account'); await settle(); expect(cache.read('owner-B')).toBe('new-account');
    expect(cache.read(null)).toBeNull(); await vi.advanceTimersByTimeAsync(Timing.ttlMs);
    expect(produce).toHaveBeenCalledTimes(2);
  });
  it('clears a settled snapshot on scope changes without returning it for the new account', async () => {
    const { cache, jobs, produce } = fixture();
    cache.read('owner-A'); await vi.advanceTimersByTimeAsync(0); jobs[0].resolve('old-account'); await settle();
    expect(cache.read('owner-B')).toBeNull(); expect(produce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0); expect(jobs[1].contextKey).toBe('owner-B');
  });
  it('invalidates the same scope without skipping the original five-second refresh interval', async () => {
    const { cache, jobs, produce } = fixture();
    cache.read('owner-A'); await vi.advanceTimersByTimeAsync(0); jobs[0].resolve('healthy'); await settle();
    await vi.advanceTimersByTimeAsync(1000); cache.invalidate();
    expect(cache.read('owner-A')).toBeNull();
    await vi.advanceTimersByTimeAsync(Timing.refreshMs - 1001); expect(produce).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(produce).toHaveBeenCalledTimes(2);
  });
  it('fences a late result after same-scope invalidation without releasing its single-flight slot', async () => {
    const { cache, jobs, produce, onChanged } = fixture();
    cache.read('owner-A'); await vi.advanceTimersByTimeAsync(0); cache.invalidate();
    await vi.advanceTimersByTimeAsync(Timing.refreshMs); expect(jobs[0].signal.aborted).toBe(true);
    expect(produce).toHaveBeenCalledTimes(1);
    jobs[0].resolve('obsolete'); await settle();
    expect(cache.read('owner-A')).toBeNull(); expect(onChanged).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0); expect(produce).toHaveBeenCalledTimes(2);
  });
  it('stops pending work, starts only after a new read, and waits for the old producer to settle', async () => {
    const { cache, jobs, produce, onChanged } = fixture();
    cache.read('owner-A'); await vi.advanceTimersByTimeAsync(0); cache.stop();
    await vi.advanceTimersByTimeAsync(0); expect(jobs[0].signal.aborted).toBe(true);
    expect(cache.read('owner-A')).toBeNull(); cache.start();
    await vi.advanceTimersByTimeAsync(Timing.refreshMs); expect(produce).toHaveBeenCalledTimes(1);
    cache.read('owner-A'); jobs[0].resolve('obsolete'); await settle();
    expect(onChanged).not.toHaveBeenCalled(); expect(cache.read('owner-A')).toBeNull();
    await vi.advanceTimersByTimeAsync(0); expect(produce).toHaveBeenCalledTimes(2);
    jobs[1].resolve('current'); await settle(); expect(cache.read('owner-A')).toBe('current');
    cache.stop(); expect(cache.read('owner-A')).toBeNull();
    cache.start(); await vi.advanceTimersByTimeAsync(Timing.ttlMs); expect(produce).toHaveBeenCalledTimes(2);
  });
  it('isolates observer errors and synchronous producer failures without stopping future refreshes', async () => {
    const produce = vi.fn<(_key: string, _signal: AbortSignal) => Promise<string | null>>()
      .mockResolvedValueOnce('healthy').mockImplementationOnce(() => { throw new Error('synchronous failure'); }).mockResolvedValue('recovered');
    const onChanged = vi.fn(() => { throw new Error('observer failure'); });
    const cache = new RemoteDisplaySnapshot({ produce, onChanged }); caches.push(cache);
    cache.read('owner-A'); await vi.advanceTimersByTimeAsync(0); expect(cache.read('owner-A')).toBe('healthy');
    await vi.advanceTimersByTimeAsync(Timing.refreshMs); expect(cache.read('owner-A')).toBeNull();
    await vi.advanceTimersByTimeAsync(Timing.refreshMs); expect(cache.read('owner-A')).toBe('recovered');
    expect(onChanged).toHaveBeenCalledTimes(3);
  });
});
