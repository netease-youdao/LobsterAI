import { type Session, WebContentsView } from 'electron';

export const WebSearchEngine = {
  Google: 'google',
  Bing: 'bing',
} as const;

export type WebSearchEngine = typeof WebSearchEngine[keyof typeof WebSearchEngine];

export interface WebSearchSourceItem {
  url: string;
  title?: string;
  snippet?: string;
}

export interface WebSearchRequest {
  query: string;
  maxResults?: number;
  engine?: WebSearchEngine;
}

export interface WebSearchResult {
  query: string;
  engine: WebSearchEngine;
  sources: WebSearchSourceItem[];
  duration: number;
}

const NAVIGATION_TIMEOUT_MS = 15_000;
const GOOGLE_AUTO_NAVIGATION_TIMEOUT_MS = 10_000;
const ABORTED_SETTLE_GRACE_MS = 1_500;
const RESULT_WAIT_TIMEOUT_MS = 10_000;
const GOOGLE_AUTO_RESULT_WAIT_TIMEOUT_MS = 8_000;
const RESULT_POLL_INTERVAL_MS = 200;
const EVALUATE_TIMEOUT_MS = 10_000;
const IDLE_CLOSE_MS = 5 * 60_000;
const DEFAULT_GOOGLE_COOLDOWN_MS = 10 * 60_000;
const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS_LIMIT = 50;
const PAGE_BOUNDS = { x: 0, y: 0, width: 1280, height: 800 };
const WEB_SEARCH_NAVIGATION_ABORTED_CODE = -3;
const WEB_SEARCH_NAVIGATION_ABORTED_NAME = 'ERR_ABORTED';
const POLICY_BLOCKED_NAVIGATION_ERROR = 'Navigation was blocked by the LobsterAI browser access policy.';

/** Minimal Electron WebContents surface needed for navigation helpers and tests. */
export interface WebSearchWebContents {
  loadURL(url: string): Promise<void>;
  executeJavaScript(script: string, userGesture?: boolean): Promise<unknown>;
  getURL(): string;
  isDestroyed(): boolean;
  isLoading(): boolean;
  isLoadingMainFrame(): boolean;
  stop(): void;
  close(): void;
  setAudioMuted(muted: boolean): void;
  setWindowOpenHandler(handler: () => { action: 'deny' }): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface WebSearchViewLike {
  readonly webContents: WebSearchWebContents;
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
}

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
  getPageContext: () => WebSearchPageContext;
  isSkillEnabled?: () => boolean;
  createPage?: (context: WebSearchPageContext) => WebSearchPage;
  googleCooldownMs?: number;
  now?: () => number;
}

interface SearchEngineSpec {
  buildUrl: (query: string) => string;
  resultSelector: string;
  extractScript: string;
}

// Extraction scripts run inside the hidden in-app WebContentsView page.
// Keep selectors up to date when Google or Bing changes its markup.
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

const createAbortError = (signal?: AbortSignal): Error => {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(typeof signal?.reason === 'string' && signal.reason ? signal.reason : 'Web search aborted.');
  error.name = 'AbortError';
  return error;
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }
};

const sleepWithAbort = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.reject(createAbortError(signal));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

/**
 * Unwrap Bing click-tracking redirect URLs (`/ck/a?...&u=a1<base64url>`) into
 * their real destination `http(s)` URL so downstream `web_fetch` and
 * `blockedHostnames` policy checks operate on the actual target host.
 */
export const decodeBingClickUrl = (rawUrl: string): string => {
  if (!rawUrl) return '';
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  const host = parsed.hostname.toLowerCase();
  if ((host !== 'bing.com' && !host.endsWith('.bing.com')) || parsed.pathname !== '/ck/a') {
    return rawUrl;
  }
  const encoded = parsed.searchParams.get('u');
  if (!encoded || !encoded.startsWith('a1') || encoded.length <= 2) {
    return rawUrl;
  }
  try {
    const base64 = encoded.slice(2).replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const decoded = Buffer.from(padded, 'base64').toString('utf8').trim();
    const target = new URL(decoded);
    if (target.protocol === 'http:' || target.protocol === 'https:') {
      return target.href;
    }
  } catch {
    // Fall back to the original URL when Bing's payload is malformed or non-base64.
  }
  return rawUrl;
};

