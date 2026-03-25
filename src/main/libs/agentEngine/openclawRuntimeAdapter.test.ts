import { afterEach, expect, test, vi } from 'vitest';
import { OpenClawRuntimeAdapter } from './openclawRuntimeAdapter';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('startChannelPolling does not overlap channel polls while a previous cycle is still running', async () => {
  vi.useFakeTimers();

  const adapter = new OpenClawRuntimeAdapter({} as any, {} as any);
  (adapter as any).channelSessionSync = {} as any;
  (adapter as any).gatewayClient = {} as any;

  const firstPoll = createDeferred<void>();
  const pollChannelSessions = vi.fn(() => firstPoll.promise);
  (adapter as any).pollChannelSessions = pollChannelSessions;

  adapter.startChannelPolling();
  expect(pollChannelSessions).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(60_000);
  expect(pollChannelSessions).toHaveBeenCalledTimes(1);

  firstPoll.resolve();
  await Promise.resolve();
});

test('startChannelPolling schedules the next channel poll only after the previous one finishes', async () => {
  vi.useFakeTimers();

  const adapter = new OpenClawRuntimeAdapter({} as any, {} as any);
  (adapter as any).channelSessionSync = {} as any;
  (adapter as any).gatewayClient = {} as any;

  const firstPoll = createDeferred<void>();
  const secondPoll = createDeferred<void>();
  const pollChannelSessions = vi
    .fn<() => Promise<void>>()
    .mockImplementationOnce(() => firstPoll.promise)
    .mockImplementationOnce(() => secondPoll.promise);
  (adapter as any).pollChannelSessions = pollChannelSessions;

  adapter.startChannelPolling();
  expect(pollChannelSessions).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(10_000);
  expect(pollChannelSessions).toHaveBeenCalledTimes(1);

  firstPoll.resolve();
  await Promise.resolve();

  await vi.advanceTimersByTimeAsync(9_999);
  expect(pollChannelSessions).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(1);
  expect(pollChannelSessions).toHaveBeenCalledTimes(2);

  secondPoll.resolve();
  await Promise.resolve();
});
