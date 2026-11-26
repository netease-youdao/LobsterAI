import { afterEach, describe, expect, it, vi } from 'vitest';

import { RemoteOwnershipContentCache } from './remoteOwnershipContentCache';

const caches: Array<RemoteOwnershipContentCache<string>> = [];
afterEach(() => { for (const cache of caches.splice(0)) cache.stop(); vi.useRealTimers(); });
function fixture() {
  vi.useFakeTimers();
  const jobs: Array<{ id: string; context: string; signal: AbortSignal; finish(value: string | null): void }> = [];
  const produce = vi.fn((context: string, id: string, signal: AbortSignal) => new Promise<string | null>(finish => jobs.push({ context, id, signal, finish })));
  const cache = new RemoteOwnershipContentCache({ produce }); caches.push(cache);
  return { cache, jobs, produce };
}
describe('bounded ownership detail cache', () => {
  it('serves header A and dialog B without cancellation or overlapping child jobs', async () => {
    const f = fixture();
    expect(f.cache.read('owner', 'A')).toBeNull(); expect(f.produce).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0); expect(f.jobs.map(job => job.id)).toEqual(['A']);
    f.cache.read('owner', 'B'); f.cache.read('owner', 'A');
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.jobs).toHaveLength(1); expect(f.jobs[0].signal.aborted).toBe(false);
    f.jobs[0].finish('A-snapshot'); await vi.advanceTimersByTimeAsync(1);
    expect(f.jobs.map(job => job.id)).toEqual(['A', 'B']);
    f.jobs[1].finish('B-snapshot'); await vi.advanceTimersByTimeAsync(1);
    expect(f.cache.read('owner', 'A')).toBe('A-snapshot'); expect(f.cache.read('owner', 'B')).toBe('B-snapshot');
    expect(f.jobs.every(job => !job.signal.aborted)).toBe(true);
  });
  it('bounds demand to four tasks without cancelling the running task when another is selected', async () => {
    const f = fixture(); f.cache.read('owner', 'A'); await vi.advanceTimersByTimeAsync(0);
    for (const id of ['B','C','D','E']) f.cache.read('owner', id);
    expect(f.jobs[0].signal.aborted).toBe(false);
    f.jobs[0].finish('evicted'); await vi.advanceTimersByTimeAsync(1);
    for (let index = 1; index < 5; index++) { expect(f.jobs[index]).toBeDefined(); f.jobs[index].finish(f.jobs[index].id); await vi.advanceTimersByTimeAsync(1); }
    expect(f.jobs.map(job => job.id)).toEqual(['A','B','C','D','E']);
    expect((f.cache as any).entries.size).toBe(4);
  });
  it('clears account epochs and waits for cancellation to settle before the new worker starts', async () => {
    const f = fixture(); f.cache.read('owner', 'A'); await vi.advanceTimersByTimeAsync(0);
    f.cache.read('other', 'A'); expect(f.jobs[0].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(f.jobs[0].signal.aborted).toBe(true); expect(f.jobs).toHaveLength(1);
    f.jobs[0].finish('old-account'); await vi.advanceTimersByTimeAsync(1);
    expect(f.jobs[1].context).toBe('other'); expect(f.cache.read('other', 'A')).toBeNull();
    f.jobs[1].finish('new-account'); await vi.advanceTimersByTimeAsync(1);
    expect(f.cache.read('other', 'A')).toBe('new-account');
  });
  it('expires evidence, rate limits refresh, and fences stop/start of the same scope', async () => {
    const f = fixture(); f.cache.read('owner', 'A'); await vi.advanceTimersByTimeAsync(0);
    f.jobs[0].finish('first'); await vi.advanceTimersByTimeAsync(1);
    f.cache.invalidate('A'); expect(f.cache.read('owner', 'A')).toBeNull();
    await vi.advanceTimersByTimeAsync(4998); expect(f.jobs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(f.jobs).toHaveLength(2);
    f.jobs[1].finish('second'); await vi.advanceTimersByTimeAsync(1);
    expect(f.cache.read('owner', 'A')).toBe('second');
    await vi.advanceTimersByTimeAsync(15001); expect(f.cache.read('owner', 'A')).toBeNull();
    f.cache.stop(); f.cache.start(); f.cache.read('owner', 'A');
    const oldJob = f.jobs[2]; await vi.advanceTimersByTimeAsync(1); expect(oldJob.signal.aborted).toBe(true);
    oldJob.finish('stopped'); await vi.advanceTimersByTimeAsync(1);
    expect(f.cache.read('owner', 'A')).toBeNull(); expect(f.jobs).toHaveLength(4);
  });
  it('contains worker rejection and observer errors without turning them into a successful status', async () => {
    vi.useFakeTimers();
    const produce = vi.fn(async () => { throw new Error('private-storage-path'); });
    const cache = new RemoteOwnershipContentCache<string>({ produce, onChanged: () => { throw new Error('observer'); } }); caches.push(cache);
    expect(cache.read('owner', 'A')).toBeNull(); await vi.advanceTimersByTimeAsync(0);
    expect(cache.read('owner', 'A')).toBeNull(); expect(produce).toHaveBeenCalledTimes(1);
  });
});