/**
 * Normalize, deduplicate, and policy-filter raw extracted search results.
 */
export const normalizeSearchSources = (
  rawItems: unknown,
  isAllowedUrl: (url: string) => boolean,
  maxResults: number,
): WebSearchSourceItem[] => {
  if (!Array.isArray(rawItems) || maxResults <= 0) return [];
  const sources: WebSearchSourceItem[] = [];
  const seen = new Set<string>();
  for (const raw of rawItems) {
    if (sources.length >= maxResults) break;
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const rawUrl = typeof item.url === 'string' ? item.url.trim() : '';
    if (!rawUrl) continue;
    const decodedUrl = decodeBingClickUrl(rawUrl);
    let normalizedUrl = '';
    try {
      const parsed = new URL(decodedUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      normalizedUrl = parsed.href;
    } catch {
      continue;
    }
    if (seen.has(normalizedUrl) || !isAllowedUrl(normalizedUrl)) continue;
    seen.add(normalizedUrl);
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const snippet = typeof item.snippet === 'string' ? item.snippet.trim() : '';
    sources.push({
      url: normalizedUrl,
      ...(title ? { title } : {}),
      ...(snippet ? { snippet } : {}),
    });
  }
  return sources;
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

export const isNavigationAbortedError = (error: unknown): boolean => {
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (record.errno === WEB_SEARCH_NAVIGATION_ABORTED_CODE) return true;
    if (record.code === WEB_SEARCH_NAVIGATION_ABORTED_NAME) return true;
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.includes(WEB_SEARCH_NAVIGATION_ABORTED_NAME);
};

export interface NavigateWebContentsOptions {
  timeoutMs: number;
  isAllowedUrl: (url: string) => boolean;
  abortedGraceMs?: number;
}

/**
 * Navigate a hidden WebContents to `url`, tolerating Chromium's `ERR_ABORTED (-3)`
 * when a search engine triggers a client/server redirect chain before `dom-ready`
 * while still failing promptly on real network errors, policy blocks, or page destruction.
 */
export const navigateWebContents = (
  webContents: WebSearchWebContents,
  url: string,
  options: NavigateWebContentsOptions,
): Promise<void> => new Promise<void>((resolve, reject) => {
  if (webContents.isDestroyed()) {
    reject(new Error('Hidden search page was destroyed.'));
    return;
  }

  // Cancel any lingering load from a previous search engine before attaching
  // listeners for this navigation so old events cannot resolve or abort it.
  if (webContents.isLoading()) {
    webContents.stop();
  }

  const abortedGraceMs = options.abortedGraceMs ?? ABORTED_SETTLE_GRACE_MS;
  let settled = false;
  let committed = false;
  let followUpNavigationStarted = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let abortedGraceTimer: ReturnType<typeof setTimeout> | undefined;

  const clearAbortedGraceTimer = () => {
    if (abortedGraceTimer) {
      clearTimeout(abortedGraceTimer);
      abortedGraceTimer = undefined;
    }
  };

  const cleanup = () => {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = undefined;
    }
    clearAbortedGraceTimer();
    webContents.removeListener('did-start-navigation', onStartNavigation);
    webContents.removeListener('did-navigate', onCommit);
    webContents.removeListener('dom-ready', onDocumentReady);
    webContents.removeListener('did-finish-load', onFinishLoad);
    webContents.removeListener('did-fail-load', onFailLoad);
    webContents.removeListener('will-navigate', onBeforeNavigate);
    webContents.removeListener('will-redirect', onBeforeNavigate);
    webContents.removeListener('destroyed', onDestroyed);
    webContents.removeListener('render-process-gone', onRendererGone);
  };

  const succeed = () => {
    if (settled) return;
    settled = true;
    cleanup();
    resolve();
  };

  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(error instanceof Error ? error : new Error(String(error)));
  };

  const onStartNavigation = (...args: unknown[]) => {
    const isInPlace = args[2] === true;
    const isMainFrame = args[3] !== false;
    if (!isMainFrame || isInPlace) return;
    committed = false;
    followUpNavigationStarted = true;
    clearAbortedGraceTimer();
  };

  const onCommit = () => {
    committed = true;
    clearAbortedGraceTimer();
  };

  const onDocumentReady = () => {
    if (committed) succeed();
  };

  const onFinishLoad = () => {
    if (committed) succeed();
  };

  const onFailLoad = (...args: unknown[]) => {
    const errorCode = typeof args[1] === 'number' ? args[1] : 0;
    const errorDescription = typeof args[2] === 'string' && args[2] ? args[2] : 'ERR_FAILED';
    const validatedURL = typeof args[3] === 'string' ? args[3] : url;
    const isMainFrame = args[4] !== false;
    if (!isMainFrame) return;
    if (errorCode === WEB_SEARCH_NAVIGATION_ABORTED_CODE) return;
    fail(new Error(`${errorDescription} (${errorCode}) loading '${validatedURL}'`));
  };

  const onBeforeNavigate = (...args: unknown[]) => {
    const event = args[0] as { preventDefault?: () => void } | undefined;
    const targetUrl = typeof args[1] === 'string' ? args[1] : '';
    if (targetUrl && !options.isAllowedUrl(targetUrl)) {
      event?.preventDefault?.();
      fail(new Error(POLICY_BLOCKED_NAVIGATION_ERROR));
    }
  };

  const onDestroyed = () => {
    fail(new Error('Hidden search page was destroyed during navigation.'));
  };

  const onRendererGone = () => {
    fail(new Error('Hidden search page renderer exited during navigation.'));
  };

  webContents.on('did-start-navigation', onStartNavigation);
  webContents.on('did-navigate', onCommit);
  webContents.on('dom-ready', onDocumentReady);
  webContents.on('did-finish-load', onFinishLoad);
  webContents.on('did-fail-load', onFailLoad);
  webContents.on('will-navigate', onBeforeNavigate);
  webContents.on('will-redirect', onBeforeNavigate);
  webContents.on('destroyed', onDestroyed);
  webContents.on('render-process-gone', onRendererGone);

  timeoutTimer = setTimeout(() => {
    fail(new Error(`Navigation timed out after ${options.timeoutMs}ms.`));
  }, options.timeoutMs);

  let loaded: Promise<void>;
  try {
    loaded = webContents.loadURL(url);
  } catch (error) {
    fail(error);
    return;
  }

  loaded.then(
    () => {
      succeed();
    },
    (error: unknown) => {
      if (settled) return;
      if (webContents.isDestroyed() || !isNavigationAbortedError(error)) {
        fail(error);
        return;
      }
      // A redirect chain can abort the initial loadURL() promise with ERR_ABORTED (-3)
      // while the replacement navigation continues toward did-navigate / dom-ready.
      if (committed || webContents.isLoadingMainFrame()) {
        return;
      }
      followUpNavigationStarted = false;
      clearAbortedGraceTimer();
      abortedGraceTimer = setTimeout(() => {
        abortedGraceTimer = undefined;
        if (settled) return;
        if (committed || followUpNavigationStarted || webContents.isLoadingMainFrame()) {
          return;
        }
        fail(error);
      }, abortedGraceMs);
    },
  );
});

