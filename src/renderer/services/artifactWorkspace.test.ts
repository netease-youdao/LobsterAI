import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  ArtifactBrowserWindowOpenDisposition,
  type ArtifactBrowserWindowOpenEvent,
} from '../../shared/artifactPreview/constants';
import { subscribeArtifactBrowserWindowOpen } from './artifactWorkspace';

describe('subscribeArtifactBrowserWindowOpen', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    if (originalWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  test('multiplexes multiple tab subscribers onto a single IPC listener and unsubscribes cleanly', () => {
    let ipcCallback: ((event: ArtifactBrowserWindowOpenEvent) => void) | undefined;
    const unsubscribeIpc = vi.fn();
    const onBrowserWindowOpen = vi.fn((callback: (event: ArtifactBrowserWindowOpenEvent) => void) => {
      ipcCallback = callback;
      return unsubscribeIpc;
    });

    (globalThis as { window?: unknown }).window = {
      electron: {
        artifact: {
          onBrowserWindowOpen,
        },
      },
    };

    const listenerA = vi.fn();
    const listenerB = vi.fn();
    const offA = subscribeArtifactBrowserWindowOpen(listenerA);
    const offB = subscribeArtifactBrowserWindowOpen(listenerB);

    expect(onBrowserWindowOpen).toHaveBeenCalledTimes(1);

    const payload: ArtifactBrowserWindowOpenEvent = {
      webContentsId: 9,
      url: 'https://www.baidu.com/s?wd=test',
      disposition: ArtifactBrowserWindowOpenDisposition.ForegroundTab,
      referrer: 'https://www.baidu.com/',
    };
    ipcCallback?.(payload);

    expect(listenerA).toHaveBeenCalledWith(payload);
    expect(listenerB).toHaveBeenCalledWith(payload);

    offA();
    expect(unsubscribeIpc).not.toHaveBeenCalled();

    offB();
    expect(unsubscribeIpc).toHaveBeenCalledTimes(1);

    // Subscribing again re-registers the underlying IPC listener.
    const listenerC = vi.fn();
    const offC = subscribeArtifactBrowserWindowOpen(listenerC);
    expect(onBrowserWindowOpen).toHaveBeenCalledTimes(2);
    offC();
    expect(unsubscribeIpc).toHaveBeenCalledTimes(2);
  });
});
