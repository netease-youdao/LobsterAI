import { beforeEach, describe, expect, test, vi } from 'vitest';

const electronMocks = vi.hoisted(() => {
  const createWebContents = () => {
    let currentUrl = '';
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
      stop: vi.fn(),
    };
    return webContents;
  };
  const webContentsInstances: Array<ReturnType<typeof createWebContents>> = [];

  return {
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
  AgentBrowserPartition,
  BrowserDisplayMode,
} from '../../shared/browserWebAccess/constants';
import { AgentBrowserHost } from './agentBrowserHost';

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
  electronMocks.flushStore.mockResolvedValue();
  electronMocks.setProxy.mockResolvedValue();
  electronMocks.fromPartition.mockReturnValue({
    cookies: {
      flushStore: electronMocks.flushStore,
    },
    flushStorageData: electronMocks.flushStorageData,
    setPermissionCheckHandler: electronMocks.setPermissionCheckHandler,
    setPermissionRequestHandler: electronMocks.setPermissionRequestHandler,
    setProxy: electronMocks.setProxy,
  });
});

describe('AgentBrowserHost persistent storage', () => {
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
});

describe('AgentBrowserHost OpenClaw browser baseline', () => {
  test('serializes concurrent cold list requests into one blank page', async () => {
    const host = createHost();

    const results = await Promise.all([
      host.handleToolRequest({ tool: 'list_pages', args: {} }),
      host.handleToolRequest({ tool: 'list_pages', args: {} }),
      host.handleToolRequest({ tool: 'list_pages', args: {} }),
    ]);

    expect(electronMocks.webContentsInstances).toHaveLength(1);
    expect(electronMocks.webContentsInstances[0].loadURL).toHaveBeenCalledOnce();
    expect(electronMocks.webContentsInstances[0].loadURL).toHaveBeenCalledWith('about:blank');
    for (const result of results) {
      expect(result.structuredContent).toEqual({
        pages: [{ id: 1, url: 'about:blank', selected: true }],
      });
    }
  });

  test('reuses the cold-start page once for the OpenClaw new-page sequence', async () => {
    const host = createHost();
    await host.handleToolRequest({ tool: 'list_pages', args: {} });

    const opened = await host.handleToolRequest({
      tool: 'new_page',
      args: { url: 'about:blank' },
    });
    const navigated = await host.handleToolRequest({
      tool: 'navigate_page',
      args: { pageId: 1, url: 'https://example.com/?lobsterai_in_app_regression=1' },
    });

    expect(electronMocks.webContentsInstances).toHaveLength(1);
    expect(opened.structuredContent).toEqual({
      pages: [{ id: 1, url: 'about:blank', selected: true }],
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

    await host.handleToolRequest({ tool: 'new_page', args: { url: 'about:blank' } });
    expect(electronMocks.webContentsInstances).toHaveLength(2);
  });
});