export const createDetachedPage = (
  context: WebSearchPageContext,
  createView: (options: Electron.WebContentsViewConstructorOptions) => WebSearchViewLike = options => (
    new WebContentsView(options) as unknown as WebSearchViewLike
  ),
): WebSearchPage => {
  const view = createView({
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
  // Keep a strong reference to the detached WebContentsView for the entire
  // page lifetime; without it V8 GC finalizes the unattached view and destroys
  // its WebContents mid-search (`ERR_FAILED` / `Object has been destroyed`).
  let retainedView: WebSearchViewLike | null = view;
  const webContents = view.webContents;
  webContents.setAudioMuted(true);
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const preventBlockedNavigation = (...args: unknown[]) => {
    const event = args[0] as { preventDefault?: () => void } | undefined;
    const targetUrl = typeof args[1] === 'string' ? args[1] : '';
    if (targetUrl && !context.isAllowedUrl(targetUrl)) event?.preventDefault?.();
  };
  webContents.on('will-navigate', preventBlockedNavigation);
  webContents.on('will-redirect', preventBlockedNavigation);
  webContents.on('destroyed', () => {
    retainedView = null;
  });
  webContents.on('render-process-gone', () => {
    const crashedView = retainedView;
    retainedView = null;
    if (crashedView && !crashedView.webContents.isDestroyed()) {
      crashedView.webContents.close();
    }
  });

  const requireLiveWebContents = (): WebSearchWebContents => {
    if (!retainedView || retainedView.webContents.isDestroyed()) {
      throw new Error('Hidden search page was destroyed.');
    }
    return retainedView.webContents;
  };

  return {
    async navigate(url, timeoutMs) {
      await context.whenReady();
      const liveWebContents = requireLiveWebContents();
      await navigateWebContents(liveWebContents, url, {
        timeoutMs,
        isAllowedUrl: context.isAllowedUrl,
      });
    },
    evaluate<T>(script: string, timeoutMs: number): Promise<T> {
      const liveWebContents = requireLiveWebContents();
      return withTimeout(
        liveWebContents.executeJavaScript(script, false) as Promise<T>,
        timeoutMs,
        `Page script timed out after ${timeoutMs}ms.`,
      );
    },
    url: () => (retainedView && !retainedView.webContents.isDestroyed() ? retainedView.webContents.getURL() : ''),
    isDestroyed: () => !retainedView || retainedView.webContents.isDestroyed(),
    destroy: () => {
      const currentView = retainedView;
      retainedView = null;
      if (currentView && !currentView.webContents.isDestroyed()) {
        currentView.webContents.close();
      }
    },
  };
};

/**
 * Runs web searches in a hidden page of LobsterAI's in-app browser session
 * (Google primary with automatic cooldown + Bing fallback), sharing the app's
 * network/proxy settings and `blockedHostnames` policy without launching an
 * external browser or background Express server.
 */
export class WebSearchHost {
  private page: WebSearchPage | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private googleCooldownUntil = 0;

  constructor(private readonly deps: WebSearchHostDeps) {}

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    throwIfAborted(signal);
    if (this.deps.isSkillEnabled && !this.deps.isSkillEnabled()) {
      this.dispose();
      throw new Error('The LobsterAI web-search skill is disabled.');
    }
    const query = typeof request.query === 'string' ? request.query.trim() : '';
    if (!query) {
      throw new Error('query is required');
    }
    if (request.engine !== undefined && !isSearchEngine(request.engine)) {
      throw new Error(`Unsupported search engine: ${String(request.engine)}`);
    }
    const maxResults = readMaxResults(request.maxResults);

    // One page serves every request; overlapping navigations would abort each other.
    const run = this.queue.then(() => this.runAutoSearch(query, maxResults, request.engine, signal));
    this.queue = run.then(() => {}, () => {});
    try {
      return await run;
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

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private getGoogleCooldownMs(): number {
    return typeof this.deps.googleCooldownMs === 'number' && this.deps.googleCooldownMs >= 0
      ? this.deps.googleCooldownMs
      : DEFAULT_GOOGLE_COOLDOWN_MS;
  }

  private async runAutoSearch(
    query: string,
    maxResults: number,
    explicitEngine: WebSearchEngine | undefined,
    signal?: AbortSignal,
  ): Promise<WebSearchResult> {
    throwIfAborted(signal);
    if (this.deps.isSkillEnabled && !this.deps.isSkillEnabled()) {
      this.dispose();
      throw new Error('The LobsterAI web-search skill is disabled.');
    }

    const engines: WebSearchEngine[] = explicitEngine
      ? [explicitEngine]
      : this.now() < this.googleCooldownUntil
        ? [WebSearchEngine.Bing]
        : [WebSearchEngine.Google, WebSearchEngine.Bing];

    let lastError: unknown;
    for (let i = 0; i < engines.length; i += 1) {
      const engine = engines[i];
      const hasFallback = i + 1 < engines.length;
      try {
        const result = await this.searchWithEngine(query, maxResults, engine, hasFallback, signal);
        if (engine === WebSearchEngine.Google) {
          this.googleCooldownUntil = 0;
        }
        return result;
      } catch (error) {
        if (signal?.aborted) {
          throw createAbortError(signal);
        }
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (engine === WebSearchEngine.Google && hasFallback) {
          this.googleCooldownUntil = this.now() + this.getGoogleCooldownMs();
          console.warn(`[WebSearchHost] google search failed; cooling down and falling back to bing: ${message}`);
          continue;
        }
        console.warn(`[WebSearchHost] ${engine} search failed: ${message}`);
        throw error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Web search failed.');
  }

  private async searchWithEngine(
    query: string,
    maxResults: number,
    engine: WebSearchEngine,
    hasFallback: boolean,
    signal?: AbortSignal,
  ): Promise<WebSearchResult> {
    throwIfAborted(signal);
    const spec = SEARCH_ENGINES[engine];
    const startedAt = this.now();
    const context = this.deps.getPageContext();
    const page = this.ensurePage(context);

    const navTimeoutMs = engine === WebSearchEngine.Google && hasFallback
      ? GOOGLE_AUTO_NAVIGATION_TIMEOUT_MS
      : NAVIGATION_TIMEOUT_MS;
    const waitTimeoutMs = engine === WebSearchEngine.Google && hasFallback
      ? GOOGLE_AUTO_RESULT_WAIT_TIMEOUT_MS
      : RESULT_WAIT_TIMEOUT_MS;

    await this.navigate(page, context, spec.buildUrl(query), navTimeoutMs, signal);
    throwIfAborted(signal);

    let rawResults: unknown[] = [];
    if (await this.waitForSelector(page, spec.resultSelector, waitTimeoutMs, signal)) {
      throwIfAborted(signal);
      rawResults = await page.evaluate<unknown[]>(`(${spec.extractScript})(${maxResults})`, EVALUATE_TIMEOUT_MS);
    } else if (engine === WebSearchEngine.Google) {
      throw new Error(await this.isGoogleUnavailable(page)
        ? 'Google appears blocked or unavailable from this network'
        : 'Google search results did not load in time');
    }

    const sources = normalizeSearchSources(rawResults, context.isAllowedUrl, maxResults);
    if (engine === WebSearchEngine.Google && sources.length === 0) {
      throw new Error('Google returned no parsable results');
    }

    return {
      query,
      engine,
      sources,
      duration: Math.max(0, this.now() - startedAt),
    };
  }

  private async navigate(
    page: WebSearchPage,
    context: WebSearchPageContext,
    url: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    let protocol = '';
    try {
      protocol = new URL(url).protocol;
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      throw new Error(`Blocked URL scheme "${protocol}" - only http/https allowed`);
    }
    if (!context.isAllowedUrl(url)) {
      throw new Error(POLICY_BLOCKED_NAVIGATION_ERROR);
    }
    await page.navigate(url, timeoutMs);
  }

  private async waitForSelector(
    page: WebSearchPage,
    selector: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const script = `Boolean(document.querySelector(${JSON.stringify(selector)}))`;
    const deadline = this.now() + timeoutMs;
    for (;;) {
      throwIfAborted(signal);
      // A redirect can replace the document mid-poll; treat that as "not yet".
      const found = await page.evaluate<boolean>(script, EVALUATE_TIMEOUT_MS).catch(() => false);
      if (found) return true;
      if (this.now() >= deadline) return false;
      await sleepWithAbort(RESULT_POLL_INTERVAL_MS, signal);
    }
  }

  private async isGoogleUnavailable(page: WebSearchPage): Promise<boolean> {
    const url = URL.parse(page.url());
    if (url?.hostname === 'consent.google.com') return true;
    if (
      (url?.hostname === 'www.google.com' || url?.hostname === 'google.com')
      && (url.pathname === '/sorry' || url.pathname.startsWith('/sorry/'))
    ) return true;
    return page.evaluate<boolean>(`(${GOOGLE_UNAVAILABLE_SCRIPT})()`, EVALUATE_TIMEOUT_MS).catch(() => false);
  }

  private ensurePage(context: WebSearchPageContext): WebSearchPage {
    if (this.page && !this.page.isDestroyed()) return this.page;
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
