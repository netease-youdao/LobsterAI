import { EventEmitter } from 'events';
import { describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({ WebContentsView: class {} }));

import { BrowserDisplayMode } from '../../shared/browserWebAccess/constants';
import {
  createDetachedPage,
  isNavigationAbortedError,
  navigateWebContents,
  WebSearchEngine,
  WebSearchHost,
  type WebSearchPage,
  type WebSearchPageContext,
  WebSearchPageErrorCode,
  WebSearchPageOp,
  type WebSearchViewLike,
  type WebSearchWebContents,
} from './webSearchHost';

const createFakePage = (options: {
  selectorFound?: boolean;
  results?: unknown[];
  redirectUrl?: string;
  googleUnavailable?: boolean;
} = {}) => {
  let currentUrl = '';
  const navigations: string[] = [];
  const page: WebSearchPage = {
    navigate: vi.fn(async (url: string) => {
      currentUrl = options.redirectUrl ?? url;
      navigations.push(url);
    }),
    evaluate: vi.fn(async (script: string) => {
      if (script.startsWith('Boolean(document.querySelector(')) return options.selectorFound ?? true;
      if (script.includes('document.body.innerText) || ""')) return 'page text';
      if (script.includes('unusual traffic')) return options.googleUnavailable ?? false;
      return options.results ?? [];
    }) as WebSearchPage['evaluate'],
    url: () => currentUrl,
    isDestroyed: () => false,
    destroy: vi.fn(),
  };
  return { page, navigations };
};

const createHost = (
  page: WebSearchPage,
  overrides: {
    displayMode?: BrowserDisplayMode;
    isAllowedUrl?: (url: string) => boolean;
    isSkillEnabled?: () => boolean;
  } = {},
) => {
  const createPage = vi.fn(() => page);
  const context = {
    session: {},
    whenReady: async () => {},
    isAllowedUrl: overrides.isAllowedUrl ?? (() => true),
  } as unknown as WebSearchPageContext;
  const host = new WebSearchHost({
    getBrowserConfig: () => ({ displayMode: overrides.displayMode ?? BrowserDisplayMode.InApp }),
    getPageContext: () => context,
    isSkillEnabled: overrides.isSkillEnabled,
    createPage,
  });
  return { host, createPage };
};

