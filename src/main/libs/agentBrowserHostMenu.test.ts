import { beforeEach, describe, expect, test, vi } from 'vitest';

const electronMocks = vi.hoisted(() => ({
  browserWindow: vi.fn(),
  nativeTheme: {
    shouldUseDarkColors: true,
  },
}));

vi.mock('electron', () => ({
  BrowserWindow: electronMocks.browserWindow,
  nativeTheme: electronMocks.nativeTheme,
}));

import { AgentBrowserHostMenuAction } from '../../shared/browserWebAccess/constants';
import {
  buildAgentBrowserHostMenuHtml,
  parseAgentBrowserHostMenuActionUrl,
  showAgentBrowserHostMenu,
} from './agentBrowserHostMenu';

type TestEventHandler = (...args: unknown[]) => unknown;

describe('Agent browser host menu', () => {
  let destroyed: boolean;
  let menuWindowHandlers: Map<string, TestEventHandler>;
  let webContentsHandlers: Map<string, TestEventHandler>;
  let targetWindowHandlers: Map<string, TestEventHandler>;
  let menuWindow: {
    close: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
    loadURL: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    setMenuBarVisibility: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    webContents: {
      executeJavaScript: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      setWindowOpenHandler: ReturnType<typeof vi.fn>;
    };
  };
  let targetWindow: {
    getContentBounds: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    destroyed = false;
    menuWindowHandlers = new Map();
    webContentsHandlers = new Map();
    targetWindowHandlers = new Map();
    menuWindow = {
      close: vi.fn(() => {
        if (destroyed) return;
        destroyed = true;
        menuWindowHandlers.get('closed')?.();
      }),
      focus: vi.fn(),
      isDestroyed: vi.fn(() => destroyed),
      loadURL: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((event: string, handler: TestEventHandler) => {
        menuWindowHandlers.set(event, handler);
      }),
      setMenuBarVisibility: vi.fn(),
      show: vi.fn(),
      webContents: {
        executeJavaScript: vi.fn().mockResolvedValue(undefined),
        on: vi.fn((event: string, handler: TestEventHandler) => {
          webContentsHandlers.set(event, handler);
        }),
        setWindowOpenHandler: vi.fn(),
      },
    };
    targetWindow = {
      getContentBounds: vi.fn(() => ({ x: 100, y: 200, width: 800, height: 600 })),
      once: vi.fn((event: string, handler: TestEventHandler) => {
        targetWindowHandlers.set(event, handler);
      }),
      removeListener: vi.fn((event: string) => {
        targetWindowHandlers.delete(event);
      }),
    };
    electronMocks.browserWindow.mockImplementation(function BrowserWindowMock() {
      return menuWindow;
    });
  });

  test('renders inline zoom controls like the browser menu reference', () => {
    const html = buildAgentBrowserHostMenuHtml({
      hasPage: true,
      zoomFactor: 1,
      darkMode: true,
    });

    expect(html).toContain('id="zoom-out"');
    expect(html).toContain('id="zoom-value"');
    expect(html).toContain('id="zoom-in"');
    expect(html).toContain('100%');
    expect(html).toContain('lobster-agent-browser-menu://action/zoom-out');
    expect(html).toContain('lobster-agent-browser-menu://action/zoom-in');
  });

  test('parses only supported browser menu action URLs', () => {
    expect(parseAgentBrowserHostMenuActionUrl(
      'lobster-agent-browser-menu://action/reset-zoom',
    )).toBe(AgentBrowserHostMenuAction.ResetZoom);
    expect(parseAgentBrowserHostMenuActionUrl(
      'lobster-agent-browser-menu://action/unknown',
    )).toBeUndefined();
    expect(parseAgentBrowserHostMenuActionUrl('https://example.com')).toBeUndefined();
  });

  test('keeps the popup open across zoom clicks and returns the next page action', async () => {
    const onZoomAction = vi.fn().mockResolvedValue(1.1);
    const responsePromise = showAgentBrowserHostMenu({
      targetWindow: targetWindow as never,
      position: { x: 576, y: 80 },
      hasPage: true,
      zoomFactor: 1,
      onZoomAction,
    });

    await vi.waitFor(() => expect(menuWindow.show).toHaveBeenCalledOnce());
    const preventDefault = vi.fn();
    webContentsHandlers.get('will-navigate')?.(
      { preventDefault },
      'lobster-agent-browser-menu://action/zoom-in',
    );
    await vi.waitFor(() => expect(onZoomAction).toHaveBeenCalledWith(
      AgentBrowserHostMenuAction.ZoomIn,
    ));

    expect(menuWindow.close).not.toHaveBeenCalled();
    expect(menuWindow.webContents.executeJavaScript).toHaveBeenCalledOnce();

    webContentsHandlers.get('will-navigate')?.(
      { preventDefault },
      'lobster-agent-browser-menu://action/new-blank-page',
    );

    await expect(responsePromise).resolves.toEqual({
      success: true,
      action: AgentBrowserHostMenuAction.NewBlankPage,
      zoomFactor: 1.1,
    });
    expect(electronMocks.browserWindow).toHaveBeenCalledWith(expect.objectContaining({
      parent: targetWindow,
      x: 676,
      y: 280,
      width: 224,
      height: 208,
      frame: false,
      transparent: true,
    }));
  });
});
