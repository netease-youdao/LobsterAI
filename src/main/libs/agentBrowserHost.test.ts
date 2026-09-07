import { runInNewContext } from 'node:vm';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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
      emit: (event: string, ...args: unknown[]) => listeners.get(event)?.(...args),
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
import { AgentBrowserHost, BrowserCdpCommand, BrowserMcpTool } from './agentBrowserHost';

const createHost = (
  overrides: Partial<ConstructorParameters<typeof AgentBrowserHost>[0]> = {},
): AgentBrowserHost => new AgentBrowserHost({
  getMainWindow: () => null,
  getBrowserConfig: () => ({ displayMode: BrowserDisplayMode.InApp }),
  useSystemProxy: () => false,
  emitState: vi.fn(),
  credentialService: {} as never,
  credentialApprovalService: {} as never,
  resolveSessionKey: () => undefined,
  ...overrides,
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

afterEach(() => {
  vi.restoreAllMocks();
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

describe('AgentBrowserHost script evaluation', () => {
  const scrollFunction = '(el) => { el.scrollIntoView({ block: "center", inline: "center" }); return true; }';

  const setupPage = async (overrides: Parameters<typeof createHost>[0] = {}) => {
    const host = createHost(overrides);
    await host.newPage();
    const webContents = electronMocks.webContentsInstances[0];
    const sendCommand = webContents.debugger.sendCommand;
    const nodes = [
      { nodeId: 'root', backendDOMNodeId: 100, childIds: ['first', 'second'], role: { value: 'RootWebArea' } },
      { nodeId: 'first', parentId: 'root', backendDOMNodeId: 101, role: { value: 'button' } },
      { nodeId: 'second', parentId: 'root', backendDOMNodeId: 102, role: { value: 'button' } },
    ];
    const evaluation: { response: Record<string, unknown> } = { response: { result: { value: true } } };
    sendCommand.mockImplementation(async (command: string, params?: Record<string, unknown>) => {
      switch (command) {
        case BrowserCdpCommand.GetFullAXTree:
          return { nodes };
        case BrowserCdpCommand.ResolveNode:
          return { object: { objectId: `element-${params?.backendNodeId}` } };
        case BrowserCdpCommand.CallFunctionOn:
        case BrowserCdpCommand.Evaluate:
          return evaluation.response;
        default:
          return {};
      }
    });
    const snapshot = await host.handleToolRequest({ tool: BrowserMcpTool.TakeSnapshot, args: { pageId: 1 } });
    const refs = (snapshot.structuredContent?.snapshot as { children: Array<{ id: string }> })
      .children.map(node => node.id);
    const evaluate = (source = scrollFunction, args: unknown[] = [refs[0]]) => host.handleToolRequest({
      tool: BrowserMcpTool.EvaluateScript,
      args: { pageId: 1, function: source, args },
    });
    return { host, webContents, sendCommand, nodes, evaluation, refs, evaluate };
  };

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  test('passes snapshot refs as DOM objects for the OpenClaw scroll action', async () => {
    const { sendCommand, evaluate } = await setupPage();

    const response = await evaluate();

    expect(response).toMatchObject({ content: [{ text: 'true' }] });
    expect(response.isError).not.toBe(true);
    expect(sendCommand).toHaveBeenCalledWith(BrowserCdpCommand.ResolveNode, {
      backendNodeId: 101,
      objectGroup: expect.any(String),
    });
    const call = sendCommand.mock.calls.find(([command]) => command === BrowserCdpCommand.CallFunctionOn)?.[1];
    expect(call).toMatchObject({
      objectId: 'element-101',
      arguments: [{ objectId: 'element-101' }],
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    const scrollIntoView = vi.fn();
    expect(runInNewContext(`(${call.functionDeclaration})`)({ scrollIntoView })).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', inline: 'center' });
    expect(sendCommand).toHaveBeenCalledWith(BrowserCdpCommand.ReleaseObjectGroup, { objectGroup: call.objectGroup });
  });

  test('preserves literal arguments when no DOM refs are supplied', async () => {
    const { sendCommand, evaluate, evaluation } = await setupPage();
    const args = ['plain text', 42, null, true, { nested: ['value'] }];
    evaluation.response = { result: { value: args } };

    const response = await evaluate('async (...values) => values', args);

    const call = sendCommand.mock.calls.find(([command]) => command === BrowserCdpCommand.Evaluate)?.[1];
    await expect(runInNewContext(call.expression)).resolves.toEqual(args);
    expect(response.structuredContent?.message).toBe(JSON.stringify(args));
    expect(sendCommand.mock.calls.some(([command]) => command === BrowserCdpCommand.ResolveNode)).toBe(false);
    expect(sendCommand).toHaveBeenCalledWith(BrowserCdpCommand.ReleaseObjectGroup, { objectGroup: call.objectGroup });
  });

  test('preserves argument order with multiple DOM refs and literal values', async () => {
    const { sendCommand, refs, evaluate } = await setupPage();

    await evaluate('(...values) => values.length', [7, refs[1], 'label', refs[0], { enabled: true }]);

    expect(sendCommand).toHaveBeenCalledWith(BrowserCdpCommand.CallFunctionOn, expect.objectContaining({
      objectId: 'element-102',
      arguments: [
        { value: 7 },
        { objectId: 'element-102' },
        { value: 'label' },
        { objectId: 'element-101' },
        { value: { enabled: true } },
      ],
    }));
    const groups = sendCommand.mock.calls
      .filter(([command]) => command === BrowserCdpCommand.ResolveNode)
      .map(([, params]) => params.objectGroup);
    expect(groups).toHaveLength(2);
    expect(new Set(groups).size).toBe(1);
  });

  test.each([false, true])('rejects stale refs after invalidation (navigation: %s)', async navigation => {
    const { host, webContents, nodes, refs, sendCommand, evaluate } = await setupPage();
    if (navigation) {
      webContents.emit('did-navigate');
    } else {
      nodes.splice(1);
      await host.handleToolRequest({ tool: BrowserMcpTool.TakeSnapshot, args: { pageId: 1 } });
    }

    const response = await evaluate();

    expect(response).toMatchObject({
      isError: true,
      content: [{ text: `Browser element ${refs[0]} is stale. Take a new snapshot and try again.` }],
    });
    expect(sendCommand.mock.calls.some(([command]) => command === BrowserCdpCommand.CallFunctionOn)).toBe(false);
    expect(sendCommand.mock.calls.some(([command]) => command === BrowserCdpCommand.Evaluate)).toBe(false);
  });

  test.each([
    {
      response: { exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: detailed failure' } } },
      message: 'TypeError: detailed failure',
    },
    {
      response: { result: { description: 'Error: remote failure' }, exceptionDetails: { text: 'Uncaught' } },
      message: 'Error: remote failure',
    },
    {
      response: { exceptionDetails: { text: 'Uncaught', exception: { value: 'Thrown string' } } },
      message: 'Thrown string',
    },
    {
      response: { exceptionDetails: { text: 'Evaluation context unavailable' } },
      message: 'Evaluation context unavailable',
    },
  ])('returns actionable exception details: $message', async ({ response, message }) => {
    const { evaluate, evaluation, sendCommand, host } = await setupPage();
    evaluation.response = response;

    expect(await evaluate()).toMatchObject({ isError: true, content: [{ text: message }] });
    expect(sendCommand).toHaveBeenLastCalledWith(BrowserCdpCommand.ReleaseObjectGroup, { objectGroup: expect.any(String) });
    expect(host.getState().error).toBeUndefined();
  });

  test('releases already resolved DOM objects if a later ref cannot be resolved', async () => {
    const { sendCommand, refs, evaluate } = await setupPage();
    const implementation = sendCommand.getMockImplementation()!;
    sendCommand.mockImplementation(async (command, params) => {
      if (command === BrowserCdpCommand.ResolveNode && params.backendNodeId === 102) {
        throw new Error('DOM node is no longer available');
      }
      return implementation(command, params);
    });

    expect(await evaluate('(first, second) => true', refs)).toMatchObject({
      isError: true,
      content: [{ text: 'DOM node is no longer available' }],
    });
    const group = sendCommand.mock.calls.find(([command]) => command === BrowserCdpCommand.ResolveNode)?.[1].objectGroup;
    expect(sendCommand).toHaveBeenLastCalledWith(BrowserCdpCommand.ReleaseObjectGroup, { objectGroup: group });
  });

  test('does not replace the operation result when navigation interrupts object cleanup', async () => {
    const { sendCommand, evaluate, evaluation } = await setupPage();
    const implementation = sendCommand.getMockImplementation()!;
    sendCommand.mockImplementation(async (command, params) => {
      if (command === BrowserCdpCommand.ReleaseObjectGroup) throw new Error('Execution context destroyed');
      return implementation(command, params);
    });

    expect((await evaluate()).isError).not.toBe(true);
    evaluation.response = { exceptionDetails: { text: 'Original failure' } };
    expect(await evaluate()).toMatchObject({ isError: true, content: [{ text: 'Original failure' }] });
  });

  test('keeps the native view attached and free of stale banners after a tool failure', async () => {
    const removeChildView = vi.fn();
    const { host, evaluate, evaluation, webContents } = await setupPage({
      getMainWindow: () => ({
        isVisible: () => true,
        isDestroyed: () => false,
        getContentBounds: () => ({ width: 800, height: 600 }),
        contentView: { addChildView: vi.fn(), removeChildView },
      }) as never,
    });
    host.setView({ visible: true, bounds: { x: 0, y: 80, width: 800, height: 520 } });
    evaluation.response = { exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: tool failure' } } };

    expect((await evaluate()).isError).toBe(true);
    expect(host.getState()).toMatchObject({ visible: true, selectedPageId: 1 });
    expect(host.getState().error).toBeUndefined();
    evaluation.response = { result: { value: true } };
    expect((await evaluate()).isError).not.toBe(true);
    expect(host.getState().error).toBeUndefined();
    expect(removeChildView).not.toHaveBeenCalled();
    expect(webContents.close).not.toHaveBeenCalled();
  });

  test('keeps page load errors separate from subsequent tool successes and failures', async () => {
    const { host, webContents, evaluation, evaluate } = await setupPage();
    webContents.emit('did-fail-load', {}, -2, 'ERR_FAILED', 'https://example.com', true);
    const pageError = host.getState().error;
    expect(pageError).toBe('ERR_FAILED (https://example.com)');

    expect((await evaluate()).isError).not.toBe(true);
    expect(host.getState().error).toBe(pageError);
    evaluation.response = { exceptionDetails: { text: 'Uncaught' } };
    expect((await evaluate()).isError).toBe(true);
    expect(host.getState().error).toBe(pageError);

    webContents.emit('did-start-loading');
    expect(host.getState().error).toBeUndefined();
  });

  test('honors the script evaluation setting for DOM ref arguments', async () => {
    const { evaluate, sendCommand } = await setupPage({
      getBrowserConfig: () => ({ displayMode: BrowserDisplayMode.InApp, evaluateEnabled: false }),
    });
    sendCommand.mockClear();

    expect((await evaluate()).isError).toBe(true);
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
