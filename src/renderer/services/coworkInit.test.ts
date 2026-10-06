import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { coworkService } from './cowork';

type CoworkServiceInternals = {
  initialized: boolean;
  setupStreamListeners: () => void;
  setupOpenClawEngineListeners: () => void;
};

const internals = coworkService as unknown as CoworkServiceInternals;

beforeEach(() => {
  vi.useFakeTimers();
  coworkService.destroy();
  vi.spyOn(internals, 'setupStreamListeners').mockImplementation(() => undefined);
  vi.spyOn(internals, 'setupOpenClawEngineListeners').mockImplementation(() => undefined);
});

afterEach(() => {
  coworkService.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('initialization settles after isolated IPC rejection and timeout', async () => {
  vi.spyOn(coworkService, 'loadConfig').mockRejectedValue(new Error('config unavailable'));
  vi.spyOn(coworkService, 'loadSessions').mockImplementation(
    () => new Promise<void>(() => undefined),
  );
  vi.spyOn(coworkService, 'loadOpenClawEngineStatus').mockResolvedValue(null);

  const initialization = coworkService.init();
  await vi.advanceTimersByTimeAsync(12_001);

  await expect(initialization).resolves.toBeUndefined();
  expect(internals.initialized).toBe(true);
});
