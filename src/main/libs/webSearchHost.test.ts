import { EventEmitter } from 'events';
import { describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({ WebContentsView: class {} }));

import { BrowserDisplayMode } from '../../shared/browserWebAccess/constants';
import {
  createDetachedPage,
  decodeBingClickUrl,
  isNavigationAbortedError,
  navigateWebContents,
  normalizeSearchSources,
  WebSearchEngine,
  WebSearchHost,
  type WebSearchPage,
  type WebSearchPageContext,
  type WebSearchViewLike,
  type WebSearchWebContents,
} from './webSearchHost';

const createFakePage = (options: {
  selectorFound?: boolean | ((url: string) => boolean);
  results?: unknown[] | ((url: string) => unknown[]);
  redirectUrl?: string | ((url: string) => string);
  googleUnavailable?: boolean;
  onNavigate?: (url: string) => Promise<void> | void;
} = {}) => {
  let currentUrl = '';
  const navigations: string[] = [];
  const page: WebSearchPage = {
    navigate: vi.fn(async (url: string) => {
      navigations.push(url);
      if (options.onNavigate) {
        await options.onNavigate(url);
      }
      currentUrl = typeof options.redirectUrl === 'function'
        ? options.redirectUrl(url)
        : (options.redirectUrl ?? url);
    }),
    evaluate: vi.fn(async (script: string) => {
      if (script.startsWith('Boolean(document.querySelector(')) {
        return typeof options.selectorFound === 'function'
          ? options.selectorFound(currentUrl)
          : (options.selectorFound ?? true);
      }
      if (script.includes('unusual traffic')) return options.googleUnavailable ?? false;
      return typeof options.results === 'function'
        ? options.results(currentUrl)
        : (options.results ?? []);
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
    googleCooldownMs?: number;
    now?: () => number;
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
    googleCooldownMs: overrides.googleCooldownMs,
    now: overrides.now,
  });
  return { host, createPage };
};

describe('decodeBingClickUrl & normalizeSearchSources', () => {
  test('unwraps Bing /ck/a click-tracking URLs into their real target URL', () => {
    const target = 'https://docs.example.org/release-notes?v=2#summary';
    const encoded = `a1${Buffer.from(target, 'utf8').toString('base64url')}`;
    const bingUrl = `https://www.bing.com/ck/a?!&&p=123&u=${encodeURIComponent(encoded)}&ntb=1`;

    expect(decodeBingClickUrl(bingUrl)).toBe(target);
    expect(decodeBingClickUrl('https://docs.example.org/plain')).toBe('https://docs.example.org/plain');
    expect(decodeBingClickUrl('https://www.bing.com/ck/a?u=not-a1-prefix')).toBe(
      'https://www.bing.com/ck/a?u=not-a1-prefix',
    );
  });

  test('filters policy-blocked URLs (including Bing-wrapped URLs), invalid schemes, and duplicates', () => {
    const blockedWrapped = `https://www.bing.com/ck/a?u=${encodeURIComponent(
      `a1${Buffer.from('https://blocked.example.com/secret', 'utf8').toString('base64url')}`,
    )}`;
    const allowedWrapped = `https://www.bing.com/ck/a?u=${encodeURIComponent(
      `a1${Buffer.from('https://allowed.example.org/guide', 'utf8').toString('base64url')}`,
    )}`;

    const sources = normalizeSearchSources(
      [
        { title: 'Blocked', url: blockedWrapped, snippet: 'secret' },
        { title: 'Allowed', url: allowedWrapped, snippet: 'helpful' },
        { title: 'Duplicate', url: 'https://allowed.example.org/guide', snippet: 'dup' },
        { title: 'Local', url: 'file:///etc/passwd', snippet: 'bad scheme' },
      ],
      url => new URL(url).hostname !== 'blocked.example.com',
      10,
    );

    expect(sources).toEqual([
      { url: 'https://allowed.example.org/guide', title: 'Allowed', snippet: 'helpful' },
    ]);
  });
});

describe('WebSearchHost', () => {
  test('refuses searches while the external browser mode is selected', async () => {
    const { page } = createFakePage();
    const { host, createPage } = createHost(page, { displayMode: BrowserDisplayMode.External });

    await expect(host.search({ query: 'lobster' })).rejects.toThrow('in-app browser mode is not enabled');
    expect(createPage).not.toHaveBeenCalled();
  });

  test('searches in the hidden page and returns normalized results', async () => {
    const { page, navigations } = createFakePage({
      results: [{ title: 'T3 Code', url: 'https://example.com/', snippet: 'Overview', source: 'bing', position: 1 }],
    });
    const { host } = createHost(page);

    const result = await host.search({
      engine: WebSearchEngine.Bing,
      query: 't3 code 是什么',
      maxResults: 5,
    });

    expect(navigations).toEqual([`https://www.bing.com/search?q=${encodeURIComponent('t3 code 是什么')}`]);
    expect(result).toMatchObject({
      query: 't3 code 是什么',
      engine: 'bing',
      sources: [{ url: 'https://example.com/', title: 'T3 Code', snippet: 'Overview' }],
    });
    host.dispose();
  });

  test('falls back from Google to Bing, cools down Google, and retries Google after cooldown expires', async () => {
    let clock = 1_000;
    let failGoogle = true;
    const isGoogleHost = (url: string) => new URL(url).hostname === 'www.google.com';
    const { page, navigations } = createFakePage({
      onNavigate: (url) => {
        if (isGoogleHost(url) && failGoogle) {
          throw new Error('ERR_CONNECTION_TIMED_OUT');
        }
      },
      results: (url) => (
        isGoogleHost(url)
          ? [{ title: 'Google Hit', url: 'https://google-hit.example/', snippet: 'from google' }]
          : [{ title: 'Bing Hit', url: 'https://bing-hit.example/', snippet: 'from bing' }]
      ),
    });
    const { host } = createHost(page, {
      googleCooldownMs: 60_000,
      now: () => clock,
    });

    // First auto search: tries Google -> fails -> cools down -> falls back to Bing.
    const r1 = await host.search({ query: 'first query' });
    expect(r1.engine).toBe(WebSearchEngine.Bing);
    expect(r1.sources).toEqual([{ url: 'https://bing-hit.example/', title: 'Bing Hit', snippet: 'from bing' }]);
    expect(navigations).toHaveLength(2);
    expect(navigations[0]).toContain('google.com');
    expect(navigations[1]).toContain('bing.com');

    // Second auto search inside cooldown window: skips Google entirely and goes straight to Bing.
    clock += 10_000;
    const r2 = await host.search({ query: 'second query' });
    expect(r2.engine).toBe(WebSearchEngine.Bing);
    expect(navigations).toHaveLength(3);
    expect(navigations[2]).toContain('bing.com');

    // After cooldown expires and Google recovers: tries Google again and succeeds.
    clock += 60_000;
    failGoogle = false;
    const r3 = await host.search({ query: 'third query' });
    expect(r3.engine).toBe(WebSearchEngine.Google);
    expect(r3.sources).toEqual([{ url: 'https://google-hit.example/', title: 'Google Hit', snippet: 'from google' }]);
    expect(navigations).toHaveLength(4);
    expect(navigations[3]).toContain('google.com');

    host.dispose();
  });

  test('reuses one page across requests and filters blocked hosts out of search results', async () => {
    const { page } = createFakePage({
      results: [
        { title: 'Blocked', url: 'https://blocked.example/secret', snippet: 'no' },
        { title: 'Allowed', url: 'https://a.example/public', snippet: 'yes' },
      ],
    });
    const { host, createPage } = createHost(page, {
      isAllowedUrl: url => new URL(url).hostname !== 'blocked.example',
    });

    const first = await host.search({ engine: WebSearchEngine.Bing, query: 'one' });
    const second = await host.search({ engine: WebSearchEngine.Google, query: 'two' });

    expect(first.sources).toEqual([{ url: 'https://a.example/public', title: 'Allowed', snippet: 'yes' }]);
    expect(second.sources).toEqual([{ url: 'https://a.example/public', title: 'Allowed', snippet: 'yes' }]);
    expect(createPage).toHaveBeenCalledTimes(1);
    host.dispose();
    expect(page.destroy).toHaveBeenCalledTimes(1);
  });

  test('fails an explicit Google search without parsable results', async () => {
    const { page } = createFakePage({ results: [] });
    const { host } = createHost(page);

    await expect(host.search({ engine: WebSearchEngine.Google, query: 'lobster' }))
      .rejects.toThrow('Google returned no parsable results');
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
      const pending = host.search({
        engine: WebSearchEngine.Google,
        query: 'lobster',
      });
      const expectation = expect(pending).rejects.toThrow(
        unavailable
          ? 'Google appears blocked or unavailable from this network'
          : 'Google search results did not load in time',
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await expectation;
    } finally {
      host.dispose();
      vi.useRealTimers();
    }
  });

  test('refuses search and disposes the hidden page when web-search skill is disabled', async () => {
    let enabled = true;
    const { page } = createFakePage({ results: [{ title: 'Ok', url: 'https://ok.example/' }] });
    const { host, createPage } = createHost(page, { isSkillEnabled: () => enabled });

    await expect(host.search({ engine: WebSearchEngine.Bing, query: 'hi' }))
      .resolves.toMatchObject({ engine: 'bing', sources: [{ url: 'https://ok.example/', title: 'Ok' }] });
    expect(createPage).toHaveBeenCalledTimes(1);

    enabled = false;
    await expect(host.search({ engine: WebSearchEngine.Bing, query: 'hi' }))
      .rejects.toThrow('web-search skill is disabled');
    expect(page.destroy).toHaveBeenCalledTimes(1);
  });

  test('aborts promptly when caller AbortSignal fires', async () => {
    const { page, navigations } = createFakePage({ selectorFound: false });
    const { host } = createHost(page);

    const preAborted = new AbortController();
    preAborted.abort(new Error('cancelled before start'));
    await expect(host.search({ query: 'ignored' }, preAborted.signal)).rejects.toThrow('cancelled before start');
    expect(navigations).toHaveLength(0);

    const midFlight = new AbortController();
    const running = host.search({ engine: WebSearchEngine.Bing, query: 'mid-flight' }, midFlight.signal);
    setTimeout(() => midFlight.abort(new Error('cancelled mid-wait')), 30);
    await expect(running).rejects.toThrow('cancelled mid-wait');
    host.dispose();
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

    await expect(host.search({ engine: WebSearchEngine.Bing, query: 'first' }))
      .resolves.toMatchObject({ sources: [{ url: 'https://recovered.example/', title: 'Recovered' }] });
    expect(index).toBe(1);

    // Simulate renderer crash on the first view -> closed & marked destroyed.
    views[0].emitter.emit('render-process-gone');
    expect(views[0].webContents.close).toHaveBeenCalledTimes(1);

    // Next search transparently recreates a healthy page instead of throwing "Object has been destroyed".
    await expect(host.search({ engine: WebSearchEngine.Bing, query: 'second' }))
      .resolves.toMatchObject({ sources: [{ url: 'https://recovered.example/', title: 'Recovered' }] });
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
      isAllowedUrl: url => new URL(url).hostname !== 'blocked.example',
    });

    expect(mock.webContents.stop).toHaveBeenCalledTimes(1);

    const preventDefault = vi.fn();
    mock.emitter.emit('will-redirect', { preventDefault }, 'https://blocked.example/secret');

    expect(preventDefault).toHaveBeenCalledTimes(1);
    await expect(navPromise).rejects.toThrow('Navigation was blocked by the LobsterAI browser access policy.');
  });
});
