import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    getVersion: () => 'test-version',
  },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { prepareOpenClawDeliverableSync } from './openclawRuntimeAdapter';

afterEach(() => vi.useRealTimers());

describe('deliverable preparation before local execution', () => {
  test('waits for preparation with the current session and working directory', async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const prepare = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const ready = vi.fn();
    const pending = prepareOpenClawDeliverableSync(prepare, 'session', '/workspace').then(ready);

    expect(prepare).toHaveBeenCalledExactlyOnceWith('session', '/workspace');
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    finish?.();
    await pending;
    expect(ready).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('bounds unavailable preparation to 100ms and tolerates a late rejection', async () => {
    vi.useFakeTimers();
    let fail: ((reason: Error) => void) | undefined;
    const prepare = () => new Promise<void>((_resolve, reject) => { fail = reject; });
    const ready = vi.fn();
    const pending = prepareOpenClawDeliverableSync(prepare, 'session', '/workspace').then(ready);

    await vi.advanceTimersByTimeAsync(99);
    expect(ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(ready).toHaveBeenCalledOnce();
    fail?.(new Error('Late filesystem failure'));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([
    () => { throw new Error('Preparation failed'); },
    () => Promise.reject(new Error('Preparation failed')),
  ])('allows local execution after preparation throws or rejects', async prepare => {
    vi.useFakeTimers();
    await expect(prepareOpenClawDeliverableSync(prepare, 'session', '/workspace')).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('does not prepare when no callback or working directory is available', async () => {
    const prepare = vi.fn(async () => undefined);
    await prepareOpenClawDeliverableSync(undefined, 'session', '/workspace');
    await prepareOpenClawDeliverableSync(prepare, 'session', '');
    await prepareOpenClawDeliverableSync(prepare, 'session', '   ');
    expect(prepare).not.toHaveBeenCalled();
  });
});
