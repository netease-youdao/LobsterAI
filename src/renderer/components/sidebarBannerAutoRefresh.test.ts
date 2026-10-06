import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  SIDEBAR_BANNER_REFRESH_MIN_INTERVAL_MS,
  startSidebarBannerAutoRefresh,
} from './sidebarBannerAutoRefresh';

const installWindowMocks = () => {
  const windowTarget = new EventTarget();
  const documentTarget = new EventTarget() as EventTarget & {
    visibilityState: DocumentVisibilityState;
    hasFocus: () => boolean;
  };
  documentTarget.visibilityState = 'hidden';
  documentTarget.hasFocus = () => false;
  vi.stubGlobal('window', windowTarget);
  vi.stubGlobal('document', documentTarget);
};

describe('sidebar banner auto refresh', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('keeps the five-minute fallback active while the window is in background', async () => {
    installWindowMocks();
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const refresh = vi.fn().mockResolvedValue(true);

    const stop = startSidebarBannerAutoRefresh(refresh);
    await vi.advanceTimersByTimeAsync(SIDEBAR_BANNER_REFRESH_MIN_INTERVAL_MS);

    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });

  test('does not overlap fallback requests', async () => {
    installWindowMocks();
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    let resolveRefresh: ((success: boolean) => void) | undefined;
    const refresh = vi.fn(() => new Promise<boolean>(resolve => {
      resolveRefresh = resolve;
    }));

    const stop = startSidebarBannerAutoRefresh(refresh);
    await vi.advanceTimersByTimeAsync(SIDEBAR_BANNER_REFRESH_MIN_INTERVAL_MS * 2);

    expect(refresh).toHaveBeenCalledTimes(1);
    resolveRefresh?.(true);
    await Promise.resolve();
    stop();
  });
});
