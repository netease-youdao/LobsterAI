import { beforeEach, describe, expect, test, vi } from 'vitest';

const electronMocks = vi.hoisted(() => {
  const createWebContents = () => {
    let currentUrl = '';
    let zoomFactor = 1;
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const webContents = {
      close: vi.fn(),
      debugger: {
        attach: vi.fn(),
        detach: vi.fn(),
        isAttached: vi.fn(() => false),
        sendCommand: vi.fn(),
      },
      executeJavaScript: vi.fn(),
      focus: vi.fn(),
      getTitle: vi.fn(() => ''),
      getURL: vi.fn(() => currentUrl),
      getZoomFactor: vi.fn(() => zoomFactor),
      isDestroyed: vi.fn(() => false),
      loadURL: vi.fn<(url: string) => Promise<void>>(async url => {
        currentUrl = url;
      }),
      navigationHistory: {
        canGoBack: vi.fn(() => false),
        canGoForward: vi.fn(() => false),
        goBack: vi.fn(),
        goForward: vi.fn(),
      },
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
        return webContents;
      }),
      reload: vi.fn(),
      sendInputEvent: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      setZoomFactor: vi.fn((factor: number) => {
        zoomFactor = factor;
      }),
      stop: vi.fn(),
    };
    return webContents;
  };
  const webContentsInstances: Array<ReturnType<typeof createWebContents>> = [];

  return {
    clearCache: vi.fn<() => Promise<void>>(),
    clearStorageData: vi.fn<() => Promise<void>>(),
    createImageFromBuffer: vi.fn(),
    createWebContents,
    flushStorageData: vi.fn(),
    flushStore: vi.fn<() => Promise<void>>(),
    fromPartition: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    setProxy: vi.fn<() => Promise<void>>(),
    webContentsInstances,
  };
});

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: electronMocks.createImageFromBuffer,
  },
  session: {
    fromPartition: electronMocks.fromPartition,
  },
  WebContentsView: class {
    readonly webContents = electronMocks.createWebContents();
    readonly setBackgroundColor = vi.fn();
    readonly setBounds = vi.fn();

    constructor() {
      electronMocks.webContentsInstances.push(this.webContents);
    }
  },
}));

import {
  type BrowserCredentialLoginState,
  BrowserCredentialLoginStatus,
} from '../../shared/browserCredentials/constants';
import {
  AgentBrowserPageUrl,
  AgentBrowserPartition,
  BrowserDisplayMode,
} from '../../shared/browserWebAccess/constants';
import { AgentBrowserHost, BrowserMcpTool } from './agentBrowserHost';

const createHost = (): AgentBrowserHost => new AgentBrowserHost({
  getMainWindow: () => null,
  getBrowserConfig: () => ({ displayMode: BrowserDisplayMode.InApp }),
  useSystemProxy: () => false,
  emitState: vi.fn(),
  credentialService: {} as never,
  credentialApprovalService: {} as never,
  resolveSessionKey: () => undefined,
});

