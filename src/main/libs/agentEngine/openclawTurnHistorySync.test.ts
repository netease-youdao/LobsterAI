import { afterEach, expect, test, vi } from 'vitest';

import { OpenClawTurnHistorySync } from './openclawTurnHistorySync';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('batches tool-boundary thinking requests and uses the current turn token', async () => {
  vi.useFakeTimers();
  const messages = [{ role: 'assistant', content: 'history' }];
  const requestHistory = vi.fn(async () => messages);
  const handleThinkingHistory = vi.fn();
  const sync = new OpenClawTurnHistorySync({
    getTurn: () => ({ sessionKey: 'agent:main:session-1', turnToken: 1 }),
    requestHistory,
    handleThinkingHistory,
    handleBackfillHistory: vi.fn(),
  });

  sync.scheduleThinking('session-1', 'call-read');
  sync.scheduleThinking('session-1', 'call-exec');
  await vi.advanceTimersByTimeAsync(250);

  expect(requestHistory).toHaveBeenCalledTimes(1);
  expect(requestHistory).toHaveBeenCalledWith('agent:main:session-1', 11);
  expect(handleThinkingHistory).toHaveBeenCalledWith('session-1', messages);
});

test('drops history returned for a stale turn', async () => {
  vi.useFakeTimers();
  let turnToken = 1;
  let resolveHistory: ((messages: unknown[]) => void) | undefined;
  const requestHistory = vi.fn(() => new Promise<unknown[]>((resolve) => {
    resolveHistory = resolve;
  }));
  const handleThinkingHistory = vi.fn();
  const sync = new OpenClawTurnHistorySync({
    getTurn: () => ({ sessionKey: 'agent:main:session-1', turnToken }),
    requestHistory,
    handleThinkingHistory,
    handleBackfillHistory: vi.fn(),
  });

  sync.scheduleThinking('session-1', 'call-read');
  await vi.advanceTimersByTimeAsync(250);
  turnToken = 2;
  resolveHistory?.([{ role: 'assistant', content: 'stale' }]);
  await Promise.resolve();

  expect(handleThinkingHistory).not.toHaveBeenCalled();
});

test('retries failed tool-result history backfill with the original tool IDs', async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const messages = [{ role: 'toolResult', toolCallId: 'call-read', content: 'result' }];
  const requestHistory = vi.fn()
    .mockRejectedValueOnce(new Error('temporary failure'))
    .mockResolvedValueOnce(messages);
  const handleBackfillHistory = vi.fn();
  const sync = new OpenClawTurnHistorySync({
    getTurn: () => ({ sessionKey: 'agent:main:session-1', turnToken: 1 }),
    requestHistory,
    handleThinkingHistory: vi.fn(),
    handleBackfillHistory,
  });

  sync.scheduleToolResultBackfill('session-1', 'call-read');
  await vi.advanceTimersByTimeAsync(2_000);
  await vi.advanceTimersByTimeAsync(2_000);

  expect(requestHistory).toHaveBeenCalledTimes(2);
  expect(handleBackfillHistory).toHaveBeenCalledWith('session-1', messages);
});

test('clearSession cancels pending work for that session', async () => {
  vi.useFakeTimers();
  const requestHistory = vi.fn(async () => []);
  const sync = new OpenClawTurnHistorySync({
    getTurn: () => ({ sessionKey: 'agent:main:session-1', turnToken: 1 }),
    requestHistory,
    handleThinkingHistory: vi.fn(),
    handleBackfillHistory: vi.fn(),
  });

  sync.scheduleThinking('session-1', 'call-read');
  sync.scheduleToolResultBackfill('session-1', 'call-read');
  sync.clearSession('session-1');
  await vi.runAllTimersAsync();

  expect(requestHistory).not.toHaveBeenCalled();
});
