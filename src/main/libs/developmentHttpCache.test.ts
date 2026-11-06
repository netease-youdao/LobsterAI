import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  clearLegacyDevelopmentServerHttpCache,
  DEVELOPMENT_HTTP_CACHE_MARKER_FILE,
} from './developmentHttpCache';

describe('clearLegacyDevelopmentServerHttpCache', () => {
  let userDataPath: string;
  let markerPath: string;

  beforeEach(() => {
    userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-http-cache-'));
    markerPath = path.join(userDataPath, DEVELOPMENT_HTTP_CACHE_MARKER_FILE);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(userDataPath, { recursive: true, force: true });
  });

  test('clears only the dev server origin and records the marker', async () => {
    const clearData = vi.fn().mockResolvedValue(undefined);

    await clearLegacyDevelopmentServerHttpCache({
      session: { clearData },
      serverUrl: 'http://localhost:5175/',
      userDataPath,
    });

    expect(clearData).toHaveBeenCalledTimes(1);
    expect(clearData).toHaveBeenCalledWith({
      dataTypes: ['cache'],
      origins: ['http://localhost:5175'],
    });
    expect(fs.existsSync(markerPath)).toBe(true);
  });

  test('does nothing once the marker exists', async () => {
    fs.writeFileSync(markerPath, 'done\n');
    const clearData = vi.fn().mockResolvedValue(undefined);

    await clearLegacyDevelopmentServerHttpCache({
      session: { clearData },
      serverUrl: 'http://localhost:5175',
      userDataPath,
    });

    expect(clearData).not.toHaveBeenCalled();
  });

  test('resolves without a marker when clearing fails', async () => {
    const clearData = vi.fn().mockRejectedValue(new Error('cache busy'));

    await expect(clearLegacyDevelopmentServerHttpCache({
      session: { clearData },
      serverUrl: 'http://localhost:5175',
      userDataPath,
    })).resolves.toBeUndefined();

    expect(console.warn).toHaveBeenCalled();
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  test('resolves without a marker when clearing throws synchronously', async () => {
    const clearData = vi.fn().mockImplementation(() => { throw new Error('session gone'); });

    await expect(clearLegacyDevelopmentServerHttpCache({
      session: { clearData },
      serverUrl: 'http://localhost:5175',
      userDataPath,
    })).resolves.toBeUndefined();

    expect(fs.existsSync(markerPath)).toBe(false);
  });

  test('continues startup after the timeout and records the marker once the clear finishes', async () => {
    vi.useFakeTimers();
    let finishClear: () => void = () => {};
    const clearData = vi.fn().mockReturnValue(new Promise<void>(resolve => { finishClear = resolve; }));

    const pending = clearLegacyDevelopmentServerHttpCache({
      session: { clearData },
      serverUrl: 'http://localhost:5175',
      userDataPath,
      timeoutMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toBeUndefined();
    expect(fs.existsSync(markerPath)).toBe(false);

    finishClear();
    await vi.waitFor(() => expect(fs.existsSync(markerPath)).toBe(true));
  });

  test('skips an invalid dev server URL', async () => {
    const clearData = vi.fn().mockResolvedValue(undefined);

    await clearLegacyDevelopmentServerHttpCache({
      session: { clearData },
      serverUrl: 'not a url',
      userDataPath,
    });

    expect(clearData).not.toHaveBeenCalled();
    expect(fs.existsSync(markerPath)).toBe(false);
  });
});
