import { type Session, WebContentsView } from 'electron';

import {
  BrowserDisplayMode,
  type BrowserWebAccessConfig,
  normalizeBrowserWebAccessConfig,
} from '../../shared/browserWebAccess/constants';
import type { WebSearchPageRequest, WebSearchPageResponse } from './mcpBridgeServer';

/**
 * Operations the web-search skill's bridge server may run on the hidden search
 * page. Deliberately narrow: the page shares the in-app browser's cookies, so
 * no operation accepts caller-supplied script.
 */
export const WebSearchPageOp = {
  Status: 'status',
  Search: 'search',
  Navigate: 'navigate',
  Text: 'text',
  Html: 'html',
} as const;

export type WebSearchPageOp = typeof WebSearchPageOp[keyof typeof WebSearchPageOp];

export const WebSearchEngine = {
  Google: 'google',
  Bing: 'bing',
} as const;

export type WebSearchEngine = typeof WebSearchEngine[keyof typeof WebSearchEngine];

/** Lets the skill server tell "use your own browser" apart from a failed search. */
export const WebSearchPageErrorCode = {
  Disabled: 'in-app-disabled',
} as const;

const NAVIGATION_TIMEOUT_MS = 15_000;
const RESULT_WAIT_TIMEOUT_MS = 10_000;
const RESULT_POLL_INTERVAL_MS = 200;
const EVALUATE_TIMEOUT_MS = 10_000;
const IDLE_CLOSE_MS = 5 * 60_000;
const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS_LIMIT = 50;
const PAGE_BOUNDS = { x: 0, y: 0, width: 1280, height: 800 };

/** A page the host can drive; the default one is a detached WebContentsView. */
export interface WebSearchPage {
  navigate(url: string, timeoutMs: number): Promise<void>;
  evaluate<T>(script: string, timeoutMs: number): Promise<T>;
  url(): string;
  isDestroyed(): boolean;
  destroy(): void;
}

/** What a hidden page needs to behave like an in-app browser page. */
export interface WebSearchPageContext {
  session: Session;
  whenReady: () => Promise<void>;
  isAllowedUrl: (url: string) => boolean;
}

export interface WebSearchHostDeps {
  getBrowserConfig: () => Partial<BrowserWebAccessConfig> | null | undefined;
  getPageContext: () => WebSearchPageContext;
  createPage?: (context: WebSearchPageContext) => WebSearchPage;
}

interface SearchEngineSpec {
  buildUrl: (query: string) => string;
  resultSelector: string;
  extractScript: string;
}

// The extraction scripts mirror SKILLs/web-search/server/search/{google,bing}.ts,
// which run the same logic through Playwright when the skill uses its own
// Chrome. Keep the selectors in sync when a search engine changes its markup.
const GOOGLE_EXTRACT_SCRIPT = String.raw`(max) => {
  const parseGoogleUrl = (rawUrl) => {
    if (!rawUrl) return '';
    try {
      const parsed = new URL(rawUrl, window.location.origin);
      if ((parsed.origin + parsed.pathname).endsWith('/url')) {
        return parsed.searchParams.get('q') || parsed.searchParams.get('url') || '';
      }
      return parsed.href;
    } catch {
      return '';
    }
  };
  const isSearchPageUrl = (url) => {
    if (!url) return true;
    try {
      const parsed = new URL(url);
      if (!parsed.hostname.includes('google.')) return false;
      return parsed.pathname === '/search' || parsed.pathname === '/url';
    } catch {
      return true;
    }
  };
  const results = [];
  const seenUrls = new Set();
  const push = (title, url, snippet) => {
    if (!title || !url || isSearchPageUrl(url) || seenUrls.has(url)) return;
    seenUrls.add(url);
    results.push({ title, url, snippet, source: 'google', position: results.length + 1 });
  };
  for (const item of Array.from(document.querySelectorAll('div#search div.g'))) {
    if (results.length >= max) break;
    const titleNode = item.querySelector('h3');
    const anchorNode = (titleNode && titleNode.closest('a')) || item.querySelector('a[href]');
    const title = ((titleNode && titleNode.textContent) || (anchorNode && anchorNode.textContent) || '').trim();
    const snippetNode = item.querySelector('.VwiC3b, .yXK7lf, span.aCOpRe, div.IsZvec');
    push(title, parseGoogleUrl((anchorNode && anchorNode.href) || ''), ((snippetNode && snippetNode.textContent) || '').trim());
  }
  if (results.length === 0) {
    for (const titleNode of Array.from(document.querySelectorAll('div#search a h3'))) {
      if (results.length >= max) break;
      const anchorNode = titleNode.closest('a');
      push((titleNode.textContent || '').trim(), parseGoogleUrl((anchorNode && anchorNode.href) || ''), '');
    }
  }
  return results;
}`;

