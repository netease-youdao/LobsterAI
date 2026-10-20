import { afterEach, describe, expect, test, vi } from 'vitest';

import { AccountRecoveryCancelledError, AccountRecoveryPhase, OpenClawAccountRecovery } from './openclawAccountRecovery';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function flush() { for (let i = 0; i < 25; i++) await Promise.resolve(); }

function fixture() {
  let identity = 'A:1';
  let allowed = true;
  const events: string[] = [];
  const deps = {
    identity: () => identity,
    canRun: () => allowed,
    allowCredentials: vi.fn(() => { events.push('credentials'); }),
    prepare: vi.fn(async () => { events.push('prepare'); }),
    start: vi.fn(async () => { events.push('start'); }),
    confirm: vi.fn(async () => { events.push('confirm'); }),
    complete: vi.fn(() => { events.push('complete'); }),
    changed: vi.fn(),
    canRetry: () => false,
    retryDelayMs: () => 0,
  };
  const recovery = new OpenClawAccountRecovery(deps);
  const fence = vi.fn(async () => { events.push('fence'); });
  return { recovery, deps, events, fence,
    switchIdentity: (next: string) => { identity = next; },
    stop: () => { allowed = false; recovery.cancel(); } };
}

afterEach(() => vi.useRealTimers());

describe('account gateway recovery', () => {
  test.each([false, true])('same-owner refresh holds new admission while retaining the committed process lease, recovered=%s', async recovered => {
    const f = fixture();
    if (recovered) await f.recovery.request({ resume: true, fence: f.fence });
    const permit = f.recovery.captureStartPermit()!;
    const revision = f.recovery.beginAuthMutation();
    expect(permit()).toBe(true);
    expect(f.recovery.captureStartPermit()).toBeNull();
    f.recovery.commitAuthMutation(revision);
    expect(permit()).toBe(true);
  });

  test('stopped account preparation resumes once when an external caller requests startup', async () => {
    const f = fixture();
    await f.recovery.request({ resume: false, fence: f.fence });
    f.recovery.requestRunning();
    f.recovery.requestRunning();
    await f.recovery.wait();
    expect(f.fence).toHaveBeenCalledOnce();
    expect(f.deps.prepare).toHaveBeenCalledOnce();
    expect(f.deps.start).toHaveBeenCalledOnce();
    expect(f.deps.complete).toHaveBeenCalledOnce();
  });

  test('a later stopped transition cannot inherit a cancelled running intent', async () => {
    const f = fixture();
    const starting = deferred();
    f.deps.start.mockImplementationOnce(() => starting.promise);
    const old = f.recovery.request({ resume: true, fence: f.fence });
    await flush();
    f.recovery.cancel();
    starting.resolve();
    await expect(old).rejects.toBeInstanceOf(AccountRecoveryCancelledError);
    await f.recovery.request({ resume: false, fence: f.fence });
    expect(f.deps.start).toHaveBeenCalledOnce();
    expect(f.recovery.active).toBe(false);
  });

  test('manual retry reuses successful isolation and configuration', async () => {
    const f = fixture();
    f.deps.confirm.mockRejectedValueOnce(new Error('connection unavailable'));
    await expect(f.recovery.request({ resume: true, fence: f.fence })).rejects.toThrow();
    await f.recovery.retry();
    expect(f.fence).toHaveBeenCalledOnce();
    expect(f.deps.prepare).toHaveBeenCalledOnce();
    expect(f.deps.confirm).toHaveBeenCalledTimes(2);
  });

  test('manual retry joins an automatic retry already in progress', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.deps.canRetry = () => true;
    f.deps.confirm.mockRejectedValueOnce(new Error('connection unavailable'));
    const first = f.recovery.request({ resume: true, fence: f.fence });
    await flush();
    const manual = f.recovery.retry();
    await vi.runAllTimersAsync();
    await Promise.all([first, manual]);
    expect(f.deps.confirm).toHaveBeenCalledTimes(2);
    expect(f.deps.start).toHaveBeenCalledTimes(2);
  });

  test('actively restores without a websocket or a task', async () => {
    const f = fixture();
    await f.recovery.request({ resume: true, fence: f.fence });
    expect(f.events).toEqual(['fence', 'credentials', 'prepare', 'start', 'confirm', 'complete']);
    expect(f.recovery.state?.phase).toBe(AccountRecoveryPhase.Complete);
  });

  test.each(['fence-first', 'commit-first'])('requires both isolation and auth commit: %s', async order => {
    const f = fixture();
    const stop = deferred();
    const revision = f.recovery.beginAuthMutation();
    const pending = f.recovery.request({ resume: true, fence: () => stop.promise });
    if (order === 'fence-first') stop.resolve(); else f.recovery.commitAuthMutation(revision);
    await flush();
    expect(f.deps.allowCredentials).not.toHaveBeenCalled();
    expect(f.deps.start).not.toHaveBeenCalled();
    expect(f.recovery.captureStartPermit()).toBeNull();
    stop.resolve();
    f.recovery.commitAuthMutation(revision);
    await pending;
    expect(f.deps.start).toHaveBeenCalledOnce();
  });

  test('preserves stopped intent while still removing old account config', async () => {
    const f = fixture();
    await f.recovery.request({ resume: false, fence: f.fence });
    expect(f.events).toEqual(['fence', 'credentials', 'prepare']);
    expect(f.recovery.state?.phase).toBe(AccountRecoveryPhase.Stopped);
  });

  test('A to B to A cannot reuse a previous startup permit', async () => {
    const f = fixture();
    await f.recovery.request({ resume: true, fence: f.fence });
    const permitA = f.recovery.captureStartPermit()!;
    expect(permitA()).toBe(true);
    f.switchIdentity('B:2');
    await f.recovery.request({ resume: true, fence: f.fence });
    f.switchIdentity('A:3');
    await f.recovery.request({ resume: true, fence: f.fence });
    expect(permitA()).toBe(false);
    expect(f.recovery.captureStartPermit()?.()).toBe(true);
  });

  test('the latest transition inherits intent while an earlier stop is pending', async () => {
    const f = fixture();
    const stopping = deferred();
    const first = f.recovery.request({ resume: true, fence: () => stopping.promise });
    f.switchIdentity('B:2');
    const last = f.recovery.request({ resume: false, fence: f.fence });
    stopping.resolve();
    await expect(first).rejects.toBeInstanceOf(AccountRecoveryCancelledError);
    await last;
    expect(f.deps.start).toHaveBeenCalledOnce();
  });

  test('failed auth cannot open credentials; a later committed transition recovers', async () => {
    const f = fixture();
    const revision = f.recovery.beginAuthMutation();
    const first = f.recovery.request({ resume: true, fence: f.fence });
    f.recovery.failAuthMutation(revision, new Error('context unavailable'));
    await expect(first).rejects.toThrow('context unavailable');
    expect(f.deps.allowCredentials).not.toHaveBeenCalled();
    const rollback = f.recovery.beginAuthMutation();
    f.switchIdentity('A:2');
    const second = f.recovery.request({ resume: true, fence: f.fence });
    f.recovery.commitAuthMutation(revision);
    await flush();
    expect(f.deps.start).not.toHaveBeenCalled();
    f.recovery.commitAuthMutation(rollback);
    await second;
    expect(f.deps.start).toHaveBeenCalledOnce();
  });

  test('ordinary auth refresh alone does not cause a gateway restart', async () => {
    const f = fixture();
    const revision = f.recovery.beginAuthMutation();
    f.recovery.commitAuthMutation(revision);
    await f.recovery.wait();
    expect(f.deps.start).not.toHaveBeenCalled();
  });

  test('explicit shutdown invalidates the permit and prevents delayed confirmation', async () => {
    const f = fixture();
    const starting = deferred();
    f.deps.start.mockImplementation(() => starting.promise);
    const pending = f.recovery.request({ resume: true, fence: f.fence });
    await flush();
    const permit = f.recovery.captureStartPermit()!;
    f.stop();
    starting.resolve();
    await expect(pending).rejects.toBeInstanceOf(AccountRecoveryCancelledError);
    expect(permit()).toBe(false);
    expect(f.deps.confirm).not.toHaveBeenCalled();
  });

  test('parallel external waiters join one full recovery', async () => {
    const f = fixture();
    const confirmation = deferred();
    f.deps.confirm.mockImplementation(() => confirmation.promise);
    const pending = f.recovery.request({ resume: true, fence: f.fence });
    await flush();
    let released = 0;
    const waiters = [f.recovery.wait(), f.recovery.wait()].map(p => p.then(() => { released++; }));
    expect(released).toBe(0);
    expect(f.recovery.captureStartPermit()?.()).toBe(true);
    confirmation.resolve();
    await Promise.all([pending, ...waiters]);
    expect(released).toBe(2);
    expect(f.deps.start).toHaveBeenCalledOnce();
  });

  test('a newer auth mutation during prepare discards the partial target', async () => {
    const f = fixture();
    const preparing = deferred();
    f.deps.prepare.mockImplementationOnce(() => preparing.promise);
    const pending = f.recovery.request({ resume: true, fence: f.fence });
    await flush();
    const revision = f.recovery.beginAuthMutation();
    preparing.resolve();
    await flush();
    expect(f.deps.start).not.toHaveBeenCalled();
    f.recovery.commitAuthMutation(revision);
    await pending;
    expect(f.deps.prepare).toHaveBeenCalledTimes(2);
    expect(f.deps.start).toHaveBeenCalledOnce();
  });

  test('uses one bounded retry budget without re-fencing or regenerating a valid config', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.deps.canRetry = () => true;
    f.deps.confirm.mockRejectedValue(new Error('connection unavailable'));
    const pending = f.recovery.request({ resume: true, fence: f.fence });
    const rejected = expect(pending).rejects.toThrow('connection unavailable');
    await vi.runAllTimersAsync();
    await rejected;
    expect(f.fence).toHaveBeenCalledOnce();
    expect(f.deps.prepare).toHaveBeenCalledOnce();
    expect(f.deps.confirm).toHaveBeenCalledTimes(5);
    expect(f.recovery.state?.attempt).toBe(4);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('respects a stricter phase cooldown', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.deps.canRetry = () => true;
    f.deps.retryDelayMs = () => 30_000;
    f.deps.confirm.mockRejectedValueOnce(new Error('retry later'));
    const pending = f.recovery.request({ resume: true, fence: f.fence });
    await flush();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.deps.confirm).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(f.deps.confirm).toHaveBeenCalledTimes(2);
  });

  test('failed isolation never reaches config or credentials', async () => {
    const f = fixture();
    await expect(f.recovery.request({ resume: true, fence: async () => { throw new Error('still running'); } }))
      .rejects.toThrow('still running');
    expect(f.deps.allowCredentials).not.toHaveBeenCalled();
    expect(f.deps.prepare).not.toHaveBeenCalled();
  });

  test('cancels scheduled retries when a newer account takes over', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.deps.canRetry = () => true;
    f.deps.confirm.mockRejectedValueOnce(new Error('transient'));
    const first = f.recovery.request({ resume: true, fence: f.fence });
    const rejected = expect(first).rejects.toBeInstanceOf(AccountRecoveryCancelledError);
    await flush();
    f.switchIdentity('B:2');
    await f.recovery.request({ resume: true, fence: f.fence });
    await rejected;
    await vi.runAllTimersAsync();
    expect(f.deps.complete).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