beforeEach(() => {
  vi.clearAllMocks();
  electronMocks.webContentsInstances.length = 0;
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

describe('AgentBrowserHost', () => {
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

describe('AgentBrowserHost OpenClaw browser baseline', () => {
  test('serializes concurrent cold list requests into one blank page', async () => {
    const host = createHost();

    const results = await Promise.all([
      host.handleToolRequest({ tool: BrowserMcpTool.ListPages, args: {} }),
      host.handleToolRequest({ tool: BrowserMcpTool.ListPages, args: {} }),
      host.handleToolRequest({ tool: BrowserMcpTool.ListPages, args: {} }),
    ]);

    expect(electronMocks.webContentsInstances).toHaveLength(1);
    expect(electronMocks.webContentsInstances[0].loadURL).toHaveBeenCalledOnce();
    expect(electronMocks.webContentsInstances[0].loadURL).toHaveBeenCalledWith(AgentBrowserPageUrl.Blank);
    for (const result of results) {
      expect(result.structuredContent).toEqual({
        pages: [{ id: 1, url: AgentBrowserPageUrl.Blank, selected: true }],
      });
    }
  });

  test('reuses the cold-start page once for the OpenClaw new-page sequence', async () => {
    const host = createHost();
    await host.handleToolRequest({ tool: BrowserMcpTool.ListPages, args: {} });

    const opened = await host.handleToolRequest({
      tool: BrowserMcpTool.NewPage,
      args: { url: AgentBrowserPageUrl.Blank },
    });
    const navigated = await host.handleToolRequest({
      tool: BrowserMcpTool.NavigatePage,
      args: { pageId: 1, url: 'https://example.com/?lobsterai_in_app_regression=1' },
    });

    expect(electronMocks.webContentsInstances).toHaveLength(1);
    expect(opened.structuredContent).toEqual({
      pages: [{ id: 1, url: AgentBrowserPageUrl.Blank, selected: true }],
    });
    expect(navigated.isError).not.toBe(true);
    expect(electronMocks.webContentsInstances[0].loadURL).toHaveBeenNthCalledWith(
      2,
      'https://example.com/?lobsterai_in_app_regression=1',
    );
    expect(host.getState().tabs).toEqual([
      expect.objectContaining({
        pageId: 1,
        url: 'https://example.com/?lobsterai_in_app_regression=1',
        selected: true,
      }),
    ]);

    await host.handleToolRequest({
      tool: BrowserMcpTool.NewPage,
      args: { url: AgentBrowserPageUrl.Blank },
    });
    expect(electronMocks.webContentsInstances).toHaveLength(2);
  });

  test('creates a separate tab for a user blank-page action after OpenClaw initialization', async () => {
    const host = createHost();
    await host.handleToolRequest({ tool: BrowserMcpTool.ListPages, args: {} });

    const state = await host.newPage();

    expect(state.selectedPageId).toBe(2);
    expect(state.tabs).toEqual([
      expect.objectContaining({ pageId: 1, url: AgentBrowserPageUrl.Blank, selected: false }),
      expect.objectContaining({ pageId: 2, url: AgentBrowserPageUrl.Blank, selected: true }),
    ]);
    expect(electronMocks.webContentsInstances).toHaveLength(2);
    expect(electronMocks.webContentsInstances[0].loadURL).toHaveBeenCalledOnce();
  });

  test('preserves the current page and its zoom when the user opens and closes a blank tab', async () => {
    const host = createHost();
    await host.handleToolRequest({ tool: BrowserMcpTool.ListPages, args: {} });
    await host.navigate('https://example.com/original');
    host.setZoomFactor(1.2);

    const newPageState = await host.newPage();

    expect(newPageState.tabs).toEqual([
      expect.objectContaining({
        pageId: 1,
        url: 'https://example.com/original',
        selected: false,
        zoomFactor: 1.2,
      }),
      expect.objectContaining({ pageId: 2, url: AgentBrowserPageUrl.Blank, selected: true }),
    ]);
    const closedState = host.closePage(2);
    expect(closedState.selectedPageId).toBe(1);
    expect(closedState.tabs).toHaveLength(1);
    expect(closedState.tabs[0].zoomFactor).toBe(1.2);
  });

  test('does not reuse the bootstrap page after the user navigates it or closes it', async () => {
    const host = createHost();
    await host.handleToolRequest({ tool: BrowserMcpTool.ListPages, args: {} });
    await host.navigate(AgentBrowserPageUrl.Blank);

    const opened = await host.handleToolRequest({
      tool: BrowserMcpTool.NewPage,
      args: { url: AgentBrowserPageUrl.Blank },
    });
    expect(opened.isError).not.toBe(true);
    expect(host.getState().tabs).toHaveLength(2);

    host.closePage(2);
    host.closePage(1);
    await host.handleToolRequest({ tool: BrowserMcpTool.ListPages, args: {} });
    host.closePage(3);
    const reopened = await host.handleToolRequest({
      tool: BrowserMcpTool.NewPage,
      args: { url: AgentBrowserPageUrl.Blank },
    });
    expect(reopened.structuredContent).toEqual({
      pages: [{ id: 4, url: AgentBrowserPageUrl.Blank, selected: true }],
    });
  });
});