const BING_EXTRACT_SCRIPT = String.raw`(max) => {
  const items = document.querySelectorAll('li.b_algo');
  const results = [];
  for (let i = 0; i < Math.min(items.length, max); i++) {
    const titleEl = items[i].querySelector('h2 a');
    if (!titleEl) continue;
    const snippetEl = items[i].querySelector('.b_caption p, .b_caption');
    const title = (titleEl.textContent || '').trim();
    const url = titleEl.href || '';
    if (title && url) {
      results.push({
        title,
        url,
        snippet: ((snippetEl && snippetEl.textContent) || '').trim(),
        source: 'bing',
        position: i + 1,
      });
    }
  }
  return results;
}`;

const GOOGLE_UNAVAILABLE_SCRIPT = String.raw`() => {
  const text = ((document.body && document.body.innerText) || '').toLowerCase();
  return text.includes('unusual traffic')
    || text.includes('before you continue to google')
    || text.includes("this site can't be reached");
}`;

const SEARCH_ENGINES: Record<WebSearchEngine, SearchEngineSpec> = {
  [WebSearchEngine.Google]: {
    buildUrl: query => `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`,
    resultSelector: 'div#search a h3, div#search div.g',
    extractScript: GOOGLE_EXTRACT_SCRIPT,
  },
  [WebSearchEngine.Bing]: {
    buildUrl: query => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
    resultSelector: 'li.b_algo, ol#b_results li',
    extractScript: BING_EXTRACT_SCRIPT,
  },
};

const isSearchEngine = (value: unknown): value is WebSearchEngine => (
  value === WebSearchEngine.Google || value === WebSearchEngine.Bing
);

const readMaxResults = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_MAX_RESULTS;
  return Math.min(Math.floor(value), MAX_RESULTS_LIMIT);
};

const withTimeout = async <T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const createDetachedPage = (context: WebSearchPageContext): WebSearchPage => {
  const view = new WebContentsView({
    webPreferences: {
      session: context.session,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      plugins: false,
      devTools: false,
      spellcheck: false,
      // Never attached to a window, so Chromium would otherwise throttle it.
      backgroundThrottling: false,
    },
  });
  view.setBounds(PAGE_BOUNDS);
  const webContents = view.webContents;
  webContents.setAudioMuted(true);
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  webContents.on('will-navigate', (event, url) => {
    if (!context.isAllowedUrl(url)) event.preventDefault();
  });

  return {
    async navigate(url, timeoutMs) {
      await context.whenReady();
      let committed = false;
      const onCommit = () => { committed = true; };
      let onDocumentReady = () => {};
      const documentReady = new Promise<void>(resolve => {
        onDocumentReady = () => { if (committed) resolve(); };
      });
      webContents.on('did-navigate', onCommit);
      webContents.on('dom-ready', onDocumentReady);
      const loaded = webContents.loadURL(url);
      // The document is usable before subresources finish; a late rejection
      // from the abandoned load must not surface as an unhandled rejection.
      loaded.catch(() => {});
      try {
        await withTimeout(
          Promise.race([loaded, documentReady]),
          timeoutMs,
          `Navigation timed out after ${timeoutMs}ms.`,
        );
      } finally {
        webContents.removeListener('did-navigate', onCommit);
        webContents.removeListener('dom-ready', onDocumentReady);
      }
    },
    evaluate<T>(script: string, timeoutMs: number): Promise<T> {
      return withTimeout(
        webContents.executeJavaScript(script, false) as Promise<T>,
        timeoutMs,
        `Page script timed out after ${timeoutMs}ms.`,
      );
    },
    url: () => webContents.getURL(),
    isDestroyed: () => webContents.isDestroyed(),
    destroy: () => {
      if (!webContents.isDestroyed()) webContents.close();
    },
  };
};

/**
 * Runs the web-search skill's searches in a hidden page of the in-app browser
 * session, so the skill does not open an external Chrome window while the
 * in-app browser mode is on.
 */
