import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  createDevelopmentMainWindowLoadRecovery,
  MainWindowLoadErrorCode,
} from './mainWindowLoadRecovery';

const RETRY_DELAY_MS = 3_000;
const SLOW_LOAD_WARNING_MS = 30_000;

function createHarness() {
  let targetAvailable = true;
  const loadDevelopmentUrl = vi.fn(() => Promise.resolve());
  const loadErrorPage = vi.fn(() => Promise.resolve());
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };
  const recovery = createDevelopmentMainWindowLoadRecovery({
    isTargetAvailable: () => targetAvailable,
    loadDevelopmentUrl,
    loadErrorPage,
    logger,
    retryDelayMs: RETRY_DELAY_MS,
    slowLoadWarningMs: SLOW_LOAD_WARNING_MS,
  });

  return {
    loadDevelopmentUrl,
    loadErrorPage,
    logger,
    recovery,
    removeTarget: () => {
      targetAvailable = false;
    },
  };
}

function failMainFrame(
  recovery: ReturnType<typeof createDevelopmentMainWindowLoadRecovery>,
  errorCode = -102,
) {
  recovery.handleDidFailLoad({
    errorCode,
    errorDescription: 'ERR_CONNECTION_REFUSED',
    isMainFrame: true,
    validatedUrl: 'http://localhost:5175/',
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('development main-window load recovery', () => {
  test('warns about a slow active load without reloading it', () => {
    const harness = createHarness();

    harness.recovery.start();
    vi.advanceTimersByTime(SLOW_LOAD_WARNING_MS);

    expect(harness.loadDevelopmentUrl).toHaveBeenCalledTimes(1);
    expect(harness.logger.warn).toHaveBeenCalledWith(
      `[Main] development window is still loading after ${SLOW_LOAD_WARNING_MS}ms; waiting without reloading`,
    );
  });

  test('ignores an aborted main-frame navigation', () => {
    const harness = createHarness();

    harness.recovery.start();
    failMainFrame(harness.recovery, MainWindowLoadErrorCode.Aborted);
    vi.advanceTimersByTime(RETRY_DELAY_MS);

    expect(harness.loadDevelopmentUrl).toHaveBeenCalledTimes(1);
    expect(harness.loadErrorPage).not.toHaveBeenCalled();
    expect(harness.logger.error).not.toHaveBeenCalled();
  });

  test('schedules only one retry for duplicate failure signals', () => {
    const harness = createHarness();

    harness.recovery.start();
    failMainFrame(harness.recovery);
    failMainFrame(harness.recovery);
    vi.advanceTimersByTime(RETRY_DELAY_MS);

    expect(harness.loadDevelopmentUrl).toHaveBeenCalledTimes(2);
  });

  test('deduplicates a rejected load promise and its did-fail-load event', async () => {
    const harness = createHarness();
    const connectionError = Object.assign(new Error('ERR_CONNECTION_REFUSED'), {
      code: 'ERR_CONNECTION_REFUSED',
      errno: -102,
    });
    harness.loadDevelopmentUrl.mockRejectedValueOnce(connectionError);

    harness.recovery.start();
    await Promise.resolve();
    failMainFrame(harness.recovery);
    vi.advanceTimersByTime(RETRY_DELAY_MS);

    expect(harness.loadDevelopmentUrl).toHaveBeenCalledTimes(2);
    expect(harness.logger.error).toHaveBeenCalledTimes(1);
  });

  test('shows the fallback page once after the bounded attempts fail', () => {
    const harness = createHarness();

    harness.recovery.start();
    failMainFrame(harness.recovery);
    vi.advanceTimersByTime(RETRY_DELAY_MS);
    failMainFrame(harness.recovery);
    vi.advanceTimersByTime(RETRY_DELAY_MS);
    failMainFrame(harness.recovery);
    failMainFrame(harness.recovery);

    expect(harness.loadDevelopmentUrl).toHaveBeenCalledTimes(3);
    expect(harness.loadErrorPage).toHaveBeenCalledTimes(1);
  });

  test('cancels pending recovery after a successful load', () => {
    const harness = createHarness();

    harness.recovery.start();
    failMainFrame(harness.recovery);
    harness.recovery.handleDidFinishLoad();
    vi.advanceTimersByTime(RETRY_DELAY_MS + SLOW_LOAD_WARNING_MS);

    expect(harness.loadDevelopmentUrl).toHaveBeenCalledTimes(1);
    expect(harness.logger.warn).toHaveBeenCalledTimes(1);
  });

  test('stops the slow-load diagnostic after the first paint', () => {
    const harness = createHarness();

    harness.recovery.start();
    harness.recovery.handleFirstPaint();
    vi.advanceTimersByTime(SLOW_LOAD_WARNING_MS);

    expect(harness.logger.warn).not.toHaveBeenCalled();
  });

  test('does not run stale timers after disposal or target destruction', () => {
    const disposedHarness = createHarness();
    disposedHarness.recovery.start();
    failMainFrame(disposedHarness.recovery);
    disposedHarness.recovery.dispose();

    const destroyedHarness = createHarness();
    destroyedHarness.recovery.start();
    failMainFrame(destroyedHarness.recovery);
    destroyedHarness.removeTarget();

    vi.advanceTimersByTime(RETRY_DELAY_MS + SLOW_LOAD_WARNING_MS);

    expect(disposedHarness.loadDevelopmentUrl).toHaveBeenCalledTimes(1);
    expect(destroyedHarness.loadDevelopmentUrl).toHaveBeenCalledTimes(1);
  });
});
