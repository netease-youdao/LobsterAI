import { EventEmitter } from 'events';
import { describe, expect, test, vi } from 'vitest';

import { CoworkBtwStatus } from '../../../shared/cowork/btw';
import { CoworkEngineRouter } from './coworkEngineRouter';
import type { CoworkRuntime } from './types';

function createRuntimeMock(): CoworkRuntime {
  const emitter = new EventEmitter();
  return {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      emitter.on(event, listener);
      return emitter;
    }) as CoworkRuntime['on'],
    off: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      emitter.off(event, listener);
      return emitter;
    }) as CoworkRuntime['off'],
    emit: emitter.emit.bind(emitter),
    startSession: vi.fn().mockResolvedValue(undefined),
    continueSession: vi.fn().mockResolvedValue(undefined),
    submitBtw: vi.fn().mockResolvedValue({ success: true, runId: 'btw-1' }),
    abortBtw: vi.fn().mockResolvedValue({
      success: true,
      aborted: true,
      runId: 'btw-1',
    }),
    stopSession: vi.fn(),
    stopAllSessions: vi.fn(),
    respondToPermission: vi.fn(),
    isSessionActive: vi.fn().mockReturnValue(false),
    getSessionConfirmationMode: vi.fn().mockReturnValue(null),
    onSessionDeleted: vi.fn(),
  };
}

describe('CoworkEngineRouter', () => {
  test('only stops the openclaw runtime when no session engine is recorded', () => {
    const openclawRuntime = createRuntimeMock();
    const router = new CoworkEngineRouter({
      getCurrentEngine: () => 'openclaw',
      openclawRuntime,
    });

    router.stopSession('missing-session');

    expect(openclawRuntime.stopSession).toHaveBeenCalledWith('missing-session');
  });

  test('forwards context maintenance events from the runtime', () => {
    const openclawRuntime = createRuntimeMock();
    const router = new CoworkEngineRouter({
      getCurrentEngine: () => 'openclaw',
      openclawRuntime,
    });
    const listener = vi.fn();

    router.on('contextMaintenance', listener);
    (openclawRuntime as CoworkRuntime & { emit: (event: string, ...args: unknown[]) => boolean })
      .emit('contextMaintenance', 'session-1', true);

    expect(listener).toHaveBeenCalledWith('session-1', true);
  });

  test('delegates BTW requests and forwards only the BTW result event', async () => {
    const openclawRuntime = createRuntimeMock();
    const router = new CoworkEngineRouter({
      getCurrentEngine: () => 'openclaw',
      openclawRuntime,
    });
    const listener = vi.fn();
    router.on('btwResult', listener);

    await expect(router.submitBtw('session-1', 'What changed?', 'btw-1')).resolves.toEqual({
      success: true,
      runId: 'btw-1',
    });
    expect(openclawRuntime.submitBtw).toHaveBeenCalledWith(
      'session-1',
      'What changed?',
      'btw-1',
    );
    await expect(router.abortBtw('session-1', 'btw-1')).resolves.toEqual({
      success: true,
      aborted: true,
      runId: 'btw-1',
    });
    expect(openclawRuntime.abortBtw).toHaveBeenCalledWith('session-1', 'btw-1');

    const result = {
      runId: 'btw-1',
      sessionId: 'session-1',
      question: 'What changed?',
      status: CoworkBtwStatus.Answered,
      answer: 'Only docs.',
      createdAt: 1,
      completedAt: 2,
    };
    (openclawRuntime as CoworkRuntime & { emit: (event: string, ...args: unknown[]) => boolean })
      .emit('btwResult', 'session-1', result);
    expect(listener).toHaveBeenCalledWith('session-1', result);
  });
});
