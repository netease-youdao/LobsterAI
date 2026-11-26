import { afterEach, expect, it, vi } from 'vitest';

import { RemoteAccountTransition } from '../remote/remoteAccountTransition';
import { MobileRemoteAccountFence } from './mobileRemoteAccountFence';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('keeps the execution barrier closed until the failed identity has recovered', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const transition = new RemoteAccountTransition();
  const fence = new MobileRemoteAccountFence(transition);
  const isolate = vi.fn().mockRejectedValueOnce(new Error('host busy')).mockResolvedValue(undefined);
  fence.change(isolate);
  await expect(transition.wait()).rejects.toThrow('host busy');
  await fence.retry();
  await transition.wait();
  await vi.advanceTimersByTimeAsync(12000);
  expect(isolate).toHaveBeenCalledTimes(2);
  fence.dispose();
});

it('supersedes an old identity before its queued isolation can start', async () => {
  const transition = new RemoteAccountTransition();
  const fence = new MobileRemoteAccountFence(transition);
  const first = vi.fn(), second = vi.fn();
  fence.change(first);
  fence.change(second);
  await transition.wait();
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledOnce();
  fence.dispose();
});
