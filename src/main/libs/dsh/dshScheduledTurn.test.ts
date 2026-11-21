import { EventEmitter } from 'node:events';

import { expect, test, vi } from 'vitest';

import { runScheduledTurn } from './dshScheduledTurn';

class Runtime extends EventEmitter {
  startSession = vi.fn().mockResolvedValue(undefined);
  stopSession = vi.fn();
}

test('the schedule stop button cancels the exact submitted turn and removes both sets of listeners', async () => {
  const runtime = new Runtime();
  const abort = new AbortController();
  const result = runScheduledTurn(runtime, 'scheduled', 'main', 'Summary', abort.signal);
  runtime.emit('complete', 'unrelated');
  abort.abort();
  await expect(result).resolves.toBe(true);
  expect(runtime.stopSession.mock.calls).toEqual([['scheduled']]);
  expect(runtime.eventNames()).toEqual([]);
  await expect(runScheduledTurn(runtime, 'early', 'main', 'Never submit', abort.signal)).resolves.toBe(true);
  expect(runtime.startSession).toHaveBeenCalledOnce();
});

test('chat-side stop closes its run without waiting for a completion event', async () => {
  const runtime = new Runtime();
  const abort = new AbortController();
  const result = runScheduledTurn(runtime, 'scheduled', 'main', 'Summary', abort.signal);
  runtime.emit('sessionStopped', 'scheduled');
  await expect(result).resolves.toBe(true);
  abort.abort();
  expect(runtime.stopSession).not.toHaveBeenCalled();
  expect(runtime.eventNames()).toEqual([]);
});

test('normal completion and errors keep their existing outcomes', async () => {
  const runtime = new Runtime();
  const signal = new AbortController().signal;
  const completed = runScheduledTurn(runtime, 'ok', 'main', 'Summary', signal);
  runtime.emit('complete', 'ok');
  await expect(completed).resolves.toBe(false);
  const failed = runScheduledTurn(runtime, 'bad', 'main', 'Summary', signal);
  runtime.emit('error', 'bad', 'Gateway disconnected');
  await expect(failed).rejects.toThrow('Gateway disconnected');
  expect(runtime.eventNames()).toEqual([]);
});
