import { describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({ WebContentsView: class {} }));

import { BrowserDisplayMode } from '../../shared/browserWebAccess/constants';
import {
  WebSearchEngine,
  WebSearchHost,
  type WebSearchPage,
  type WebSearchPageContext,
  WebSearchPageErrorCode,
  WebSearchPageOp,
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
  overrides: { displayMode?: BrowserDisplayMode; isAllowedUrl?: (url: string) => boolean } = {},
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
});