describe('WebSearchHost', () => {
  test('refuses every operation while the external browser mode is selected', async () => {
    const { page } = createFakePage();
    const { host, createPage } = createHost(page, { displayMode: BrowserDisplayMode.External });

    const response = await host.handleRequest({
      op: WebSearchPageOp.Search,
      engine: WebSearchEngine.Bing,
      query: 'lobster',
    });

    expect(response).toMatchObject({ success: false, code: WebSearchPageErrorCode.Disabled });
    expect(createPage).not.toHaveBeenCalled();
  });

  test('reports status without creating the hidden page', async () => {
    const { page } = createFakePage();
    const { host, createPage } = createHost(page);

    await expect(host.handleRequest({ op: WebSearchPageOp.Status })).resolves.toEqual({
      success: true,
      data: { active: true },
    });
    expect(createPage).not.toHaveBeenCalled();
  });

  test('searches in the hidden page and returns the extracted results', async () => {
    const results = [{ title: 'T3 Code', url: 'https://example.com/', snippet: '', source: 'bing', position: 1 }];
    const { page, navigations } = createFakePage({ results });
    const { host } = createHost(page);

    const response = await host.handleRequest({
      op: WebSearchPageOp.Search,
      engine: WebSearchEngine.Bing,
      query: 't3 code 是什么',
      maxResults: 5,
    });

    expect(navigations).toEqual([`https://www.bing.com/search?q=${encodeURIComponent('t3 code 是什么')}`]);
    expect(response).toMatchObject({
      success: true,
      data: { query: 't3 code 是什么', engine: 'bing', results, totalResults: 1 },
    });
    host.dispose();
  });

  test('reuses one page across requests', async () => {
    const { page } = createFakePage({ results: [{ title: 'a', url: 'https://a.example/' }] });
    const { host, createPage } = createHost(page);

    await host.handleRequest({ op: WebSearchPageOp.Search, engine: WebSearchEngine.Bing, query: 'one' });
    await host.handleRequest({ op: WebSearchPageOp.Search, engine: WebSearchEngine.Google, query: 'two' });

    expect(createPage).toHaveBeenCalledTimes(1);
    host.dispose();
    expect(page.destroy).toHaveBeenCalledTimes(1);
  });

  test('fails a Google search without parsable results so the caller can fall back', async () => {
    const { page } = createFakePage({ results: [] });
    const { host } = createHost(page);

    const response = await host.handleRequest({
      op: WebSearchPageOp.Search,
      engine: WebSearchEngine.Google,
      query: 'lobster',
    });

    expect(response).toEqual({ success: false, error: 'Google returned no parsable results' });
    host.dispose();
  });

  test.each([
    { redirectUrl: 'https://consent.google.com/m', unavailable: true },
    { redirectUrl: 'https://www.google.com/sorry/index', unavailable: true },
    { redirectUrl: 'https://consent.google.com.example.com/', unavailable: false },
    { redirectUrl: 'https://fake-consent.google.com/', unavailable: false },
    { redirectUrl: 'https://consent.google.com@example.com/', unavailable: false },
    { redirectUrl: 'https://www.google.com/search?q=consent.google.com/sorry', unavailable: false },
    { redirectUrl: 'https://example.com/sorry', unavailable: false },
    { redirectUrl: 'https://www.google.com/sorry-example', unavailable: false },
    { redirectUrl: 'about:blank', unavailable: true, googleUnavailable: true },
  ])('classifies a Google result timeout at $redirectUrl', async ({ redirectUrl, unavailable, googleUnavailable }) => {
    vi.useFakeTimers();
    const { page } = createFakePage({ selectorFound: false, redirectUrl, googleUnavailable });
    const { host } = createHost(page);
    try {
      const response = host.handleRequest({
        op: WebSearchPageOp.Search,
        engine: WebSearchEngine.Google,
        query: 'lobster',
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(response).resolves.toEqual({
        success: false,
        error: unavailable
          ? 'Google appears blocked or unavailable from this network'
          : 'Google search results did not load in time',
      });
    } finally {
      host.dispose();
      vi.useRealTimers();
    }
  });

  test('rejects unknown engines, non-http URLs and policy-blocked hosts', async () => {
    const { page, navigations } = createFakePage();
    const { host } = createHost(page, { isAllowedUrl: url => !url.includes('blocked.example') });

    await expect(host.handleRequest({ op: WebSearchPageOp.Search, engine: 'duck', query: 'x' }))
      .resolves.toMatchObject({ success: false, error: 'Unsupported search engine: duck' });
    await expect(host.handleRequest({ op: WebSearchPageOp.Navigate, url: 'file:///etc/passwd' }))
      .resolves.toMatchObject({ success: false });
    await expect(host.handleRequest({ op: WebSearchPageOp.Navigate, url: 'https://blocked.example/' }))
      .resolves.toMatchObject({
        success: false,
        error: 'Navigation was blocked by the LobsterAI browser access policy.',
      });
    await expect(host.handleRequest({ op: 'evaluate', script: 'alert(1)' }))
      .resolves.toMatchObject({ success: false });

    expect(navigations).toEqual([]);
    host.dispose();
  });

  test('reads text only after a document has been loaded', async () => {
    const { page } = createFakePage();
    const { host } = createHost(page);

    await expect(host.handleRequest({ op: WebSearchPageOp.Text }))
      .resolves.toEqual({ success: true, data: { text: '' } });

    await host.handleRequest({ op: WebSearchPageOp.Navigate, url: 'https://example.com/' });
    await expect(host.handleRequest({ op: WebSearchPageOp.Text }))
      .resolves.toEqual({ success: true, data: { text: 'page text' } });
    host.dispose();
  });

  test('refuses status and search and disposes the hidden page when web-search skill is disabled', async () => {
    let enabled = true;
    const { page } = createFakePage({ results: [{ title: 'Ok', url: 'https://ok.example/' }] });
    const { host, createPage } = createHost(page, { isSkillEnabled: () => enabled });

    await expect(host.handleRequest({ op: WebSearchPageOp.Search, engine: WebSearchEngine.Bing, query: 'hi' }))
      .resolves.toMatchObject({ success: true });
    expect(createPage).toHaveBeenCalledTimes(1);

    enabled = false;
    await expect(host.handleRequest({ op: WebSearchPageOp.Status })).resolves.toMatchObject({
      success: false,
      code: WebSearchPageErrorCode.SkillDisabled,
    });
    expect(page.destroy).toHaveBeenCalledTimes(1);

    await expect(host.handleRequest({ op: WebSearchPageOp.Search, engine: WebSearchEngine.Bing, query: 'hi' }))
      .resolves.toMatchObject({
        success: false,
        code: WebSearchPageErrorCode.SkillDisabled,
      });
  });

  test('recreates a fresh hidden page after a renderer crash destroys the previous detached page', async () => {
    const createMockView = () => {
      const emitter = new EventEmitter();
      let destroyed = false;
      let currentUrl = '';
      const webContents: WebSearchWebContents = {
        loadURL: vi.fn(async (url: string) => {
          currentUrl = url;
          emitter.emit('did-navigate', {}, url);
          emitter.emit('dom-ready');
        }),
        executeJavaScript: vi.fn(async (script: string) => {
          if (script.startsWith('Boolean(document.querySelector(')) return true;
          return [{ title: 'Recovered', url: 'https://recovered.example/', snippet: '', source: 'bing', position: 1 }];
        }),
        getURL: () => currentUrl,
        isDestroyed: () => destroyed,
        isLoading: () => false,
        isLoadingMainFrame: () => false,
        stop: vi.fn(),
        close: vi.fn(() => {
          if (destroyed) return;
          destroyed = true;
          emitter.emit('destroyed');
        }),
        setAudioMuted: vi.fn(),
        setWindowOpenHandler: vi.fn(),
        on: (event, listener) => emitter.on(event, listener),
        removeListener: (event, listener) => emitter.removeListener(event, listener),
      };
      const view: WebSearchViewLike = {
        webContents,
        setBounds: vi.fn(),
      };
      return { view, emitter, webContents };
    };

    const views = [createMockView(), createMockView()];
    let index = 0;
    const context = {
      session: {},
      whenReady: async () => {},
      isAllowedUrl: () => true,
    } as unknown as WebSearchPageContext;
    const host = new WebSearchHost({
      getBrowserConfig: () => ({ displayMode: BrowserDisplayMode.InApp }),
      getPageContext: () => context,
      createPage: ctx => createDetachedPage(ctx, () => views[index++].view),
    });

    await expect(host.handleRequest({ op: WebSearchPageOp.Search, engine: WebSearchEngine.Bing, query: 'first' }))
      .resolves.toMatchObject({ success: true, data: { totalResults: 1 } });
    expect(index).toBe(1);

    // Simulate renderer crash on the first view -> closed & marked destroyed.
    views[0].emitter.emit('render-process-gone');
    expect(views[0].webContents.close).toHaveBeenCalledTimes(1);

    // Next search transparently recreates a healthy page instead of throwing "Object has been destroyed".
    await expect(host.handleRequest({ op: WebSearchPageOp.Search, engine: WebSearchEngine.Bing, query: 'second' }))
      .resolves.toMatchObject({ success: true, data: { totalResults: 1 } });
    expect(index).toBe(2);
    host.dispose();
  });
});

const createMockWebContents = (overrides: Partial<WebSearchWebContents> = {}) => {
  const emitter = new EventEmitter();
  let destroyed = false;
  let loading = false;
  let loadingMainFrame = false;
  let currentUrl = '';

  const webContents: WebSearchWebContents = {
    loadURL: vi.fn(() => new Promise<void>(() => {})),
    executeJavaScript: vi.fn(async () => null),
    getURL: () => currentUrl,
    isDestroyed: () => destroyed,
    isLoading: () => loading,
    isLoadingMainFrame: () => loadingMainFrame,
    stop: vi.fn(() => {
      loading = false;
      loadingMainFrame = false;
    }),
    close: vi.fn(() => {
      destroyed = true;
      emitter.emit('destroyed');
    }),
    setAudioMuted: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    on: (event, listener) => emitter.on(event, listener),
    removeListener: (event, listener) => emitter.removeListener(event, listener),
    ...overrides,
  };

  return {
    webContents,
    emitter,
    setDestroyed: (value: boolean) => { destroyed = value; },
    setLoading: (value: boolean) => { loading = value; },
    setLoadingMainFrame: (value: boolean) => { loadingMainFrame = value; },
    setUrl: (value: string) => { currentUrl = value; },
  };
};

describe('navigateWebContents', () => {
  test('identifies ERR_ABORTED (-3) errors by errno, code, or message', () => {
    expect(isNavigationAbortedError(Object.assign(new Error('load failed'), { errno: -3 }))).toBe(true);
    expect(isNavigationAbortedError(Object.assign(new Error('load failed'), { code: 'ERR_ABORTED' }))).toBe(true);
    expect(isNavigationAbortedError(new Error("ERR_ABORTED (-3) loading 'https://www.google.com/search?q=test&sei=abc'"))).toBe(true);
    expect(isNavigationAbortedError(Object.assign(new Error("ERR_FAILED (-2) loading 'https://www.bing.com'"), { errno: -2, code: 'ERR_FAILED' }))).toBe(false);
  });

  test('recovers from redirect-induced ERR_ABORTED (-3) when the follow-up navigation commits and becomes ready', async () => {
    const abortError = Object.assign(
      new Error("ERR_ABORTED (-3) loading 'https://www.google.com/search?q=flask&hl=en&sei=abc'"),
      { errno: -3, code: 'ERR_ABORTED' },
    );
    const mock = createMockWebContents({
      loadURL: vi.fn(() => Promise.reject(abortError)),
    });
    mock.setLoadingMainFrame(true);

    const navPromise = navigateWebContents(mock.webContents, 'https://www.google.com/search?q=flask&hl=en', {
      timeoutMs: 5_000,
      isAllowedUrl: () => true,
      abortedGraceMs: 50,
    });

    // Wait a tick so the initial ERR_ABORTED rejection is processed.
    await Promise.resolve();
    mock.emitter.emit('did-start-navigation', {}, 'https://www.google.com/search?q=flask&hl=en&sei=abc', false, true);
    mock.emitter.emit('did-navigate', {}, 'https://www.google.com/search?q=flask&hl=en&sei=abc');
    mock.emitter.emit('dom-ready');

    await expect(navPromise).resolves.toBeUndefined();
  });

  test('fails immediately when the replacement navigation emits a non-aborted did-fail-load', async () => {
    const abortError = Object.assign(new Error('ERR_ABORTED (-3)'), { errno: -3, code: 'ERR_ABORTED' });
    const mock = createMockWebContents({
      loadURL: vi.fn(() => Promise.reject(abortError)),
    });
    mock.setLoadingMainFrame(true);

    const navPromise = navigateWebContents(mock.webContents, 'https://www.google.com/search?q=flask', {
      timeoutMs: 5_000,
      isAllowedUrl: () => true,
      abortedGraceMs: 50,
    });

    await Promise.resolve();
    mock.emitter.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://www.google.com/search?q=flask', true);

    await expect(navPromise).rejects.toThrow("ERR_NAME_NOT_RESOLVED (-105) loading 'https://www.google.com/search?q=flask'");
  });

  test('rejects after the abort grace period when ERR_ABORTED (-3) has no replacement navigation', async () => {
    vi.useFakeTimers();
    const abortError = Object.assign(new Error('ERR_ABORTED (-3) loading url'), { errno: -3, code: 'ERR_ABORTED' });
    const mock = createMockWebContents({
      loadURL: vi.fn(() => Promise.reject(abortError)),
    });
    mock.setLoadingMainFrame(false);

    try {
      const navPromise = navigateWebContents(mock.webContents, 'https://www.google.com/search?q=flask', {
        timeoutMs: 15_000,
        isAllowedUrl: () => true,
        abortedGraceMs: 100,
      });
      const expectation = expect(navPromise).rejects.toThrow('ERR_ABORTED (-3)');
      await vi.advanceTimersByTimeAsync(100);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });

  test('blocks disallowed redirects immediately with policy error and stops lingering prior loads', async () => {
    const mock = createMockWebContents();
    mock.setLoading(true);

    const navPromise = navigateWebContents(mock.webContents, 'https://allowed.example/start', {
      timeoutMs: 5_000,
      isAllowedUrl: url => !url.includes('blocked.example'),
    });

    expect(mock.webContents.stop).toHaveBeenCalledTimes(1);

    const preventDefault = vi.fn();
    mock.emitter.emit('will-redirect', { preventDefault }, 'https://blocked.example/secret');

    expect(preventDefault).toHaveBeenCalledTimes(1);
    await expect(navPromise).rejects.toThrow('Navigation was blocked by the LobsterAI browser access policy.');
  });
});
