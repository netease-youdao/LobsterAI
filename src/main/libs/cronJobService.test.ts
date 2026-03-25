import { afterEach, expect, test, vi } from 'vitest';
import { CronJobService } from './cronJobService';

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

test('startPolling does not overlap poll cycles while a previous poll is still running', async () => {
  vi.useFakeTimers();

  const service = new CronJobService({
    getGatewayClient: () => null,
    ensureGatewayReady: async () => {},
  });

  const firstPoll = createDeferred<void>();
  const pollOnce = vi.fn(() => firstPoll.promise);
  (service as any).pollOnce = pollOnce;

  service.startPolling();
  expect(pollOnce).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(60_000);
  expect(pollOnce).toHaveBeenCalledTimes(1);

  firstPoll.resolve();
  await Promise.resolve();
});

test('startPolling waits for the previous poll to finish before scheduling the next cycle', async () => {
  vi.useFakeTimers();

  const service = new CronJobService({
    getGatewayClient: () => null,
    ensureGatewayReady: async () => {},
  });

  const firstPoll = createDeferred<void>();
  const secondPoll = createDeferred<void>();
  const pollOnce = vi
    .fn<() => Promise<void>>()
    .mockImplementationOnce(() => firstPoll.promise)
    .mockImplementationOnce(() => secondPoll.promise);
  (service as any).pollOnce = pollOnce;

  service.startPolling();
  expect(pollOnce).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(15_000);
  expect(pollOnce).toHaveBeenCalledTimes(1);

  firstPoll.resolve();
  await Promise.resolve();

  await vi.advanceTimersByTimeAsync(14_999);
  expect(pollOnce).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(1);
  expect(pollOnce).toHaveBeenCalledTimes(2);

  secondPoll.resolve();
  await Promise.resolve();
});