export class WebSearchHost {
  private page: WebSearchPage | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly deps: WebSearchHostDeps) {}

  async handleRequest(request: WebSearchPageRequest): Promise<WebSearchPageResponse> {
    if (!this.isInAppMode()) {
      this.dispose();
      return {
        success: false,
        code: WebSearchPageErrorCode.Disabled,
        error: 'The LobsterAI in-app browser mode is not enabled.',
      };
    }
    if (request.op === WebSearchPageOp.Status) {
      return { success: true, data: { active: true } };
    }

    // One page serves every request; overlapping navigations would abort each other.
    const run = this.queue.then(() => this.dispatch(request));
    this.queue = run.then(() => {}, () => {});
    try {
      return { success: true, data: await run };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[WebSearchHost] ${String(request.op)} failed: ${message}`);
      return { success: false, error: message };
    } finally {
      this.scheduleIdleClose();
    }
  }

  dispose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.page?.destroy();
    this.page = null;
  }

  private isInAppMode(): boolean {
    return normalizeBrowserWebAccessConfig(this.deps.getBrowserConfig()).displayMode
      === BrowserDisplayMode.InApp;
  }

  private async dispatch(request: WebSearchPageRequest): Promise<unknown> {
    switch (request.op) {
      case WebSearchPageOp.Search:
        return this.search(request);
      case WebSearchPageOp.Navigate: {
        const page = this.ensurePage();
        await this.navigate(page, typeof request.url === 'string' ? request.url : '');
        return { url: page.url() };
      }
      case WebSearchPageOp.Text:
        return { text: await this.readDocument('(document.body && document.body.innerText) || ""') };
      case WebSearchPageOp.Html:
        return {
          content: await this.readDocument(
            '(document.documentElement && document.documentElement.outerHTML) || ""',
          ),
        };
      default:
        throw new Error(`Unsupported web search page operation: ${String(request.op)}`);
    }
  }

  /** Nothing has been loaded before the first search, and a page without a document cannot run script. */
  private async readDocument(script: string): Promise<string> {
    const page = this.page;
    if (!page || page.isDestroyed() || !page.url()) return '';
    return page.evaluate<string>(script, EVALUATE_TIMEOUT_MS);
  }

  private async search(request: WebSearchPageRequest): Promise<unknown> {
    const query = typeof request.query === 'string' ? request.query.trim() : '';
    if (!query) throw new Error('query is required');
    if (!isSearchEngine(request.engine)) {
      throw new Error(`Unsupported search engine: ${String(request.engine)}`);
    }
    const engine = request.engine;
    const spec = SEARCH_ENGINES[engine];
    const maxResults = readMaxResults(request.maxResults);
    const startedAt = Date.now();
    const page = this.ensurePage();

    await this.navigate(page, spec.buildUrl(query));

    let results: unknown[] = [];
    if (await this.waitForSelector(page, spec.resultSelector)) {
      results = await page.evaluate<unknown[]>(`(${spec.extractScript})(${maxResults})`, EVALUATE_TIMEOUT_MS);
    } else if (engine === WebSearchEngine.Google) {
      throw new Error(await this.isGoogleUnavailable(page)
        ? 'Google appears blocked or unavailable from this network'
        : 'Google search results did not load in time');
    }
    if (engine === WebSearchEngine.Google && results.length === 0) {
      throw new Error('Google returned no parsable results');
    }

    return {
      query,
      engine,
      results,
      totalResults: results.length,
      timestamp: Date.now(),
      duration: Date.now() - startedAt,
    };
  }

  private async navigate(page: WebSearchPage, url: string): Promise<void> {
    let protocol = '';
    try {
      protocol = new URL(url).protocol;
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new Error(`Blocked URL scheme "${protocol}" - only http/https allowed`);
    }
    if (!this.deps.getPageContext().isAllowedUrl(url)) {
      throw new Error('Navigation was blocked by the LobsterAI browser access policy.');
    }
    await page.navigate(url, NAVIGATION_TIMEOUT_MS);
  }

  private async waitForSelector(page: WebSearchPage, selector: string): Promise<boolean> {
    const script = `Boolean(document.querySelector(${JSON.stringify(selector)}))`;
    const deadline = Date.now() + RESULT_WAIT_TIMEOUT_MS;
    for (;;) {
      // A redirect can replace the document mid-poll; treat that as "not yet".
      const found = await page.evaluate<boolean>(script, EVALUATE_TIMEOUT_MS).catch(() => false);
      if (found) return true;
      if (Date.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, RESULT_POLL_INTERVAL_MS));
    }
  }

  private async isGoogleUnavailable(page: WebSearchPage): Promise<boolean> {
    const url = page.url().toLowerCase();
    if (url.includes('/sorry') || url.includes('consent.google.com')) return true;
    return page.evaluate<boolean>(`(${GOOGLE_UNAVAILABLE_SCRIPT})()`, EVALUATE_TIMEOUT_MS).catch(() => false);
  }

  private ensurePage(): WebSearchPage {
    if (this.page && !this.page.isDestroyed()) return this.page;
    const context = this.deps.getPageContext();
    this.page = (this.deps.createPage ?? createDetachedPage)(context);
    console.log('[WebSearchHost] Created the hidden search page.');
    return this.page;
  }

  private scheduleIdleClose(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.dispose(), IDLE_CLOSE_MS);
    this.idleTimer.unref?.();
  }
}
