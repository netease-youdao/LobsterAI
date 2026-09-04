import { beforeEach, describe, expect, test, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  clearCache: vi.fn<() => Promise<void>>(),
  clearStorageData: vi.fn<() => Promise<void>>(),
  createImageFromBuffer: vi.fn(),
  flushStorageData: vi.fn(),
  flushStore: vi.fn<() => Promise<void>>(),
  fromPartition: vi.fn(),
  setPermissionCheckHandler: vi.fn(),
  setPermissionRequestHandler: vi.fn(),
  setProxy: vi.fn<() => Promise<void>>(),
}));

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: electronMocks.createImageFromBuffer,
  },
  session: {
    fromPartition: electronMocks.fromPartition,
  },
  WebContentsView: class {},
}));

import {
  type BrowserCredentialLoginState,
  BrowserCredentialLoginStatus,
} from '../../shared/browserCredentials/constants';
import { AgentBrowserPartition } from '../../shared/browserWebAccess/constants';
import { AgentBrowserHost } from './agentBrowserHost';

const createHost = (): AgentBrowserHost => new AgentBrowserHost({
  getMainWindow: () => null,
  getBrowserConfig: () => undefined,
  useSystemProxy: () => false,
  emitState: vi.fn(),
  credentialService: {} as never,
  credentialApprovalService: {} as never,
  resolveSessionKey: () => undefined,
});

describe('AgentBrowserHost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electronMocks.clearCache.mockResolvedValue();
    electronMocks.clearStorageData.mockResolvedValue();
    electronMocks.createImageFromBuffer.mockReset();
    electronMocks.flushStore.mockResolvedValue();
    electronMocks.setProxy.mockResolvedValue();
    electronMocks.fromPartition.mockReturnValue({
      cookies: {
        flushStore: electronMocks.flushStore,
      },
      clearCache: electronMocks.clearCache,
      clearStorageData: electronMocks.clearStorageData,
      flushStorageData: electronMocks.flushStorageData,
      setPermissionCheckHandler: electronMocks.setPermissionCheckHandler,
      setPermissionRequestHandler: electronMocks.setPermissionRequestHandler,
      setProxy: electronMocks.setProxy,
    });
  });

  test('uses a persistent Electron partition for in-app pages', () => {
    createHost();

    expect(electronMocks.fromPartition).toHaveBeenCalledWith(
      AgentBrowserPartition.Default,
      { cache: true },
    );
    expect(AgentBrowserPartition.Default).toMatch(/^persist:/);
  });

  test('flushes cookies and DOM storage before shutdown completes', async () => {
    let finishCookieFlush: (() => void) | undefined;
    electronMocks.flushStore.mockReturnValue(new Promise(resolve => {
      finishCookieFlush = resolve;
    }));
    const host = createHost();

    let disposed = false;
    const disposePromise = host.dispose().then(() => {
      disposed = true;
    });
    await new Promise<void>(resolve => { setImmediate(resolve); });

    expect(electronMocks.flushStorageData).toHaveBeenCalledOnce();
    expect(electronMocks.flushStore).toHaveBeenCalledOnce();
    expect(disposed).toBe(false);

    finishCookieFlush?.();
    await disposePromise;

    expect(disposed).toBe(true);
  });

  test('dismisses a completed saved-credential login status', () => {
    const host = createHost();
    const hostState = host as unknown as {
      credentialLoginState?: BrowserCredentialLoginState;
    };
    hostState.credentialLoginState = {
      status: BrowserCredentialLoginStatus.Failed,
      origin: 'https://example.com',
    };

    expect(host.getState().credentialLogin).toBeDefined();

    const state = host.dismissCredentialLoginStatus();

    expect(state.credentialLogin).toBeUndefined();
    expect(host.getState().credentialLogin).toBeUndefined();
  });

  test('clears cookies and cache from the Agent browser partition', async () => {
    const host = createHost();

    await host.clearCookies();
    await host.clearCache();

    expect(electronMocks.clearStorageData).toHaveBeenCalledWith({
      storages: ['cookies'],
    });
    expect(electronMocks.flushStore).toHaveBeenCalledOnce();
    expect(electronMocks.clearCache).toHaveBeenCalledOnce();
  });

  test('clamps zoom for the selected page', () => {
    let zoomFactor = 1;
    const setZoomFactor = vi.fn((factor: number) => {
      zoomFactor = factor;
    });
    const page = {
      pageId: 1,
      loading: false,
      refs: new Map(),
      view: {
        webContents: {
          getTitle: () => 'Example',
          getURL: () => 'https://example.com',
          getZoomFactor: () => zoomFactor,
          isDestroyed: () => false,
          navigationHistory: {
            canGoBack: () => false,
            canGoForward: () => false,
          },
          setZoomFactor,
        },
      },
    };
    const host = createHost();
    const hostState = host as unknown as {
      pages: Map<number, typeof page>;
      selectedPageId?: number;
    };
    hostState.pages.set(page.pageId, page);
    hostState.selectedPageId = page.pageId;

    const state = host.setZoomFactor(10);

    expect(setZoomFactor).toHaveBeenCalledWith(3);
    expect(state.tabs[0]?.zoomFactor).toBe(3);
  });

  test('captures the selected page for clipboard export', async () => {
    const image = { isEmpty: () => false };
    const sendCommand = vi.fn(async (method: string) => (
      method === 'Page.captureScreenshot' ? { data: Buffer.from('image').toString('base64') } : {}
    ));
    electronMocks.createImageFromBuffer.mockReturnValue(image);
    const page = {
      pageId: 1,
      loading: false,
      refs: new Map(),
      view: {
        webContents: {
          debugger: {
            attach: vi.fn(),
            isAttached: () => false,
            sendCommand,
          },
        },
      },
    };
    const host = createHost();
    const hostState = host as unknown as {
      pages: Map<number, typeof page>;
      selectedPageId?: number;
    };
    hostState.pages.set(page.pageId, page);
    hostState.selectedPageId = page.pageId;

    await expect(host.captureScreenshot()).resolves.toBe(image);
    expect(sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    expect(electronMocks.createImageFromBuffer).toHaveBeenCalledWith(Buffer.from('image'));
  });

  test('selects the adjacent page when closing the active tab', () => {
    const createPage = (pageId: number) => ({
      pageId,
      loading: false,
      refs: new Map(),
      view: {
        webContents: {
          close: vi.fn(),
          debugger: {
            detach: vi.fn(),
            isAttached: () => false,
          },
          getTitle: () => `Page ${pageId}`,
          getURL: () => `https://example.com/${pageId}`,
          getZoomFactor: () => 1,
          isDestroyed: () => false,
          navigationHistory: {
            canGoBack: () => false,
            canGoForward: () => false,
          },
        },
      },
    });
    const pages = [createPage(1), createPage(2), createPage(3)];
    const host = createHost();
    const hostState = host as unknown as {
      pages: Map<number, (typeof pages)[number]>;
      selectedPageId?: number;
    };
    for (const page of pages) hostState.pages.set(page.pageId, page);
    hostState.selectedPageId = 2;

    const stateAfterMiddleClose = host.closePage(2);
    const stateAfterRightClose = host.closePage(3);

    expect(stateAfterMiddleClose.selectedPageId).toBe(3);
    expect(stateAfterRightClose.selectedPageId).toBe(1);
  });
});
